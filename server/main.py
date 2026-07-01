"""
Сервер-аккумулятор AvitoParser.

Принимает данные от клиентов-парсеров (Авито, Циан, Яндекс.Карты, Росреестр),
сопоставляет их по адресу, смерживает в единую запись и экспортирует в TSV.

Запуск:
    python -m uvicorn server.main:app --host 0.0.0.0 --port 8000 --reload

    или просто:
    python server/main.py
"""

from __future__ import annotations

import sys
import os

# Добавляем корень проекта в путь
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Dict, Any, Optional

from server.models import register_client, ingest, export_tsv, merge_to_unified

app = FastAPI(
    title="AvitoParser Server",
    description="Аккумулятор данных о недвижимости из разных источников",
    version="1.0.0",
)


# ── Схемы запросов / ответов ────────────────────────────────────

class RegisterRequest(BaseModel):
    client_id: str
    client_type: str


class ListingRecord(BaseModel):
    item_id: str = ""
    url: str = ""
    title: str = ""
    price: str = ""
    price_per_m2: str = ""
    address: str = ""
    metro: str = ""
    description: str = ""
    listing_date: str = ""
    views_total: str = ""
    views_today: str = ""
    seller_name: str = ""
    seller_type: str = ""
    flat_params: str = ""
    house_params: str = ""
    rosreestr: str = ""
    parsed_at: str = ""


class IngestRequest(BaseModel):
    client_id: str
    records: List[ListingRecord]


class StatsResponse(BaseModel):
    new: int
    updated: int
    total: int


# ── Эндпоинты ────────────────────────────────────────────────────

@app.get("/")
def root():
    return {"service": "AvitoParser Server", "version": "1.0.0"}


@app.post("/register")
def register(req: RegisterRequest):
    """Регистрация клиента на сервере."""
    result = register_client(req.client_id, req.client_type)
    return result


@app.post("/ingest")
def ingest_data(req: IngestRequest):
    """
    Приём спаршенных данных от клиента.
    Каждая запись сопоставляется с существующими по адресу.
    """
    records_dict = [r.model_dump() for r in req.records]
    stats = ingest(req.client_id, records_dict)
    return {
        "status": "ok",
        "source": req.client_id,
        **stats,
    }


@app.get("/export")
def export():
    """Экспорт смерженных данных в TSV."""
    path = export_tsv()
    return {"status": "ok", "file": path, "rows": len(merge_to_unified())}


@app.get("/data")
def get_data():
    """Получить смерженные данные в JSON."""
    records = merge_to_unified()
    return {"total": len(records), "records": records}


@app.get("/clients")
def list_clients():
    """Список зарегистрированных клиентов."""
    from server.models import get_db
    db = get_db()
    rows = db.execute("SELECT client_id, client_type, registered_at, last_seen_at FROM clients ORDER BY client_id").fetchall()
    db.close()
    return [
        {"client_id": r["client_id"], "client_type": r["client_type"],
         "registered_at": r["registered_at"], "last_seen_at": r["last_seen_at"]}
        for r in rows
    ]


@app.get("/health")
def health():
    return {"status": "healthy"}


# ── Точка входа ──────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server.main:app", host="0.0.0.0", port=8000, reload=True)