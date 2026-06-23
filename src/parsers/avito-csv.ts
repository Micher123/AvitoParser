/**
 * Парсер Avito → CSV
 *
 * Два режима работы:
 *
 * 1. ПО URL ПОИСКА — даёте ссылку на поиск Avito с фильтрами,
 *    парсер проходит все страницы, собирает объявления и пишет CSV.
 *    Пример:
 *      deno task parse-avito "https://www.avito.ru/moskva/kvartiry/sdam/na_dlitelnyy_srok?p=1"
 *
 * 2. ИЗ ПАПКИ С HTML — читает локальные .html файлы (старый режим).
 *    Пример:
 *      deno task parse-avito /путь/к/папке
 *
 * ⚠️ Avito требует куки для показа объявлений. Если парсер получает
 *    только рекламные блоки вместо реальных объявлений — задайте
 *    AVITO_COOKIE в .env (скопируйте куки из браузера после захода на avito.ru).
 */
import { DOMParser } from "dom-parser";
import { pooledMap } from "@std/async";
import { join } from "@std/path";
import { appendToCsv, type ListingRecord } from "../csv-writer.ts";

// --- конфигурация ---
import { AVITO_COOKIE } from "#env";

const CSV_FILE = "avito_listings.csv";
const CONCURRENCY = 3; // одновременных загрузок объявлений
const DELAY_MS = 1500; // задержка между запросами (чтобы не забанили)

// --- типы ---
interface AvitoSearchItem {
  id: string | number;
  title: string;
  url: string;
  priceDetailed?: {
    value: number;
    currency?: string;
    prefix?: string;
  };
  location?: {
    address?: string;
    district?: string;
    city?: string;
  };
  images?: Array<{ urls: Record<string, string> }>;
}

interface AvitoInitialData {
  catalog?: {
    items?: AvitoSearchItem[];
    totalCount?: number;
    pageSize?: number;
    currentPage?: number;
  };
}

// --- утилиты: fetch страницы ---
async function fetchPage(url: string): Promise<string> {
  const headers: Record<string, string> = {};
  if (AVITO_COOKIE) {
    headers["Cookie"] = AVITO_COOKIE;
  }

  const resp = await fetch(url, {
    headers: {
      ...headers,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "ru-RU,ru;q=0.9",
    },
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} для ${url}`);
  }
  return await resp.text();
}

// --- извлечение __initialData__ ---
function extractInitialData(html: string): AvitoInitialData | null {
  const re = /window\.__initialData__\s*=\s*(["'`])([\s\S]*?)\1\s*;/;
  const match = html.match(re);
  if (!match) return null;

  const encoded = match[2].trim();
  let jsonText: string;
  try {
    jsonText = decodeURIComponent(encoded);
  } catch {
    jsonText = encoded;
  }

  try {
    return JSON.parse(jsonText) as AvitoInitialData;
  } catch {
    return null;
  }
}

// --- сбор ссылок на объявления со страницы поиска ---
interface SearchPageResult {
  items: AvitoSearchItem[];
  totalCount: number;
  pageSize: number;
}

async function collectSearchPage(url: string): Promise<SearchPageResult> {
  console.log(`📄 Загружаю: ${url}`);
  const html = await fetchPage(url);
  const data = extractInitialData(html);

  if (!data?.catalog?.items) {
    throw new Error(
      `Не удалось извлечь список объявлений. Возможно, Avito вернул капчу. ` +
        `Добавьте AVITO_COOKIE в .env файл.`,
    );
  }

  return {
    items: data.catalog.items,
    totalCount: data.catalog.totalCount ?? 0,
    pageSize: data.catalog.pageSize ?? data.catalog.items.length,
  };
}

// --- определение общего количества страниц ---
function getBaseUrl(searchUrl: string): { base: string; pageParam: string } {
  const url = new URL(searchUrl);

  // Avito использует ?p=N или &p=N
  const pageParam = url.searchParams.has("p") ? "p" : null;

  // Убираем параметр страницы, будем подставлять сами
  url.searchParams.delete("p");
  // Убеждаемся что есть слэш перед параметрами
  let base = url.toString();
  if (base.endsWith("?")) base = base.slice(0, -1);

  return { base, pageParam: pageParam ?? "p" };
}

// --- парсинг одного объявления ---
function parseAdHtml(html: string, offerUrl: string): Omit<ListingRecord, "source"> {
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc) throw new Error("broken markup");

  // Заголовок
  const title =
    doc.head
      ?.querySelector('meta[property="vk:title"]')
      ?.getAttribute("content") ??
      doc.querySelector('h1[itemprop="name"]')?.textContent ??
      doc.querySelector("h1")?.textContent ??
      "N/A";

  // Адрес
  const address =
    doc.querySelector('div[itemProp="address"]')?.textContent ??
    doc.querySelector('span[class*="address"]')?.textContent ??
    doc.querySelector('[data-marker="item-address"]')?.textContent ??
    "N/A";

  // Описание
  const metaDesc = doc.head
    ?.querySelector('meta[property="og:description"]')
    ?.getAttribute("content");
  let description = metaDesc?.trim() ?? "";
  if (!description) {
    const descDiv = doc.querySelector('div[class*="item-description"]');
    if (descDiv) {
      // deno-lint-ignore no-explicit-any
      const clone = descDiv.cloneNode(true) as any;
      clone.querySelector?.("button")?.remove();
      description = (clone.textContent ?? "").trim();
    }
  }

  // Цена
  const priceMeta = doc.head
    ?.querySelector('meta[itemprop="price"]')
    ?.getAttribute("content");
  let price = priceMeta ?? "";
  if (!price) {
    const priceEl = doc.querySelector('[data-marker="item-price"]') ??
      doc.querySelector('span[class*="price"]');
    price = priceEl?.textContent?.replace(/[^\d]/g, "") ?? "";
  }

  // Фото
  const photos = parsePhotos(html);

  // Координаты (из initialData карточки)
  const initData = extractInitialData(html);
  let lat = 0;
  let lon = 0;
  if (initData) {
    // Ищем координаты в initialData (может быть в разных местах)
    const coords = findCoords(initData);
    if (coords) {
      lat = coords.lat;
      lon = coords.lon;
    }
  }

  return {
    url: offerUrl,
    title: title.trim(),
    address: address.trim(),
    description: description.trim(),
    price,
    rating: "",
    operators: "",
    routes: "",
    images: photos.join(", "),
    lat,
    lon,
    parsedAt: new Date().toISOString(),
  };
}

// --- рекурсивный обход JSON для сбора фото ---
function walkGallery(
  key: string,
  value: unknown,
  images: string[],
): void {
  if (value === null || value === undefined) return;

  if (
    key === "galleryInfo" &&
    typeof value === "object" &&
    "media" in value
  ) {
    const media = (value as { media: Array<{ urls: Record<string, string> }> }).media;
    for (const { urls } of media) {
      const first = Object.values(urls)[0];
      if (first) images.push(first);
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, idx) => walkGallery(String(idx), item, images));
    return;
  }

  if (typeof value === "object") {
    Object.entries(value as Record<string, unknown>).forEach(([k, v]) =>
      walkGallery(k, v, images),
    );
  }
}

function parsePhotos(html: string): string[] {
  const re = /window\.__initialData__\s*=\s*(["'`])([\s\S]*?)\1\s*;/;
  const match = html.match(re);
  if (!match) return [];

  const encoded = match[2].trim();
  let jsonText: string;
  try {
    jsonText = decodeURIComponent(encoded);
  } catch {
    jsonText = encoded;
  }

  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return [];
  }

  const images: string[] = [];
  walkGallery("", data, images);
  return images;
}

// --- поиск координат в initialData ---
// deno-lint-ignore no-explicit-any
function findCoords(obj: any): { lat: number; lon: number } | null {
  if (!obj || typeof obj !== "object") return null;

  // Прямые координаты
  if (typeof obj.lat === "number" && typeof obj.lon === "number") {
    return { lat: obj.lat, lon: obj.lon };
  }
  if (typeof obj.latitude === "number" && typeof obj.longitude === "number") {
    return { lat: obj.latitude, lon: obj.longitude };
  }

  // Координаты в поле coordinates
  if (obj.coordinates && typeof obj.coordinates.lat === "number") {
    return { lat: obj.coordinates.lat, lon: obj.coordinates.lng ?? obj.coordinates.lon };
  }

  // Рекурсивно
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      const found = findCoords(v);
      if (found) return found;
    }
  }
  return null;
}

// --- режим 2: чтение из папки (старый режим) ---
async function readFromDirectory(dirPath: string): Promise<Array<{ file: string; html: string }>> {
  const stat = await Deno.stat(dirPath);
  if (!stat.isDirectory) throw new Error(`"${dirPath}" не является директорией`);

  const ads: Array<{ file: string; html: string }> = [];
  for (const entry of Deno.readDirSync(dirPath)) {
    if (!entry.isFile || !entry.name.endsWith(".html")) continue;
    const text = await Deno.readTextFile(join(dirPath, entry.name));
    ads.push({ file: entry.name.replace(".html", ""), html: text });
  }
  return ads;
}

// --- main ---
async function main() {
  const input = Deno.args[0];

  if (!input) {
    console.error("❌ Укажите URL поиска Avito или путь к папке с HTML-файлами.");
    console.error("");
    console.error("   Режим 1 — URL поиска:");
    console.error('     deno task parse-avito "https://www.avito.ru/moskva/kvartiry/sdam?p=1"');
    console.error("");
    console.error("   Режим 2 — папка с HTML:");
    console.error("     deno task parse-avito /путь/к/avito-export");
    console.error("");
    if (!AVITO_COOKIE) {
      console.error("   💡 Если Avito возвращает рекламные блоки вместо объявлений,");
      console.error("      добавьте AVITO_COOKIE в файл .env (скопируйте куки из браузера).");
    }
    Deno.exit(1);
  }

  // Определяем режим: URL или папка
  const isUrl = input.startsWith("http://") || input.startsWith("https://");

  if (isUrl) {
    // --- Режим 1: поиск по URL ---
    console.log("🔍 Режим поиска по URL");
    console.log(`   Поисковый запрос: ${input}`);

    // Страница 1
    const firstPage = await collectSearchPage(input);
    const totalItems = firstPage.totalCount;
    const pageSize = firstPage.pageSize;
    const totalPages = Math.ceil(totalItems / pageSize);

    console.log(`   Найдено объявлений: ${totalItems}`);
    console.log(`   Страниц: ${totalPages}`);
    console.log("");

    const { base, pageParam } = getBaseUrl(input);

    // Собираем все items со всех страниц
    const allItems: AvitoSearchItem[] = [...firstPage.items];

    for (let page = 2; page <= totalPages; page++) {
      const pageUrl = `${base}?${pageParam}=${page}`;
      try {
        // Задержка между запросами страниц поиска
        await new Promise((r) => setTimeout(r, DELAY_MS));
        const result = await collectSearchPage(pageUrl);
        allItems.push(...result.items);
        console.log(`   Страница ${page}/${totalPages}: +${result.items.length} объявлений`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`⚠️  Не удалось загрузить страницу ${page}: ${msg}`);
        // Продолжаем со следующей
      }
    }

    console.log(`\n🔍 Всего собрано ссылок: ${allItems.length}`);
    console.log(`🔍 Загружаю и парсю каждое объявление...\n`);

    let processed = 0;
    let failed = 0;

    await Array.fromAsync(
      pooledMap(CONCURRENCY, allItems, async (item: AvitoSearchItem) => {
        try {
          const itemUrl = new URL(item.url, "https://www.avito.ru").toString();
          const html = await fetchPage(itemUrl);

          const parsed = parseAdHtml(html, itemUrl);

          const record: ListingRecord = {
            source: "avito",
            ...parsed,
          };

          await appendToCsv(CSV_FILE, [record]);

          processed++;
          console.log(`✅ [${processed}/${allItems.length}] ${parsed.title}`);
        } catch (err) {
          failed++;
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`❌ Ошибка: ${item.url} — ${msg}`);
        }
        // Задержка между объявлениями
        await new Promise((r) => setTimeout(r, 500));
      }),
    );

    console.log(`\n📊 Готово! Обработано: ${processed}, ошибок: ${failed}`);
    console.log(`📁 Результат сохранён в output/${CSV_FILE}`);

  } else {
    // --- Режим 2: чтение из папки ---
    console.log("📂 Режим чтения из папки");

    const ads = await readFromDirectory(input);

    if (!ads.length) {
      console.error(`❌ В папке "${input}" не найдено HTML-файлов.`);
      Deno.exit(1);
    }

    console.log(`🔍 Найдено ${ads.length} HTML-файлов. Запускаю обработку...\n`);

    let processed = 0;
    let failed = 0;

    await Array.fromAsync(
      pooledMap(CONCURRENCY, ads, async ({ file: offerKey, html }) => {
        try {
          const parsed = parseAdHtml(html, `https://avito.ru/all/kvartiry/${offerKey}`);
          const record: ListingRecord = {
            source: "avito",
            ...parsed,
          };

          await appendToCsv(CSV_FILE, [record]);

          processed++;
          console.log(`✅ [${processed}/${ads.length}] ${parsed.title}`);
        } catch (err) {
          failed++;
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`❌ Ошибка при обработке ${offerKey}: ${msg}`);
        }
      }),
    );

    console.log(`\n📊 Готово! Обработано: ${processed}, ошибок: ${failed}`);
    console.log(`📁 Результат сохранён в output/${CSV_FILE}`);
  }
}

if (import.meta.main) {
  await main();
}