#!/usr/bin/env bash
# ────────────────────────────────────────────────────────────────────
# AvitoParser — экспорт данных из PostgreSQL в TSV-файл
#
# Использование:
#     ./export.sh                 # вывод в output/state.tsv (по умолчанию)
#     ./export.sh output.tsv      # вывод в указанный файл
#     ./export.sh -               # вывод в stdout
#
# Переменные окружения (из .env или export):
#     DB_HOST     — хост PostgreSQL         (по умолчанию: localhost)
#     DB_PORT     — порт PostgreSQL         (по умолчанию: 5432)
#     DB_NAME     — имя БД                  (по умолчанию: state)
#     DB_USER     — пользователь            (по умолчанию: admin)
#     DB_PASSWORD — пароль                  (по умолчанию: admin)
# ────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Загрузка .env если есть ────────────────────────────────────────
if [[ -f "$SCRIPT_DIR/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$SCRIPT_DIR/.env"
    set +a
fi

# ── Параметры подключения ──────────────────────────────────────────
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-state}"
DB_USER="${DB_USER:-admin}"
DB_PASSWORD="${DB_PASSWORD:-admin}"

# ── Выходной файл ──────────────────────────────────────────────────
OUTPUT="${1:-$SCRIPT_DIR/output/state.tsv}"

# Создаём папку output если нужно
if [[ "$OUTPUT" != "-" ]]; then
    mkdir -p "$(dirname "$OUTPUT")"
fi

# ── SQL-запрос для экспорта смерженных данных ──────────────────────
SQL="
COPY (
    SELECT
        -- ID объявления (берём item_id из avito, если нет — из cian)
        COALESCE(
            (SELECT payload::json->>'item_id'
             FROM client_data
             WHERE property_id = p.id AND source = 'avito'
             ORDER BY received_at ASC LIMIT 1),
            (SELECT payload::json->>'item_id'
             FROM client_data
             WHERE property_id = p.id AND source = 'cian'
             ORDER BY received_at ASC LIMIT 1),
            ''
        ) AS \"ID объявления\",

        -- URL
        COALESCE(
            (SELECT payload::json->>'url'
             FROM client_data
             WHERE property_id = p.id AND source = 'avito'
             ORDER BY received_at ASC LIMIT 1),
            (SELECT payload::json->>'url'
             FROM client_data
             WHERE property_id = p.id AND source = 'cian'
             ORDER BY received_at ASC LIMIT 1),
            ''
        ) AS \"URL\",

        -- Заголовок
        COALESCE(
            (SELECT payload::json->>'title'
             FROM client_data
             WHERE property_id = p.id AND source = 'avito'
             ORDER BY received_at ASC LIMIT 1),
            (SELECT payload::json->>'title'
             FROM client_data
             WHERE property_id = p.id AND source = 'cian'
             ORDER BY received_at ASC LIMIT 1),
            ''
        ) AS \"Заголовок\",

        -- Цена
        COALESCE(
            (SELECT payload::json->>'price'
             FROM client_data
             WHERE property_id = p.id AND source = 'avito'
             ORDER BY received_at ASC LIMIT 1),
            (SELECT payload::json->>'price'
             FROM client_data
             WHERE property_id = p.id AND source = 'cian'
             ORDER BY received_at ASC LIMIT 1),
            ''
        ) AS \"Цена\",

        -- Цена за м²
        COALESCE(
            (SELECT payload::json->>'price_per_m2'
             FROM client_data
             WHERE property_id = p.id AND source = 'avito'
             ORDER BY received_at ASC LIMIT 1),
            (SELECT payload::json->>'price_per_m2'
             FROM client_data
             WHERE property_id = p.id AND source = 'cian'
             ORDER BY received_at ASC LIMIT 1),
            ''
        ) AS \"Цена за м²\",

        -- Адрес
        COALESCE(
            (SELECT payload::json->>'address'
             FROM client_data
             WHERE property_id = p.id AND source = 'avito'
             ORDER BY received_at ASC LIMIT 1),
            (SELECT payload::json->>'address'
             FROM client_data
             WHERE property_id = p.id AND source = 'cian'
             ORDER BY received_at ASC LIMIT 1),
            p.address_key
        ) AS \"Адрес\",

        -- Метро
        COALESCE(
            (SELECT payload::json->>'metro'
             FROM client_data
             WHERE property_id = p.id AND source = 'avito'
             ORDER BY received_at ASC LIMIT 1),
            (SELECT payload::json->>'metro'
             FROM client_data
             WHERE property_id = p.id AND source = 'cian'
             ORDER BY received_at ASC LIMIT 1),
            ''
        ) AS \"Метро\",

        -- Описание
        COALESCE(
            (SELECT payload::json->>'description'
             FROM client_data
             WHERE property_id = p.id AND source = 'avito'
             ORDER BY received_at ASC LIMIT 1),
            (SELECT payload::json->>'description'
             FROM client_data
             WHERE property_id = p.id AND source = 'cian'
             ORDER BY received_at ASC LIMIT 1),
            ''
        ) AS \"Описание\",

        -- Дата публикации
        COALESCE(
            (SELECT payload::json->>'listing_date'
             FROM client_data
             WHERE property_id = p.id AND source = 'avito'
             ORDER BY received_at ASC LIMIT 1),
            (SELECT payload::json->>'listing_date'
             FROM client_data
             WHERE property_id = p.id AND source = 'cian'
             ORDER BY received_at ASC LIMIT 1),
            ''
        ) AS \"Дата публикации\",

        -- Всего просмотров
        COALESCE(
            (SELECT payload::json->>'views_total'
             FROM client_data
             WHERE property_id = p.id AND source = 'avito'
             ORDER BY received_at ASC LIMIT 1),
            ''
        ) AS \"Всего просмотров\",

        -- Просмотров сегодня
        COALESCE(
            (SELECT payload::json->>'views_today'
             FROM client_data
             WHERE property_id = p.id AND source = 'avito'
             ORDER BY received_at ASC LIMIT 1),
            ''
        ) AS \"Просмотров сегодня\",

        -- Имя продавца
        COALESCE(
            (SELECT payload::json->>'seller_name'
             FROM client_data
             WHERE property_id = p.id AND source = 'avito'
             ORDER BY received_at ASC LIMIT 1),
            (SELECT payload::json->>'seller_name'
             FROM client_data
             WHERE property_id = p.id AND source = 'cian'
             ORDER BY received_at ASC LIMIT 1),
            ''
        ) AS \"Имя продавца\",

        -- Статус продавца
        COALESCE(
            (SELECT payload::json->>'seller_type'
             FROM client_data
             WHERE property_id = p.id AND source = 'avito'
             ORDER BY received_at ASC LIMIT 1),
            (SELECT payload::json->>'seller_type'
             FROM client_data
             WHERE property_id = p.id AND source = 'cian'
             ORDER BY received_at ASC LIMIT 1),
            ''
        ) AS \"Статус продавца\",

        -- Характеристики квартиры
        COALESCE(
            (SELECT payload::json->>'flat_params'
             FROM client_data
             WHERE property_id = p.id AND source = 'avito'
             ORDER BY received_at ASC LIMIT 1),
            (SELECT payload::json->>'flat_params'
             FROM client_data
             WHERE property_id = p.id AND source = 'cian'
             ORDER BY received_at ASC LIMIT 1),
            ''
        ) AS \"Характеристики квартиры\",

        -- Характеристики дома
        COALESCE(
            (SELECT payload::json->>'house_params'
             FROM client_data
             WHERE property_id = p.id AND source = 'avito'
             ORDER BY received_at ASC LIMIT 1),
            (SELECT payload::json->>'house_params'
             FROM client_data
             WHERE property_id = p.id AND source = 'cian'
             ORDER BY received_at ASC LIMIT 1),
            ''
        ) AS \"Характеристики дома\",

        -- Росреестр
        COALESCE(
            (SELECT payload::json->>'rosreestr'
             FROM client_data
             WHERE property_id = p.id AND source = 'avito'
             ORDER BY received_at ASC LIMIT 1),
            (SELECT payload::json->>'rosreestr'
             FROM client_data
             WHERE property_id = p.id AND source = 'rosreestr'
             ORDER BY received_at ASC LIMIT 1),
            ''
        ) AS \"Росреестр\",

        -- Источники
        STRING_AGG(DISTINCT source, ',' ORDER BY source) AS \"Источники\"

    FROM properties p
    LEFT JOIN client_data cd ON cd.property_id = p.id
    GROUP BY p.id, p.address_key
    ORDER BY p.updated_at DESC
) TO STDOUT WITH (FORMAT csv, DELIMITER E'\\t', HEADER true, ENCODING 'UTF8')
"

# ── Выполняем экспорт ──────────────────────────────────────────────
export PGPASSWORD="$DB_PASSWORD"

if [[ "$OUTPUT" == "-" ]]; then
    # Вывод в stdout
    psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "$SQL"
    echo ""
    echo "[export.sh] ✔ Данные выведены в stdout" >&2
else
    psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "$SQL" > "$OUTPUT"
    echo "[export.sh] ✔ Экспортировано $(wc -l < "$OUTPUT" | tr -d ' ') строк (включая заголовок) в $OUTPUT"
fi

unset PGPASSWORD