#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════
# AvitoParser — запуск парсинга Avito по ссылке
# ═══════════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"

# ── Проверка аргументов ────────────────────────────────────────────
if [ $# -eq 0 ]; then
    echo "Использование: $0 <URL поиска Avito>"
    echo "Пример:       $0 'https://www.avito.ru/moskva/kvartiry/prodam'"
    exit 1
fi

SEARCH_URL="$1"

# ── Активация venv (создание при необходимости) ────────────────────
if [ ! -d "$VENV_DIR" ]; then
    echo "[parse.sh] Создаю виртуальное окружение..."
    python3 -m venv "$VENV_DIR"
fi

echo "[parse.sh] Активирую venv..."
source "$VENV_DIR/bin/activate"

# ── Установка зависимостей (если не установлены) ──────────────────
if ! python -c "import requests" 2>/dev/null; then
    echo "[parse.sh] Устанавливаю зависимости..."
    pip install -r "$SCRIPT_DIR/requirements.txt" -q
fi

# ── Запуск парсера ─────────────────────────────────────────────────
echo "[parse.sh] URL: $SEARCH_URL"
cd "$SCRIPT_DIR"
python run_avito.py "$SEARCH_URL"