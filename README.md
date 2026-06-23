# House-Research — Парсер объявлений в CSV

Собирает объявления с **Avito** и **Циан** и записывает их в CSV-файлы
с разделителем `;`.

Работает без Docker, без Node.js, без AI.

---

## Системные требования

- [Deno](https://deno.com/) v2.x
  ```bash
  curl -fsSL https://deno.land/install.sh | sh
  ```

---

## Быстрый старт

```bash
git clone https://github.com/zxcloli666/House-Research.git
cd House-Research
```

---

## Парсер Avito

### Режим 1 — Поиск по URL (основной)

Даёте **ссылку на поиск Avito** с любыми фильтрами (город, тип недвижимости,
количество комнат, цена и т.д.). Парсер сам пройдёт все страницы, скачает
каждое объявление и запишет результат в CSV.

```bash
deno task parse-avito "https://www.avito.ru/moskva/kvartiry/sdam/na_dlitelnyy_srok?p=1"
```

**Важно:** Avito требует куки, иначе вместо объявлений приходят рекламные блоки.

1. Откройте [avito.ru](https://avito.ru) в браузере
2. Настройте фильтры и скопируйте URL (включая `?p=1`)
3. Откройте DevTools → Application/Хранилище → Cookies → avito.ru
4. Скопируйте **все куки одной строкой** (или хотя бы сессионные)
5. Создайте `.env` файл:
   ```
   AVITO_COOKIE=ваши_куки_строкой
   ```
6. Запустите парсер командой выше

**Что происходит:**
1. Загружается первая страница поиска, из `window.__initialData__` извлекается
   общее количество объявлений и список
2. Вычисляется количество страниц, загружаются все страницы пагинации
3. Для каждого объявления загружается страница, извлекается:
   - Заголовок (`<meta property="vk:title">`)
   - Адрес (`<div itemProp="address">`)
   - Описание (`<meta property="og:description">`)
   - Цена (`<meta itemprop="price">`)
   - Фото (из `window.__initialData__` / `galleryInfo`)
4. Всё пишется в `output/avito_listings.csv`

### Режим 2 — Из папки с HTML (старый)

```bash
deno task parse-avito /путь/к/папке-с-html
```

Читает локальные `.html`‑файлы, извлекает те же поля.

---

## Парсер Циан

### Режим 1 — Через API (требуется cookie агента)

1. Авторизуйтесь на [cian.ru](https://cian.ru) как агент/специалист
2. Откройте DevTools → Application/Хранилище → Cookies
3. Скопируйте значение cookie-сессии
4. Создайте `.env` файл:
   ```
   CIAN_SEARCH_COOKIE=ваш_cookie_здесь
   ```
5. Создайте настройки поиска в `conf/conf.yml` (см. ниже)
6. Запустите:

```bash
deno task parse-cian
```

### Режим 2 — Из JSON-файлов

```bash
deno task parse-cian /путь/к/папке-с-json
```

JSON-файлы должны содержать массив объектов или объект с полем `offers`.

---

## Формат CSV

Разделитель — `;`. Колонки:

| source | url | title | address | description | price | rating | operators | routes | images | lat | lon | parsedAt |

Пустые колонки (`rating`, `operators`, `routes`, `lat`, `lon`) — для
совместимости, по умолчанию "" или 0.

---

## Файл .env

```
AVITO_COOKIE=...           # куки для Avito (режим URL-поиска)
CIAN_SEARCH_COOKIE=...      # куки для API Циан
```

---

## Настройка conf.yml

Создайте `conf/conf.yml`:

```yaml
cianSearch:
  minPrice: 0
  maxPrice: 100000
  geo:
    - 123
  regions:
    - 1
```

---

## Структура проекта

```
├── conf/
│   └── conf.yml
├── src/
│   ├── csv-writer.ts
│   ├── core/
│   │   ├── config.ts
│   │   ├── env.ts
│   │   └── logger.ts
│   ├── parsers/
│   │   ├── avito-csv.ts    ← два режима: URL или папка
│   │   └── cian-csv.ts     ← API или JSON
│   └── utils/
│       └── spyFetch.ts
├── output/
├── deno.json
└── import_map.json
```

---

## Итог

```bash
# Avito — поиск по URL (основной способ)
deno task parse-avito "https://www.avito.ru/.../sdam/...?p=1"

# Avito — из папки
deno task parse-avito /путь/к/avito-export

# Циан — через API
deno task parse-cian

# Циан — из папки
deno task parse-cian /путь/к/json
```

Результаты: `output/avito_listings.csv` и `output/cian_listings.csv`.