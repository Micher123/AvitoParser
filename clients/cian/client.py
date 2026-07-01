"""
Клиент Циан — заглушка.

Отправляет тестовые данные на сервер-аккумулятор.
Реальная реализация парсера будет добавлена позже.
"""

import os
import sys
import requests

# Добавляем корень проекта
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, _PROJECT_ROOT)

from dotenv import load_dotenv

_env_dir = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(_env_dir, ".env"))

SERVER_URL = os.getenv("SERVER_URL", "http://localhost:8000").rstrip("/")
CLIENT_ID = os.getenv("CLIENT_ID", "cian")


class CianClient:
    """Заглушка клиента Циан."""

    def __init__(self, server_url: str = None, client_id: str = None):
        self.server_url = server_url or SERVER_URL
        self.client_id = client_id or CLIENT_ID
        self.registered = False

    def register(self) -> bool:
        try:
            resp = requests.post(
                f"{self.server_url}/register",
                json={"client_id": self.client_id, "client_type": "cian"},
                timeout=10,
            )
            if resp.status_code == 200:
                print(f"[Cian] Зарегистрирован на сервере {self.server_url}")
                self.registered = True
                return True
            return False
        except Exception as e:
            print(f"[Cian] Ошибка: {e}")
            return False

    def send_record(self, record: dict) -> bool:
        if not self.registered:
            if not self.register():
                return False
        try:
            resp = requests.post(
                f"{self.server_url}/ingest",
                json={"client_id": self.client_id, "records": [record]},
                timeout=30,
            )
            return resp.status_code == 200
        except Exception:
            return False

    def health_check(self) -> bool:
        try:
            return requests.get(f"{self.server_url}/health", timeout=5).status_code == 200
        except Exception:
            return False


if __name__ == "__main__":
    print(f"[Cian] Сервер: {SERVER_URL}")
    client = CianClient()
    if client.health_check():
        client.register()
        # TODO: Реальная реализация парсера Циан
        print("[Cian] Заглушка — парсер в разработке")
    else:
        print("[Cian] Сервер недоступен")