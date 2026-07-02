#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════
# AvitoParser — deploy.sh
# Запуск сервера или клиентов парсинга.
# ═══════════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"
REQ_FILE="$SCRIPT_DIR/requirements.txt"

# ── Справка ──────────────────────────────────────────────────────
usage() {
    cat <<EOF
AvitoParser — запуск сервера и клиентов

Использование:
  $0 --server                              Запустить сервер-аккумулятор (FastAPI)
  $0 --client --avito [URL] [PAGES]        Запустить парсер Avito
  $0 --client --cian                       Запустить парсер Циан
  $0 --client --yamap                      Запустить парсер Яндекс.Карты
  $0 --client --reestr                     Запустить парсер Росреестр
  $0 --install                             Только установить зависимости и venv
  $0 --help                                Показать эту справку

Флаги:
  --server      Режим сервера (FastAPI на порту 8000)
  --client      Режим клиента (требует указания источника)
  --avito       Запустить клиент Avito (только с --client)
  --cian        Запустить клиент Циан (только с --client)
  --yamap       Запустить клиент Яндекс.Карты (только с --client)
  --reestr      Запустить клиент Росреестр (только с --client)
  --install     Только установка окружения (venv + pip)
  --help        Справка

Примеры:
  $0 --server
  $0 --client --avito
  $0 --client --avito "https://www.avito.ru/moskva/kvartiry/prodam" 5
  $0 --client --cian
  $0 --client --yamap
EOF
    exit 0
}

# ── Разбор аргументов ────────────────────────────────────────────
MODE=""
CLIENT=""
AVITO_URL=""
AVITO_PAGES=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --server)
            MODE="server"
            shift
            ;;
        --client)
            MODE="client"
            shift
            ;;
        --avito)
            CLIENT="avito"
            shift
            ;;
        --cian)
            CLIENT="cian"
            shift
            ;;
        --yamap)
            CLIENT="yandex_maps"
            shift
            ;;
        --reestr)
            CLIENT="rosreestr"
            shift
            ;;
        --install)
            MODE="install"
            shift
            ;;
        --help|-h)
            usage
            ;;
        -*)
            echo "❌ Неизвестный флаг: $1"
            usage
            ;;
        *)
            if [[ "$CLIENT" == "avito" && -z "$AVITO_URL" ]]; then
                AVITO_URL="$1"
            elif [[ "$CLIENT" == "avito" && -z "$AVITO_PAGES" ]]; then
                AVITO_PAGES="$1"
            else
                echo "❌ Лишний аргумент: $1"
                usage
            fi
            shift
            ;;
    esac
done

# ── Валидация ────────────────────────────────────────────────────
if [[ -z "$MODE" ]]; then
    echo "❌ Укажите режим: --server или --client"
    echo "   $0 --help  — справка"
    exit 1
fi

if [[ "$MODE" == "client" && -z "$CLIENT" ]]; then
    echo "❌ Укажите источник: --avito, --cian, --yamap или --reestr"
    echo "   $0 --help  — справка"
    exit 1
fi

# ── Автосоздание .env из примера ─────────────────────────────────
if [[ ! -f "$SCRIPT_DIR/.env" ]]; then
    if [[ -f "$SCRIPT_DIR/.env.example" ]]; then
        cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
        echo "[deploy.sh] ✔ Создан .env из .env.example (с настройками по умолчанию)"
        echo "  Отредактируйте .env при необходимости."
    fi
fi

# ── Загрузка .env ────────────────────────────────────────────────
if [[ -f "$SCRIPT_DIR/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$SCRIPT_DIR/.env"
    set +a
fi

# ── Активация / создание venv ────────────────────────────────────
if [[ ! -d "$VENV_DIR" ]]; then
    echo "[deploy.sh] Создаю виртуальное окружение .venv ..."
    python3 -m venv "$VENV_DIR"
fi

# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

# ── Установка зависимостей ───────────────────────────────────────
_ensure_deps() {
    if ! python -c "import fastapi" 2>/dev/null; then
        echo "[deploy.sh] Устанавливаю зависимости из requirements.txt ..."
        pip install -r "$REQ_FILE" -q
        echo "[deploy.sh] ✔ Зависимости установлены"
    fi
}

# ── Проверка PostgreSQL (только для server) ──────────────────────
_check_postgres() {
    local db_host="${DB_HOST:-localhost}"
    local db_port="${DB_PORT:-5432}"
    local db_user="${DB_USER:-admin}"
    local db_name="${DB_NAME:-state}"

    echo "[deploy.sh] Проверяю PostgreSQL ($db_host:$db_port) ..."

    if ! command -v psql &>/dev/null; then
        echo "❌ psql не найден. Установите PostgreSQL клиент:"
        echo "   sudo apt install postgresql-client"
        exit 1
    fi

    # Проверяем, запущен ли PostgreSQL
    if ! pg_isready -h "$db_host" -p "$db_port" -q 2>/dev/null; then
        echo "❌ PostgreSQL не доступен на $db_host:$db_port"
        echo "   Убедитесь, что PostgreSQL запущен:"
        echo "   sudo systemctl start postgresql"
        exit 1
    fi

    # Проверяем, может ли пользователь подключиться к postgres (для CREATE DATABASE)
    export PGPASSWORD="${DB_PASSWORD:-admin}"
    if psql -h "$db_host" -p "$db_port" -U "$db_user" -d postgres -c "SELECT 1" &>/dev/null; then
        echo "[deploy.sh] ✔ PostgreSQL доступен, пользователь '$db_user' может подключаться"
    else
        echo "⚠️  Пользователь '$db_user' не может подключиться к PostgreSQL."
        echo "   Создайте пользователя и дайте ему права:"
        echo ""
        echo "   sudo -u postgres psql"
        echo "   CREATE USER admin WITH PASSWORD 'admin' CREATEDB;"
        echo "   \\q"
        echo ""
        echo "   Или измените DB_USER / DB_PASSWORD в .env файле."
        echo ""
        echo "   Продолжаю запуск (БД будет создана сервером автоматически при наличии прав)..."
    fi
    unset PGPASSWORD
}

# ── Режим: install ───────────────────────────────────────────────
if [[ "$MODE" == "install" ]]; then
    _ensure_deps
    echo "[deploy.sh] ✔ Окружение готово"
    echo "  source .venv/bin/activate"
    exit 0
fi

_ensure_deps

# ── Режим: server ────────────────────────────────────────────────
if [[ "$MODE" == "server" ]]; then
    _check_postgres
    echo "[deploy.sh] Запуск сервера-аккумулятора (FastAPI) ..."
    cd "$SCRIPT_DIR"
    exec python server/main.py
fi

# ── Режим: client ────────────────────────────────────────────────
echo "[deploy.sh] Запуск клиента: $CLIENT"

cd "$SCRIPT_DIR"

case "$CLIENT" in
    avito)
        if [[ -n "$AVITO_URL" ]]; then
            if [[ -n "$AVITO_PAGES" ]]; then
                exec python clients/avito/run.py "$AVITO_URL" "$AVITO_PAGES"
            else
                exec python clients/avito/run.py "$AVITO_URL"
            fi
        else
            exec python clients/avito/run.py
        fi
        ;;
    cian)
        exec python clients/cian/client.py
        ;;
    yandex_maps)
        exec python clients/yandex_maps/client.py
        ;;
    rosreestr)
        exec python clients/rosreestr/client.py
        ;;
    *)
        echo "❌ Неизвестный клиент: $CLIENT"
        exit 1
        ;;
esac