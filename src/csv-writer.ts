/**
 * Утилита для записи CSV-файлов с разделителем ";".
 * Поддерживает дозапись в существующий файл и создание нового с заголовками.
 */
import { ensureDir } from "@std/fs";
import { join } from "@std/path";

const OUTPUT_DIR = "./output";

/** Экранирует значение для CSV: оборачивает в кавычки при наличии ";", кавычек или переносов строк */
function escapeCsvValue(value: unknown): string {
  const str = String(value ?? "");
  if (str.includes(";") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

/** Преобразует массив значений в строку CSV */
function toCsvLine(values: unknown[]): string {
  return values.map(escapeCsvValue).join(";") + "\n";
}

/** Интерфейс одной записи объявления для CSV */
export interface ListingRecord {
  source: "avito" | "cian";
  url: string;
  title: string;
  address: string;
  description: string;
  price?: string;
  rating: string;
  operators: string;
  routes: string;
  images: string;
  lat: number;
  lon: number;
  parsedAt: string;
}

const CSV_HEADERS = [
  "source",
  "url",
  "title",
  "address",
  "description",
  "price",
  "rating",
  "operators",
  "routes",
  "images",
  "lat",
  "lon",
  "parsedAt",
];

/**
 * Записывает массив объявлений в CSV-файл.
 * Если файл не существует — создаёт с заголовками.
 * Если существует — дозаписывает строки.
 */
export async function appendToCsv(filename: string, records: ListingRecord[]): Promise<void> {
  await ensureDir(OUTPUT_DIR);
  const filepath = join(OUTPUT_DIR, filename);

  let fileExists = false;
  try {
    await Deno.stat(filepath);
    fileExists = true;
  } catch {
    // файл не существует
  }

  const lines: string[] = [];

  if (!fileExists) {
    lines.push(toCsvLine(CSV_HEADERS));
  }

  for (const record of records) {
    lines.push(toCsvLine([
      record.source,
      record.url,
      record.title,
      record.address,
      record.description,
      record.price ?? "",
      record.rating,
      record.operators,
      record.routes,
      record.images,
      record.lat,
      record.lon,
      record.parsedAt,
    ]));
  }

  await Deno.writeTextFile(filepath, lines.join(""), { append: fileExists, create: true });
  console.log(`[CSV] Записано ${records.length} записей в ${filepath}`);
}