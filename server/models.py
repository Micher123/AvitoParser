"""
Модели данных сервера-аккумулятора AvitoParser.

Схема БД строится вокруг объекта недвижимости (Property).
Каждый клиент (Авито, Циан, ...) шлёт свой «срез» данных.
Сервер смерживает их в единую запись без дублирования полей.

База данных: PostgreSQL.
При старте сервера БД и таблицы создаются автоматически, если их ещё нет.

Приоритет источников (кто первый прислал поле — того и значение):
  1) avito
  2) cian
  3) yandex_maps
  4) rosreestr
"""

from __future__ import annotations

import os
import json
from typing import Optional, Dict, Any, List

import psycopg2
import psycopg2.extras
from dotenv import load_dotenv

# ── Загрузка .env ─────────────────────────────────────────────────
load_dotenv()

# ── Параметры подключения к PostgreSQL из переменных окружения ─────
DB_CONFIG = {
    "host": os.getenv("DB_HOST", "localhost"),
    "port": int(os.getenv("DB_PORT", "5432")),
    "dbname": os.getenv("DB_NAME", "state"),
    "user": os.getenv("DB_USER", "admin"),
    "password": os.getenv("DB_PASSWORD", "admin"),
}


# ── Схема таблиц ──────────────────────────────────────────────────

SCHEMA = """
CREATE TABLE IF NOT EXISTS properties (
    id            SERIAL PRIMARY KEY,
    address_key   TEXT    NOT NULL UNIQUE,   -- нормализованный адрес (ключ сопоставления)
    created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Сырые данные от каждого источника (JSON)
CREATE TABLE IF NOT EXISTS client_data (
    id            SERIAL PRIMARY KEY,
    property_id   INTEGER NOT NULL REFERENCES properties(id),
    source        TEXT    NOT NULL,          -- avito / cian / yandex_maps / rosreestr
    payload       TEXT    NOT NULL,          -- полный JSON от клиента
    received_at   TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Зарегистрированные клиенты
CREATE TABLE IF NOT EXISTS clients (
    id            SERIAL PRIMARY KEY,
    client_id     TEXT    NOT NULL UNIQUE,   -- avito / cian / yandex_maps / rosreestr
    client_type   TEXT    NOT NULL,
    registered_at TIMESTAMP NOT NULL DEFAULT NOW(),
    last_seen_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Индекс для быстрого поиска по property_id в client_data
CREATE INDEX IF NOT EXISTS idx_client_data_property_id ON client_data(property_id);

-- Индекс для поиска по источнику
CREATE INDEX IF NOT EXISTS idx_client_data_source ON client_data(source);
"""


# ── Управление БД ─────────────────────────────────────────────────

def db_exists() -> bool:
    """
    Проверяет, существует ли уже БД state (или та, что указана в .env).
    Подключается к серверу PostgreSQL без указания БД и проверяет.
    """
    try:
        admin_conn = psycopg2.connect(
            host=DB_CONFIG["host"],
            port=DB_CONFIG["port"],
            dbname="postgres",
            user=DB_CONFIG["user"],
            password=DB_CONFIG["password"],
        )
        admin_conn.autocommit = True
        cur = admin_conn.cursor()
        cur.execute("SELECT 1 FROM pg_database WHERE datname = %s", (DB_CONFIG["dbname"],))
        exists = cur.fetchone() is not None
        cur.close()
        admin_conn.close()
        return exists
    except Exception:
        # Если не можем подключиться к postgres — БД точно нет
        return False


def create_database() -> bool:
    """
    Создаёт БД, если её ещё нет.
    Возвращает True если создана, False если уже существовала.
    """
    if db_exists():
        return False

    try:
        admin_conn = psycopg2.connect(
            host=DB_CONFIG["host"],
            port=DB_CONFIG["port"],
            dbname="postgres",
            user=DB_CONFIG["user"],
            password=DB_CONFIG["password"],
        )
        admin_conn.autocommit = True
        cur = admin_conn.cursor()
        cur.execute("CREATE DATABASE %s" % DB_CONFIG["dbname"])
        cur.close()
        admin_conn.close()
        return True
    except Exception as e:
        raise RuntimeError(
            f"Не удалось создать БД '{DB_CONFIG['dbname']}'. "
            f"Убедитесь, что PostgreSQL запущен и пользователь '{DB_CONFIG['user']}' "
            f"имеет права CREATE DATABASE.\nОшибка: {e}"
        )


def init_tables() -> None:
    """
    Создаёт таблицы в БД, если их ещё нет.
    """
    conn = get_db()
    try:
        with conn.cursor() as cur:
            cur.execute(SCHEMA)
        conn.commit()
    except Exception as e:
        conn.rollback()
        raise RuntimeError(f"Не удалось создать таблицы: {e}")
    finally:
        conn.close()


# ── DB helpers ─────────────────────────────────────────────────────

def get_db():
    """Возвращает соединение с БД."""
    try:
        conn = psycopg2.connect(**DB_CONFIG)
        # Настройка: возвращать строки как словари
        psycopg2.extras.register_default_json(conn, loads=json.loads)
        return conn
    except Exception as e:
        raise RuntimeError(
            f"Не удалось подключиться к PostgreSQL. Проверьте параметры в .env файле.\n"
            f"Хост: {DB_CONFIG['host']}:{DB_CONFIG['port']}, "
            f"БД: {DB_CONFIG['dbname']}, Пользователь: {DB_CONFIG['user']}\n"
            f"Ошибка: {e}"
        )


def get_db_cursor(conn, dict_cursor: bool = True):
    """Возвращает курсор (опционально — DictCursor)."""
    if dict_cursor:
        return conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    return conn.cursor()


# ── Клиент ────────────────────────────────────────────────────────

def register_client(client_id: str, client_type: str) -> Dict[str, Any]:
    conn = get_db()
    try:
        with get_db_cursor(conn) as cur:
            cur.execute(
                """INSERT INTO clients (client_id, client_type, registered_at, last_seen_at)
                   VALUES (%s, %s, NOW(), NOW())
                   ON CONFLICT (client_id) DO UPDATE
                   SET last_seen_at = NOW(), client_type = EXCLUDED.client_type""",
                (client_id, client_type),
            )
        conn.commit()
    finally:
        conn.close()
    return {"client_id": client_id, "client_type": client_type, "status": "registered"}


# ── Нормализация адреса ───────────────────────────────────────────

def normalize_address(addr: str) -> str:
    """Приводит адрес к единому виду для сопоставления записей."""
    if not addr:
        return ""
    return (
        addr.strip()
        .lower()
        .replace("россия, ", "")
        .replace("г. ", "")
        .replace("город ", "")
        .replace("улица ", "ул. ")
        .replace("проспект ", "пр-т ")
        .replace("проезд ", "пр-д ")
        .replace("бульвар ", "б-р ")
        .replace("шоссе ", "ш. ")
        .replace("  ", " ")
    )


# ── Приём данных ──────────────────────────────────────────────────

def ingest(source: str, records: List[Dict[str, str]]) -> Dict[str, Any]:
    """
    Принимает список записей от клиента.
    Каждая запись — словарь с полями ListingRecord.

    Возвращает статистику: сколько новых / обновлённых.
    """
    conn = get_db()
    new_count = 0
    updated_count = 0
    skipped_count = 0

    try:
        with get_db_cursor(conn) as cur:
            for rec in records:
                address_raw = rec.get("address", "")
                item_id = rec.get("item_id", "")
                url = rec.get("url", "")
                address_key = normalize_address(address_raw)
                if not address_key:
                    # fallback: используем item_id как ключ
                    if item_id:
                        address_key = f"id:{source}:{item_id}"
                    elif url:
                        # fallback: используем URL как ключ
                        address_key = f"url:{source}:{hash(url) & 0x7fffffff}"
                    else:
                        print(f"[ingest] ПРОПУЩЕНО: запись без адреса, item_id и url: {{'title': '{rec.get('title','')[:50]}'}}")
                        skipped_count += 1
                        continue
                
                # Отладка: логируем первую запись от каждого источника
                if new_count + updated_count == 0:
                    fields_present = [k for k, v in rec.items() if v]
                    print(f"[ingest] Первая запись {source}: поля={fields_present}, address='{address_raw[:80] if address_raw else '(пусто)'}', address_key='{address_key[:80]}'")

                # Ищем или создаём property
                cur.execute(
                    "SELECT id FROM properties WHERE address_key = %s",
                    (address_key,),
                )
                row = cur.fetchone()

                if row:
                    prop_id = row["id"]
                    updated_count += 1
                else:
                    cur.execute(
                        "INSERT INTO properties (address_key) VALUES (%s) RETURNING id",
                        (address_key,),
                    )
                    prop_id = cur.fetchone()["id"]
                    new_count += 1

                # Сохраняем сырые данные клиента
                cur.execute(
                    "INSERT INTO client_data (property_id, source, payload) VALUES (%s, %s, %s)",
                    (prop_id, source, json.dumps(rec, ensure_ascii=False)),
                )

                # Обновляем updated_at
                cur.execute(
                    "UPDATE properties SET updated_at = NOW() WHERE id = %s",
                    (prop_id,),
                )

                # Обновляем last_seen_at клиента
                cur.execute(
                    "UPDATE clients SET last_seen_at = NOW() WHERE client_id = %s",
                    (source,),
                )

        conn.commit()
    except Exception as e:
        conn.rollback()
        raise RuntimeError(f"Ошибка при сохранении данных: {e}")
    finally:
        conn.close()

    print(f"[ingest] {source}: новых={new_count}, обновлено={updated_count}, пропущено={skipped_count}, всего={len(records)}")

    return {
        "new": new_count,
        "updated": updated_count,
        "total": new_count + updated_count,
    }


# ── Мержер ────────────────────────────────────────────────────────

# Порядок приоритета источников для каждого поля
SOURCE_PRIORITY = {"avito": 0, "cian": 1, "yandex_maps": 2, "rosreestr": 3}

# Поля которые НЕ дублируются
DUPLICATE_BLOCK_LIST = {
    "rosreestr": ["rosreestr"],
}


def merge_to_unified() -> List[Dict[str, str]]:
    """
    Собирает единый список записей из всех client_data,
    с учётом приоритета источников и запрета дублирования.
    """
    conn = get_db()
    result: List[Dict[str, str]] = []

    try:
        with get_db_cursor(conn) as cur:
            cur.execute("SELECT id, address_key FROM properties")
            properties = cur.fetchall()

            for prop in properties:
                prop_id = prop["id"]

                cur.execute(
                    """SELECT source, payload FROM client_data
                       WHERE property_id = %s
                       ORDER BY
                         CASE source
                           WHEN 'avito' THEN 0
                           WHEN 'cian' THEN 1
                           WHEN 'yandex_maps' THEN 2
                           WHEN 'rosreestr' THEN 3
                           ELSE 4
                         END,
                         received_at ASC""",
                    (prop_id,),
                )
                rows = cur.fetchall()

                unified: Dict[str, str] = {
                    "item_id": "",
                    "url": "",
                    "title": "",
                    "price": "",
                    "price_per_m2": "",
                    "address": "",
                    "metro": "",
                    "description": "",
                    "listing_date": "",
                    "views_total": "",
                    "views_today": "",
                    "flat_params": "",
                    "house_params": "",
                    "rosreestr": "",
                    "source": "",
                }

                filled_fields: Dict[str, str] = {}

                for row in rows:
                    source = row["source"]
                    payload = row["payload"]
                    if isinstance(payload, str):
                        payload = json.loads(payload)

                    for field, value in payload.items():
                        if field in ("address_key", "parsed_at"):
                            continue
                        if field not in unified:
                            continue

                        # Проверка запрета дублирования
                        skip = False
                        for block_source, block_fields in DUPLICATE_BLOCK_LIST.items():
                            if (
                                source == block_source
                                and field in block_fields
                                and filled_fields.get(field, "") == "avito"
                            ):
                                skip = True
                                break
                        if skip:
                            continue

                        if not unified.get(field) and value:
                            unified[field] = str(value)
                            filled_fields[field] = source

                        if unified["source"]:
                            sources = set(unified["source"].split(","))
                            sources.add(source)
                            unified["source"] = ",".join(sorted(sources))
                        else:
                            unified["source"] = source

                if not unified["address"]:
                    unified["address"] = prop["address_key"]

                result.append(unified)
    finally:
        conn.close()

    return result


# ── Экспорт в TSV (разделитель — табуляция) ────────────────────────

TSV_HEADERS = [
    "ID объявления",
    "URL",
    "Заголовок",
    "Цена",
    "Цена за м²",
    "Адрес",
    "Метро",
    "Описание",
    "Дата публикации",
    "Всего просмотров",
    "Просмотров сегодня",
    "Характеристики квартиры",
    "Характеристики дома",
    "Росреестр",
    "Источники",
]

TSV_FIELDS = [
    "item_id", "url", "title", "price", "price_per_m2",
    "address", "metro", "description", "listing_date",
    "views_total", "views_today",
    "flat_params", "house_params", "rosreestr", "source",
]

# Папка output в корне проекта
_OUTPUT_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "output"
)


def export_tsv(filepath: Optional[str] = None) -> str:
    """
    Экспортирует смерженные данные из PostgreSQL в TSV-файл с разделителем табуляции.

    Аргументы:
        filepath: путь к выходному файлу. Если None — сохраняет в output/state.tsv

    Возвращает полный путь к файлу.
    """
    import csv

    if filepath is None:
        os.makedirs(_OUTPUT_DIR, exist_ok=True)
        filepath = os.path.join(_OUTPUT_DIR, "state.tsv")

    records = merge_to_unified()

    with open(filepath, "w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f, delimiter="\t", quoting=csv.QUOTE_MINIMAL)
        writer.writerow(TSV_HEADERS)
        for rec in records:
            row = [
                (rec.get(f, "") or "")
                .replace("\t", " ")
                .replace("\n", " ")
                .replace("\r", " ")
                for f in TSV_FIELDS
            ]
            writer.writerow(row)

    return filepath