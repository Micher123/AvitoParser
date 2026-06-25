"""
Запись TSV-файлов с разделителем табуляции.
Поддерживает дозапись в существующий файл и создание нового с заголовками.
"""
import csv
import os
from typing import List


# Определяем корень проекта (там же где этот файл)
_this_dir = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(_this_dir, "output")


class ListingRecord:
    """Поля объявления по алгоритму"""
    __slots__ = (
        "item_id", "url", "title", "price", "price_per_m2",
        "address", "metro", "description",
        "listing_date", "views_total", "views_today",
        "seller_name", "seller_type",
        "flat_params", "house_params", "rosreestr",
        "parsed_at",
    )

    def __init__(self):
        self.item_id = ""
        self.url = ""
        self.title = ""
        self.price = ""
        self.price_per_m2 = ""
        self.address = ""
        self.metro = ""
        self.description = ""
        self.listing_date = ""
        self.views_total = ""
        self.views_today = ""
        self.seller_name = ""
        self.seller_type = ""
        self.flat_params = ""
        self.house_params = ""
        self.rosreestr = ""
        self.parsed_at = ""


CSV_HEADERS = [
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
    "Дата парсинга",
]


def _clean(v: str) -> str:
    """Удаляет табуляции и переносы строк из значения"""
    return v.replace("\t", " ").replace("\n", " ").replace("\r", "")


def record_to_values(r: ListingRecord) -> list:
    """Порядок полей (соответствует CSV_HEADERS)"""
    return [
        _clean(r.item_id),
        _clean(r.url),
        _clean(r.title),
        _clean(r.price),
        _clean(r.price_per_m2),
        _clean(r.address),
        _clean(r.metro),
        _clean(r.description),
        _clean(r.listing_date),
        _clean(r.views_total),
        _clean(r.views_today),
        _clean(r.seller_name),
        _clean(r.seller_type),
        _clean(r.flat_params),
        _clean(r.house_params),
        _clean(r.rosreestr),
        _clean(r.parsed_at),
    ]


def empty_record() -> ListingRecord:
    """Создаёт пустую запись"""
    return ListingRecord()


def append_to_csv(filename: str, records: List[ListingRecord]) -> None:
    """
    Записывает массив объявлений в TSV-файл.
    Если файл не существует — создаёт с заголовками.
    Если существует — дозаписывает строки.
    """
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    filepath = os.path.join(OUTPUT_DIR, filename)

    file_exists = os.path.isfile(filepath)

    mode = "a" if file_exists else "w"
    with open(filepath, mode, encoding="utf-8", newline="") as f:
        writer = csv.writer(f, delimiter="\t", quoting=csv.QUOTE_MINIMAL)
        if not file_exists:
            writer.writerow(CSV_HEADERS)
        for record in records:
            writer.writerow(record_to_values(record))

    print(f"[CSV] Записано {len(records)} записей в {filepath}")