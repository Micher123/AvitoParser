#!/usr/bin/env python3
"""
Клиент Avito — парсит объявления и отправляет на сервер-аккумулятор.

Запуск:
    python clients/avito/run.py "https://www.avito.ru/moskva/kvartiry/prodam"
    python clients/avito/run.py  # использует AVITO_SEARCH_URL из .env

Перед запуском:
    1. Скопируйте clients/avito/.env.example в clients/avito/.env
    2. Укажите SERVER_URL (адрес сервера-аккумулятора)
    3. Укажите AVITO_SEARCH_URL (URL поиска Avito)
"""

import json
import os
import random
import re
import sys
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from urllib.parse import urljoin, urlparse, parse_qs, urlencode, urlunparse

# Добавляем корень проекта в путь для импорта общих модулей
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, _PROJECT_ROOT)

from bs4 import BeautifulSoup, Tag
from dotenv import load_dotenv

from core.env import AVITO_COOKIES_FILE, AVITO_COOKIE, AVITO_PROXY
from utils.cookies_parser import (
    parse_cookies_file,
    merge_cookies,
    get_user_agent,
    ParsedCookies,
)
from utils.spy_fetch import spy_fetch

# Импорт HTTP-клиента
from client import AvitoClient

# ── Загрузка .env клиента ──────────────────────────────────────
_ENV_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(_ENV_DIR, ".env"), override=True)

SERVER_URL = os.getenv("SERVER_URL", "http://localhost:8000").rstrip("/")
AVITO_SEARCH_URL = os.getenv("AVITO_SEARCH_URL", "")
AVITO_MAX_PAGES = int(os.getenv("AVITO_MAX_PAGES", "0") or "0")

# ── Константы ──────────────────────────────────────────────────
PAGES_DIR = os.path.join(_ENV_DIR, "Pages")
SEND_BATCH_SIZE = 5  # отправлять на сервер пачками по N записей

DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/138.0.0.0 Safari/537.36"
)


# ═══════════════════════════════════════════════════════════════════
# Утилиты (копия из parsers/avito_csv.py)
# ═══════════════════════════════════════════════════════════════════

def safe_text(el: Optional[Tag], default: str = "") -> str:
    if el is None:
        return default
    return el.get_text(strip=True)


def safe_attr(el: Optional[Tag], attr: str, default: str = "") -> str:
    if el is None:
        return default
    return (el.get(attr) or default).strip()


def prepare_headers() -> Dict[str, str]:
    """Формирует заголовки для запросов."""
    headers = {
        "User-Agent": DEFAULT_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
    }
    cookie_value = AVITO_COOKIE
    if not cookie_value:
        try:
            parsed = parse_cookies_file(AVITO_COOKIES_FILE) if AVITO_COOKIES_FILE and os.path.isfile(AVITO_COOKIES_FILE) else ParsedCookies()
            if parsed.user_agent:
                headers["User-Agent"] = parsed.user_agent
            cookie_value = parsed.cookie_string
        except Exception:
            pass
    if cookie_value:
        headers["Cookie"] = cookie_value
    return headers


def prepare_proxies() -> Optional[Dict[str, str]]:
    if AVITO_PROXY:
        return {"http": AVITO_PROXY, "https": AVITO_PROXY}
    return None


def download_search_page(url: str, headers: Dict[str, str], proxies: Optional[Dict[str, str]], page_num: int) -> Optional[str]:
    """Скачивает поисковую страницу Avito."""
    try:
        fetch_options: Dict[str, Any] = {
            "headers": headers,
            "timeout": 30,
        }
        if proxies:
            fetch_options["proxies"] = proxies

        resp = spy_fetch(url, fetch_options)
        if not resp.ok:
            print(f"[Avito] Ошибка загрузки страницы: HTTP {resp.status_code}")
            return None

        return resp.text
    except Exception as err:
        print(f"[Avito] Ошибка загрузки страницы: {err}")
        return None


def extract_ad_links(html: str, search_url: str = "") -> List[str]:
    """Извлекает ссылки на объявления из поисковой страницы."""
    soup = BeautifulSoup(html, "lxml")
    links: List[str] = []

    # Проверяем, не пришла ли страница с капчей / логином
    page_text = soup.get_text()[:2000].lower()
    if "капча" in page_text or "captcha" in page_text:
        print("[Avito] ⚠ Обнаружена капча. Нужны актуальные куки.")

    if "вход" in page_text and "пароль" in page_text:
        print("[Avito] ⚠ Страница логина. Куки устарели.")

    # Проверяем, что мы на Avito, а не на другом сайте
    parsed = urlparse(search_url) if search_url else None
    is_avito = parsed and "avito.ru" in parsed.netloc if parsed else False
    if search_url and not is_avito:
        print(f"[Avito] ⚠ URL не принадлежит Avito: {search_url}")
        print("[Avito] Проверьте AVITO_SEARCH_URL в .env")
        return links

    # Способ 1: a[data-marker="item-title"]
    title_links = soup.select('a[data-marker="item-title"]')
    for a in title_links:
        href = safe_attr(a, "href")
        if href and "/" in href:
            full_url = urljoin("https://www.avito.ru", href)
            links.append(full_url)

    # Способ 2: запасной — div[data-marker="item"] → data-item-id
    if not links:
        items = soup.select('div[data-marker="item"]')
        for item in items:
            item_id = safe_attr(item, "data-item-id")
            if item_id:
                links.append(f"https://www.avito.ru/_/{item_id}")

    # Диагностика
    if not links:
        print("[Avito] Селекторы не нашли объявлений. Пробую найти data-marker атрибуты:")
        markers = set()
        for el in soup.select('[data-marker]'):
            val = el.get("data-marker", "")
            if val:
                markers.add(val)
        if markers:
            print(f"  Найдены data-marker: {sorted(markers)[:20]}")
        else:
            title = soup.find("title")
            print(f"  <title>: {safe_text(title)[:100] if title else 'нет'}")

    return links


def download_ad_page(ad_url: str, headers: Dict[str, str], proxies: Optional[Dict[str, str]]) -> Optional[str]:
    """Скачивает страницу объявления."""
    os.makedirs(PAGES_DIR, exist_ok=True)
    filename = re.sub(r'[^\w\-_\.]', '_', ad_url.split("/")[-1] or "ad") + ".html"
    filepath = os.path.join(PAGES_DIR, filename)

    try:
        fetch_options: Dict[str, Any] = {
            "headers": headers,
            "timeout": 30,
        }
        if proxies:
            fetch_options["proxies"] = proxies

        resp = spy_fetch(ad_url, fetch_options)
        if not resp.ok:
            print(f"  Ошибка загрузки объявления: HTTP {resp.status_code}")
            return None

        html = resp.text
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(html)
        return filepath
    except Exception as err:
        print(f"  Ошибка загрузки объявления: {err}")
        return None


def extract_next_page_url(html: str, current_url: str) -> Optional[str]:
    """Извлекает URL следующей страницы пагинации."""
    soup = BeautifulSoup(html, "lxml")

    # data-marker="pagination-button/nextPage"
    next_btn = soup.select_one('a[data-marker="pagination-button/nextPage"]')
    if next_btn and safe_attr(next_btn, "href"):
        return urljoin(current_url, safe_attr(next_btn, "href"))

    # rel="next"
    rel_next = soup.select_one('a[rel="next"]')
    if rel_next and safe_attr(rel_next, "href"):
        return urljoin(current_url, safe_attr(rel_next, "href"))

    # aria-label с «Следующая» / «Next»
    for a in soup.select('a[aria-label]'):
        label = a.get("aria-label", "").lower()
        if "следующая" in label or "next" in label:
            href = safe_attr(a, "href")
            if href:
                return urljoin(current_url, href)

    # Числовые ссылки пагинации data-marker="pagination-button/page(N)"
    parsed = urlparse(current_url)
    qs = parse_qs(parsed.query)
    current_p = int(qs.get("p", ["1"])[0])
    page_links = []
    for a in soup.select('a[data-marker^="pagination-button/page"]'):
        marker = a.get("data-marker", "")
        m = re.search(r'page\((\d+)\)', marker)
        if m:
            p = int(m.group(1))
            if p > current_p:
                page_links.append((p, safe_attr(a, "href")))
    if page_links:
        page_links.sort()
        return urljoin(current_url, page_links[0][1])

    # Конструируем URL с параметром p=next
    next_p = current_p + 1
    new_qs = parse_qs(parsed.query)
    new_qs["p"] = [str(next_p)]
    new_url = urlunparse((
        parsed.scheme, parsed.netloc, parsed.path,
        parsed.params, urlencode(new_qs, doseq=True), parsed.fragment,
    ))
    return new_url


# ═══════════════════════════════════════════════════════════════════
# Парсинг полей объявления
# ═══════════════════════════════════════════════════════════════════

def parse_ad_page(filepath: str, ad_url: str) -> Dict[str, str]:
    """Парсит HTML объявления и возвращает словарь полей."""
    with open(filepath, "r", encoding="utf-8") as f:
        html = f.read()

    soup = BeautifulSoup(html, "lxml")
    record: Dict[str, str] = {}

    # ID из URL (несколько вариантов)
    m = re.search(r'_(\d{7,12})(?:\?|$|_)', ad_url)  # avito.ru/..._1234567890
    if not m:
        m = re.search(r'/(\d{7,12})(?:/|$|\?|#)', ad_url)  # avito.ru/.../1234567890
    if not m:
        m = re.search(r'/(\d+)(?:_|$)', ad_url)
    record["item_id"] = m.group(1) if m else str(hash(ad_url) & 0x7fffffff)
    record["url"] = ad_url
    record["parsed_at"] = datetime.now(timezone.utc).isoformat()

    # Заголовок
    title_el = soup.select_one('h1[data-marker="item-view/title-info"]')
    record["title"] = safe_text(title_el)

    # Цена
    price_el = soup.select_one('span[data-marker="item-view/item-price"]')
    price_text = safe_text(price_el)
    record["price"] = re.sub(r'[^\d]', '', price_text)

    # Цена за м²
    price_per_m2_el = soup.select_one('span[data-marker="item-view/item-price-per-area"]')
    price_per_m2_text = safe_text(price_per_m2_el)
    record["price_per_m2"] = re.sub(r'[^\d]', '', price_per_m2_text)

    # Адрес (несколько резервных селекторов)
    addr_el = soup.select_one('span[data-marker="item-view/item-address"]')
    if not addr_el:
        addr_el = soup.select_one('span[class*="address"]') or soup.select_one('div[class*="address"]')
    if not addr_el:
        addr_el = soup.select_one('[itemprop="address"]') or soup.select_one('.item-address__string')
    if not addr_el:
        # Пробуем найти любой элемент содержащий "Москва" или "Санкт-Петербург"
        for el in soup.select('span, div, p'):
            text = safe_text(el)
            if any(city in text for city in ['Москва', 'Санкт-Петербург', 'мкр', 'район', 'ул.', 'улица', 'проспект', 'шоссе']):
                addr_el = el
                break
    record["address"] = safe_text(addr_el)
    if not record["address"]:
        # Последний fallback: можно спарсить из breadcrumbs
        bc = soup.select_one('div[class*="breadcrumbs"]') or soup.select_one('nav[aria-label="breadcrumbs"]')
        if bc:
            parts = [safe_text(a) for a in bc.select('a, span') if safe_text(a)]
            record["address"] = ', '.join(parts) if parts else ""

    # Метро
    metro_spans = soup.select('span._22d8cf68e753a9b9')
    metro_parts = []
    for span in metro_spans:
        child_spans = span.find_all('span', recursive=False)
        name = safe_text(child_spans[1]) if len(child_spans) >= 2 else ''
        time_el = span.select_one('span._975960bc91729d0a')
        walking_time = safe_text(time_el)
        if name and walking_time:
            metro_parts.append(f'{name}:{walking_time}')
        else:
            metro_parts.append(name or walking_time)
    record["metro"] = ', '.join(filter(None, metro_parts))

    # Описание
    desc_el = soup.select_one('div[data-marker="item-view/item-description"]')
    record["description"] = safe_text(desc_el)

    # Дата публикации
    date_el = soup.select_one('span[data-marker="item-view/item-date"]')
    record["listing_date"] = safe_text(date_el)

    # Просмотры
    views_total_el = soup.select_one('span[data-marker="item-view/total-views"]')
    record["views_total"] = safe_text(views_total_el)
    views_today_el = soup.select_one('span[data-marker="item-view/today-views"]')
    record["views_today"] = safe_text(views_today_el)

    # Продавец
    seller_name_el = soup.select_one('span[data-marker="item-view/seller-name"]')
    record["seller_name"] = safe_text(seller_name_el)
    if not record["seller_name"]:
        seller_link = soup.select_one('a[data-marker="item-view/seller-link"]')
        record["seller_name"] = safe_text(seller_link)
    seller_type_el = soup.select_one('div[data-marker="seller-type-label"] span')
    record["seller_type"] = safe_text(seller_type_el)

    # Характеристики квартиры
    flat_params = {}
    for row in soup.select('li[data-marker="item-view/item-flat-params"]'):
        label_el = row.select_one('span[data-marker="item-view/item-flat-params-label"]')
        value_el = row.select_one('span[data-marker="item-view/item-flat-params-value"]')
        if label_el and value_el:
            flat_params[safe_text(label_el)] = safe_text(value_el)
    record["flat_params"] = json.dumps(flat_params, ensure_ascii=False) if flat_params else ""

    # Характеристики дома
    house_params = {}
    for row in soup.select('li[data-marker="item-view/item-house-params"]'):
        label_el = row.select_one('span[data-marker="item-view/item-house-params-label"]')
        value_el = row.select_one('span[data-marker="item-view/item-house-params-value"]')
        if label_el and value_el:
            house_params[safe_text(label_el)] = safe_text(value_el)
    record["house_params"] = json.dumps(house_params, ensure_ascii=False) if house_params else ""

    # Росреестр
    rosreestr = {}
    rosreestr_block = soup.select_one('div[data-marker="item-view/rosreestr-info"]')
    if rosreestr_block:
        for item in rosreestr_block.select('div, p, span'):
            text = safe_text(item)
            if text and ':' in text:
                k, v = text.split(':', 1)
                rosreestr[k.strip()] = v.strip()
    record["rosreestr"] = json.dumps(rosreestr, ensure_ascii=False) if rosreestr else ""

    return record


# ═══════════════════════════════════════════════════════════════════
# Главный цикл
# ═══════════════════════════════════════════════════════════════════

def main():
    search_url = None
    if len(sys.argv) > 1:
        search_url = sys.argv[1]
    else:
        search_url = AVITO_SEARCH_URL

    if not search_url:
        print("[Avito] Укажите URL поиска:")
        print("  python clients/avito/run.py \"https://www.avito.ru/moskva/kvartiry/prodam\"")
        print("  или задайте AVITO_SEARCH_URL в clients/avito/.env")
        sys.exit(1)

    max_pages = AVITO_MAX_PAGES
    if len(sys.argv) > 2:
        max_pages = int(sys.argv[2])

    # Инициализация клиента
    print(f"[Avito] Сервер: {SERVER_URL}")
    client = AvitoClient(server_url=SERVER_URL, client_id="avito")

    if not client.health_check():
        print("[Avito] ⚠ Сервер недоступен! Запустите сервер:")
        print("  python server/main.py")
        print("[Avito] Продолжаю без отправки на сервер (данные будут только локально).")
        client = None
    else:
        client.register()

    os.makedirs(PAGES_DIR, exist_ok=True)

    headers = prepare_headers()
    proxies = prepare_proxies()

    current_url: Optional[str] = search_url
    page_num = 0
    all_records: List[Dict[str, str]] = []
    processed_urls: set = set()

    # Цикл по страницам поиска
    while current_url:
        if max_pages > 0 and page_num >= max_pages:
            break

        page_num += 1
        print(f"\n{'='*60}")
        print(f"[Avito] Страница поиска {page_num}: {current_url}")

        # Шаг 1: Загружаем страницу поиска
        html = download_search_page(current_url, headers, proxies, page_num)
        if not html:
            print("[Avito] Не удалось загрузить страницу поиска.")
            break

        # Шаг 2: Извлекаем ссылки на объявления
        ad_links = extract_ad_links(html, current_url)
        print(f"[Avito] Найдено объявлений: {len(ad_links)}")

        new_links = [url for url in ad_links if url not in processed_urls]

        if not new_links:
            print("[Avito] Новых объявлений нет.")
        else:
            for i, ad_url in enumerate(new_links):
                print(f"  [{i + 1}/{len(new_links)}] {ad_url}")

                if ad_url in processed_urls:
                    continue
                processed_urls.add(ad_url)

                filepath = download_ad_page(ad_url, headers, proxies)
                if not filepath:
                    continue

                try:
                    record = parse_ad_page(filepath, ad_url)
                    all_records.append(record)
                    print(f"    ✓ {record.get('title', '')[:60]}")
                except Exception as err:
                    print(f"    ✗ Ошибка парсинга: {err}")

                try:
                    if os.path.isfile(filepath):
                        os.remove(filepath)
                except OSError as err:
                    print(f"    Не удалось удалить {filepath}: {err}")

                # Отправляем пачку на сервер
                if client and len(all_records) >= SEND_BATCH_SIZE:
                    client.send_records(all_records)
                    all_records.clear()

                time.sleep(random.uniform(3, 6))

        # Следующая страница
        next_url = extract_next_page_url(html, current_url)
        if next_url and next_url != current_url:
            current_url = next_url
            time.sleep(3)
        else:
            print("[Avito] Больше страниц нет.")
            break

    # Отправляем оставшиеся записи
    if client and all_records:
        client.send_records(all_records)
        all_records.clear()

    print(f"\n[Avito] ✅ Готово. Обработано страниц: {page_num}")


if __name__ == "__main__":
    main()