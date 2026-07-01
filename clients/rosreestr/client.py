"""Клиент Росреестр — заглушка. Реальная реализация будет добавлена позже."""
import os, sys, requests
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, _PROJECT_ROOT)
from dotenv import load_dotenv
_env_dir = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(_env_dir, ".env"))
SERVER_URL = os.getenv("SERVER_URL", "http://localhost:8000").rstrip("/")

class RosreestrClient:
    def __init__(self, server_url=None, client_id="rosreestr"):
        self.server_url = server_url or SERVER_URL
        self.client_id = client_id
    def register(self) -> bool:
        try:
            r=requests.post(f"{self.server_url}/register",json={"client_id":self.client_id,"client_type":"rosreestr"},timeout=10); return r.status_code==200
        except: return False
    def send_record(self, rec):requests.post(f"{self.server_url}/ingest",json={"client_id":self.client_id,"records":[rec]},timeout=30)
    def health_check(self)->bool:
        try: return requests.get(f"{self.server_url}/health",timeout=5).status_code==200
        except: return False