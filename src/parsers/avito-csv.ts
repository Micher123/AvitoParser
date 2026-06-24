/**
 * Парсер Avito → CSV (разделитель ";")
 *
 * Алгоритм работы:
 *   1. Получаем URL поисковой страницы Avito с фильтрами.
 *      Пример: "https://www.avito.ru/moskva_i_mo/kvartiry/prodam-ASgBAgICAUSSA8YQ"
 *   2. Скачиваем поисковую страницу во временный HTML-файл.
 *   3. Из JSON-LD (<script type="application/ld+json">) извлекаем список объявлений:
 *      @graph[0].offers.offers[] → url каждого объявления.
 *   4. Для каждого url скачиваем страницу объявления во временный файл.
 *   5. Из страницы объявления извлекаем поля:
 *      - __staticRouterHydrationData (новый формат Avito)
 *      - __initialData__ (старый формат, fallback)
 *      - DOM (meta-теги, data-marker атрибуты)
 *   6. Сохраняем извлечённые данные в CSV-файл (output/avito_listings.csv).
 *   7. Удаляем временный файл объявления.
 *   8. Переходим к следующему объявлению (п.4).
 *   9. Когда все объявления на странице обработаны — ищем пагинацию
 *      (data-marker="pagination-button/page(N)") и переходим на следующую
 *      поисковую страницу.
 *  10. Удаляем предыдущую поисковую страницу, скачиваем новую (п.2).
 */

import { DOMParser } from "dom-parser";
import { appendToCsv, emptyRecord, type ListingRecord } from "../csv-writer.ts";

// --- конфигурация ---
const PAGES_DIR = "./Pages";           // временные HTML файлы
const CONCURRENCY = 3;                  // одновременных загрузок объявлений
const PAGE_DELAY_MS = 2500;             // задержка между страницами поиска (2.5 сек)

/** Случайная задержка 3–6 секунд между объявлениями чтобы не триггерить антибот */
function adDelayMs(): number {
  return 3000 + Math.random() * 3000;
}

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

// ═══════════════════════════════════════════════════════════════════
// HTTP-утилиты
// ═══════════════════════════════════════════════════════════════════

/**
 * Скачивает страницу по URL во временный файл.
 * Возвращает путь к файлу.
 */
async function downloadToFile(
  url: string,
  prefix: string,
  referer: string,
): Promise<string> {
  await Deno.mkdir(PAGES_DIR, { recursive: true });
  const ts = Date.now();
  const filePath = `${PAGES_DIR}/${prefix}_${ts}.html`;

  // Пробуем сначала с curl (более надёжно обходит защиту)
  try {
    const cmd = new Deno.Command("curl", {
      args: [
        "-s", "-L",
        "-H", `User-Agent: ${DEFAULT_USER_AGENT}`,
        "-H", `Referer: ${referer}`,
        "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "-H", "Accept-Language: ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
        "-o", filePath,
        url,
      ],
      stdout: "null",
      stderr: "null",
    });
    const result = await cmd.output();
    if (result.code === 0) {
      const info = await Deno.stat(filePath);
      if (info.size > 100) {
        return filePath;
      }
      // файл слишком маленький — возможно блокировка
      await Deno.remove(filePath).catch(() => {});
      throw new Error("curl вернул слишком маленький файл");
    }
    throw new Error(`curl exit code: ${result.code}`);
  } catch (curlErr) {
    // Fallback: используем встроенный fetch
    console.warn(`   curl не сработал (${curlErr}), пробую fetch...`);
    const resp = await fetch(url, {
      headers: {
        "User-Agent": DEFAULT_USER_AGENT,
        "Referer": referer,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
      },
      redirect: "follow",
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} для ${url}`);
    }
    const html = await resp.text();
    await Deno.writeTextFile(filePath, html);
  }

  return filePath;
}

// ═══════════════════════════════════════════════════════════════════
// Извлечение данных из JSON-LD поисковой страницы
// ═══════════════════════════════════════════════════════════════════

interface SearchOffer {
  url: string;
  price: string;
  name: string;
  image: string;
  validFrom: string;
}

interface SearchPageResult {
  offers: SearchOffer[];
  totalCount: number;
}

/**
 * Извлекает массив offers из JSON-объекта с @graph.
 * Ожидаемая структура:
 *   { "@graph": [{ "@type": "Product", "offers": { "@type": "AggregateOffer", "offers": [...] } }] }
 */
// deno-lint-ignore no-explicit-any
function extractOffersFromGraph(data: any): SearchPageResult {
  const allOffers: SearchOffer[] = [];
  let totalCount = 0;

  const graph = data["@graph"];
  if (!Array.isArray(graph)) return { offers: allOffers, totalCount };

  for (const node of graph) {
    if (node["@type"] !== "Product") continue;
    const aggOffer = node.offers;
    if (!aggOffer || aggOffer["@type"] !== "AggregateOffer") continue;
    totalCount = aggOffer.offerCount ?? 0;
    const offers = aggOffer.offers;
    if (!Array.isArray(offers)) continue;

    for (const offer of offers) {
      if (offer["@type"] !== "Offer") continue;
      const url = String(offer.url ?? "");
      if (!url) continue;

      allOffers.push({
        url,
        price: String(offer.price ?? ""),
        name: String(offer.name ?? ""),
        image: String(offer.image ?? ""),
        validFrom: String(offer.validFrom ?? ""),
      });
    }
  }

  return { offers: allOffers, totalCount };
}

/**
 * Разархивирует экранированные символы в JSON-строке извлечённой из JSON.parse("...")
 * Обрабатывает: \\" → ", \\\\ → \\, \\n → \n, \\uXXXX → соответствующий Unicode-символ
 */
function unescapeJsonString(str: string): string {
  return str
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Рекурсивно ищет поле "payload", содержащее строку с @graph.
 * Возвращает результат extractOffersFromGraph или null.
 */
// deno-lint-ignore no-explicit-any
function findOffersInPayload(obj: any, path: string, depth: number): SearchPageResult | null {
  if (depth > 10 || !obj || typeof obj !== "object") return null;

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const result = findOffersInPayload(obj[i], `${path}[${i}]`, depth + 1);
      if (result && result.offers.length > 0) return result;
    }
    return null;
  }

  const rec = obj as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (key === "payload" && typeof rec[key] === "string" && (rec[key] as string).includes("@graph")) {
      try {
        const ld = JSON.parse(rec[key] as string);
        const result = extractOffersFromGraph(ld);
        if (result.offers.length > 0) return result;
      } catch {
        // continue searching
      }
    }
    const result = findOffersInPayload(rec[key], `${path}.${key}`, depth + 1);
    if (result && result.offers.length > 0) return result;
  }

  return null;
}

/**
 * Извлекает список объявлений из страницы Avito.
 * Пробует несколько стратегий (от наиболее современной к устаревшим):
 * 1. "schemaOrg":{"payload":"<json-string>"} внутри любого <script> (текущий формат Avito)
 * 2. <script type="application/ld+json"> с @graph (устаревший формат)
 * 3. JSON.parse("...") с полем "payload", содержащим @graph (промежуточный формат)
 */
function extractOffersFromJsonLd(html: string): SearchPageResult {
  // ── Стратегия 1: "schemaOrg":{"payload":"<json-string>"} ──
  // Ищем во всех <script> тегах
  let match;
  const scriptReAll = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  while ((match = scriptReAll.exec(html)) !== null) {
    const content = match[1];
    if (!content.includes('"schemaOrg"')) continue;

    // Извлекаем payload из schemaOrg
    // Паттерн: "schemaOrg":{"payload":"<escaped-json>"}
    const payloadRe = /"schemaOrg"\s*:\s*\{[^}]*"payload"\s*:\s*"((?:[^"\\]|\\.)*?)"\s*\}/;
    const pm = content.match(payloadRe);
    if (!pm) continue;

    try {
      const unescaped = unescapeJsonString(pm[1]);
      if (!unescaped.includes("@graph")) continue;
      const ld = JSON.parse(unescaped);
      const result = extractOffersFromGraph(ld);
      if (result.offers.length > 0) return result;
    } catch {
      // невалидный JSON — пропускаем
    }
  }

  // ── Стратегия 2: <script type="application/ld+json"> ──
  const ldRe = /<script\s+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  while ((match = ldRe.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      const result = extractOffersFromGraph(data);
      if (result.offers.length > 0) return result;
    } catch {
      // невалидный JSON — пропускаем
    }
  }

  // ── Стратегия 3: JSON.parse("...") с payload ──
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  while ((match = scriptRe.exec(html)) !== null) {
    const content = match[1];
    if (!content.includes("JSON.parse(")) continue;

    const parseRe = /JSON\.parse\s*\(\s*"((?:[^"\\]|\\.)*?)"\s*\)/g;
    let parseMatch;
    while ((parseMatch = parseRe.exec(content)) !== null) {
      try {
        const unescaped = unescapeJsonString(parseMatch[1]);
        if (!unescaped.includes("@graph")) continue;
        const data = JSON.parse(unescaped);
        const result = findOffersInPayload(data, "root", 0);
        if (result && result.offers.length > 0) return result;
      } catch {
        // невалидный JSON — пропускаем
      }
    }
  }

  return { offers: [], totalCount: 0 };
}

// ═══════════════════════════════════════════════════════════════════
// Пагинация: поиск ссылки на следующую страницу
// ═══════════════════════════════════════════════════════════════════

/**
 * Извлекает ссылку на следующую страницу из пагинации.
 * Ищет кнопку с data-marker="pagination-button/page(N)" где N > текущей страницы.
 * Приоритет: самая маленькая следующая страница (обычно +1).
 */
function extractNextPageUrl(html: string, baseUrl: string): string | null {
  const doc = new DOMParser().parseFromString(html, "text/html");

  // Ищем все ссылки пагинации
  const paginationLinks = doc.querySelectorAll('[data-marker^="pagination-button/page"]');

  if (paginationLinks.length === 0) {
    // Альтернативный поиск: <a> с классом пагинации
    const altLinks = doc.querySelectorAll("a[class*='pagination']");
    for (const link of altLinks) {
      const href = link.getAttribute("href")?.trim();
      if (href) {
        try {
          return new URL(href, baseUrl).toString();
        } catch {
          continue;
        }
      }
    }
    return null;
  }

  // Ищем текущую активную страницу
  let currentPage = 1;
  const activeEl = doc.querySelector('[data-marker^="pagination-button/page"] [aria-current="page"]');
  if (activeEl) {
    const text = activeEl.textContent?.trim();
    if (text && /^\d+$/.test(text)) {
      currentPage = parseInt(text, 10);
    }
  } else {
    // Ищем span с классом current
    const currentSpan = doc.querySelector('[class*="current"] span, [class*="active"] span');
    if (currentSpan) {
      const text = currentSpan.textContent?.trim();
      if (text && /^\d+$/.test(text)) {
        currentPage = parseInt(text, 10);
      }
    }
  }

  // Собираем все номера страниц с ссылками
  const pageLinks: Map<number, string> = new Map();
  for (const link of paginationLinks) {
    const href = link.getAttribute("href")?.trim();
    if (!href) continue;
    // извлекаем номер страницы из data-marker
    const marker = link.getAttribute("data-marker") ?? "";
    const pageMatch = marker.match(/page\((\d+)\)/);
    if (!pageMatch) continue;
    const pageNum = parseInt(pageMatch[1], 10);
    try {
      const fullUrl = new URL(href, baseUrl).toString();
      pageLinks.set(pageNum, fullUrl);
    } catch {
      continue;
    }
  }

  // Ищем страницу currentPage + 1
  const nextPage = pageLinks.get(currentPage + 1);
  if (nextPage) return nextPage;

  // Если не нашли +1 — ищем минимальную страницу > currentPage
  let minNextPage = Infinity;
  let minNextUrl: string | null = null;
  for (const [pageNum, url] of pageLinks) {
    if (pageNum > currentPage && pageNum < minNextPage) {
      minNextPage = pageNum;
      minNextUrl = url;
    }
  }

  return minNextUrl;
}

// ═══════════════════════════════════════════════════════════════════
// Извлечение __staticRouterHydrationData (новый формат Avito)
// ═══════════════════════════════════════════════════════════════════

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
function extractInitialData(html: string): any | null {
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
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
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

// deno-lint-ignore no-explicit-any
function extractBuyerItem(html: string): any | null {
  const data = extractStaticRouterData(html);
  if (!data) return null;
  const buyerItem = getByPath(data, 'loaderData["catalog-or-main-or-item"].buyerItem') ??
         getByPath(data, "loaderData.catalog-or-main-or-item.buyerItem");
  return buyerItem?.item ?? buyerItem;
}

/** Да/Нет из boolean или строки */
function yn(v: unknown): string {
  if (v === true || v === "true" || v === "да" || v === "yes") return "да";
  if (v === false || v === "false" || v === "нет" || v === "no") return "нет";
  return "";
}

// deno-lint-ignore no-explicit-any
function getParam(items: any[], titlePattern: string): string {
  if (!Array.isArray(items)) return "";
  for (const it of items) {
    if (it.title && String(it.title).toLowerCase().includes(titlePattern.toLowerCase())) {
      return String(it.description ?? it.value ?? "");
    }
  }
  return "";
}

// deno-lint-ignore no-explicit-any
function getAllParams(items: any[]): string {
  if (!Array.isArray(items)) return "";
  return items
    .map(it => {
      const title = it.title ?? "";
      const desc = it.description ?? it.value ?? "";
      return `${title}: ${desc}`;
    })
    .join(" | ");
}

// ═══════════════════════════════════════════════════════════════════
// Основной парсинг страницы объявления → CSV-запись
// ═══════════════════════════════════════════════════════════════════

/**
 * Парсит HTML страницу объявления Avito и возвращает заполненную запись
 * для CSV. Использует три источника данных (по приоритету):
 *   1. __staticRouterHydrationData (новый формат)
 *   2. __initialData__ (старый формат)
 *   3. DOM (meta-теги, data-marker атрибуты)
 */
// deno-lint-ignore no-explicit-any
function parseAdHtml(html: string, adUrl: string, offerPrice: string, offerName: string): ListingRecord {
  const record = emptyRecord("avito");

  // ── Источник 1: новый формат __staticRouterHydrationData ──
  const buyerItem = extractBuyerItem(html);
  const item: any = buyerItem?.item ?? null;

  // ── Источник 2: старый формат __initialData__ (если нового нет) ──
  const initData = !item ? extractInitialData(html) : null;
  const legacyItem: any = initData ? getByPath(initData, "ad.item") : null;

  // ── Источник 3: DOM ──
  const doc = new DOMParser().parseFromString(html, "text/html");

  // ═══════════════════════════════════════════════
  // item_id
  // ═══════════════════════════════════════════════
  record.item_id = String(
    item?.id ??
    legacyItem?.id ??
    doc?.querySelector('[data-item-id]')?.getAttribute("data-item-id") ??
    ""
  );

  // ═══════════════════════════════════════════════
  // url
  // ═══════════════════════════════════════════════
  record.url = (
    item?.canonicalUrl ??
    item?.url ??
    adUrl
  ).trim();

  // ═══════════════════════════════════════════════
  // title
  // ═══════════════════════════════════════════════
  record.title = (
    item?.title ??
    legacyItem?.title ??
    offerName ??
    doc?.querySelector('[itemprop="name"]')?.textContent ??
    doc?.head?.querySelector('meta[property="og:title"]')?.getAttribute("content") ??
    doc?.querySelector("h1")?.textContent ??
    ""
  ).trim();

  // ═══════════════════════════════════════════════
  // price
  // ═══════════════════════════════════════════════
  if (item?.formattedPrice?.value) {
    record.price = String(item.formattedPrice.value);
  } else if (item?.normalizedPrice) {
    record.price = String(item.normalizedPrice);
  } else if (item?.price && typeof item.price === "number") {
    record.price = String(item.price);
  } else if (legacyItem?.priceDetailed?.value) {
    record.price = String(legacyItem.priceDetailed.value);
  } else if (legacyItem?.price?.value) {
    record.price = String(legacyItem.price.value);
  } else if (offerPrice) {
    record.price = offerPrice;
  } else {
    const metaPrice = doc?.head?.querySelector('meta[itemprop="price"]')?.getAttribute("content");
    if (metaPrice) record.price = metaPrice;
    else {
      const priceEl = doc?.querySelector('[data-marker="item-view/item-price"]');
      if (priceEl) {
        const priceText = priceEl.textContent?.trim() ?? "";
        const numMatch = priceText.match(/([\d\s]+)/);
        if (numMatch) {
          record.price = numMatch[1].replace(/\s/g, "");
        }
      }
    }
  }

  // price_per_m2
  if (legacyItem?.priceDetailed?.pricePerM2) {
    record.price_per_m2 = String(legacyItem.priceDetailed.pricePerM2);
  } else if (item?.pricePerM2) {
    record.price_per_m2 = String(item.pricePerM2);
  }

  // ═══════════════════════════════════════════════
  // description
  // ═══════════════════════════════════════════════
  record.description = (
    item?.description ??
    legacyItem?.description ??
    doc?.querySelector('[data-marker="item-view/item-description"]')?.textContent ??
    ""
  ).trim();
  record.description_html = (
    item?.descriptionHtml ??
    legacyItem?.descriptionHtml ??
    item?.description ??
    legacyItem?.description ??
    ""
  ).trim();

  // ═══════════════════════════════════════════════
  // address
  // ═══════════════════════════════════════════════
  record.address = (
    item?.item?.address ??
    item?.geo?.address ??
    item?.address ??
    legacyItem?.address ??
    doc?.querySelector('[data-marker="item-address"]')?.textContent ??
    ""
  ).trim();

  // ═══════════════════════════════════════════════
  // Параметры квартиры из conditionParams / paramsBlock
  // ═══════════════════════════════════════════════
  const condItems: any[] = item?.conditionParams?.data?.items ??
    item?.paramsBlock?.items ?? [];

  record.rooms = getParam(condItems, "Количество комнат") ||
    getParam(condItems, "Комнат") || getParam(condItems, "rooms");
  record.total_area = getParam(condItems, "Общая площадь") ||
    getParam(condItems, "Площадь") || getParam(condItems, "area");
  record.kitchen_area = getParam(condItems, "Площадь кухни") ||
    getParam(condItems, "Кухня") || getParam(condItems, "kitchen");
  record.living_area = getParam(condItems, "Жилая площадь") ||
    getParam(condItems, "living");
  record.floor = getParam(condItems, "Этаж") ||
    getParam(condItems, "floor");
  record.floors_total = getParam(condItems, "Этажей в доме") ||
    getParam(condItems, "Этажность") || getParam(condItems, "floors");
  record.balcony = getParam(condItems, "Балкон") ||
    getParam(condItems, "Лоджия") || getParam(condItems, "balcony");
  record.room_type = getParam(condItems, "Тип комнат") ||
    getParam(condItems, "room_type");
  record.bathroom = getParam(condItems, "Санузел") ||
    getParam(condItems, "bathroom");
  record.windows = getParam(condItems, "Окна") ||
    getParam(condItems, "windows");
  record.renovation = getParam(condItems, "Ремонт") ||
    getParam(condItems, "Состояние") || getParam(condItems, "renovation");
  record.furniture = getParam(condItems, "Мебель") ||
    getParam(condItems, "furniture");
  record.is_furnished = yn(
    getParam(condItems, "Меблирована") || getParam(condItems, "Мебель") || getParam(condItems, "furnished")
  );

  // Параметры дома из houseParams
  const houseItems: any[] = item?.houseParams?.data?.items ?? [];
  record.house_type = getParam(houseItems, "Тип дома") ||
    getParam(houseItems, "building_type") || record.house_type;
  record.build_year = getParam(houseItems, "Год постройки") ||
    getParam(houseItems, "build_year") || record.build_year;
  record.floors_total = getParam(houseItems, "Этажей в доме") ||
    getParam(houseItems, "floors_total") || record.floors_total;
  record.passenger_elevator = getParam(houseItems, "Пассажирский лифт") ||
    getParam(houseItems, "elevator") || record.passenger_elevator;
  record.freight_elevator = getParam(houseItems, "Грузовой лифт") ||
    getParam(houseItems, "freight") || record.freight_elevator;
  record.parking = getParam(houseItems, "Парковка") ||
    getParam(houseItems, "parking") || record.parking;

  // ═══════════════════════════════════════════════
  // Продавец
  // ═══════════════════════════════════════════════
  record.seller_name = (
    item?.shop?.name ??
    item?.seller?.name ??
    legacyItem?.seller?.name ??
    ""
  ).trim();
  record.seller_type = (
    item?.shop?.isShop ? "Магазин" : (item?.seller?.type ?? legacyItem?.seller?.type ?? "")
  ).trim();
  record.seller_contact_person = (
    item?.publicProfileInfo?.sellerName ??
    legacyItem?.seller?.contactPerson ?? ""
  ).trim();
  record.is_agency = yn(
    item?.shop?.isShop ??
    legacyItem?.seller?.isAgency ??
    legacyItem?.seller?.is_agency ??
    legacyItem?.isAgency
  );
  record.seller_id = String(
    item?.userId ??
    item?.shop?.id ??
    legacyItem?.seller?.id ?? ""
  );
  record.seller_link = (
    item?.shopLink ??
    item?.shop?.profileUrl ??
    ""
  ).trim();
  record.seller_avatar = (
    item?.seller?.avatar ??
    item?.shop?.logo ??
    ""
  ).trim();

  // ═══════════════════════════════════════════════
  // Статус объявления
  // ═══════════════════════════════════════════════
  record.is_active = yn(item?.isActive ?? legacyItem?.isActive ?? true);
  record.is_favorite = yn(item?.isFavorite ?? legacyItem?.isFavorite ?? false);

  // ═══════════════════════════════════════════════
  // Телефон
  // ═══════════════════════════════════════════════
  record.phone_number = (
    item?.phone?.mask ??
    item?.phone?.publicPhone ??
    legacyItem?.phone ??
    legacyItem?.contacts?.phone ??
    ""
  ).trim();

  // ═══════════════════════════════════════════════
  // Мессенджеры
  // ═══════════════════════════════════════════════
  const isMsgEnabled = item?.flags?.isMessageEnabled ?? false;
  if (isMsgEnabled) {
    record.messenger_availability = "да";
  } else {
    const msgBtn = doc.querySelector('[data-marker="item-chat"]') ??
                   doc.querySelector('[data-marker="chat-button"]');
    record.messenger_availability = msgBtn ? "да" : "";
  }

  // ═══════════════════════════════════════════════
  // Дата размещения
  // ═══════════════════════════════════════════════
  record.listing_date = (
    item?.sortFormatedDate ??
    item?.publicationDate ??
    legacyItem?.publicationDate ??
    legacyItem?.created ??
    doc?.querySelector('[data-marker="item-view/item-date"]')?.textContent ??
    ""
  ).trim();

  // ═══════════════════════════════════════════════
  // Просмотры
  // ═══════════════════════════════════════════════
  if (item?.views !== undefined && item?.views !== null) {
    record.views_total = String(item.views);
  } else if (legacyItem?.views !== undefined && legacyItem?.views !== null) {
    record.views_total = String(legacyItem.views);
  } else {
    const viewsEl = doc.querySelector('[data-marker="item-view/total-views"]');
    if (viewsEl) record.views_total = viewsEl.textContent?.trim() ?? "";
  }

  if (item?.viewsToday !== undefined && item?.viewsToday !== null) {
    record.views_today = String(item.viewsToday);
  } else if (legacyItem?.viewsToday !== undefined && legacyItem?.viewsToday !== null) {
    record.views_today = String(legacyItem.viewsToday);
  } else {
    const viewsTodayEl = doc.querySelector('[data-marker="item-view/today-views"]');
    if (viewsTodayEl) record.views_today = viewsTodayEl.textContent?.trim() ?? "";
  }

  // ═══════════════════════════════════════════════
  // Изображения
  // ═══════════════════════════════════════════════
  const photos: string[] = [];

  if (Array.isArray(item?.imageUrls)) {
    for (const img of item.imageUrls) {
      if (typeof img === "string") {
        photos.push(img);
      } else if (img && typeof img === "object" && img.url) {
        photos.push(String(img.url));
      } else if (img && typeof img === "object") {
        const firstUrl = Object.values(img)[0];
        if (firstUrl) photos.push(String(firstUrl));
      }
    }
  }

  if (photos.length === 0 && Array.isArray(legacyItem?.images)) {
    for (const img of legacyItem.images) {
      if (typeof img === "string") photos.push(img);
      else if (img?.url) photos.push(String(img.url));
    }
  }

  if (photos.length === 0 && item?.listingImageUrl) {
    photos.push(String(item.listingImageUrl));
  }

  record.images_count = String(photos.length);
  record.main_image_url = photos[0] ?? "";
  record.image_urls = photos.join(" | ");

  // ═══════════════════════════════════════════════
  // Гео
  // ═══════════════════════════════════════════════
  const lat = item?.geo?.coords?.lat ??
    item?.item?.geo?.coords?.lat ??
    legacyItem?.coords?.lat ??
    legacyItem?.geo?.lat;
  if (lat !== undefined && lat !== null) record.latitude = String(lat);

  const lng = item?.geo?.coords?.lng ??
    item?.item?.geo?.coords?.lng ??
    legacyItem?.coords?.lng ??
    legacyItem?.geo?.lng;
  if (lng !== undefined && lng !== null) record.longitude = String(lng);

  // Гео-ссылки (метро и т.д.)
  const refs: string[] = [];
  if (Array.isArray(item?.geo?.references)) {
    for (const ref of item.geo.references) {
      if (ref?.name) refs.push(ref.name);
    }
  } else if (Array.isArray(legacyItem?.metro)) {
    for (const m of legacyItem.metro) {
      if (m?.name) refs.push(m.name);
    }
  }
  record.geo_references = refs.join(" | ");

  // ═══════════════════════════════════════════════
  // Онлайн-показ (badgeBar)
  // ═══════════════════════════════════════════════
  if (Array.isArray(item?.badgeBar)) {
    for (const badge of item.badgeBar) {
      if (badge?.option === "2360" || badge?.id === "2360") {
        record.is_online_view = "да";
        break;
      }
    }
  }
  // DOM fallback
  if (record.is_online_view !== "да") {
    const onlineBadge = doc.querySelector('[data-marker="badgeBar/option/2360"]');
    if (onlineBadge) record.is_online_view = "да";
  }

  // ═══════════════════════════════════════════════
  // Ипотека
  // ═══════════════════════════════════════════════
  const mortgageItems: any[] = item?.mortgageParams?.data?.items ??
    legacyItem?.mortgage?.items ?? [];
  record.is_mortgage_possible = yn(
    getParam(mortgageItems, "Ипотека") || getParam(mortgageItems, "mortgage")
  );
  record.mortgage_payment = getParam(mortgageItems, "Платёж") ||
    getParam(mortgageItems, "payment");
  record.mortgage_rate = getParam(mortgageItems, "Ставка") ||
    getParam(mortgageItems, "rate");
  record.mortgage_income = getParam(mortgageItems, "Доход") ||
    getParam(mortgageItems, "income");

  // ═══════════════════════════════════════════════
  // Сделка
  // ═══════════════════════════════════════════════
  const rentItems: any[] = item?.rentTermsParams?.data?.items ?? [];
  record.sale_method = getParam(rentItems, "Способ продажи") ||
    getParam(rentItems, "sale_method");
  record.sale_terms = getParam(rentItems, "Условия") ||
    getParam(rentItems, "sale_terms");

  // ═══════════════════════════════════════════════
  // Дополнительные поля
  // ═══════════════════════════════════════════════

  // Хлебные крошки
  if (Array.isArray(item?.breadcrumbs)) {
    record.breadcrumbs = item.breadcrumbs
      .map((b: any) => b?.name ?? "")
      .filter(Boolean)
      .join(" > ");
  } else if (Array.isArray(legacyItem?.breadcrumbs)) {
    record.breadcrumbs = legacyItem.breadcrumbs
      .map((b: any) => b?.name ?? b?.title ?? "")
      .filter(Boolean)
      .join(" > ");
  }

  // SEO теги
  if (Array.isArray(item?.seoTags)) {
    record.seo_tags = item.seoTags
      .map((t: any) => t?.title ?? "")
      .filter(Boolean)
      .join(" | ");
  } else if (Array.isArray(legacyItem?.seoTags)) {
    record.seo_tags = legacyItem.seoTags
      .map((t: any) => t?.title ?? t?.name ?? "")
      .filter(Boolean)
      .join(" | ");
  }

  // USPs (преимущества)
  if (Array.isArray(item?.realtyUSP?.list)) {
    record.usps = item.realtyUSP.list
      .map((u: any) => u?.title ?? "")
      .filter(Boolean)
      .join(" | ");
  }

  // Информация о застройщике
  if (item?.developerV2) {
    const dev = item.developerV2;
    record.developer_description = dev?.description ?? "";
    const devItems: string[] = [];
    if (Array.isArray(dev?.items)) {
      for (const di of dev.items) {
        devItems.push(`${di?.title ?? ""}: ${di?.description ?? ""}`);
      }
    }
    record.developer_items = devItems.join(" | ");
    record.developer_trust = dev?.trustCard?.title ?? "";
  }

  // Все параметры скопом (для отладки)
  if (condItems.length > 0) {
    record.all_params = getAllParams(condItems);
  }
  if (houseItems.length > 0) {
    record.all_house_params = getAllParams(houseItems);
  }

  // ═══════════════════════════════════════════════
  // Мета
  // ═══════════════════════════════════════════════
  record.parsed_at = new Date().toISOString();

  return record;
}

// ═══════════════════════════════════════════════════════════════════
// Удаление временного файла
// ═══════════════════════════════════════════════════════════════════

async function removeTempFile(filePath: string, silent = false) {
  try {
    await Deno.remove(filePath);
    if (!silent) console.log(`   🗑 Удалён: ${filePath}`);
  } catch {
    // файл мог быть уже удалён
  }
}

// ═══════════════════════════════════════════════════════════════════
// Главная функция
// ═══════════════════════════════════════════════════════════════════

async function main() {
  // ── Разбор аргументов ──
  const args = Deno.args;

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║           Avito Parser → CSV (разделитель ";")              ║
╠══════════════════════════════════════════════════════════════╣
║                                                            ║
║  Использование:                                            ║
║    deno task parse-avito "<URL поиска>"                    ║
║                                                            ║
║  Пример:                                                   ║
║    deno task parse-avito "https://www.avito.ru/moskva_i_mo/║
║      kvartiry/prodam-ASgBAgICAUSSA8YQ"                    ║
║                                                            ║
║  Как получить URL поиска:                                  ║
║    1. Откройте avito.ru                                   ║
║    2. Выберите категорию (например, Квартиры → Продам)     ║
║    3. Настройте фильтры                                   ║
║    4. Скопируйте URL из адресной строки браузера           ║
║    5. Передайте URL в команду выше                        ║
║                                                            ║
║  Результат:                                                ║
║    CSV-файл в ./output/avito_listings.csv                  ║
║    Разделитель: ";"                                       ║
║                                                            ║
║  Требования:                                               ║
║    - Deno 2+ (https://deno.com)                           ║
║    - curl (обычно уже установлен)                          ║
║                                                            ║
╚══════════════════════════════════════════════════════════════╝
`);
    Deno.exit(0);
  }

  const searchUrl = args[0];

  // Валидация URL
  try {
    new URL(searchUrl);
  } catch {
    console.error("❌ Ошибка: невалидный URL.");
    console.error(`   Получено: "${searchUrl}"`);
    Deno.exit(1);
  }

  console.log("╔══════════════════════════════════════════════╗");
  console.log("║   Avito Parser → CSV                         ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`\n🔍 Начинаю обработку: ${searchUrl}\n`);

  // Создаём папки
  await Deno.mkdir(PAGES_DIR, { recursive: true });
  await Deno.mkdir("./output", { recursive: true });

  let currentUrl = searchUrl;
  let pageNum = 1;
  let totalProcessed = 0;
  const batch: ListingRecord[] = [];
  const BATCH_SIZE = 10; // сбрасываем в CSV каждые 10 объявлений

  while (currentUrl) {
    console.log(`\n📄 Поисковая страница ${pageNum}`);
    console.log(`   URL: ${currentUrl}`);

    // 1. Скачиваем поисковую страницу
    let searchFilePath: string;
    try {
      searchFilePath = await downloadToFile(currentUrl, `search_p${pageNum}`, "https://www.avito.ru/");
      console.log(`   Сохранено: ${searchFilePath}`);
    } catch (err) {
      console.error(`   ❌ Не удалось скачать поисковую страницу: ${err}`);
      break;
    }

    // 2. Читаем и парсим JSON-LD
    let html: string;
    try {
      html = await Deno.readTextFile(searchFilePath);
    } catch (err) {
      console.error(`   ❌ Не удалось прочитать файл: ${err}`);
      await removeTempFile(searchFilePath, true);
      break;
    }

    const searchResult = extractOffersFromJsonLd(html);
    console.log(`   📋 Найдено объявлений: ${searchResult.offers.length}`);

    if (searchResult.offers.length === 0) {
      console.log("   ⚠️ Объявлений не найдено — возможно, страница пуста или изменился формат.");
      console.log(`   💾 Отладочный HTML сохранён: ${searchFilePath}`);

      // Пробуем найти следующую страницу
      const nextUrl = extractNextPageUrl(html, currentUrl);
      if (nextUrl && nextUrl !== currentUrl) {
        currentUrl = nextUrl;
        pageNum++;
        continue;
      }
      break;
    }

    // 3. Обрабатываем каждое объявление
    for (let i = 0; i < searchResult.offers.length; i++) {
      const offer = searchResult.offers[i];
      console.log(`\n   📝 Объявление ${i + 1}/${searchResult.offers.length}`);
      console.log(`      URL: ${offer.url}`);

      let adFilePath: string;
      try {
        // Задержка перед загрузкой (антибот)
        if (i > 0) {
          const delay = adDelayMs();
          console.log(`      ⏳ Пауза ${Math.round(delay / 1000)}с...`);
          await new Promise((r) => setTimeout(r, delay));
        }

        adFilePath = await downloadToFile(offer.url, `ad_${offer.url.split("/").pop()?.split("?")[0]?.slice(0, 30)}`, currentUrl);
        console.log(`      💾 Сохранено: ${adFilePath}`);
      } catch (err) {
        console.error(`      ❌ Не удалось скачать объявление: ${err}`);
        // Записываем хотя бы то, что знаем из поисковой страницы
        const minimalRecord = emptyRecord("avito");
        minimalRecord.item_id = offer.url.split("_").pop()?.replace(/\D/g, "") ?? "";
        minimalRecord.url = offer.url;
        minimalRecord.price = offer.price;
        minimalRecord.title = offer.name;
        minimalRecord.main_image_url = offer.image;
        batch.push(minimalRecord);
        continue;
      }

      let adHtml: string;
      try {
        adHtml = await Deno.readTextFile(adFilePath);
      } catch (err) {
        console.error(`      ❌ Не удалось прочитать файл объявления: ${err}`);
        const minimalRecord = emptyRecord("avito");
        minimalRecord.item_id = offer.url.split("_").pop()?.replace(/\D/g, "") ?? "";
        minimalRecord.url = offer.url;
        minimalRecord.price = offer.price;
        minimalRecord.title = offer.name;
        minimalRecord.main_image_url = offer.image;
        batch.push(minimalRecord);
        await removeTempFile(adFilePath, true);
        continue;
      }

      // 4. Парсим объявление
      let record: ListingRecord;
      try {
        record = parseAdHtml(adHtml, offer.url, offer.price, offer.name);
        console.log(`      ✅ Заголовок: ${record.title.slice(0, 80)}`);
        console.log(`      💰 Цена: ${record.price}`);
      } catch (err) {
        console.error(`      ❌ Ошибка парсинга: ${err}`);
        const minimalRecord = emptyRecord("avito");
        minimalRecord.item_id = offer.url.split("_").pop()?.replace(/\D/g, "") ?? "";
        minimalRecord.url = offer.url;
        minimalRecord.price = offer.price;
        minimalRecord.title = offer.name;
        minimalRecord.main_image_url = offer.image;
        record = minimalRecord;
      }

      batch.push(record);
      totalProcessed++;

      // 5. Удаляем временный файл объявления
      await removeTempFile(adFilePath, true);

      // Сбрасываем в CSV когда накопилось BATCH_SIZE
      if (batch.length >= BATCH_SIZE) {
        await appendToCsv("avito_listings.csv", batch.splice(0));
      }
    }

    // Сбрасываем оставшиеся записи
    if (batch.length > 0) {
      await appendToCsv("avito_listings.csv", batch.splice(0));
    }

    // 6. Ищем следующую поисковую страницу
    const nextUrl = extractNextPageUrl(html, currentUrl);

    // 7. Удаляем текущую поисковую страницу
    await removeTempFile(searchFilePath, true);

    if (nextUrl && nextUrl !== currentUrl) {
      console.log(`\n   ➡️ Найдена следующая страница: ${nextUrl}`);
      currentUrl = nextUrl;
      pageNum++;

      // Задержка перед следующей поисковой страницей
      console.log(`   ⏳ Пауза ${PAGE_DELAY_MS / 1000}с...`);
      await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
    } else {
      console.log("\n   🏁 Пагинация закончилась — все страницы обработаны.");
      break;
    }
  }

  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║   Готово!                                    ║`);
  console.log(`║   Всего обработано объявлений: ${String(totalProcessed).padStart(4)}           ║`);
  console.log(`║   Результат: ./output/avito_listings.csv     ║`);
  console.log(`╚══════════════════════════════════════════════╝`);
}

// ── Запуск ──
main().catch((err) => {
  console.error("💥 Критическая ошибка:", err);
  Deno.exit(1);
});