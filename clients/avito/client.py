"""
HTTP-клиент для отправки спаршенных данных Авито на сервер-аккумулятор.

При запуске:
  1. Регистрируется на сервере (POST /register)
  2. Ждёт появления данных
  3. Отправляет их пачками (POST /ingest)

Может работать как отдельный процесс на любой машине.
"""

from __future__ import annotations

import os
import sys
import time
import json
import requests
from typing import List, Dict

# Добавляем путь к общим модулям
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from dotenv import load_dotenv

# Загружаем .env из папки клиента (clients/avito/.env)
_env_dir = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(_env_dir, ".env"))

SERVER_URL = os.getenv("SERVER_URL", "http://localhost:8000").rstrip("/")
CLIENT_ID = os.getenv("CLIENT_ID", "avito")


class AvitoClient:
    """Клиент для отправки данных Авито на сервер."""

    def __init__(self, server_url: str = None, client_id: str = None):
        self.server_url = server_url or SERVER_URL
        self.client_id = client_id or CLIENT_ID
        self.registered = False

    def register(self) -> bool:
        """Регистрирует клиента на сервере."""
        try:
            resp = requests.post(
                f"{self.server_url}/register",
                json={"client_id": self.client_id, "client_type": "avito"},
                timeout=10,
            )
            if resp.status_code == 200:
                print(f"[Client] Зарегистрирован на сервере {self.server_url}: {resp.json()}")
                self.registered = True
                return True
            else:
                print(f"[Client] Ошибка регистрации: {resp.status_code} {resp.text}")
                return False
        except Exception as e:
            print(f"[Client] Не удалось подключиться к серверу: {e}")
            return False

    def send_records(self, records: List[Dict[str, str]]) -> bool:
        """
        Отправляет список записей на сервер.

        records — список словарей с полями ListingRecord.
        Возвращает True при успехе.
        """
        if not records:
            return True

        if not self.registered:
            if not self.register():
                return False

        try:
            resp = requests.post(
                f"{self.server_url}/ingest",
                json={"client_id": self.client_id, "records": records},
                timeout=30,
            )
            if resp.status_code == 200:
                data = resp.json()
                print(
                    f"[Client] Отправлено {len(records)} записей → "
                    f"новых: {data.get('new', 0)}, обновлено: {data.get('updated', 0)}"
                )
                return True
            else:
                print(f"[Client] Ошибка отправки: {resp.status_code} {resp.text}")
                return False
        except Exception as e:
            print(f"[Client] Ошибка сети: {e}")
            return False

    def send_record(self, record: Dict[str, str]) -> bool:
        """Отправляет одну запись (обёртка)."""
        return self.send_records([record])

    def health_check(self) -> bool:
        """Проверяет доступность сервера."""
        try:
            resp = requests.get(f"{self.server_url}/health", timeout=5)
            return resp.status_code == 200
        except Exception:
            return False


# ── Тестовый запуск ──────────────────────────────────────────────

if __name__ == "__main__":
    print(f"[Client] Сервер: {SERVER_URL}")
    print(f"[Client] ID: {CLIENT_ID}")

    client = AvitoClient()

    if client.health_check():
        print("[Client] Сервер доступен")
    else:
        print("[Client] Сервер недоступен, запустите сначала сервер:")
        print("  python server/main.py")
        sys.exit(1)

    if client.register():
        # Тестовая запись
        test_record = {
            "item_id": "test_001",
            "url": "https://www.avito.ru/test",
            "title": "Тестовая квартира",
            "price": "10000000",
            "price_per_m2": "200000",
            "address": "Москва, ул. Тверская, д. 1",
            "metro": "Охотный ряд:5 мин.",
            "description": "Тестовое объявление",
            "listing_date": "2026-07-01",
            "views_total": "100",
            "views_today": "10",
            "flat_params": '{"rooms": 3, "area": 50}',
            "house_params": '{"floors": 9, "type": "кирпичный"}',
            "rosreestr": '{"owners": 1}',
            "parsed_at": "2026-07-01T17:00:00",
        }
        client.send_record(test_record)
        print("[Client] Тестовая запись отправлена")