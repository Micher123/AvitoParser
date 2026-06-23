# House-Research — Парсер объявлений Avito и Циан в CSV

Парсит объявления с **Avito** и **Циан** и сохраняет результат в CSV-файлы
с разделителем `;` (совместимо с Microsoft Excel).

---

## Установка

```bash
# Установите Deno 2.x
curl -fsSL https://deno.land/install.sh | sh

# Склонируйте проект
git clone https://github.com/zxcloli666/House-Research.git
cd House-Research
```

---

## Настройка

Создайте файл `.env` из примера:

```bash
cp .env.example .env
```

Затем отредактируйте `.env` (см. `nano .env`):

```env
# КУКИ AVITO (обязательно для URL-режима)
AVITO_COOKIE=ваши_куки_из_браузера

# ПРОКСИ для обхода IP-блокировок Avito (опционально)
AVITO_PROXY=http://user:pass@host:port

# КУКИ ЦИАН (обязательно для API-режима)
CIAN_SEARCH_COOKIE=ваши_куки_из_браузера
```

### Как получить куки

1. Откройте сайт (`avito.ru` / `cian.ru`) в браузере.
2. Нажмите `F12` → вкладка **Application** (или **Storage**).
3. Слева выберите **Cookies** → `https://www.avito.ru`.
4. Скопируйте **всю строку куков** целиком и вставьте в `.env`.

---

## Парсер Avito

### Режим 1 — Поиск по URL (рекомендуемый)

Парсер сам ходит по страницам поиска, скачивает объявления и пишет CSV.

```bash
deno task parse-avito "https://www.avito.ru/moskva/kvartiry/sdam/na_dlitelnyy_srok?p=1"
```

Что происходит:
- Парсер открывает страницу 1 поиска, собирает ссылки на объявления
- Скачивает каждое объявление, извлекает 45 полей, удаляет временный HTML
- Переходит на страницу 2, 3, … пока есть объявления
- Между страницами пауза 2.5 секунды, между объявлениями 1.2 секунды
- Результат сохраняется в `output/avito_listings.csv`

### Режим 2 — Из папки с HTML-файлами

Если Avito блокирует IP даже с куками — скачайте страницы объявлений вручную (Ctrl+S в браузере) и сложите `.html` файлы в одну папку.

```bash
deno task parse-avito /путь/к/папке/с/html
```

---

## Парсер Циан

### Режим 1 — Через API Циан (рекомендуемый)

Требуется `CIAN_SEARCH_COOKIE` в `.env` и настройки поиска в `conf/conf.yml`.

```bash
deno task parse-cian
```

Парсер сам обойдёт все страницы выдачи через API Циан и запишет результат в `output/cian_listings.csv`.

### Режим 2 — Из папки с JSON-файлами

Если куков нет — можно скопировать JSON-ответы из вкладки Network браузера:

1. Откройте Циан, нажмите `F12` → **Network**.
2. Найдите запрос к `search-offers`.
3. Скопируйте ответ (`response`) и сохраните как `.json` файл.
4. Запустите парсер с путём к папке:

```bash
deno task parse-cian /путь/к/папке/с/json
```

---

## Результат

CSV-файлы сохраняются в папку `output/`:

```
output/
  avito_listings.csv
  cian_listings.csv
```

Файлы используют разделитель `;` и кодировку UTF-8 (с BOM для корректного
открытия в Excel).

---

## Поля CSV (45 колонок)

Оба парсера выдают одинаковую структуру:

| № | Поле | Описание |
|---|------|----------|
| 1 | item_id | ID объявления |
| 2 | title | Заголовок |
| 3 | price | Цена (₽) |
| 4 | price_per_m2 | Цена за м² |
| 5 | description | Описание (текст) |
| 6 | description_html | Описание (HTML) |
| 7 | address | Адрес |
| 8 | rooms | Количество комнат |
| 9 | total_area | Общая площадь |
| 10 | kitchen_area | Площадь кухни |
| 11 | living_area | Жилая площадь |
| 12 | floor | Этаж |
| 13 | floors_total | Этажность дома |
| 14 | balcony | Балкон/лоджия |
| 15 | room_type | Тип комнат |
| 16 | bathroom | Санузел |
| 17 | windows | Окна |
| 18 | renovation | Ремонт |
| 19 | furniture | Мебель |
| 20 | is_furnished | Меблирована (да/нет) |
| 21 | house_type | Тип дома |
| 22 | build_year | Год постройки |
| 23 | passenger_elevator | Пассажирский лифт |
| 24 | freight_elevator | Грузовой лифт |
| 25 | parking | Парковка |
| 26 | seller_name | Продавец |
| 27 | seller_type | Тип продавца |
| 28 | seller_contact_person | Контактное лицо |
| 29 | is_agency | Агентство (да/нет) |
| 30 | phone_number | Телефон |
| 31 | messenger_availability | Доступен чат (да/нет) |
| 32 | sale_method | Способ продажи |
| 33 | sale_terms | Условия сделки |
| 34 | listing_date | Дата публикации |
| 35 | views_total | Всего просмотров |
| 36 | views_today | Просмотров сегодня |
| 37 | images_count | Количество фото |
| 38 | image_urls | Ссылки на фото (через запятую) |
| 39 | main_image_url | Главное фото |
| 40 | latitude | Широта |
| 41 | longitude | Долгота |
| 42 | map_zoom | Zoom карты |
| 43 | is_online_view | Онлайн-показ (да/нет) |
| 44 | is_mortgage_possible | Ипотека возможна (да/нет) |
| 45 | mortgage_payment | Платёж по ипотеке |
| 46 | mortgage_rate | Ставка по ипотеке |
| 47 | mortgage_income | Доход для ипотеки |
| 48 | parsed_at | Дата парсинга |
| 49 | source | Источник (avito/cian) |

---

## Частые проблемы

### Avito возвращает рекламные блоки вместо объявлений
→ Добавьте `AVITO_COOKIE` в `.env`. Без куков Avito не показывает реальные объявления.

### Avito блокирует IP (ошибка 429 или «Доступ ограничен»)
→ Добавьте `AVITO_PROXY` в `.env` — HTTP/HTTPS прокси с российским IP.
→ Или используйте Режим 2 (ручная загрузка HTML через браузер).

### Циан: «Не задана переменная CIAN_SEARCH_COOKIE»
→ Добавьте куки в `.env` ИЛИ укажите путь к папке с JSON-файлами:
`deno task parse-cian /путь/к/json`