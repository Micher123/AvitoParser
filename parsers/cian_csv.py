"""
Парсер Циан → CSV (65 полей)

Требуется: CIAN_SEARCH_COOKIE в .env или JSON-файлы с экспортом.

Использование:
  python -m parsers.cian_csv              # через API
  python -m parsers.cian_csv /путь/json   # из файлов
"""
import json
import os
import sys
import time
from typing import Any, Dict, List, Optional

from csv_writer import (
    ListingRecord,
    empty_record,
    append_to_csv,
)
from core.env import CIAN_SEARCH_COOKIE
from core.config import Config
from utils.spy_fetch import spy_fetch

CSV_FILE = "cian_listings.csv"

# ═══════════════════════════════════════════════
# Утилиты
# ═══════════════════════════════════════════════


def yn(v: Any) -> str:
    """Да/Нет из boolean или строки"""
    if v is True or v == "true" or v == "да" or v == "yes":
        return "да"
    if v is False or v == "false" or v == "нет" or v == "no":
        return "нет"
    return ""


def s(v: Any) -> str:
    """Безопасное преобразование в строку"""
    return str(v) if v is not None else ""


# ═══════════════════════════════════════════════
# Конвертация CianSearchOfferResponse → ListingRecord
# ═══════════════════════════════════════════════


class CianSearchOfferResponse(dict):
    """Тип-обёртка для ответа API Циан (по сути словарь)"""
    pass


def offer_to_record(offer: Dict[str, Any]) -> ListingRecord:
    """Конвертация CianSearchOfferResponse → ListingRecord (45 полей)"""
    record = empty_record("cian")

    # ID
    record.item_id = s(offer.get("id"))

    # Title: пробуем title, иначе description
    record.title = (offer.get("title") or offer.get("description") or "").strip()

    # Price
    bargain = offer.get("bargainTerms") or {}
    if bargain.get("priceRur"):
        record.price = str(bargain["priceRur"])
    elif bargain.get("price"):
        record.price = str(bargain["price"])

    # Price per m2
    if bargain.get("pricePerMeter") is not None:
        record.price_per_m2 = str(bargain["pricePerMeter"])

    # Description
    record.description = (offer.get("description") or "").strip()
    record.description_html = ""  # Циан API не даёт HTML

    # Address
    geo = offer.get("geo") or {}
    record.address = (geo.get("userInput") or geo.get("address") or "").strip()

    # Flat params
    flat = offer.get("flat") or {}
    record.rooms = s(flat.get("rooms"))
    record.total_area = s(flat.get("area"))
    record.kitchen_area = s(flat.get("kitchenArea"))
    record.living_area = s(flat.get("livingArea"))
    record.floor = s(flat.get("floor"))
    record.balcony = s(flat.get("balcony"))
    record.room_type = s(flat.get("roomType"))
    record.bathroom = s(flat.get("bathroom"))
    record.windows = s(flat.get("windows"))
    record.renovation = s(flat.get("renovation"))
    record.furniture = s(flat.get("furniture"))
    record.is_furnished = yn(flat.get("isFurnished"))

    # Building
    building = offer.get("building") or {}
    record.floors_total = s(building.get("floorsCount"))
    record.house_type = s(building.get("series") or building.get("name"))
    record.build_year = s(building.get("buildYear"))
    record.passenger_elevator = s(
        building.get("passengerLiftsCount")
        or ("1" if building.get("hasPassengerLift") else "")
    )
    record.freight_elevator = s(
        building.get("freightLiftsCount")
        or ("1" if building.get("hasFreightLift") else "")
    )
    record.parking = s(building.get("parking"))

    # Seller
    seller = offer.get("seller") or {}
    record.seller_contact_person = s(seller.get("contactPerson"))
    record.is_agency = yn(seller.get("isAgency") if seller.get("isAgency") is not None
                          else not offer.get("isByHomeowner"))
    record.phone_number = s(seller.get("phone"))

    # Messenger
    chat = offer.get("chat") or {}
    record.messenger_availability = yn(chat.get("messengerEnabled"))

    # Sale
    record.sale_method = s(bargain.get("saleMethod"))
    record.sale_terms = s(bargain.get("saleTerms"))

    # Mortgage
    mortgage = offer.get("mortgageInfo") or {}
    record.is_mortgage_possible = yn(mortgage.get("isPossible"))
    if mortgage:
        record.mortgage_payment = s(mortgage.get("payment"))
        record.mortgage_rate = s(mortgage.get("rate"))
        record.mortgage_income = s(mortgage.get("income"))

    # Dates
    record.listing_date = s(offer.get("publicationDate") or offer.get("date"))

    # Views
    record.views_total = s(offer.get("views"))
    record.views_today = s(offer.get("viewsToday"))

    # Images
    photos = offer.get("photos") or []
    if isinstance(photos, list) and len(photos) > 0:
        image_urls = [p.get("fullUrl", "") for p in photos if isinstance(p, dict)]
        record.images_count = str(len(image_urls))
        record.image_urls = ", ".join(image_urls)
        record.main_image_url = image_urls[0] if image_urls else ""

    # Geo
    map_info = offer.get("mapInfo") or {}
    coordinates = geo.get("coordinates") or {}
    record.latitude = s(coordinates.get("lat") or map_info.get("latitude"))
    record.longitude = s(coordinates.get("lng") or map_info.get("longitude"))
    record.map_zoom = s(map_info.get("zoom"))

    # Online view
    record.is_online_view = yn(offer.get("isOnlineView"))

    record.parsed_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    return record


# ═══════════════════════════════════════════════
# Работа с API
# ═══════════════════════════════════════════════


def fetch_from_api() -> List[Dict[str, Any]]:
    """Загружает объявления через API Циан"""
    if not CIAN_SEARCH_COOKIE:
        raise RuntimeError("NO_COOKIE")

    config = Config.get()
    search_config = config.cian_search

    ads: List[Dict[str, Any]] = []
    current_page = 1
    total_offers: Optional[int] = None

    while True:
        body = {
            "_type": "flatrent",
            "engine_version": {"type": "term", "value": 2},
            "currency": {"type": "term", "value": 2},
            "wp": {"type": "term", "value": True},
            "for_day": {"type": "term", "value": "!1"},
            "price": {
                "type": "range",
                "value": {"lte": search_config.get("maxPrice", 50000), "gte": search_config.get("minPrice", 0)},
            },
            "geo": {
                "type": "geo",
                "value": [{"type": "district", "id": id} for id in search_config.get("geo", [0, 1, 2])],
            },
            "region": {"type": "terms", "value": search_config.get("regions", [1])},
            "sort": {"type": "term", "value": "total_price_desc"},
            "page": {"type": "term", "value": current_page},
        }

        print(f"Страница {current_page}...")

        resp = spy_fetch(
            "https://api.cian.ru/lk-specialist/v1/search-offers/",
            {
                "method": "POST",
                "headers": {
                    "Content-Type": "application/json",
                    "Cookie": CIAN_SEARCH_COOKIE,
                },
                "body": json.dumps(body),
            },
        )

        json_data = resp.json()

        if resp.status_code != 200:
            print(f"  HTTP {resp.status_code}:", json.dumps(json_data, ensure_ascii=False)[:300])
            raise RuntimeError(f"API вернул ошибку {resp.status_code}")

        offers = json_data.get("data", {}).get("offersSerialized") or \
                 json_data.get("offersSerialized") or []

        # Определяем total на первой странице
        if total_offers is None:
            total_offers = (
                json_data.get("data", {}).get("totalOffers")
                or json_data.get("totalOffers")
                or json_data.get("data", {}).get("total")
                or json_data.get("total")
                or 0
            )
            print(f"  Всего объявлений: {total_offers}")

        if not offers:
            print("  Пусто — стоп.")
            break

        ads.extend(offers)
        print(f"  +{len(offers)} объявлений (всего {len(ads)})")

        # Проверяем, не превысили ли total
        if total_offers is not None and total_offers > 0 and len(ads) >= total_offers:
            break
        # Если пришло меньше 28 объявлений — последняя страница
        if len(offers) < 28:
            break
        # Страховка от бесконечного цикла
        if current_page > 200:
            break

        current_page += 1

        # Задержка между запросами
        time.sleep(1)

    return ads


# ═══════════════════════════════════════════════
# Работа с JSON-файлами
# ═══════════════════════════════════════════════


def read_from_directory(dir_path: str) -> List[Dict[str, Any]]:
    """Читает JSON-файлы из директории"""
    if not os.path.isdir(dir_path):
        raise RuntimeError(f'"{dir_path}" не является директорией')

    ads: List[Dict[str, Any]] = []

    for entry in sorted(os.listdir(dir_path)):
        filepath = os.path.join(dir_path, entry)
        if not os.path.isfile(filepath) or not entry.endswith(".json"):
            continue

        try:
            with open(filepath, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (json.JSONDecodeError, Exception):
            print(f"Пропускаю {entry} — невалидный JSON")
            continue

        if isinstance(data, list):
            ads.extend(data)
        elif isinstance(data, dict) and "offers" in data:
            ads.extend(data["offers"])

    return ads


# ═══════════════════════════════════════════════
# Точка входа
# ═══════════════════════════════════════════════


def main() -> None:
    """Основная функция парсера Циан"""
    ads_raw: List[Dict[str, Any]] = []

    # Пробуем сначала API
    try:
        ads_raw = fetch_from_api()
        print(f"\nПолучено {len(ads_raw)} объявлений через API Циан.")
    except RuntimeError as err:
        msg = str(err)
        if msg == "NO_COOKIE":
            # Пробуем читать из папки
            dir_path = sys.argv[1] if len(sys.argv) > 1 else ""
            if not dir_path:
                print("Не задана переменная CIAN_SEARCH_COOKIE в .env файле.")
                print("   Либо укажите путь к папке с JSON-файлами Циан:")
                print("     python -m parsers.cian_csv /путь/к/json-export")
                sys.exit(1)
            try:
                ads_raw = read_from_directory(dir_path)
            except RuntimeError as dir_err:
                print(str(dir_err))
                sys.exit(1)
        else:
            print(f"Ошибка API: {msg}")
            sys.exit(1)

    if not ads_raw:
        print("Не найдено ни одного объявления Циан.")
        sys.exit(1)

    print(f"Запускаю обработку {len(ads_raw)} объявлений...\n")

    records: List[ListingRecord] = []
    processed = 0
    failed = 0

    for i, offer in enumerate(ads_raw):
        try:
            record = offer_to_record(offer)
            records.append(record)
            processed += 1
            print(f"[{processed}/{len(ads_raw)}] {record.title}")
        except Exception as err:
            failed += 1
            print(f"Ошибка при обработке {offer.get('fullUrl', '')}: {err}")

        # Периодически сохраняем
        if len(records) >= 10:
            append_to_csv(CSV_FILE, records)
            records.clear()

    # Сохраняем остаток
    if records:
        append_to_csv(CSV_FILE, records)

    print(f"\nГотово! Обработано: {processed}, ошибок: {failed}")
    print(f"Результат сохранён в output/{CSV_FILE}")


if __name__ == "__main__":
    main()