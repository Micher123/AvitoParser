# AvitoParser — распределённый парсер объявлений о недвижимости

Собирает данные из разных источников (Авито, Циан, Яндекс.Карты, Росреестр),
сопоставляет их по адресу, смерживает в единую запись и отдаёт в TSV-файл.

**Архитектура**: клиент-сервер. Сервер — аккумулятор (FastAPI + SQLite).
Каждый клиент парсит свой источник и HTTP-запросами отправляет сырые
данные на сервер. Сервер сам сопоставляет записи и склеивает поля от
разных источников по приоритету.

```
┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│  Avito       │   │  Cian        │   │ Yandex.Maps  │   │  Rosreestr   │
│  client      │   │  client      │   │  client      │   │  client      │
└──────┬───────┘   └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
       │ POST /ingest     │                  │                  │
       └──────────────────┼──────────────────┼──────────────────┘
                          ▼
                 ┌─────────────────┐
                 │   SERVER        │
                 │ FastAPI + SQLite│
                 │   (port 8000)   │
                 └────────┬────────┘
                          │ GET /export
                          ▼
                   unified_listings.tsv
```

Оглавление

- [Быстрый старт](#быстрый-старт)
- [Архитектура](#архитектура)
  - [Сервер](#сервер)
  - [Клиенты](#клиенты)
- [Установка](#установка)
- [Запуск сервера](#запуск-сервера)
- [Запуск парсера Avito](#запуск-парсера-avito)
- [Запуск заглушек (Cian / Yandex / Rosreestr)](#запуск-заглушек)
- [Просмотр и экспорт данных](#просмотр-и-экспорт-данных)
- [Как работает мерж (склейка) полей](#как-работает-мерж-склейка-полей)
- [Структура выходного TSV](#структура-выходного-tsv)
- [API сервера](#api-сервера)
- [Старые скрипты (parsers/)](#старые-скрипты-parsers)
- [FAQ / Проблемы](#faq--проблемы)

---

## Быстрый старт

```bash
# 1. Установка
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 2. Запуск сервера (в отдельном терминале)
python server/main.py

# 3. Запуск парсера Avito (в другом терминале)
cp clients/avito/.env.example clients/avito/.env
#   → пропишите в .env AVITO_SEARCH_URL и AVITO_COOKIE / cookies.json
python clients/avito/run.py

# 4. Экспорт данных
#   http://localhost:8000/export   ← скачает unified_listings.tsv
```

---

## Архитектура

### Сервер

Файлы в `server/`:

| Файл         | Назначение |
|--------------|-----------|
| `main.py`    | FastAPI-приложение (эндпоинты) |
| `models.py`  | Схема SQLite, функции `ingest()`, `merge_to_unified()`, `export_tsv()` |

Сервер хранит всё в SQLite (`server/data/listings.db`).  
Схема — три таблицы:

| Таблица       | Зачем |
|---------------|-------|
| `properties`  | Объект недвижимости (ключ — нормализованный адрес) |
| `client_data` | Сырые JSON-данные от каждого клиента |
| `clients`     | Зарегистрированные клиенты (avito, cian, …) |

### Клиенты

Каждый клиент — автономный Python-скрипт, который:

1. Регистрируется на сервере: `POST /register`
2. Парсит страницы своего источника.
3. Отправляет пачки записей: `POST /ingest`

Клиенты могут работать на **разных машинах** (нужно только указать
`SERVER_URL` в `.env` клиента).

---

## Установка

```bash
# Python 3.10+
python3 --version

# Клонирование
git clone <repo-url> AvitoParser
cd AvitoParser

# Виртуальное окружение
python3 -m venv .venv
source .venv/bin/activate        # Linux / macOS
# .venv\Scripts\activate         # Windows

# Зависимости
pip install -r requirements.txt
```

`requirements.txt`:

- `requests` — HTTP-клиент
- `beautifulsoup4`, `lxml` — парсинг HTML
- `PyYAML` — (задел на будущее)
- `python-dotenv` — переменные окружения из `.env`
- `fastapi`, `uvicorn` — сервер-аккумулятор

**Docker НЕ нужен.** Всё работает локально без контейнеров.

---

## Запуск сервера

```bash
# Из корня проекта
python server/main.py
```

Сервер поднимется на `http://0.0.0.0:8000`.

Проверка:

```bash
curl http://localhost:8000/health
# → {"status":"healthy"}
```

Swagger-документация доступна по адресу:  
→ `http://localhost:8000/docs`

---

## Запуск парсера Avito

### 1. Настройка `.env`

```bash
cp clients/avito/.env.example clients/avito/.env
```

Отредактируйте `clients/avito/.env`:

```ini
SERVER_URL=http://localhost:8000
CLIENT_ID=avito
AVITO_SEARCH_URL=https://www.avito.ru/moskva/kvartiry/prodam
AVITO_MAX_PAGES=5

# Куки (любой вариант):
AVITO_COOKIES_FILE=cookies.json       # путь до Firefox-экспорта
# или
AVITO_COOKIE="sessionid=abc..."       # строка Cookie целиком

AVITO_PROXY=                           # http://user:pass@host:port (если нужно)
```

Где взять `cookies.json`:

1. В Firefox: откройте `about:extensions` → «Управление расширениями»
2. Найдите расширение `cookie-manager`
3. Экспортируйте куки в JSON → положите в корень проекта как `cookies.json`

### 2. Запуск

```bash
# URL поиска можно передать прямо в командной строке
python clients/avito/run.py "https://www.avito.ru/moskva/kvartiry/prodam"

# Или без аргументов — тогда возьмётся AVITO_SEARCH_URL из .env
python clients/avito/run.py

# Вторым аргументом — лимит страниц
python clients/avito/run.py "https://www.avito.ru/..." 3
```

### 3. Что происходит

- Скачиваются поисковые страницы (и кешируются в `clients/avito/Pages/`)
- Извлекаются ссылки на объявления
- Каждое объявление парсится (DOM-селекторы Avito)
- Данные отправляются на сервер пачками по 5 записей

---

## Запуск заглушек

На данный момент только **Avito** имеет реальный парсер.  
Остальные клиенты — **заглушки**, готовые к добавлению парсеров.

```bash
python clients/cian/client.py          # заглушка
python clients/yandex_maps/client.py   # заглушка
python clients/rosreestr/client.py     # заглушка
```

Каждая заглушка регистрируется на сервере и готова принимать вызовы
`.send_record(...)` из будущего парсера.

---

## Просмотр и экспорт данных

### Через браузер / curl

```
GET  http://localhost:8000/data      → все смерженные записи (JSON)
GET  http://localhost:8000/export    → экспорт в TSV (возвращает путь)
GET  http://localhost:8000/clients   → список зарегистрированных клиентов
```

### Файл

Экспортированный файл лежит в:

```
server/output/unified_listings.tsv
```

Разделитель — **табуляция**.

Открыть в Excel / LibreOffice:

```bash
# LibreOffice
libreoffice --calc server/output/unified_listings.tsv

# Или скопировать (символ табуляции уже есть)
cat server/output/unified_listings.tsv
```

---

## Как работает мерж (склейка) полей

Сервер собирает данные по объектам недвижимости.  
**Ключ сопоставления** — нормализованный адрес (приведение к нижнему
регистру, замена «улица» → «ул.» и т.д.).

**Правила приоритета** при склейке полей:

| Приоритет | Источник    | Почему |
|-----------|-------------|--------|
| 1 (высший)| Avito       | Самый полный источник |
| 2         | Cian        | Дополняет Avito |
| 3         | Yandex.Maps | Гео-данные, метро |
| 4 (низший)| Rosreestr   | Юридическая информация |

- **Avito победил?** → Поля из Avito не перезаписываются более
  низкоприоритетными источниками.
- **Есть поле только у Cian?** → Оно добавится в общую запись.
- **Rosreestr-NOT-duplicate:** Если Avito уже дал данные Росреестра —
  Rosreestr не дублирует.

---

## Структура выходного TSV

| Колонка (рус.)           | Поле           | Источники |
|--------------------------|----------------|-----------|
| ID объявления            | item_id        | avito, cian |
| URL                      | url            | avito, cian |
| Заголовок                | title          | avito, cian |
| Цена                     | price          | avito, cian |
| Цена за м²               | price_per_m2   | avito, cian |
| Адрес                    | address        | все |
| Метро                    | metro          | все |
| Описание                 | description    | avito, cian |
| Дата публикации          | listing_date   | avito, cian |
| Всего просмотров         | views_total    | avito |
| Просмотров сегодня       | views_today    | avito |
| Имя продавца             | seller_name    | avito, cian |
| Статус продавца          | seller_type    | avito, cian |
| Характеристики квартиры  | flat_params    | все (JSON) |
| Характеристики дома      | house_params   | все (JSON) |
| Росреестр                | rosreestr      | avito, rosreestr |
| Источники                | source         | avito,cian,yandex_maps,… |

---

## API сервера

Подробную схему смотрите в Swagger: `http://localhost:8000/docs`

### `GET /health`
Проверка живости сервера.

### `POST /register`
Зарегистрировать клиента.

```json
{"client_id": "avito", "client_type": "avito"}
```

### `POST /ingest`
Отправить спаршенные записи.

```json
{
  "client_id": "avito",
  "records": [
    {
      "item_id": "123",
      "url": "https://...",
      "title": "Квартира",
      "price": "10000000",
      "address": "Москва, ул. Тверская, д. 1",
      "...": "..."
    }
  ]
}
```

### `GET /export`
Экспорт объединённых данных в TSV. Возвращает путь к файлу.

### `GET /data`
Получить смерженные данные как JSON (для отладки).

### `GET /clients`
Список зарегистрированных клиентов и время последней активности.

---

## Старые скрипты (parsers/)

В директории `parsers/` лежат старые скрипты (`avito_csv.py`, `cian_csv.py`).
Они сохраняют данные **локально** в TSV без сервера.
Можно использовать, если сервер не нужен:

```bash
python run_avito.py
python run_cian.py
```

Но эти скрипты:
- Не общаются с сервером
- Не участвуют в мерже записей
- **Рекомендуется использовать клиентов из `clients/`**

---

## FAQ / Проблемы

### Сервер не запускается
Проверьте, что порт 8000 свободен:
```bash
ss -tlnp | grep 8000
```

### Парсер Avito не находит объявления
Avito может показывать капчу. Нужны актуальные куки из браузера.
Проверьте `cookies.json` и `AVITO_COOKIE`.

### Хочу парсить Циан / Яндекс.Карты
Сейчас заглушки. Нужно реализовать парсер в `clients/.../run.py`
по аналогии с Avito-клиентом. Архитектура уже готова — осталось
только дописать DOM-селекторы или API-запросы.

### Все клиенты на разных машинах
Поменяйте `SERVER_URL` в `.env` каждого клиента на реальный IP сервера:
```ini
SERVER_URL=http://192.168.1.100:8000
```

### Хочу запустить всё одной командой
```bash
# Терминал 1
python server/main.py

# Терминал 2
cd clients/avito && python run.py

# Терминал 3
cd clients/cian && python client.py
```

Сервер сам соберёт все данные и смержит их.

---

Лицензия — см. `LICENSE`.