#!/bin/bash
set -e
cd "$(dirname "$0")/.."

# Load env for JIRA/GitHub validation
if [ -f .env ]; then
  set -a
  source .env
  set +a
else
  echo "No .env found. Run ./scripts/start.sh first to complete initial setup."
  exit 1
fi

# Check required env vars exist (needed for project validation)
for var in JIRA_BASE_URL JIRA_USER_EMAIL JIRA_API_TOKEN GITHUB_TOKEN NGROK_BASE_URL GITHUB_WEBHOOK_SECRET; do
  if [ -z "${!var}" ]; then
    echo "Missing $var in .env. Run ./scripts/start.sh first to complete initial setup."
    exit 1
  fi
done

context="The .env file is at: $(pwd)/.env. The projects.yaml file is at: $(pwd)/projects.yaml."
context="$context Skip Phase 1 (environment variables) — they are already configured."
context="$context Skip Phase 3 JIRA webhook setup — it is already configured."
context="$context Focus only on Phase 2 (project configuration) and the GitHub webhook for the new repo."

if [ -f projects.yaml ]; then
  context="$context projects.yaml already exists with existing projects — read it first and add to it, don't overwrite."
fi

claude "I want to add a new project to Wario. Walk me through it." \
  --system-prompt-file "$(pwd)/prompts/agents/wario-setup.md" \
  --append-system-prompt "$context"
