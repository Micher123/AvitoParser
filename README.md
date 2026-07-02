# AvitoParser — распределённый парсер объявлений о недвижимости

Собирает данные из разных источников (Авито, Циан, Яндекс.Карты, Росреестр),
сопоставляет их по адресу, смерживает в единую запись и хранит в **PostgreSQL**.

**Архитектура**: клиент-сервер. Сервер — аккумулятор (FastAPI + PostgreSQL).
Каждый клиент парсит свой источник и HTTP-запросами отправляет сырые
данные на сервер. Сервер сам сопоставляет записи и склеивает поля от
разных источников по приоритету.

**TSV-экспорт**: утилита `export.sh` делает выгрузку из PostgreSQL в TSV-файл
(разделитель — табуляция \t).

```
┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│  Avito       │   │  Cian        │   │ Yandex.Maps  │   │  Rosreestr   │
│  client      │   │  client      │   │  client      │   │  client      │
└──────┬───────┘   └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
       │ POST /ingest     │                  │                  │
       └──────────────────┼──────────────────┼──────────────────┘
                          ▼
                 ┌──────────────────┐
                 │   SERVER         │
                 │ FastAPI +        │
                 │ PostgreSQL       │
                 │   (port 8000)    │
                 └────────┬─────────┘
                          │ ./export.sh
                          ▼
                   state.tsv (TSV)
```

## Оглавление

- [Быстрый старт](#быстрый-старт)
- [Требования](#требования)
- [Архитектура](#архитектура)
  - [Сервер](#сервер)
  - [Клиенты](#клиенты)
  - [База данных PostgreSQL](#база-данных-postgresql)
- [Установка](#установка)
- [Запуск сервера](#запуск-сервера)
- [Запуск парсера Avito](#запуск-парсера-avito)
- [Запуск других клиентов (Cian / Yandex / Rosreestr)](#запуск-других-клиентов)
- [Экспорт данных в TSV](#экспорт-данных-в-tsv)
- [Как работает мерж (склейка) полей](#как-работает-мерж-склейка-полей)
- [Структура выходного TSV](#структура-выходного-tsv)
- [API сервера](#api-сервера)
- [Настройка (.env)](#настройка-env)
- [FAQ / Проблемы](#faq--проблемы)

---

## Быстрый старт

```bash
# 1. Настройка PostgreSQL
sudo systemctl start postgresql
sudo -u postgres psql -c "CREATE USER admin WITH PASSWORD 'admin' CREATEDB;"
# (если БД state уже существует и вы хотите её пересоздать:)
# sudo -u postgres psql -c "DROP DATABASE IF EXISTS state;"

# 2. Установка и первый запуск сервера (создаст .env, venv, БД и таблицы)
./deploy.sh --server

# 3. Запуск парсера Avito (в другом терминале)
./deploy.sh --client --avito

# 4. Экспорт данных в TSV
./export.sh
# → output/state.tsv
```

---

## Требования

- Python 3.9+
- PostgreSQL (запущенный)
- `psql` (клиент PostgreSQL, для `export.sh`)

---

## Архитектура

### Сервер

Файлы в `server/`:

| Файл        | Назначение |
|-------------|-----------|
| `main.py`   | FastAPI-приложение (эндпоинты), автоинициализация БД при старте |
| `models.py` | Схема PostgreSQL, `ingest()`, `merge_to_unified()`, `export_tsv()` |

Сервер хранит всё в **PostgreSQL**.  
При запуске сервер автоматически:
1. Проверяет, существует ли БД `state` (или имя из `.env`)
2. Если нет — создаёт её
3. Создаёт таблицы (`properties`, `client_data`, `clients`), если их ещё нет

### Клиенты

Каждый клиент — автономный Python-скрипт, который:

1. Регистрируется на сервере: `POST /register`
2. Парсит страницы своего источника.
3. Отправляет пачки записей: `POST /ingest`

Клиенты могут работать на **разных машинах** (нужно только указать
`SERVER_URL` в `.env` клиента).

### База данных PostgreSQL

Схема — три таблицы:

| Таблица       | Зачем |
|---------------|-------|
| `properties`  | Объект недвижимости (ключ — нормализованный адрес) |
| `client_data` | Сырые JSON-данные от каждого клиента |
| `clients`     | Зарегистрированные клиенты (avito, cian, …) |

Параметры подключения к БД задаются в `.env`:

```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=state
DB_USER=admin
DB_PASSWORD=admin
```

---

## Установка

```bash
# Автоматическая установка (создаст .venv и установит зависимости)
./deploy.sh --install
```

Или вручную:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### Настройка PostgreSQL

Создайте пользователя и базу:

```bash
# Запустите PostgreSQL
sudo systemctl start postgresql

# Создайте пользователя (под sudo)
sudo -u postgres psql
```

В psql:

```sql
CREATE USER admin WITH PASSWORD 'admin' CREATEDB;
\q
```

Сервер сам создаст БД `state` при первом запуске (если у пользователя есть права `CREATEDB`).

---

## Запуск сервера

```bash
./deploy.sh --server
```

Что произойдёт при запуске:
1. Автосоздание `.env` из `.env.example` (если `.env` нет)
2. Создание/активация `.venv`
3. Установка зависимостей (если ещё не установлены)
4. Проверка доступности PostgreSQL
5. Автосоздание БД `state` (если её нет)
6. Автосоздание таблиц
7. Запуск FastAPI на `http://0.0.0.0:8000`

Интерактивная документация API: http://localhost:8000/docs

---

## Запуск парсера Avito

```bash
./deploy.sh --client --avito
```

Или с URL категории и лимитом страниц:

```bash
./deploy.sh --client --avito "https://www.avito.ru/moskva/kvartiry/prodam" 5
```

Перед запуском настройте `.env` (автосоздаётся из `.env.example`):

```env
AVITO_COOKIES_FILE=cookies.json      # путь к файлу cookies (Firefox export)
AVITO_COOKIE=                         # или строка Cookie целиком
AVITO_SEARCH_URL=                     # URL поиска (если не передан в командной строке)
AVITO_MAX_PAGES=5                     # макс. число страниц
AVITO_PROXY=                          # прокси (http://user:pass@host:port)
```

> **Как получить cookies:** см. [docs/cookies_export/COOKIES_EXPORT.md](docs/cookies_export/COOKIES_EXPORT.md)
> и [docs/browsers/extensions/COOKIE_MANAGER.md](docs/browsers/extensions/COOKIE_MANAGER.md)

---

## Запуск других клиентов

```bash
./deploy.sh --client --cian         # Циан
./deploy.sh --client --yamap        # Яндекс.Карты
./deploy.sh --client --reestr       # Росреестр
```

---

## Экспорт данных в TSV

Утилита `export.sh` делает выгрузку смерженных данных из PostgreSQL в TSV-файл
(разделитель — табуляция \t, кодировка UTF-8).

```bash
# Экспорт в output/state.tsv (по умолчанию)
./export.sh

# Экспорт в указанный файл
./export.sh my_data.tsv

# Экспорт в stdout
./export.sh -

# Открыть в Excel / LibreOffice Calc
libreoffice --calc output/state.tsv
```

Также можно экспортировать через API сервера:

```bash
# Через веб (скачает файл)
curl http://localhost:8000/export

# Или открыть в браузере
xdg-open http://localhost:8000/export
```

---

## Как работает мерж (склейка) полей

Сервер склеивает записи от разных источников по адресу.

Приоритет полей: **avito > cian > yandex_maps > rosreestr**

Пример:
- Avito прислал цену 10 млн и телефон продавца.
- Циан прислал цену 9.5 млн и этаж.
- Итог: цена берётся из Avito, этаж из Циана, телефон из Avito.

Алгоритм:
1. Запись приходит через `POST /ingest`.
2. Адрес нормализуется (нижний регистр, замена сокращений).
3. Если адреса ещё нет в БД — создаётся новый `property`.
4. Если адрес уже есть — новая запись `client_data` привязывается к тому же объекту.
5. При экспорте (`/export` или `export.sh`) данные склеиваются:
   для каждого поля берётся первое непустое значение в порядке приоритета источников.

---

## Структура выходного TSV

Файл `output/state.tsv` (UTF-8, табуляция \t, RFC 4180):

| Колонка | Описание |
|---------|----------|
| ID объявления | item_id из Avito или Cian |
| URL | Ссылка на объявление |
| Заголовок | Название объявления |
| Цена | Цена в рублях |
| Цена за м² | Цена за квадратный метр |
| Адрес | Полный адрес |
| Метро | Ближайшее метро и расстояние |
| Описание | Текст объявления |
| Дата публикации | Дата размещения |
| Всего просмотров | Общее число просмотров (только Avito) |
| Просмотров сегодня | Просмотров за сегодня (только Avito) |
| Имя продавца | Имя / название |
| Статус продавца | Частное лицо / Агентство / Застройщик |
| Характеристики квартиры | JSON: этаж, комнаты, площадь |
| Характеристики дома | JSON: тип дома, год постройки |
| Росреестр | JSON: данные из Росреестра |
| Источники | avito,cian,... — через запятую |

---

## API сервера

| Метод   | Путь       | Описание |
|---------|------------|----------|
| `GET`   | `/`        | Информация о сервере |
| `GET`   | `/health`  | Health-check |
| `POST`  | `/register`| Регистрация клиента |
| `POST`  | `/ingest`  | Приём данных от клиента |
| `GET`   | `/export`  | Экспорт в TSV (через Python) |
| `GET`   | `/data`    | Все смерженные данные в JSON |
| `GET`   | `/clients` | Список клиентов |

Swagger UI: http://localhost:8000/docs

---

## Настройка (.env)

Файл `.env` создаётся автоматически из `.env.example` при первом запуске `deploy.sh`.
При необходимости отредактируйте его:

```env
# ─── База данных PostgreSQL ───────────────────────
DB_HOST=localhost
DB_PORT=5432
DB_NAME=state
DB_USER=admin
DB_PASSWORD=admin

# ─── Avito ────────────────────────────────────────
AVITO_COOKIES_FILE=cookies.json
AVITO_COOKIE=
AVITO_SEARCH_URL=
AVITO_MAX_PAGES=5
AVITO_PROXY=

# ─── Циан ─────────────────────────────────────────
CIAN_SEARCH_COOKIE=

# ─── Общие ────────────────────────────────────────
LOG_LEVEL=info
```

---

## FAQ / Проблемы

### "psql не найден"

Установите клиент PostgreSQL:

```bash
sudo apt install postgresql-client
```

### "PostgreSQL не доступен"

Запустите PostgreSQL:

```bash
sudo systemctl start postgresql
```

### "Пользователь не может подключиться к PostgreSQL"

Создайте пользователя с правами на создание БД:

```bash
sudo -u postgres psql
CREATE USER admin WITH PASSWORD 'admin' CREATEDB;
\q
```

### "Не удалось создать БД"

Убедитесь, что у пользователя есть права `CREATEDB`.  
Или создайте БД вручную:

```bash
sudo -u postgres psql
CREATE DATABASE state OWNER admin;
GRANT ALL PRIVILEGES ON DATABASE state TO admin;
\q
```

### "Клиент не может подключиться к серверу"

По умолчанию сервер слушает `0.0.0.0:8000`.  
Проверьте, что порт не занят:

```bash
lsof -i :8000
```

Если сервер на другой машине — укажите `SERVER_URL` в `.env` клиента.

### "Данные не экспортируются"

Проверьте, есть ли данные в БД:

```bash
source .env 2>/dev/null || true
export PGPASSWORD="${DB_PASSWORD:-admin}"
psql -h "${DB_HOST:-localhost}" -p "${DB_PORT:-5432}" -U "${DB_USER:-admin}" -d "${DB_NAME:-state}" -c "SELECT count(*) FROM properties;"