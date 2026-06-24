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

/** Полный набор полей объявления */
export interface ListingRecord {
  // Основные
  item_id: string;
  site_name: "avito" | "cian";
  url: string;
  title: string;
  price: string;
  price_per_m2: string;
  description: string;
  description_html: string;
  address: string;

  // Параметры квартиры
  rooms: string;
  total_area: string;
  kitchen_area: string;
  living_area: string;
  floor: string;
  floors_total: string;
  balcony: string;
  room_type: string;
  bathroom: string;
  windows: string;
  renovation: string;
  furniture: string;
  is_furnished: string; // "да"/"нет"

  // Тип дома / постройка
  house_type: string;
  build_year: string;
  passenger_elevator: string;
  freight_elevator: string;

  // Парковка
  parking: string;

  // Продавец
  seller_name: string;
  seller_type: string;
  seller_contact_person: string;
  is_agency: string; // "да"/"нет"
  seller_id: string;
  seller_link: string;
  seller_avatar: string;
  is_active: string; // "да"/"нет"
  is_favorite: string; // "да"/"нет"
  phone_number: string;
  messenger_availability: string; // "да"/"нет"

  // Сделка
  sale_method: string;
  sale_terms: string;

  // Ипотека
  is_mortgage_possible: string; // "да"/"нет"
  mortgage_payment: string;
  mortgage_rate: string;
  mortgage_income: string;

  // Статистика
  listing_date: string;
  views_total: string;
  views_today: string;

  // Изображения
  images_count: string;
  image_urls: string;
  main_image_url: string;

  // Гео
  latitude: string;
  longitude: string;
  map_zoom: string;
  geo_references: string;

  // Онлайн-показ
  is_online_view: string; // "да"/"нет"

  // Хлебные крошки / SEO
  breadcrumbs: string;
  seo_tags: string;
  usps: string;

  // Застройщик
  developer_description: string;
  developer_items: string;
  developer_trust: string;

  // Все параметры скопом
  all_params: string;
  all_house_params: string;

  // Мета
  parsed_at: string;
}

export const CSV_HEADERS = [
  "ID объявления",
  "Сайт",
  "URL",
  "Заголовок объявления",
  "Цена",
  "Цена за м²",
  "Описание",
  "Описание (HTML)",
  "Адрес",
  "Количество комнат",
  "Общая площадь",
  "Площадь кухни",
  "Жилая площадь",
  "Этаж",
  "Этажей в доме",
  "Балкон или лоджия",
  "Тип комнат",
  "Санузел",
  "Окна",
  "Ремонт",
  "Мебель",
  "Есть ли мебель",
  "Тип дома",
  "Год постройки",
  "Пассажирский лифт",
  "Грузовой лифт",
  "Парковка",
  "Имя продавца",
  "Тип продавца",
  "Контактное лицо",
  "Является ли объявление от агентства",
  "ID продавца",
  "Ссылка на профиль продавца",
  "Аватар продавца",
  "Объявление активно",
  "В избранном",
  "Телефон",
  "Доступность мессенджера",
  "Способ продажи",
  "Условия продажи",
  "Возможна ли ипотека",
  "Платёж по ипотеке (от)",
  "Ставка по ипотеке (от)",
  "Требуемый доход (от)",
  "Дата размещения",
  "Всего просмотров",
  "Просмотров сегодня",
  "Количество изображений",
  "Ссылки на все изображения",
  "URL главного изображения",
  "Широта (геоданные)",
  "Долгота (геоданные)",
  "Масштаб карты",
  "Гео-объекты",
  "Онлайн-показ",
  "Хлебные крошки",
  "SEO теги",
  "Преимущества (USP)",
  "Описание застройщика",
  "Параметры застройщика",
  "Trust-карточка застройщика",
  "Все параметры квартиры",
  "Все параметры дома",
  "Дата парсинга",
];

/** Порядок полей для записи (соответствует CSV_HEADERS) */
function recordToValues(r: ListingRecord): unknown[] {
  return [
    r.item_id,
    r.site_name,
    r.url,
    r.title,
    r.price,
    r.price_per_m2,
    r.description,
    r.description_html,
    r.address,
    r.rooms,
    r.total_area,
    r.kitchen_area,
    r.living_area,
    r.floor,
    r.floors_total,
    r.balcony,
    r.room_type,
    r.bathroom,
    r.windows,
    r.renovation,
    r.furniture,
    r.is_furnished,
    r.house_type,
    r.build_year,
    r.passenger_elevator,
    r.freight_elevator,
    r.parking,
    r.seller_name,
    r.seller_type,
    r.seller_contact_person,
    r.is_agency,
    r.seller_id,
    r.seller_link,
    r.seller_avatar,
    r.is_active,
    r.is_favorite,
    r.phone_number,
    r.messenger_availability,
    r.sale_method,
    r.sale_terms,
    r.is_mortgage_possible,
    r.mortgage_payment,
    r.mortgage_rate,
    r.mortgage_income,
    r.listing_date,
    r.views_total,
    r.views_today,
    r.images_count,
    r.image_urls,
    r.main_image_url,
    r.latitude,
    r.longitude,
    r.map_zoom,
    r.geo_references,
    r.is_online_view,
    r.breadcrumbs,
    r.seo_tags,
    r.usps,
    r.developer_description,
    r.developer_items,
    r.developer_trust,
    r.all_params,
    r.all_house_params,
    r.parsed_at,
  ];
}

/** Создаёт пустую запись с site_name */
export function emptyRecord(site_name: "avito" | "cian"): ListingRecord {
  return {
    item_id: "",
    site_name,
    url: "",
    title: "",
    price: "",
    price_per_m2: "",
    description: "",
    description_html: "",
    address: "",
    rooms: "",
    total_area: "",
    kitchen_area: "",
    living_area: "",
    floor: "",
    floors_total: "",
    balcony: "",
    room_type: "",
    bathroom: "",
    windows: "",
    renovation: "",
    furniture: "",
    is_furnished: "",
    house_type: "",
    build_year: "",
    passenger_elevator: "",
    freight_elevator: "",
    parking: "",
    seller_name: "",
    seller_type: "",
    seller_contact_person: "",
    is_agency: "",
    seller_id: "",
    seller_link: "",
    seller_avatar: "",
    is_active: "",
    is_favorite: "",
    phone_number: "",
    messenger_availability: "",
    sale_method: "",
    sale_terms: "",
    is_mortgage_possible: "",
    mortgage_payment: "",
    mortgage_rate: "",
    mortgage_income: "",
    listing_date: "",
    views_total: "",
    views_today: "",
    images_count: "",
    image_urls: "",
    main_image_url: "",
    latitude: "",
    longitude: "",
    map_zoom: "",
    geo_references: "",
    is_online_view: "",
    breadcrumbs: "",
    seo_tags: "",
    usps: "",
    developer_description: "",
    developer_items: "",
    developer_trust: "",
    all_params: "",
    all_house_params: "",
    parsed_at: new Date().toISOString(),
  };
}

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
    lines.push(toCsvLine(recordToValues(record)));
  }

  await Deno.writeTextFile(filepath, lines.join(""), { append: fileExists, create: true });
  console.log(`[CSV] Записано ${records.length} записей в ${filepath}`);
}