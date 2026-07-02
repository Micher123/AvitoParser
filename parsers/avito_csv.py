"""
Парсер Avito по алгоритму:
1. Загрузить страницу поиска
2. Извлечь ссылки на объявления
3. Загрузить каждое объявление
4. DOM-парсинг полей
5. Записать в TSV
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

from bs4 import BeautifulSoup, Tag

from csv_writer import ListingRecord, empty_record, append_to_csv, OUTPUT_DIR
from core.env import AVITO_COOKIES_FILE, AVITO_COOKIE, AVITO_PROXY
from utils.cookies_parser import (
    parse_cookies_file,
    merge_cookies,
    get_user_agent,
    ParsedCookies,
)
from utils.spy_fetch import spy_fetch

# Константы
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_ROOT_DIR = os.path.dirname(_THIS_DIR)
PAGES_DIR = os.path.join(_ROOT_DIR, "Pages")
CSV_FILE = "avito_listings.csv"
DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/138.0.0.0 Safari/537.36"
)


# ═══════════════════════════════════════════════════════════════════
# Утилиты
# ═══════════════════════════════════════════════════════════════════

def safe_text(el: Optional[Tag], default: str = "") -> str:
    """Безопасное извлечение текста из элемента"""
    if el is None:
        return default
    return el.get_text(strip=True)


def safe_attr(el: Optional[Tag], attr: str, default: str = "") -> str:
    """Безопасное извлечение атрибута"""
    if el is None:
        return default
    return (el.get(attr) or default).strip()


def strip_tabs(text: str) -> str:
    """Удаляет табуляции из текста"""
    return text.replace("\t", " ").replace("\n", " ").replace("\r", "")


def extract_number(text: str) -> str:
    """Извлекает числовое значение из строки (убирает пробелы, символы валют)"""
    if not text:
        return ""
    # Удаляем всё кроме цифр, точки и запятой
    cleaned = re.sub(r"[^\d.,]", "", text)
    cleaned = cleaned.replace(",", ".")
    return cleaned


def extract_number_int(text: str) -> str:
    """Извлекает целое число из строки"""
    if not text:
        return ""
    match = re.search(r"\d+", text.replace(" ", ""))
    return match.group(0) if match else ""


# ═══════════════════════════════════════════════════════════════════
# Шаг 1: Загрузка страницы поиска и извлечение ссылок
# ═══════════════════════════════════════════════════════════════════


def download_search_page(
    url: str,
    headers: Dict[str, str],
    proxies: Optional[Dict[str, str]],
    page_num: int = 1,
) -> str:
    """
    Загружает HTML страницы поиска и сохраняет в Pages/.
    Возвращает HTML содержимое.
    """
    os.makedirs(PAGES_DIR, exist_ok=True)

    try:
        fetch_options: Dict[str, Any] = {
            "headers": headers,
            "timeout": 30,
        }
        if proxies:
            fetch_options["proxies"] = proxies

        resp = spy_fetch(url, fetch_options)
        html = resp.text

        # Сохраняем в Pages
        filename = f"search_page_{page_num:04d}.html"
        filepath = os.path.join(PAGES_DIR, filename)
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(html)

        print(f"[Avito] Страница поиска сохранена: {filepath}")
        return html

    except Exception as err:
        print(f"[Avito] Ошибка загрузки страницы поиска: {err}")
        return ""


def extract_ad_links(html: str) -> List[str]:
    """
    Шаг 2: Извлекает ссылки на объявления.
    Основной способ: a[data-marker="item-title"] → href.
    Запасной: div[data-marker="item"] → data-item-id → собираем URL.
    """
    soup = BeautifulSoup(html, "lxml")
    links: List[str] = []

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

    return links


def extract_next_page_url(html: str, base_url: str) -> Optional[str]:
    """
    Извлекает ссылку на следующую страницу пагинации по алгоритму (шаги 8-14).

    Поиск по data-marker атрибутам Avito во всём документе
    (pagination-button/nextPage, pagination-button/page(N)),
    с запасными вариантами по aria-label и тексту.
    """
    soup = BeautifulSoup(html, "lxml")

    # ── Шаг 9: Прямая ссылка «Следующая страница» ──

    # 9.1: data-marker="pagination-button/nextPage" (основной для Avito)
    next_link = soup.select_one('[data-marker="pagination-button/nextPage"]')
    if next_link:
        href = safe_attr(next_link, "href")
        if href and href != "#" and not href.lower().startswith("javascript:"):
            return _normalize_url(href, base_url)

    # 9.2: rel="next"
    next_link = soup.select_one('a[rel="next"]')
    if next_link:
        href = safe_attr(next_link, "href")
        if href and href != "#" and not href.lower().startswith("javascript:"):
            return _normalize_url(href, base_url)

    # 9.3: aria-label с "Следующая", "Next"
    for link in soup.select("a"):
        aria = safe_attr(link, "aria-label").strip().lower()
        if "следующ" in aria or "next" in aria:
            href = safe_attr(link, "href")
            if href and href != "#" and not href.lower().startswith("javascript:"):
                return _normalize_url(href, base_url)

    # 9.4: класс с next / forward / arrow-right
    next_link = soup.select_one(
        'a[class*="next"], a[class*="forward"], a[class*="arrow-right"]'
    )
    if next_link:
        href = safe_attr(next_link, "href")
        if href and href != "#" and not href.lower().startswith("javascript:"):
            return _normalize_url(href, base_url)

    # 9.5: текст «Вперёд», «Далее», «Next», «Следующая», «→»
    for link in soup.select("a"):
        text = safe_text(link).strip().lower()
        if text in ("вперёд", "далее", "next", "следующая", "→"):
            href = safe_attr(link, "href")
            if href and href != "#" and not href.lower().startswith("javascript:"):
                return _normalize_url(href, base_url)

    # ── Шаг 10-11: Числовые страницы ──

    # Определяем текущую страницу из URL
    current_page = _extract_page_param(base_url)

    # Собираем все ссылки на страницы по data-marker="pagination-button/page(N)"
    page_links: Dict[int, str] = {}
    for link in soup.select('[data-marker^="pagination-button/page"]'):
        marker = safe_attr(link, "data-marker")
        match = re.search(r"page\((\d+)\)", marker)
        if match:
            pn = int(match.group(1))
            href = safe_attr(link, "href")
            if href and href != "#" and not href.lower().startswith("javascript:"):
                page_links[pn] = urljoin(base_url, href)

    # Также ищем по aria-label="Страница N"
    if not page_links:
        for link in soup.select('a[aria-label^="Страница"]'):
            label = safe_attr(link, "aria-label")
            match = re.search(r"(\d+)", label)
            if match:
                pn = int(match.group(1))
                href = safe_attr(link, "href")
                if href and href != "#":
                    page_links[pn] = urljoin(base_url, href)

    # Страница +1
    if (current_page + 1) in page_links:
        return page_links[current_page + 1]

    # Ближайшая > current
    candidates = sorted(p for p in page_links if p > current_page)
    if candidates:
        return page_links[candidates[0]]

    # ── Шаг 10: Найти последнюю страницу и сконструировать URL ──
    if page_links:
        last_page = max(page_links.keys())
        if last_page > current_page:
            return _build_page_url(base_url, current_page + 1)

    # ── Шаг 13: Следующей страницы нет ──
    return None


def _normalize_url(href: str, base_url: str) -> str:
    """Дополняет относительный путь протоколом и доменом"""
    return urljoin(base_url, href)


def _extract_page_param(url: str) -> int:
    """Извлекает номер страницы из параметра p в URL"""
    try:
        parsed = urlparse(url)
        qs = parse_qs(parsed.query)
        if "p" in qs:
            return int(qs["p"][0])
    except (ValueError, TypeError):
        pass
    return 1


def _build_page_url(base_url: str, page_num: int) -> str:
    """Строит URL с параметром p=page_num"""
    parsed = urlparse(base_url)
    qs = parse_qs(parsed.query)
    qs["p"] = [str(page_num)]
    new_query = urlencode(qs, doseq=True)
    return urlunparse(parsed._replace(query=new_query))


# ═══════════════════════════════════════════════════════════════════
# Шаг 3-4: Загрузка и парсинг страницы объявления
# ═══════════════════════════════════════════════════════════════════


def download_ad_page(
    url: str,
    headers: Dict[str, str],
    proxies: Optional[Dict[str, str]],
) -> Optional[str]:
    """
    Загружает HTML страницы объявления и сохраняет в Pages/.
    Возвращает путь к сохранённому файлу.
    """
    os.makedirs(PAGES_DIR, exist_ok=True)

    try:
        fetch_options: Dict[str, Any] = {
            "headers": headers,
            "timeout": 30,
        }
        if proxies:
            fetch_options["proxies"] = proxies

        resp = spy_fetch(url, fetch_options)
        html = resp.text

        # Имя файла — item_id из URL
        item_id_match = re.search(r"_([a-zA-Z0-9]+)$", url.rstrip("/"))
        item_id = item_id_match.group(1) if item_id_match else f"ad_{int(time.time())}"

        filename = f"ad_{item_id}.html"
        filepath = os.path.join(PAGES_DIR, filename)
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(html)

        print(f"    Сохранено: {filepath}")
        return filepath

    except Exception as err:
        print(f"    Ошибка загрузки объявления: {err}")
        return None


def parse_ad_page(filepath: str, ad_url: str) -> ListingRecord:
    """
    Шаг 4: DOM-парсинг страницы объявления.
    Возвращает заполненную ListingRecord.
    """
    with open(filepath, "r", encoding="utf-8") as f:
        html = f.read()

    soup = BeautifulSoup(html, "lxml")
    record = empty_record()
    record.url = ad_url
    record.parsed_at = datetime.now(timezone.utc).isoformat()

    # ── 1. Заголовок ──
    h1_el = soup.select_one('h1[data-marker="item-view/title-info"]')
    record.title = safe_text(h1_el)

    # ── 2. Полная цена ──
    price_el = soup.select_one('span[id="bx_item-price-value"]')
    if not price_el:
        price_el = soup.select_one('span[data-marker="item-view/item-price"]')
    record.price = extract_number(safe_text(price_el))

    # ── 3. Цена за м² ──
    ppm_el = soup.select_one("p.d870ed3c55f3c0c1")
    # Класс может меняться, пробуем найти по паттерну
    if not ppm_el:
        # Ищем p внутри блока цены, содержащий "м²"
        price_block = soup.select_one('[data-marker="item-view/item-price"]')
        if price_block:
            for p in price_block.find_all("p"):
                if "м²" in safe_text(p):
                    ppm_el = p
                    break
    record.price_per_m2 = extract_number(safe_text(ppm_el))

    # ── 4. Адрес ──
    addr_container = soup.select_one('div[itemprop="address"], div[itemProp="address"]')
    if addr_container:
        addr_span = addr_container.select_one("span._8360df6eedcf8d52")
        if not addr_span:
            # Запасной — любой span внутри
            addr_span = addr_container.find("span")
        record.address = safe_text(addr_span)

    # ── 5. Метро (читаемый формат: "Станция:время, Станция:время, ...") ──
    metro_spans = soup.select("span._22d8cf68e753a9b9")
    metro_parts: List[str] = []
    for span in metro_spans:
        # Название станции — второй span (первый — иконка цвета, без текста)
        child_spans = span.find_all("span", recursive=False)
        name = safe_text(child_spans[1]) if len(child_spans) >= 2 else ""

        # Время пешком — span с классом _975960bc91729d0a
        time_el = span.select_one("span._975960bc91729d0a")
        walking_time = safe_text(time_el)

        if name and walking_time:
            metro_parts.append(f"{name}:{walking_time}")
        elif name:
            metro_parts.append(name)
        elif walking_time:
            metro_parts.append(walking_time)

    record.metro = ", ".join(metro_parts)

    # ── 6. Описание ──
    desc_el = soup.select_one('div[data-marker="item-view/item-description"]')
    if desc_el:
        paragraphs = desc_el.find_all("p")
        record.description = "\n".join(safe_text(p) for p in paragraphs)
    if not record.description:
        record.description = safe_text(desc_el)

    # ── 7. ID объявления ──
    id_el = soup.select_one('span[data-marker="item-view/item-id"]')
    record.item_id = extract_number_int(safe_text(id_el))

    # ── 8. Дата публикации ──
    date_el = soup.select_one('span[data-marker="item-view/item-date"]')
    record.listing_date = safe_text(date_el)

    # ── 9. Всего просмотров ──
    total_views_el = soup.select_one('span[data-marker="item-view/total-views"]')
    record.views_total = extract_number_int(safe_text(total_views_el))

    # ── 10. Просмотров сегодня ──
    today_views_el = soup.select_one('span[data-marker="item-view/today-views"]')
    if today_views_el:
        text = safe_text(today_views_el)
        match = re.search(r"\((\d+)\)", text)
        if match:
            record.views_today = match.group(1)
        else:
            record.views_today = extract_number_int(text)

    # ── 11. Имя продавца ──
    seller_block = soup.select_one('[data-marker="seller-info"]')
    if seller_block:
        seller_name_el = seller_block.select_one("span._871bd196e38e7a53")
        record.seller_name = safe_text(seller_name_el)

    # ── 12. Статус продавца ──
    seller_label_el = soup.select_one('div[data-marker="seller-info/label"]')
    record.seller_type = safe_text(seller_label_el)

    # ── 13. Характеристики квартиры ──
    flat_params = _parse_params_block(soup, "О квартире")
    record.flat_params = json.dumps(flat_params, ensure_ascii=False)

    # ── 14. Характеристики дома ──
    house_params = _parse_params_block(soup, "О доме")
    record.house_params = json.dumps(house_params, ensure_ascii=False)

    # ── 15. Росреестр ──
    rosreestr_items: List[str] = []
    domoteka_block = soup.select_one('div[data-marker="domoteka-entry-block"]')
    if domoteka_block:
        teaser_items = domoteka_block.select('p[data-marker="TeaserData.item"]')
        for item in teaser_items:
            text = safe_text(item)
            if text:
                rosreestr_items.append(text)
    record.rosreestr = " | ".join(rosreestr_items)

    return record


def _parse_params_block(soup: BeautifulSoup, section_title: str) -> Dict[str, str]:
    """
    Извлекает параметры из блока div[id="bx_item-params"].
    section_title: "О квартире" или "О доме" — заголовок h3 внутри блока.
    """
    result: Dict[str, str] = {}

    params_blocks = soup.select('div[id="bx_item-params"]')
    for block in params_blocks:
        # Ищем h3 с нужным заголовком
        h3 = block.find("h3")
        if not h3 or section_title.lower() not in safe_text(h3).lower():
            continue

        # Извлекаем ul с классом a428a905bbb93d32
        ul = block.select_one("ul.a428a905bbb93d32")
        if not ul:
            # Запасной — любой ul
            ul = block.find("ul")

        if not ul:
            continue

        for li in ul.find_all("li"):
            # Название параметра
            name_el = li.select_one("span.d6e8fd2e3d52b32a")
            name = safe_text(name_el).rstrip(":")
            if not name:
                continue

            # Значение — текст после span, или следующий span
            value = ""
            if name_el:
                # Удаляем name_el, берём оставшийся текст
                name_el.extract()
                value = safe_text(li)
            else:
                value = safe_text(li)

            result[name] = value

    return result


# ═══════════════════════════════════════════════════════════════════
# Загрузка кук и заголовков
# ═══════════════════════════════════════════════════════════════════


def prepare_headers() -> Dict[str, str]:
    """Загружает куки и возвращает заголовки для запросов"""
    headers: Dict[str, str] = {}

    cookies_file = AVITO_COOKIES_FILE
    parsed_cookies: Optional[ParsedCookies] = None

    if cookies_file and os.path.isfile(cookies_file):
        try:
            parsed_cookies = parse_cookies_file(cookies_file)
        except RuntimeError as err:
            print(f"[Avito] {err}")

    cookie_string = merge_cookies(parsed_cookies, AVITO_COOKIE)
    user_agent = get_user_agent(parsed_cookies, DEFAULT_UA)

    if cookie_string:
        headers["Cookie"] = cookie_string
        print(f"[Avito] Загружены куки из {cookies_file}")
    else:
        print("[Avito] ⚠️ Куки не заданы. Парсинг может не работать.")

    if user_agent:
        headers["User-Agent"] = user_agent

    return headers


def prepare_proxies() -> Optional[Dict[str, str]]:
    """Настраивает прокси если задан AVITO_PROXY"""
    proxy = AVITO_PROXY
    if proxy:
        return {"http": proxy, "https": proxy}
    return None


# ═══════════════════════════════════════════════════════════════════
# Главный цикл
# ═══════════════════════════════════════════════════════════════════


def main() -> None:
    """Основная функция"""

    # Аргументы
    arg1 = sys.argv[1] if len(sys.argv) > 1 else ""
    if arg1 and arg1.startswith(("http://", "https://")):
        search_url = arg1
    else:
        search_url = os.getenv("AVITO_SEARCH_URL", "")

    if not search_url:
        print("[Avito] Укажите URL поиска первым аргументом или AVITO_SEARCH_URL в .env")
        print("[Avito] Пример: ./deploy.sh --client --avito 'https://www.avito.ru/moskva/kvartiry/prodam'")
        return

    max_pages_str = os.getenv("AVITO_MAX_PAGES", "0")
    max_pages = int(max_pages_str) if max_pages_str.isdigit() else 0

    print(f"[Avito] URL поиска: {search_url}")

    # Подготовка
    os.makedirs(PAGES_DIR, exist_ok=True)
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    headers = prepare_headers()
    proxies = prepare_proxies()

    current_url: Optional[str] = search_url
    page_num = 0
    all_records: List[ListingRecord] = []
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
        ad_links = extract_ad_links(html)
        print(f"[Avito] Найдено объявлений: {len(ad_links)}")

        # Отсеиваем дубликаты
        new_links = [url for url in ad_links if url not in processed_urls]

        if not new_links:
            print("[Avito] Новых объявлений нет.")
        else:
            # Шаг 3-6: Парсим каждое объявление
            for i, ad_url in enumerate(new_links):
                print(f"  [{i + 1}/{len(new_links)}] {ad_url}")

                if ad_url in processed_urls:
                    continue
                processed_urls.add(ad_url)

                # Шаг 3: Загружаем страницу объявления
                filepath = download_ad_page(ad_url, headers, proxies)
                if not filepath:
                    continue

                # Шаг 4: Парсим
                try:
                    record = parse_ad_page(filepath, ad_url)
                    all_records.append(record)
                    print(f"    ✓ {record.title[:60]}")
                except Exception as err:
                    print(f"    ✗ Ошибка парсинга: {err}")

                # Шаг 6: Удаляем файл объявления
                try:
                    if os.path.isfile(filepath):
                        os.remove(filepath)
                        print(f"    Удалён: {os.path.basename(filepath)}")
                except OSError as err:
                    print(f"    Не удалось удалить {filepath}: {err}")

                time.sleep(random.uniform(3, 6))


        # Следующая страница поиска
        next_url = extract_next_page_url(html, current_url)
        if next_url and next_url != current_url:
            current_url = next_url
            time.sleep(3)
        else:
            print("[Avito] Больше страниц нет.")
            break

    # Шаг 5: Финальная запись в TSV
    if all_records:
        append_to_csv(CSV_FILE, all_records)
        print(f"\n[Avito] ✅ Всего записано объявлений: {len(all_records)}")
    else:
        print("[Avito] Нет данных для записи.")


if __name__ == "__main__":
    main()