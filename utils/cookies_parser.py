"""
Парсер cookies.json (экспорт из Firefox / браузерных расширений)

Формат:
{
  "cookieManagerVersion": "1.8",
  "userAgent": "Mozilla/5.0 ...",
  "cookies": [
    {
      "name": "srv_id",
      "value": "FjFDBl...",
      "domain": ".avito.ru",
      ...
    },
    ...
  ]
}

Результат:
  cookie_string — строка для HTTP-заголовка Cookie (name=value; ...)
  user_agent   — User-Agent из файла (опционально)
"""
import json
from typing import Dict, List, Optional


class ParsedCookies:
    """Результат парсинга cookies.json"""
    __slots__ = ("cookie_string", "user_agent", "count")

    def __init__(self, cookie_string: str, user_agent: Optional[str] = None, count: int = 0):
        self.cookie_string = cookie_string
        self.user_agent = user_agent
        self.count = count


def parse_cookies_file(file_path: str) -> ParsedCookies:
    """
    Парсит файл cookies.json и возвращает строку для HTTP-заголовка Cookie.
    """
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            raw = f.read()
    except Exception as err:
        raise RuntimeError(
            f'Не удалось прочитать файл кук "{file_path}": {err}'
        )

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        raise RuntimeError(f'Файл "{file_path}" не является валидным JSON')

    cookies: List[dict] = data.get("cookies", [])
    if not isinstance(cookies, list) or len(cookies) == 0:
        raise RuntimeError(f'В файле "{file_path}" не найдено кук (поле "cookies" пусто или отсутствует)')

    # Фильтруем: только куки для avito.ru (основной домен и www-поддомен)
    relevant_cookies: List[dict] = []
    for c in cookies:
        if not c.get("name") or c.get("value") is None:
            continue
        domain = (c.get("domain") or "").lower()
        if "avito.ru" in domain:
            relevant_cookies.append(c)

    if len(relevant_cookies) == 0:
        print(
            f'⚠️  В файле "{file_path}" нет кук для avito.ru. '
            f'Проверьте, что куки экспортированы с сайта avito.ru.'
        )

    # Склеиваем в строку: name=value; name=value; ...
    cookie_string = "; ".join(f"{c['name']}={c['value']}" for c in relevant_cookies)

    print(
        f"   Загружено кук из {file_path}: {len(relevant_cookies)} "
        f"(всего в файле: {len(cookies)})"
    )

    return ParsedCookies(
        cookie_string=cookie_string,
        user_agent=data.get("userAgent"),
        count=len(relevant_cookies),
    )


def merge_cookies(parsed: Optional[ParsedCookies], env_cookie: str) -> str:
    """
    Объединяет куки из файла и AVITO_COOKIE из .env.
    Если есть оба — куки из .env добавляются в конец строки (приоритетнее).
    """
    parts: List[str] = []

    if parsed and parsed.cookie_string:
        parts.append(parsed.cookie_string)

    if env_cookie:
        parts.append(env_cookie)

    return "; ".join(parts)


def get_user_agent(parsed: Optional[ParsedCookies], fallback: str) -> str:
    """
    Определяет User-Agent:
    1. Если в cookies.json указан — используем его
    2. Иначе возвращаем дефолтный
    """
    if parsed and parsed.user_agent:
        return parsed.user_agent
    return fallback