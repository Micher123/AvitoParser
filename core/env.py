"""
Переменные окружения.
"""
import os
from dotenv import load_dotenv

_loaded: bool = False


def load_env() -> None:
    """Загружает .env файл (можно вызывать повторно, загрузится один раз)"""
    global _loaded
    if _loaded:
        return
    load_dotenv()
    _loaded = True


# Автозагрузка при импорте модуля
load_env()

CIAN_SEARCH_COOKIE = os.getenv("CIAN_SEARCH_COOKIE", "")
AVITO_COOKIE = os.getenv("AVITO_COOKIE", "")
AVITO_PROXY = os.getenv("AVITO_PROXY", "")

# Авто-поиск cookies.json: сначала из .env, потом в корне проекта
_cookies_file = os.getenv("AVITO_COOKIES_FILE", "")
if not _cookies_file:
    # Ищем cookies.json в корне проекта
    # core/env.py → core/ → корень проекта
    _project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    _default_cookies = os.path.join(_project_root, "cookies.json")
    if os.path.isfile(_default_cookies):
        _cookies_file = _default_cookies
AVITO_COOKIES_FILE = _cookies_file

# ─── HTTP retry delays (в секундах) ──────────────────────
HTTP_RETRY_DELAYS: dict[int, int] = {}
for _status in (403, 429, 502, 504):
    _val = os.getenv(f"HTTP_RETRY_{_status}", "")
    if _val and _val.isdigit():
        HTTP_RETRY_DELAYS[_status] = int(_val)
# Значения по умолчанию, если не заданы в .env
HTTP_RETRY_DELAYS.setdefault(403, 180)
HTTP_RETRY_DELAYS.setdefault(429, 180)
HTTP_RETRY_DELAYS.setdefault(502, 900)
HTTP_RETRY_DELAYS.setdefault(504, 900)
