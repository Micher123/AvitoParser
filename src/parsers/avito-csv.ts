/**
 * Парсер Avito → CSV (45 полей)
 *
 * Два режима работы:
 *
 * 1. ПО URL ПОИСКА — даёте ссылку на поиск Avito с фильтрами,
 *    парсер проходит все страницы, собирает объявления и пишет CSV.
 *    Каждая страница скачивается во временный HTML-файл, парсится,
 *    файл удаляется — затем переход к следующей странице с паузой.
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
import { appendToCsv, emptyRecord, type ListingRecord } from "../csv-writer.ts";

// --- конфигурация ---
import { AVITO_COOKIE, AVITO_PROXY } from "#env";

const CSV_FILE = "avito_listings.csv";
const PAGES_DIR = "./Pages"; // временные HTML страниц поиска и объявлений
const CONCURRENCY = 3; // одновременных загрузок объявлений
const PAGE_DELAY_MS = 2500; // задержка между страницами поиска (2.5 сек)
const AD_DELAY_MS = 800; // задержка между объявлениями

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
  ad?: {
    item?: Record<string, unknown>;
  };
}

// --- глобальное состояние ---
let sessionWarmed = false;

// --- прогрев сессии (заход на главную для получения кук) ---
async function warmupSession() {
  if (sessionWarmed) return;
  console.log("Прогрев сессии: заход на avito.ru...");

  const init: RequestInit & { headers: Record<string, string> } = {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
    },
  };
  if (AVITO_COOKIE) {
    init.headers["Cookie"] = AVITO_COOKIE;
  }

  try {
    let resp: Response;
    if (AVITO_PROXY) {
      const p = new URL(AVITO_PROXY);
      p.searchParams.set("url", "https://www.avito.ru/");
      resp = await fetch(p.toString(), init);
    } else {
      resp = await fetch("https://www.avito.ru/", init);
    }

    if (resp.ok) {
      sessionWarmed = true;
      console.log("   Главная загружена, сессионные куки установлены\n");
      await new Promise((r) => setTimeout(r, 2000));
      return;
    }

    if (resp.status === 429) {
      console.warn("   429 на главной — IP заблокирован, нужен прокси\n");
    } else {
      console.warn(`   HTTP ${resp.status} при прогреве\n`);
    }
  } catch (err) {
    console.warn(`   Ошибка прогрева: ${err instanceof Error ? err.message : err}\n`);
  }
  sessionWarmed = true;
}

// --- скачать HTML и сохранить во временный файл ---
async function downloadToFile(
  url: string,
  prefix: string,
  referer?: string,
): Promise<string> {
  const init: RequestInit & { headers: Record<string, string> } = {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
      "sec-ch-ua": '"Not=A?Brand";v="24", "Chromium";v="134"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": referer ? "same-origin" : "none",
      "sec-fetch-user": "?1",
      "Upgrade-Insecure-Requests": "1",
      "Cache-Control": "max-age=0",
    },
  };
  if (AVITO_COOKIE) {
    init.headers["Cookie"] = AVITO_COOKIE;
  }
  if (referer) {
    init.headers["Referer"] = referer;
  }

  const MAX_RETRIES = 2;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let resp: Response;
    if (AVITO_PROXY) {
      const proxyUrl = new URL(AVITO_PROXY);
      proxyUrl.searchParams.set("url", url);
      resp = await fetch(proxyUrl.toString(), init);
    } else {
      resp = await fetch(url, init);
    }

    if (resp.ok) {
      const html = await resp.text();

      // Детекция блокировки IP — проверяем только видимый текст (не JS)
      const visibleCheck = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
      if (visibleCheck.includes("Доступ ограничен") || visibleCheck.includes("проблема с IP")) {
        const debugPath = "./output/avito_blocked.html";
        try {
          await Deno.mkdir("./output", { recursive: true });
          await Deno.writeTextFile(debugPath, html);
        } catch { /* ignore */ }
        throw new Error(
          `Avito заблокировал IP-адрес сервера.\n` +
          `   Добавьте AVITO_PROXY в .env (HTTP/HTTPS прокси с российским IP).\n` +
          `   Либо используйте режим папки с загруженными вручную HTML-файлами.\n` +
          `   Ответ Avito сохранён в ${debugPath}`,
        );
      }

      // Сохраняем HTML во временный файл в Pages/
      const filePath = `${PAGES_DIR}/${prefix}_${Date.now()}.html`;
      try {
        await Deno.mkdir(PAGES_DIR, { recursive: true });
        await Deno.writeTextFile(filePath, html);
      } catch (err) {
        throw new Error(`Не удалось записать временный файл ${filePath}: ${err instanceof Error ? err.message : err}`);
      }

      return filePath;
    }

    // 429 — ретрай с большой паузой
    if (resp.status === 429) {
      if (attempt < MAX_RETRIES) {
        let bodySnippet = "";
        try { bodySnippet = (await resp.text()).slice(0, 500); } catch { /* ignore */ }
        const debugPath = "./output/avito_429.html";
        try {
          await Deno.mkdir("./output", { recursive: true });
          await Deno.writeTextFile(debugPath, bodySnippet);
        } catch { /* ignore */ }
        const delay = 10_000 + Math.random() * 5000;
        console.warn(`HTTP 429 (IP-бан) — жду ${Math.round(delay / 1000)}с, попытка ${attempt + 1}/${MAX_RETRIES}`);
        console.warn(`   Если ошибка повторится — нужен AVITO_PROXY с российским IP`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      break;
    }

    // 5xx — ретрай
    if (resp.status >= 500 && attempt < MAX_RETRIES) {
      const delay = 5000 + Math.random() * 3000;
      console.warn(`HTTP ${resp.status} — повтор через ${Math.round(delay / 1000)}с (попытка ${attempt + 1}/${MAX_RETRIES})`);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    throw new Error(`HTTP ${resp.status} для ${url}`);
  }

  // Все попытки исчерпаны — сохраняем дебаг
  const debugPath = "./output/avito_429_final.html";
  try {
    await Deno.mkdir("./output", { recursive: true });
    const debugResp = AVITO_PROXY
      ? await fetch(new URL(AVITO_PROXY).toString(), { ...init, headers: { ...init.headers, Referer: "https://www.avito.ru/" } })
      : await fetch(url, { ...init, headers: { ...init.headers, Referer: "https://www.avito.ru/" } });
    const body = await debugResp.text();
    await Deno.writeTextFile(debugPath, body.slice(0, 2000));
  } catch { /* ignore */ }

  throw new Error(
    `Avito блокирует IP-адрес сервера (HTTP 429).\n` +
    `   Решение: добавьте AVITO_PROXY в .env — HTTP/HTTPS прокси с российским IP.\n` +
    `   Альтернатива: используйте режим папки — скачайте HTML вручную через браузер.\n` +
    `   Дебаг-ответ сохранён в ${debugPath}`,
  );
}

// --- удалить временный файл ---
async function removeTempFile(filePath: string, silent = false) {
  try {
    await Deno.remove(filePath);
    if (!silent) console.log(`   Удалён: ${filePath}`);
  } catch {
    // файл мог быть уже удалён — не страшно
  }
}

// --- извлечение __initialData__ (старый формат) ---
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

// --- извлечение __staticRouterHydrationData (новый формат Avito) ---
// deno-lint-ignore no-explicit-any
function extractStaticRouterData(html: string): any | null {
  // Ищем JSON.parse("...") внутри __staticRouterHydrationData
  const re = /__staticRouterHydrationData\s*=\s*JSON\.parse\s*\(\s*"((?:[^"\\]|\\[\s\S])*?)"\s*\)\s*;/;
  const match = html.match(re);
  if (!match) return null;

  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

// deno-lint-ignore no-explicit-any
function extractBuyerItem(html: string): any | null {
  const data = extractStaticRouterData(html);
  if (!data) return null;
  const buyerItem = getByPath(data, 'loaderData["catalog-or-main-or-item"].buyerItem') ??
         getByPath(data, "loaderData.catalog-or-main-or-item.buyerItem");
  return buyerItem?.item ?? buyerItem;
}

// deno-lint-ignore no-explicit-any
function getByPath(obj: any, path: string): any {
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

// --- сбор объявлений со страницы поиска (из файла) ---
interface SearchPageResult {
  items: AvitoSearchItem[];
  totalCount: number;
  pageSize: number;
}

async function collectSearchPage(url: string, pageNum: number): Promise<SearchPageResult> {
  console.log(`Загружаю страницу ${pageNum}...`);
  const filePath = await downloadToFile(url, `search_p${pageNum}`, "https://www.avito.ru/");
  console.log(`   Сохранено: ${filePath}`);

  // Читаем из файла
  const html = await Deno.readTextFile(filePath);
  const doc = new DOMParser().parseFromString(html, "text/html");

  // Ищем все карточки объявлений через data-marker="item"
  const itemElements = doc.querySelectorAll('[data-marker="item"]');
  const items: AvitoSearchItem[] = [];

  for (const el of itemElements) {
    const id = el.getAttribute("data-item-id");
    if (!id) continue;

    const linkEl = el.querySelector('a[data-marker="item-photo-sliderLink"]');
    const href = linkEl?.getAttribute("href") ?? "";
    const adUrl = href
      ? new URL(href, "https://www.avito.ru").toString()
      : `https://www.avito.ru/${id}`;

    const titleEl = el.querySelector('[data-marker="item-title"]');
    const title = titleEl?.textContent?.trim() ?? `Объявление ${id}`;

    const priceEl = el.querySelector('[data-marker="item-price"]');
    const priceText = priceEl?.textContent?.trim() ?? "";

    items.push({
      id,
      title,
      url: adUrl,
      priceDetailed: priceText ? parsePriceFromText(priceText) : undefined,
      location: {},
    });
  }

  // Удаляем временный файл
  await removeTempFile(filePath, true);

  if (items.length === 0) {
    const debugPath = "./output/avito_debug.html";
    try {
      await Deno.mkdir("./output", { recursive: true });
      await Deno.writeTextFile(debugPath, html);
    } catch { /* ignore */ }
    throw new Error(
      `Не удалось извлечь список объявлений из HTML. Возможно, Avito вернул капчу. ` +
        `Добавьте AVITO_COOKIE в .env файл.\n` +
        `HTML сохранён в ${debugPath} — откройте в браузере, чтобы увидеть что пришло.`,
    );
  }

  return {
    items,
    totalCount: items.length,
    pageSize: items.length,
  };
}

// --- извлечение цены из текстовой строки ---
function parsePriceFromText(text: string): { value: number; currency?: string; prefix?: string } | undefined {
  const cleaned = text.replace(/&nbsp;|&thinsp;/g, " ").trim();
  const numMatch = cleaned.match(/([\d\s]+)/);
  if (!numMatch) return undefined;
  const value = parseInt(numMatch[1].replace(/\s/g, ""), 10);
  if (isNaN(value)) return undefined;
  return { value, currency: "₽" };
}

// --- определение базового URL ---
function getBaseUrl(searchUrl: string): { base: string; pageParam: string } {
  const url = new URL(searchUrl);
  const pageParam = url.searchParams.has("p") ? "p" : null;
  url.searchParams.delete("p");
  let base = url.toString();
  if (base.endsWith("?")) base = base.slice(0, -1);
  return { base, pageParam: pageParam ?? "p" };
}

// ─────────────────────────────────────────────────────────
// Парсинг одного объявления → 45 полей ListingRecord
// ─────────────────────────────────────────────────────────

/** Да/Нет из boolean */
function yn(v: unknown): string {
  if (v === true || v === "true" || v === "да" || v === "yes") return "да";
  if (v === false || v === "false" || v === "нет" || v === "no") return "нет";
  return "";
}

/** Извлечение параметров из массива params Avito */
// deno-lint-ignore no-explicit-any
function getParam(params: any, keys: string[]): string {
  if (!Array.isArray(params)) return "";
  for (const k of keys) {
    // params может быть массивом объектов {key, value} или Record
    if (typeof params[0] === "object" && "key" in params[0]) {
      const found = params.find((p: { key: string }) => p.key === k);
      if (found && found.value !== undefined) return String(found.value);
    } else {
      const rec = params as unknown as Record<string, string>;
      if (rec[k] !== undefined) return String(rec[k]);
    }
  }
  return "";
}

/** Собрать все фото из __initialData__ (рекурсивный обход) */
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

/** Извлечь фото из HTML (initialData) */
function extractPhotos(html: string): string[] {
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

/** Поиск координат в initialData */
// deno-lint-ignore no-explicit-any
function findCoords(obj: any): { lat: number; lon: number } | null {
  if (!obj || typeof obj !== "object") return null;

  if (typeof obj.lat === "number" && typeof obj.lon === "number") {
    return { lat: obj.lat, lon: obj.lon };
  }
  if (typeof obj.latitude === "number" && typeof obj.longitude === "number") {
    return { lat: obj.latitude, lon: obj.longitude };
  }
  if (obj.coordinates && typeof obj.coordinates.lat === "number") {
    return { lat: obj.coordinates.lat, lon: obj.coordinates.lng ?? obj.coordinates.lon };
  }

  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      const found = findCoords(v);
      if (found) return found;
    }
  }
  return null;
}

/** Основной парсинг HTML объявления Avito → 45 полей */
// deno-lint-ignore no-explicit-any
function parseAdHtml(html: string): ListingRecord {
  // Пробуем оба источника данных
  const initData = extractInitialData(html);
  const buyerItem = extractBuyerItem(html);

  // deno-lint-ignore no-explicit-any
  let item: any = initData ? getByPath(initData, "ad.item") : null;
  // Если __initialData__ не найден — используем buyerItem из staticRouter
  if (!item && buyerItem) item = buyerItem;

  const doc = new DOMParser().parseFromString(html, "text/html");

  // Базовый шаблон записи
  const record = emptyRecord("avito");

  // -- item_id --
  record.item_id = String(item?.id ?? "");

  // -- title --
  record.title = (
    item?.title ??
    doc?.head?.querySelector('meta[property="vk:title"]')?.getAttribute("content") ??
    doc?.querySelector('h1[itemprop="name"]')?.textContent ??
    doc?.querySelector("h1")?.textContent ??
    ""
  ).trim();

  // -- price --
  if (item?.priceDetailed?.value) {
    record.price = String(item.priceDetailed.value);
  } else if (item?.price?.value !== undefined && item.price.value !== null) {
    // Новый формат: price.value
    record.price = String(item.price.value);
  } else {
    const metaPrice = doc?.head?.querySelector('meta[itemprop="price"]')?.getAttribute("content");
    if (metaPrice) record.price = metaPrice;
  }

  // -- price_per_m2 --
  if (item?.priceDetailed?.pricePerM2) {
    record.price_per_m2 = String(item.priceDetailed.pricePerM2);
  }

  // -- description + description_html --
  record.description = (item?.description ?? "").trim();
  record.description_html = (item?.descriptionHtml ?? item?.description ?? "").trim();

  // -- address --
  record.address = (
    item?.address ??
    doc?.querySelector('div[itemProp="address"]')?.textContent ??
    doc?.querySelector('span[class*="address"]')?.textContent ??
    doc?.querySelector('[data-marker="item-address"]')?.textContent ??
    ""
  ).trim();

  // -- params (характеристики) --
  // deno-lint-ignore no-explicit-any
  const params: any = item?.params ?? [];

  record.rooms = getParam(params, ["flat_rooms", "rooms", "количество_комнат", "room_count"]);
  record.total_area = getParam(params, ["flat_area", "area", "общая_площадь", "total_area", "square"]);
  record.kitchen_area = getParam(params, ["flat_kitchen_area", "kitchen_area", "площадь_кухни", "kitchen"]);
  record.living_area = getParam(params, ["flat_living_area", "living_area", "жилая_площадь", "living"]);
  record.floor = getParam(params, ["flat_floor", "floor", "этаж"]);
  record.floors_total = getParam(params, ["flat_floors", "floors_total", "этажность", "floors_count", "house_floors"]);
  record.balcony = getParam(params, ["flat_balcony", "balcony", "балкон", "лоджия"]);
  record.room_type = getParam(params, ["flat_room_type", "room_type", "тип_комнат", "room_variant"]);
  record.bathroom = getParam(params, ["flat_bathroom", "bathroom_unit", "bathroom", "санузел"]);
  record.windows = getParam(params, ["flat_windows", "windows", "окна", "window_view"]);
  record.renovation = getParam(params, ["flat_condition", "flat_renovation", "condition", "renovation", "состояние", "ремонт"]);
  record.furniture = getParam(params, ["flat_furniture", "furniture", "мебель"]);
  record.is_furnished = yn(getParam(params, ["flat_furnished", "furnished", "is_furnished"]));
  record.house_type = getParam(params, ["flat_building_type", "building_type", "house_type", "тип_дома"]);
  record.build_year = getParam(params, ["flat_build_year", "build_year", "год_постройки", "house_year"]);
  record.passenger_elevator = getParam(params, ["flat_elevator", "elevator", "passenger_elevator", "лифт", "elevators"]);
  record.freight_elevator = getParam(params, ["flat_freight_elevator", "freight_elevator", "грузовой_лифт", "cargo_elevator"]);
  record.parking = getParam(params, ["flat_parking", "parking", "парковка"]);

  // -- sale_method / sale_terms --
  record.sale_method = getParam(params, ["sale_method", "способ_продажи", "deal_type"]);
  record.sale_terms = getParam(params, ["sale_terms", "условия_продажи", "deal_terms"]);

  // -- seller --
  record.seller_name = (item?.seller?.name ?? "").trim();
  record.seller_type = (item?.seller?.type ?? item?.seller?.userType ?? "").trim();
  record.seller_contact_person = (item?.seller?.contactPerson ?? "").trim();
  record.is_agency = yn(item?.seller?.isAgency ?? item?.seller?.is_agency ?? item?.isAgency);

  // -- phone --
  record.phone_number = (item?.phone ?? item?.contacts?.phone ?? "").trim();

  // -- messenger_availability (по наличию кнопки "Написать сообщение") --
  const msgBtn = doc.querySelector('[data-marker="item-chat"]') ??
                 doc.querySelector('[data-marker="chat-button"]') ??
                 doc.querySelector('button[data-marker*="chat"]');
  record.messenger_availability = msgBtn ? "да" : "";

  // -- listing_date --
  record.listing_date = (item?.publicationDate ?? item?.created ?? item?.date ?? "").trim();

  // -- views --
  if (item?.views !== undefined && item?.views !== null) {
    record.views_total = String(item.views);
  }
  if (item?.viewsToday !== undefined && item?.viewsToday !== null) {
    record.views_today = String(item.viewsToday);
  }

  // -- images (пробуем оба источника) --
  let photos: string[] = extractPhotos(html);
  if (photos.length === 0 && buyerItem?.gallery?.items) {
    // Новый формат: buyerItem.gallery.items[].urls
    for (const gi of buyerItem.gallery.items) {
      if (gi.urls) {
        const first = Object.values(gi.urls)[0];
        if (first) photos.push(String(first));
      }
    }
  } else if (photos.length === 0 && buyerItem?.images) {
    // Альтернативно: buyerItem.images[].url
    for (const img of buyerItem.images) {
      if (img.url) photos.push(String(img.url));
    }
  }
  if (photos.length > 0) {
    record.images_count = String(photos.length);
    record.image_urls = photos.join(", ");
    record.main_image_url = photos[0];
  }

  // -- coords (пробуем оба источника) --
  let lat = 0;
  let lon = 0;
  if (item?.coords) {
    lat = item.coords.lat ?? item.coords.latitude ?? 0;
    lon = item.coords.lon ?? item.coords.longitude ?? item.coords.lng ?? 0;
  } else if (buyerItem?.coords) {
    lat = buyerItem.coords.lat ?? buyerItem.coords.latitude ?? 0;
    lon = buyerItem.coords.lon ?? buyerItem.coords.longitude ?? 0;
  } else if (initData) {
    const coords = findCoords(initData);
    if (coords) { lat = coords.lat; lon = coords.lon; }
  }
  record.latitude = lat !== 0 ? String(lat) : "";
  record.longitude = lon !== 0 ? String(lon) : "";

  // -- map_zoom --
  if (item?.coords?.zoom !== undefined) {
    record.map_zoom = String(item.coords.zoom);
  } else if (item?.mapZoom !== undefined) {
    record.map_zoom = String(item.mapZoom);
  }

  // -- is_online_view (онлайн-показ) --
  const onlineShow = doc.querySelector('[data-marker="online-show"]') ??
                     doc.querySelector('[class*="online"]');
  record.is_online_view = onlineShow ? "да" : "";

  // -- is_mortgage_possible --
  record.is_mortgage_possible = yn(item?.mortgage?.possible ?? item?.isMortgagePossible);

  // -- mortgage_* --
  if (item?.mortgage) {
    if (item.mortgage.payment) record.mortgage_payment = String(item.mortgage.payment);
    if (item.mortgage.rate) record.mortgage_rate = String(item.mortgage.rate);
    if (item.mortgage.income) record.mortgage_income = String(item.mortgage.income);
  }

  record.parsed_at = new Date().toISOString();

  return record;
}

// --- обработка одного объявления: скачать → сохранить → распарсить → удалить ---
async function processOneAd(
  item: AvitoSearchItem,
  index: number,
  total: number,
): Promise<ListingRecord | null> {
  const adUrl = new URL(item.url, "https://www.avito.ru").toString();
  const adId = String(item.id);

  try {
    // 1. Скачать HTML объявления во временный файл в Pages/
    const filePath = await downloadToFile(adUrl, `ad_${adId}`, "https://www.avito.ru/");

    // 2. Прочитать из файла
    const html = await Deno.readTextFile(filePath);

    // 3. Распарсить
    const record = parseAdHtml(html);

    // 4. Удалить временный файл
    await removeTempFile(filePath, true);

    await appendToCsv(CSV_FILE, [record]);
    console.log(`[${index}/${total}] ${record.title}`);

    return record;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Ошибка [${index}/${total}]: ${adUrl} — ${msg}`);
    return null;
  }
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
    console.error("Укажите URL поиска Avito или путь к папке с HTML-файлами.");
    console.error("");
    console.error("   Режим 1 — URL поиска:");
    console.error('     deno task parse-avito "https://www.avito.ru/moskva/kvartiry/sdam?p=1"');
    console.error("");
    console.error("   Режим 2 — папка с HTML:");
    console.error("     deno task parse-avito /путь/к/avito-export");
    console.error("");
    if (!AVITO_COOKIE) {
      console.error("   Если Avito возвращает рекламные блоки вместо объявлений,");
      console.error("      добавьте AVITO_COOKIE в файл .env (скопируйте куки из браузера).");
    }
    Deno.exit(1);
  }

  const isUrl = input.startsWith("http://") || input.startsWith("https://");

  if (isUrl) {
    // ═══════════════════════════════════════════════
    // Режим 1: поиск по URL — файловый конвейер
    // ═══════════════════════════════════════════════
    console.log("Режим поиска по URL (файловый конвейер)");
    console.log(`   Поисковый запрос: ${input}`);
    console.log("");

    // Прогрев сессии
    await warmupSession();

    // Страница 1 — скачать → сохранить → распарсить → удалить
    const firstPage = await collectSearchPage(input, 1);
    const pageSize = firstPage.pageSize;
    console.log(`   Страница 1: найдено ${firstPage.items.length} объявлений`);

    // Обрабатываем объявления с первой страницы: скачать → файл → парсить → удалить
    let globalIndex = 0;
    let processed = 0;
    let failed = 0;

    console.log(`\nОбрабатываю объявления со страницы 1...\n`);

    for (const item of firstPage.items) {
      globalIndex++;
      const result = await processOneAd(item, globalIndex, firstPage.items.length);
      if (result) processed++;
      else failed++;
      // Задержка между объявлениями
      await new Promise((r) => setTimeout(r, AD_DELAY_MS));
    }

    // Если на первой странице меньше pageSize — значит это единственная страница
    if (firstPage.items.length < pageSize) {
      console.log(`\nГотово! Всего страниц: 1. Обработано: ${processed}, ошибок: ${failed}`);
      console.log(`Результат сохранён в output/${CSV_FILE}`);
      return;
    }

    // Определяем URL для следующих страниц
    const { base, pageParam } = getBaseUrl(input);
    const sep = base.includes("?") ? "&" : "?";

    // Страницы 2, 3, ... — пока есть объявления
    let page = 2;
    let maxEmptyPages = 3; // стоп после 3 пустых страниц подряд

    while (maxEmptyPages > 0) {
      const pageUrl = `${base}${sep}${pageParam}=${page}`;

      // Задержка между страницами (2.5 секунды)
      console.log(`\nПауза ${PAGE_DELAY_MS / 1000}с перед страницей ${page}...`);
      await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));

      let pageResult: SearchPageResult;
      try {
        pageResult = await collectSearchPage(pageUrl, page);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Не удалось загрузить страницу ${page}: ${msg}`);
        page++;
        maxEmptyPages--;
        continue;
      }

      const itemCount = pageResult.items.length;
      console.log(`   Страница ${page}: найдено ${itemCount} объявлений`);

      if (itemCount === 0) {
        console.log(`   Пустая страница — возможно, достигнут конец выдачи`);
        maxEmptyPages--;
        page++;
        continue;
      }

      // Сброс счётчика пустых страниц
      maxEmptyPages = 3;

      // Обрабатываем объявления с этой страницы
      for (const item of pageResult.items) {
        globalIndex++;
        const result = await processOneAd(item, globalIndex, globalIndex);
        if (result) processed++;
        else failed++;
        await new Promise((r) => setTimeout(r, AD_DELAY_MS));
      }

      page++;
    }

    console.log(`\nГотово! Всего страниц: ${page - 1}. Обработано: ${processed}, ошибок: ${failed}`);
    console.log(`Результат сохранён в output/${CSV_FILE}`);

  } else {
    // ═══════════════════════════════════════════════
    // Режим 2: чтение из папки
    // ═══════════════════════════════════════════════
    console.log("Режим чтения из папки");

    const ads = await readFromDirectory(input);

    if (!ads.length) {
      console.error(`В папке "${input}" не найдено HTML-файлов.`);
      Deno.exit(1);
    }

    console.log(`Найдено ${ads.length} HTML-файлов. Запускаю обработку...\n`);

    let processed = 0;
    let failed = 0;

    await Array.fromAsync(
      pooledMap(CONCURRENCY, ads, async ({ file: offerKey, html }) => {
        try {
          const record = parseAdHtml(html);

          await appendToCsv(CSV_FILE, [record]);

          processed++;
          console.log(`[${processed}/${ads.length}] ${record.title}`);
        } catch (err) {
          failed++;
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`Ошибка при обработке ${offerKey}: ${msg}`);
        }
      }),
    );

    console.log(`\nГотово! Обработано: ${processed}, ошибок: ${failed}`);
    console.log(`Результат сохранён в output/${CSV_FILE}`);
  }
}

if (import.meta.main) {
  await main();
}