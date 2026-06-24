/**
 * Парсер cookies.json (экспорт из Firefox / браузерных расширений)
 *
 * Формат:
 * {
 *   "cookieManagerVersion": "1.8",
 *   "userAgent": "Mozilla/5.0 ...",
 *   "cookies": [
 *     {
 *       "name": "srv_id",
 *       "value": "FjFDBl...",
 *       "domain": ".avito.ru",
 *       ...
 *     },
 *     ...
 *   ]
 * }
 *
 * Результат:
 *   cookieString — строка для HTTP-заголовка Cookie (name=value; ...)
 *   userAgent   — User-Agent из файла (опционально)
 */

interface CookieEntry {
  name: string;
  value: string;
  domain: string;
  hostOnly?: boolean;
  path: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  session?: boolean;
  expirationDate?: number;
}

interface CookiesFile {
  cookieManagerVersion?: string;
  userAgent?: string;
  cookies: CookieEntry[];
}

export interface ParsedCookies {
  /** Строка для заголовка Cookie: "name1=value1; name2=value2; ..." */
  cookieString: string;
  /** User-Agent из файла, если указан */
  userAgent?: string;
  /** Общее количество кук */
  count: number;
}

/**
 * Парсит файл cookies.json и возвращает строку для HTTP-заголовка Cookie.
 * @param filePath — путь к JSON-файлу с куками
 */
export async function parseCookiesFile(filePath: string): Promise<ParsedCookies> {
  let raw: string;
  try {
    raw = await Deno.readTextFile(filePath);
  } catch (err) {
    throw new Error(
      `Не удалось прочитать файл кук "${filePath}": ${err instanceof Error ? err.message : err}`,
    );
  }

  let data: CookiesFile;
  try {
    data = JSON.parse(raw) as CookiesFile;
  } catch {
    throw new Error(`Файл "${filePath}" не является валидным JSON`);
  }

  if (!Array.isArray(data.cookies) || data.cookies.length === 0) {
    throw new Error(`В файле "${filePath}" не найдено кук (поле "cookies" пусто или отсутствует)`);
  }

  // Фильтруем: только куки для avito.ru (основной домен и www-поддомен)
  const relevantCookies = data.cookies.filter((c) => {
    if (!c.name || c.value === undefined) return false;
    // Принимаем куки для .avito.ru, www.avito.ru, .www.avito.ru
    const domain = c.domain?.toLowerCase() ?? "";
    return domain.includes("avito.ru");
  });

  if (relevantCookies.length === 0) {
    console.warn(
      `⚠️  В файле "${filePath}" нет кук для avito.ru. Проверьте, что куки экспортированы с сайта avito.ru.`,
    );
  }

  // Склеиваем в строку: name=value; name=value; ...
  const cookieString = relevantCookies
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");

  console.log(
    `   Загружено кук из ${filePath}: ${relevantCookies.length} (всего в файле: ${data.cookies.length})`,
  );

  return {
    cookieString,
    userAgent: data.userAgent,
    count: relevantCookies.length,
  };
}

/**
 * Объединяет куки из файла и AVITO_COOKIE из .env.
 * Если есть оба — куки из .env добавляются в конец строки (приоритетнее).
 *
 * @param parsed — результат parseCookiesFile()
 * @param envCookie — значение AVITO_COOKIE из .env
 * @returns итоговая строка Cookie
 */
export function mergeCookies(parsed: ParsedCookies | null, envCookie: string): string {
  const parts: string[] = [];

  if (parsed && parsed.cookieString) {
    parts.push(parsed.cookieString);
  }

  if (envCookie) {
    parts.push(envCookie);
  }

  return parts.join("; ");
}

/**
 * Определяет User-Agent:
 * 1. Если в cookies.json указан — используем его
 * 2. Иначе возвращаем дефолтный
 */
export function getUserAgent(parsed: ParsedCookies | null, fallback: string): string {
  if (parsed?.userAgent) return parsed.userAgent;
  return fallback;
}