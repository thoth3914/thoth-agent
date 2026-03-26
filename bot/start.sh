#!/bin/bash
# Thoth Bot — safe start with PID guard
PID_FILE="/tmp/thoth_bot.pid"
BOT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Проверяем есть ли уже живая копия
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Thoth already running (PID $OLD_PID)"
    exit 0
  fi
fi

# Запускаем
cd "$BOT_DIR"
nohup node bot.js >> ../memory/bot.log 2>&1 &
NEW_PID=$!
echo $NEW_PID > "$PID_FILE"
echo "Thoth started (PID $NEW_PID)"
