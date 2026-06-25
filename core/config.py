"""
Класс-синглтон для работы с конфигурацией.
"""
import os
import yaml
from typing import Any, Dict, List, Optional


class AppConfig:
    """Конфигурация приложения"""
    __slots__ = ("important_locations", "cian_search", "avito_disk_path", "log_level")

    def __init__(
        self,
        important_locations: Optional[List[Dict[str, str]]] = None,
        cian_search: Optional[Dict[str, Any]] = None,
        avito_disk_path: str = "",
        log_level: str = "info",
    ):
        self.important_locations = important_locations or []
        self.cian_search = cian_search or {}
        self.avito_disk_path = avito_disk_path
        self.log_level = log_level


DEFAULT_CONFIG = AppConfig(
    important_locations=[
        {"name": "Офис", "lat": "55.751017", "lon": "37.617261"},
        {"name": "Храм", "lat": "55.744635", "lon": "37.605634"},
    ],
    cian_search={
        "maxPrice": 50_000,
        "minPrice": 0,
        "geo": [0, 1, 2],
        "regions": [1],
    },
    avito_disk_path="/root/utils/avito-export",
    log_level="info",
)


def _config_to_dict(config: AppConfig) -> Dict[str, Any]:
    """Преобразует AppConfig в словарь для сериализации"""
    return {
        "importantLocations": config.important_locations,
        "cianSearch": config.cian_search,
        "avitoDiskPath": config.avito_disk_path,
        "logLevel": config.log_level,
    }


def _dict_to_config(data: Dict[str, Any]) -> AppConfig:
    """Преобразует словарь в AppConfig"""
    return AppConfig(
        important_locations=data.get("importantLocations", []),
        cian_search=data.get("cianSearch", {}),
        avito_disk_path=data.get("avitoDiskPath", ""),
        log_level=data.get("logLevel", "info"),
    )


class Config:
    """Класс-синглтон для работы с конфигурацией."""

    _path: str = "./conf/conf.yml"
    _instance: Optional[AppConfig] = None

    @classmethod
    def get(cls) -> AppConfig:
        """Получить актуальную конфигурацию (ленивая загрузка)."""
        if cls._instance is None:
            cls._load()
        return cls._instance

    @classmethod
    def reload(cls) -> AppConfig:
        """Принудительно перечитать файл с диска."""
        cls._load()
        return cls._instance

    @classmethod
    def _load(cls) -> None:
        """Внутренняя логика чтения/merge/сохранения."""
        if not os.path.exists(cls._path):
            # Файл отсутствует — создаём целиком из дефолтов
            os.makedirs(os.path.dirname(cls._path), exist_ok=True)
            default_dict = _config_to_dict(DEFAULT_CONFIG)
            with open(cls._path, "w", encoding="utf-8") as f:
                yaml.dump(default_dict, f, allow_unicode=True, default_flow_style=False, sort_keys=False)
            cls._instance = DEFAULT_CONFIG
            return

        with open(cls._path, "r", encoding="utf-8") as f:
            text = f.read()

        parsed: Dict[str, Any] = {}
        if text.strip():
            try:
                loaded = yaml.safe_load(text)
                if isinstance(loaded, dict):
                    parsed = loaded
            except yaml.YAMLError as err:
                print(f"[Config] YAML parse error, используя defaults {err}")

        # Глубокий merge
        merged = cls._deep_merge(_config_to_dict(DEFAULT_CONFIG), parsed)
        cls._instance = _dict_to_config(merged)

        # Аккуратно дописываем недостающие ключи (без перезаписи если не изменилось)
        updated_dict = cls._apply_defaults_to_dict(_config_to_dict(DEFAULT_CONFIG), parsed)
        updated_yaml = yaml.dump(updated_dict, allow_unicode=True, default_flow_style=False, sort_keys=False)
        if updated_yaml != text:
            with open(cls._path, "w", encoding="utf-8") as f:
                f.write(updated_yaml)

    @staticmethod
    def _deep_merge(defaults: Dict[str, Any], provided: Dict[str, Any]) -> Dict[str, Any]:
        """deepMerge строит итоговый объект конфигурации."""
        result: Dict[str, Any] = {}

        for key in defaults:
            if key in provided:
                def_val = defaults[key]
                prov_val = provided[key]
                if isinstance(def_val, dict) and isinstance(prov_val, dict):
                    result[key] = Config._deep_merge(def_val, prov_val)
                elif isinstance(def_val, list) and isinstance(prov_val, list):
                    # Для списков используем provided если он не пуст
                    result[key] = prov_val if prov_val else def_val
                else:
                    result[key] = prov_val
            else:
                result[key] = defaults[key]

        return result

    @staticmethod
    def _apply_defaults_to_dict(defaults: Dict[str, Any], provided: Dict[str, Any]) -> Dict[str, Any]:
        """Добавляет недостающие ключи в словарь на основе defaults."""
        result = dict(provided)
        for key, def_val in defaults.items():
            if key not in result:
                result[key] = def_val
            elif isinstance(def_val, dict) and isinstance(result.get(key), dict):
                result[key] = Config._apply_defaults_to_dict(def_val, result[key])
        return result