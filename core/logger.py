"""
Logger с поддержкой уровней логирования из конфига.
"""
from datetime import datetime, timezone
from core.config import Config

_level: int = 2  # info по умолчанию
_initialized: bool = False


def _get_level() -> int:
    """Получить числовой уровень из конфига"""
    try:
        config = Config.get()
        level_map = {
            "trace": 4,
            "debug": 3,
            "info": 2,
            "warn": 1,
            "error": 0,
        }
        return level_map.get(config.log_level, 2)
    except Exception:
        return 2


def _ensure_level() -> None:
    """Инициализировать уровень при первом использовании"""
    global _level, _initialized
    if not _initialized:
        _level = _get_level()
        _initialized = True


def _pfx(log_type: str) -> str:
    """Префикс с временной меткой"""
    return f"[{datetime.now(timezone.utc).isoformat()}] [{log_type}]"


def log_trace(msg, *args) -> None:
    _ensure_level()
    if _level >= 4:
        print(_pfx("trace"), msg, *args)


def log_debug(msg, *args) -> None:
    _ensure_level()
    if _level >= 3:
        print(_pfx("debug"), msg, *args)


def log_info(msg, *args) -> None:
    _ensure_level()
    if _level >= 2:
        print(_pfx("info"), msg, *args)


def log_warn(msg, *args) -> None:
    _ensure_level()
    if _level >= 1:
        print(_pfx("warn"), msg, *args)


def log_error(msg, *args) -> None:
    _ensure_level()
    if _level >= 0:
        print(_pfx("error"), msg, *args)