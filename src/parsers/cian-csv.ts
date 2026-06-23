/**
 * Парсер Циан → CSV (без AI)
 *
 * Подключается к API Циан (через cookie агента),
 * собирает объявления и пишет результат в CSV с разделителем ";".
 *
 * Требуется: cookie сессия cian.ru (CIAN_SEARCH_COOKIE) и настройки
 * поиска в conf/conf.yml.
 *
 * Если cookie не задан — парсер предложит прочитать готовые JSON-файлы
 * из директории, переданной аргументом.
 *
 * Использование:
 *   deno run --allow-all --env-file=.env src/parsers/cian-csv.ts
 *   deno run --allow-all src/parsers/cian-csv.ts /путь/к/json-export
 */
import { spyFetch } from "#utils/spyFetch.ts";
import { pooledMap } from "@std/async";
import { join } from "@std/path";
import { appendToCsv, type ListingRecord } from "../csv-writer.ts";

const CSV_FILE = "cian_listings.csv";

// ---------- типы API-ответа Циан ----------
interface CianSearchOfferResponse {
  fullUrl: string;
  exportPdfLink: string;
  description: string;
  photos: { fullUrl: string }[];
  geo: { userInput: string; coordinates?: { lat: number; lng: number } };
}

interface CianJsonExport {
  offers?: CianSearchOfferResponse[];
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
  let currentPage = 0;

  while (true) {
    currentPage++;

    const json = await spyFetch(
      "https://api.cian.ru/lk-specialist/v1/search-offers/",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: CIAN_SEARCH_COOKIE,
        },
        body: JSON.stringify({
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
        }),
      },
    ).then((resp) => resp.json());

    const offers = json.data?.offersSerialized as CianSearchOfferResponse[];
    if (!offers?.length) break;
    ads.push(...offers);
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
      console.error(`⚠️  Пропускаю ${entry.name} — невалидный JSON`);
    }
  }

  return ads;
}

// ---------- main ----------
async function main() {
  let ads: CianSearchOfferResponse[] = [];

  // Пробуем сначала API
  try {
    ads = await fetchFromApi();
    console.log("🔍 Получаю объявления через API Циан...");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "NO_COOKIE") {
      // Пробуем читать из папки
      const dirPath = Deno.args[0];
      if (!dirPath) {
        console.error("❌ Не задана переменная CIAN_SEARCH_COOKIE в .env файле.");
        console.error("   Либо укажите путь к папке с JSON-файлами Циан:");
        console.error("     deno task parse-cian /путь/к/json-export");
        Deno.exit(1);
      }
      try {
        ads = await readFromDirectory(dirPath);
      } catch (dirErr) {
        console.error(`❌ ${dirErr instanceof Error ? dirErr.message : String(dirErr)}`);
        Deno.exit(1);
      }
    } else {
      throw err;
    }
  }

  if (!ads.length) {
    console.error("❌ Не найдено ни одного объявления.");
    Deno.exit(1);
  }

  console.log(`🔍 Найдено ${ads.length} объявлений Циан. Запускаю обработку...\n`);

  let processed = 0;
  let failed = 0;

  await Array.fromAsync(
    pooledMap(3, ads, async (offer: CianSearchOfferResponse) => {
      try {
        const record: ListingRecord = {
          source: "cian",
          url: offer.fullUrl,
          title: offer.description || "N/A",
          address: offer.geo.userInput || "N/A",
          description: offer.description || "",
          rating: "",
          operators: "",
          routes: "",
          images: offer.photos?.map((p) => p.fullUrl).join(", ") ?? "",
          lat: offer.geo.coordinates?.lat ?? 0,
          lon: offer.geo.coordinates?.lng ?? 0,
          parsedAt: new Date().toISOString(),
        };

        await appendToCsv(CSV_FILE, [record]);

        processed++;
        console.log(`✅ [${processed}/${ads.length}] ${record.title}`);
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`❌ Ошибка при обработке ${offer.fullUrl}: ${msg}`);
      }
    }),
  );

  console.log(`\n📊 Готово! Обработано: ${processed}, ошибок: ${failed}`);
  console.log(`📁 Результат сохранён в output/${CSV_FILE}`);
}

if (import.meta.main) {
  await main();
}