#!/bin/bash
set -e

# Load .env
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

# Kill any previous ngrok/channel processes
pkill -f "ngrok http 8788" 2>/dev/null || true
pkill -f "jira-channel.ts" 2>/dev/null || true
# Free the webhook port if still held
lsof -ti :8788 | xargs kill 2>/dev/null || true
sleep 1

echo "Starting ngrok tunnel on port 8788..."
ngrok http 8788 --url="$NGROK_BASE_URL" --log=stdout --log-level=warn > /tmp/ngrok-wario.log 2>&1 &
NGROK_PID=$!

# Give ngrok a moment to start
sleep 2
echo "ngrok running (PID $NGROK_PID, log at /tmp/ngrok-wario.log)"

echo "Starting Claude Code with JIRA channel..."
echo "Webhook URL: $NGROK_BASE_URL/webhooks/jira-webhook"
echo ""

claude --dangerously-load-development-channels server:wario

# Cleanup ngrok on exit
kill $NGROK_PID 2>/dev/null || true
