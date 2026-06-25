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
