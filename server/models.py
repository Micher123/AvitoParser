"""
Модели данных сервера-аккумулятора.

Схема БД строится вокруг объекта недвижимости (Property).
Каждый клиент (Авито, Циан, ...) шлёт свой «срез» данных.
Сервер смерживает их в единую запись без дублирования полей.

Приоритет источников (кто первый прислал поле — того и значение,
кроме случаев когда источник явно переопределяет):
  1) avito
  2) cian
  3) yandex_maps
  4) rosreestr
"""

from __future__ import annotations

import sqlite3
import os
import json
from typing import Optional, Dict, Any, List

DB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
DB_PATH = os.path.join(DB_DIR, "listings.db")


# ── Схема ────────────────────────────────────────────────────────

SCHEMA = """
CREATE TABLE IF NOT EXISTS properties (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    address_key   TEXT    NOT NULL UNIQUE,   -- нормализованный адрес (ключ сопоставления)
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Сырые данные от каждого источника (JSON)
CREATE TABLE IF NOT EXISTS client_data (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    property_id   INTEGER NOT NULL REFERENCES properties(id),
    source        TEXT    NOT NULL,          -- avito / cian / yandex_maps / rosreestr
    payload       TEXT    NOT NULL,          -- полный JSON от клиента
    received_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Зарегистрированные клиенты
CREATE TABLE IF NOT EXISTS clients (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id     TEXT    NOT NULL UNIQUE,   -- avito / cian / yandex_maps / rosreestr
    client_type   TEXT    NOT NULL,
    registered_at TEXT    NOT NULL DEFAULT (datetime('now')),
    last_seen_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
"""


# ── DB helpers ───────────────────────────────────────────────────

def get_db() -> sqlite3.Connection:
    os.makedirs(DB_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(SCHEMA)
    conn.commit()
    return conn


# ── Клиент ───────────────────────────────────────────────────────

def register_client(client_id: str, client_type: str) -> Dict[str, Any]:
    db = get_db()
    db.execute(
        "INSERT OR REPLACE INTO clients (client_id, client_type, last_seen_at) VALUES (?, ?, datetime('now'))",
        (client_id, client_type),
    )
    db.commit()
    db.close()
    return {"client_id": client_id, "client_type": client_type, "status": "registered"}


# ── Приём данных ─────────────────────────────────────────────────

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


def ingest(source: str, records: List[Dict[str, str]]) -> Dict[str, Any]:
    """
    Принимает список записей от клиента.
    Каждая запись — словарь с полями ListingRecord + поле 'address_key'.

    Возвращает статистику: сколько новых / обновлённых.
    """
    db = get_db()
    new_count = 0
    updated_count = 0

    for rec in records:
        address_raw = rec.get("address", "")
        address_key = normalize_address(address_raw)
        if not address_key:
            continue

        # Ищем или создаём property
        row = db.execute(
            "SELECT id FROM properties WHERE address_key = ?", (address_key,)
        ).fetchone()

        if row:
            prop_id = row["id"]
            updated_count += 1
        else:
            cur = db.execute(
                "INSERT INTO properties (address_key) VALUES (?)", (address_key,)
            )
            prop_id = cur.lastrowid
            new_count += 1

        # Сохраняем сырые данные клиента
        db.execute(
            "INSERT INTO client_data (property_id, source, payload) VALUES (?, ?, ?)",
            (prop_id, source, json.dumps(rec, ensure_ascii=False)),
        )

        # Обновляем updated_at
        db.execute(
            "UPDATE properties SET updated_at = datetime('now') WHERE id = ?",
            (prop_id,),
        )

        # Обновляем last_seen_at клиента
        db.execute(
            "UPDATE clients SET last_seen_at = datetime('now') WHERE client_id = ?",
            (source,),
        )

    db.commit()
    db.close()
    return {"new": new_count, "updated": updated_count, "total": new_count + updated_count}


# ── Мержер ───────────────────────────────────────────────────────

# Порядок приоритета источников для каждого поля
# Если поле уже заполнено из более приоритетного источника — не перезаписываем
SOURCE_PRIORITY = {"avito": 0, "cian": 1, "yandex_maps": 2, "rosreestr": 3}

# Поля которые НЕ дублируются (исключаем rosreestr если avito уже дал)
DUPLICATE_BLOCK_LIST = {
    "rosreestr": ["rosreestr"],  # если avito дал rosreestr — не берём из rosreestr
}

# Поля, которые приходят с каждого источника
FIELD_SOURCE_MAP = {
    # avito — всё
    "avito": [
        "item_id", "url", "title", "price", "price_per_m2",
        "address", "metro", "description",
        "listing_date", "views_total", "views_today",
        "seller_name", "seller_type",
        "flat_params", "house_params", "rosreestr",
    ],
    # cian
    "cian": [
        "item_id", "url", "title", "price", "price_per_m2",
        "address", "metro", "description",
        "listing_date",
        "seller_name", "seller_type",
        "flat_params", "house_params",
    ],
    # yandex_maps
    "yandex_maps": [
        "address", "metro", "flat_params", "house_params",
    ],
    # rosreestr
    "rosreestr": [
        "address", "flat_params", "house_params", "rosreestr",
    ],
}


def merge_to_unified() -> List[Dict[str, str]]:
    """
    Собирает единый список записей из всех client_data,
    с учётом приоритета источников и запрета дублирования.
    """
    db = get_db()
    properties = db.execute("SELECT id, address_key FROM properties").fetchall()
    result: List[Dict[str, str]] = []

    for prop in properties:
        prop_id = prop["id"]
        # Все записи client_data для этого property, упорядочены по приоритету
        rows = db.execute(
            """SELECT source, payload FROM client_data
               WHERE property_id = ?
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
        ).fetchall()

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
            "seller_name": "",
            "seller_type": "",
            "flat_params": "",
            "house_params": "",
            "rosreestr": "",
            "source": "",
        }

        filled_fields: Dict[str, str] = {}  # поле → источник

        for row in rows:
            source = row["source"]
            payload = json.loads(row["payload"])

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

                # Если поле ещё не заполнено — заполняем
                if not unified.get(field) and value:
                    unified[field] = str(value)
                    filled_fields[field] = source

                # Обновляем source
                if unified["source"]:
                    sources = set(unified["source"].split(","))
                    sources.add(source)
                    unified["source"] = ",".join(sorted(sources))
                else:
                    unified["source"] = source

        # Если address не заполнен через payload, берём из properties
        if not unified["address"]:
            unified["address"] = prop["address_key"]

        result.append(unified)

    db.close()
    return result


# ── Экспорт в TSV ────────────────────────────────────────────────

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
    "Имя продавца",
    "Статус продавца",
    "Характеристики квартиры",
    "Характеристики дома",
    "Росреестр",
    "Источники",
]

TSV_FIELDS = [
    "item_id", "url", "title", "price", "price_per_m2",
    "address", "metro", "description", "listing_date",
    "views_total", "views_today", "seller_name", "seller_type",
    "flat_params", "house_params", "rosreestr", "source",
]


def export_tsv() -> str:
    """Экспортирует смерженные данные в TSV-файл, возвращает путь."""
    import csv

    records = merge_to_unified()
    output_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
    os.makedirs(output_dir, exist_ok=True)
    filepath = os.path.join(output_dir, "unified_listings.tsv")

    with open(filepath, "w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f, delimiter="\t", quoting=csv.QUOTE_MINIMAL)
        writer.writerow(TSV_HEADERS)
        for rec in records:
            row = [rec.get(f, "").replace("\t", " ").replace("\n", " ") for f in TSV_FIELDS]
            writer.writerow(row)

    return filepath