#!/bin/bash
set -e
cd "$(dirname "$0")/.."

# Load .env
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

# Kill any previous processes
pkill -f "ngrok http 8788" 2>/dev/null || true
pkill -f "orchestrator/index.ts" 2>/dev/null || true
lsof -ti :8788 | xargs kill 2>/dev/null || true
sleep 1

echo "Starting ngrok tunnel on port 8788..."
ngrok http 8788 --url="$NGROK_BASE_URL" --log=stdout --log-level=warn > /tmp/ngrok-wario.log 2>&1 &
NGROK_PID=$!

sleep 2
echo "ngrok running (PID $NGROK_PID, log at /tmp/ngrok-wario.log)"
echo "Webhook URL: $NGROK_BASE_URL"
echo ""

echo "Starting Wario orchestrator..."
npx tsx orchestrator/index.ts

# Cleanup on exit
kill $NGROK_PID 2>/dev/null || true
