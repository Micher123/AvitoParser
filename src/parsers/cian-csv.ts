/**
 * Парсер Циан → CSV (45 полей)
 *
 * Требуется: переменная CIAN_SEARCH_COOKIE в .env и настройки
 * поиска в conf/conf.yml (создаётся автоматически при первом запуске).
 *
 * Если cookie не задан — парсер предложит прочитать готовые JSON-файлы
 * из директории, переданной аргументом.
 *
 * Использование:
 *   deno task parse-cian
 *   deno task parse-cian /путь/к/json-export
 */
import { spyFetch } from "#utils/spyFetch.ts";
import { pooledMap } from "@std/async";
import { join } from "@std/path";
import { appendToCsv, emptyRecord, type ListingRecord } from "../csv-writer.ts";

const CSV_FILE = "cian_listings.csv";

// ---------- типы API-ответа Циан ----------
interface CianSearchOfferResponse {
  id?: number;
  fullUrl?: string;
  exportPdfLink?: string;
  description?: string;
  title?: string;
  photos?: { fullUrl: string }[];
  geo?: {
    userInput?: string;
    coordinates?: { lat: number; lng: number };
    address?: string;
  };
  bargainTerms?: {
    price?: number;
    priceRur?: number;
    pricePerMeter?: number;
    saleTerms?: string;
    saleMethod?: string;
    isAuction?: boolean;
  };
  building?: {
    name?: string;
    buildYear?: number;
    series?: string;
    floorsCount?: number;
    passengerLiftsCount?: number;
    freightLiftsCount?: number;
    parking?: string;
    hasFreightLift?: boolean;
    hasPassengerLift?: boolean;
  };
  flat?: {
    rooms?: number;
    area?: number;
    kitchenArea?: number;
    livingArea?: number;
    floor?: number;
    balcony?: string;
    roomType?: string;
    bathroom?: string;
    windows?: string;
    renovation?: string;
    furniture?: string;
    isFurnished?: boolean;
  };
  seller?: {
    name?: string;
    type?: string;
    contactPerson?: string;
    isAgency?: boolean;
    phone?: string;
  };
  chat?: {
    messengerEnabled?: boolean;
  };
  date?: string;
  publicationDate?: string;
  views?: number;
  viewsToday?: number;
  isOnlineView?: boolean;
  isByHomeowner?: boolean;
  mortgageInfo?: {
    isPossible?: boolean;
    payment?: number;
    rate?: number;
    income?: number;
  };
  mapInfo?: {
    latitude?: number;
    longitude?: number;
    zoom?: number;
  };
}

interface CianJsonExport {
  offers?: CianSearchOfferResponse[];
}

/** Да/Нет из boolean */
function yn(v: unknown): string {
  if (v === true || v === "true" || v === "да" || v === "yes") return "да";
  if (v === false || v === "false" || v === "нет" || v === "no") return "нет";
  return "";
}

function s(v: unknown): string {
  return v !== null && v !== undefined ? String(v) : "";
}

/** Конвертация CianSearchOfferResponse → ListingRecord (45 полей) */
function offerToRecord(offer: CianSearchOfferResponse): ListingRecord {
  const record = emptyRecord("cian");

  // ID
  record.item_id = s(offer.id);

  // Title: пробуем title, иначе description
  record.title = (offer.title ?? offer.description ?? "").trim();

  // Price
  if (offer.bargainTerms?.priceRur) {
    record.price = String(offer.bargainTerms.priceRur);
  } else if (offer.bargainTerms?.price) {
    record.price = String(offer.bargainTerms.price);
  }

  // Price per m2
  if (offer.bargainTerms?.pricePerMeter !== undefined) {
    record.price_per_m2 = String(offer.bargainTerms.pricePerMeter);
  }

  // Description
  record.description = (offer.description ?? "").trim();
  record.description_html = ""; // Циан API не даёт HTML

  // Address
  record.address = (
    offer.geo?.userInput ??
    offer.geo?.address ??
    ""
  ).trim();

  // Flat params
  record.rooms = s(offer.flat?.rooms);
  record.total_area = s(offer.flat?.area);
  record.kitchen_area = s(offer.flat?.kitchenArea);
  record.living_area = s(offer.flat?.livingArea);
  record.floor = s(offer.flat?.floor);
  record.floors_total = s(offer.building?.floorsCount);
  record.balcony = s(offer.flat?.balcony);
  record.room_type = s(offer.flat?.roomType);
  record.bathroom = s(offer.flat?.bathroom);
  record.windows = s(offer.flat?.windows);
  record.renovation = s(offer.flat?.renovation);
  record.furniture = s(offer.flat?.furniture);
  record.is_furnished = yn(offer.flat?.isFurnished);

  // Building
  record.house_type = s(offer.building?.series ?? offer.building?.name);
  record.build_year = s(offer.building?.buildYear);
  record.passenger_elevator = s(offer.building?.passengerLiftsCount ?? (offer.building?.hasPassengerLift ? "1" : ""));
  record.freight_elevator = s(offer.building?.freightLiftsCount ?? (offer.building?.hasFreightLift ? "1" : ""));
  record.parking = s(offer.building?.parking);

  // Seller
  record.seller_name = s(offer.seller?.name);
  record.seller_type = s(offer.seller?.type);
  record.seller_contact_person = s(offer.seller?.contactPerson);
  record.is_agency = yn(offer.seller?.isAgency ?? !offer.isByHomeowner);
  record.phone_number = s(offer.seller?.phone);

  // Messenger
  record.messenger_availability = yn(offer.chat?.messengerEnabled);

  // Sale
  record.sale_method = s(offer.bargainTerms?.saleMethod);
  record.sale_terms = s(offer.bargainTerms?.saleTerms);

  // Mortgage
  record.is_mortgage_possible = yn(offer.mortgageInfo?.isPossible);
  if (offer.mortgageInfo) {
    record.mortgage_payment = s(offer.mortgageInfo.payment);
    record.mortgage_rate = s(offer.mortgageInfo.rate);
    record.mortgage_income = s(offer.mortgageInfo.income);
  }

  // Dates
  record.listing_date = s(offer.publicationDate ?? offer.date);

  // Views
  record.views_total = s(offer.views);
  record.views_today = s(offer.viewsToday);

  // Images
  if (offer.photos && offer.photos.length > 0) {
    const imageUrls = offer.photos.map((p) => p.fullUrl);
    record.images_count = String(imageUrls.length);
    record.image_urls = imageUrls.join(", ");
    record.main_image_url = imageUrls[0];
  }

  // Geo
  record.latitude = s(offer.geo?.coordinates?.lat ?? offer.mapInfo?.latitude);
  record.longitude = s(offer.geo?.coordinates?.lng ?? offer.mapInfo?.longitude);
  record.map_zoom = s(offer.mapInfo?.zoom);

  // Online view
  record.is_online_view = yn(offer.isOnlineView);

  record.parsed_at = new Date().toISOString();

  return record;
}

// ---------- работа с API ----------
import { CIAN_SEARCH_COOKIE } from "#env";
import { Config } from "#config";

async function fetchFromApi(): Promise<CianSearchOfferResponse[]> {
  if (!CIAN_SEARCH_COOKIE) {
    throw new Error("NO_COOKIE");
  }

  const config = (await Config.get()).cianSearch;

  const ads: CianSearchOfferResponse[] = [];
  let currentPage = 1;
  let totalOffers: number | null = null;

  while (true) {
    const body = {
      _type: "flatrent",
      engine_version: { type: "term", value: 2 },
      currency: { type: "term", value: 2 },
      wp: { type: "term", value: true },
      for_day: { type: "term", value: "!1" },
      price: {
        type: "range",
        value: { lte: config.maxPrice, gte: config.minPrice },
      },
      geo: {
        type: "geo",
        value: config.geo.map((id: number) => ({ type: "district", id })),
      },
      region: { type: "terms", value: config.regions },
      sort: { type: "term", value: "total_price_desc" },
      page: { type: "term", value: currentPage },
    };

    console.log(`Страница ${currentPage}...`);

    const resp = await spyFetch(
      "https://api.cian.ru/lk-specialist/v1/search-offers/",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: CIAN_SEARCH_COOKIE,
        },
        body: JSON.stringify(body),
      },
    );

    const json = await resp.json();

    if (!resp.ok) {
      console.error(`  HTTP ${resp.status}:`, JSON.stringify(json).slice(0, 300));
      throw new Error(`API вернул ошибку ${resp.status}`);
    }

    const offers = (json.data?.offersSerialized ??
      json.offersSerialized ??
      []) as CianSearchOfferResponse[];

    // Определяем total на первой странице
    if (totalOffers === null) {
      totalOffers = json.data?.totalOffers ??
        json.totalOffers ??
        json.data?.total ??
        json.total ??
        0;
      console.log(`  Всего объявлений: ${totalOffers}`);
    }

    if (!offers.length) {
      console.log(`  Пусто — стоп.`);
      break;
    }

    ads.push(...offers);
    console.log(`  +${offers.length} объявлений (всего ${ads.length})`);

    // Проверяем, не превысили ли total
    if (totalOffers != null && totalOffers > 0 && ads.length >= totalOffers) break;
    // Если пришло меньше 28 объявлений — последняя страница
    if (offers.length < 28) break;
    // Страховка от бесконечного цикла
    if (currentPage > 200) break;

    currentPage++;

    // Задержка между запросами
    await new Promise((r) => setTimeout(r, 1000));
  }

  return ads;
}

// ---------- работа с JSON-файлами ----------
async function readFromDirectory(dirPath: string): Promise<CianSearchOfferResponse[]> {
  const stat = await Deno.stat(dirPath);
  if (!stat.isDirectory) throw new Error(`"${dirPath}" не является директорией`);

  const ads: CianSearchOfferResponse[] = [];

  for (const entry of Deno.readDirSync(dirPath)) {
    if (!entry.isFile || !entry.name.endsWith(".json")) continue;
    const text = await Deno.readTextFile(join(dirPath, entry.name));
    try {
      const parsed: CianJsonExport = JSON.parse(text);
      if (Array.isArray(parsed)) {
        ads.push(...parsed as unknown as CianSearchOfferResponse[]);
      } else if (parsed.offers) {
        ads.push(...parsed.offers);
      }
    } catch {
      console.error(`Пропускаю ${entry.name} — невалидный JSON`);
    }
  }

  return ads;
}

// ---------- main ----------
async function main() {
  let ads_raw: CianSearchOfferResponse[] = [];

  // Пробуем сначала API
  try {
    ads_raw = await fetchFromApi();
    console.log(`\nПолучено ${ads_raw.length} объявлений через API Циан.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "NO_COOKIE") {
      // Пробуем читать из папки
      const dirPath = Deno.args[0];
      if (!dirPath) {
        console.error("Не задана переменная CIAN_SEARCH_COOKIE в .env файле.");
        console.error("   Либо укажите путь к папке с JSON-файлами Циан:");
        console.error("     deno task parse-cian /путь/к/json-export");
        Deno.exit(1);
      }
      try {
        ads_raw = await readFromDirectory(dirPath);
      } catch (dirErr) {
        console.error(`${dirErr instanceof Error ? dirErr.message : String(dirErr)}`);
        Deno.exit(1);
      }
    } else {
      console.error(`Ошибка API: ${msg}`);
      Deno.exit(1);
    }
  }

  if (!ads_raw.length) {
    console.error("Не найдено ни одного объявления Циан.");
    Deno.exit(1);
  }

  console.log(`Запускаю обработку ${ads_raw.length} объявлений...\n`);

  let processed = 0;
  let failed = 0;

  await Array.fromAsync(
    pooledMap(3, ads_raw, async (offer: CianSearchOfferResponse) => {
      try {
        const record = offerToRecord(offer);
        await appendToCsv(CSV_FILE, [record]);
        processed++;
        console.log(`[${processed}/${ads_raw.length}] ${record.title}`);
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Ошибка при обработке ${offer.fullUrl}: ${msg}`);
      }
    }),
  );

  console.log(`\nГотово! Обработано: ${processed}, ошибок: ${failed}`);
  console.log(`Результат сохранён в output/${CSV_FILE}`);
}

if (import.meta.main) {
  await main();
}