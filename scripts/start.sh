#!/bin/bash
set -e
cd "$(dirname "$0")/.."

# ── Helpers ────────────────────────────────────────────────────────

fail() {
  echo "✗ $1"
  if [ -n "$2" ]; then
    echo "  → $2"
  fi
}

ok() { echo "✓ $1"; }

# ── Phase 1: Check for claude CLI (needed to fix other issues) ─────

echo "Checking prerequisites..."
echo ""

if ! command -v claude >/dev/null 2>&1; then
  echo "✗ claude CLI not found"
  echo "  → Install from https://code.claude.com/docs/en/quickstart"
  echo "  Claude is required both to run Wario and to auto-fix missing prerequisites."
  exit 1
fi
ok "claude CLI"

# ── Phase 2: Check tools, collect missing ones ────────────────────

missing_tools=()

for tool in git gh ngrok pnpm; do
  if command -v "$tool" >/dev/null 2>&1; then
    ok "$tool"
  else
    fail "$tool not found"
    missing_tools+=("$tool")
  fi
done

# Auto-install missing tools via Claude
if [ ${#missing_tools[@]} -gt 0 ]; then
  echo ""
  echo "Launching Claude to install missing tools: ${missing_tools[*]}"
  claude -p "Install these command-line tools on this system: ${missing_tools[*]}. Use the appropriate package manager for this OS. Verify each one works after installing." --dangerously-skip-permissions
  echo ""

  # Re-check after install
  still_missing=()
  for tool in "${missing_tools[@]}"; do
    if command -v "$tool" >/dev/null 2>&1; then
      ok "$tool installed"
    else
      still_missing+=("$tool")
    fi
  done

  if [ ${#still_missing[@]} -gt 0 ]; then
    echo "✗ Could not install: ${still_missing[*]}"
    echo "  → Please install them manually and try again."
    exit 1
  fi
fi
echo ""

# ── Phase 3: Authentication ───────────────────────────────────────

echo "Authentication:"
if gh auth status >/dev/null 2>&1; then
  ok "gh authenticated"
else
  fail "gh not authenticated" "Run: gh auth login"
  exit 1
fi
echo ""

# ── Phase 4: Files ────────────────────────────────────────────────

echo "Files:"

# .env
if [ -f .env ]; then
  ok ".env"
else
  fail ".env not found" "Run: cp .env.example .env — then fill in your values (see docs/SETUP.md)"
  exit 1
fi

# projects.yaml
needs_setup=false
if [ ! -f projects.yaml ]; then
  fail "projects.yaml not found" "The setup assistant will help you create it"
  needs_setup=true
elif ! grep -q "jiraProjectKey" projects.yaml 2>/dev/null; then
  fail "projects.yaml has no projects configured" "The setup assistant will help you set one up"
  needs_setup=true
elif ! grep -q "localRepoPath" projects.yaml 2>/dev/null; then
  fail "projects.yaml is incomplete" "The setup assistant will help you finish it"
  needs_setup=true
else
  ok "projects.yaml"
fi

# claude-context: auto-clone and build if missing
if [ -f mcp/claude-context/packages/mcp/dist/index.js ]; then
  ok "mcp/claude-context (built)"
else
  # claude-context requires pnpm >= 10
  pnpm_version=$(pnpm -v 2>/dev/null)
  pnpm_major=$(echo "$pnpm_version" | cut -d. -f1)
  if [ -n "$pnpm_major" ] && [ "$pnpm_major" -lt 10 ]; then
    echo "⟳ pnpm $pnpm_version is too old for claude-context (requires >=10), upgrading..."
    pnpm i -g pnpm
  fi

  echo "⟳ mcp/claude-context not built — setting up..."
  if [ ! -d mcp/claude-context/.git ]; then
    rm -rf mcp/claude-context
    git clone git@github.com:alfredsgenkins/claude-context.git mcp/claude-context
  fi
  cd mcp/claude-context
  pnpm install
  pnpm build:mcp
  cd ../..

  if [ -f mcp/claude-context/packages/mcp/dist/index.js ]; then
    ok "mcp/claude-context (built)"
  else
    fail "mcp/claude-context build failed" "Check the output above for errors"
    exit 1
  fi
fi
echo ""

# ── Phase 5: Environment variables ────────────────────────────────

set -a
source .env
set +a

echo "Environment variables:"
env_errors=0

check_env() {
  local var_name="$1"
  local hint="$2"
  local value="${!var_name}"
  if [ -n "$value" ]; then
    ok "$var_name"
  else
    fail "$var_name not set" "$hint"
    env_errors=$((env_errors + 1))
  fi
}

check_env JIRA_BASE_URL          "Your Atlassian URL, e.g. https://yourorg.atlassian.net"
check_env JIRA_USER_EMAIL        "Email of the JIRA service account"
check_env JIRA_API_TOKEN         "Create at https://id.atlassian.com/manage-profile/security/api-tokens"
check_env WARIO_JIRA_ACCOUNT_ID  "See docs/SETUP.md 'Finding your JIRA account ID'"
check_env GITHUB_WEBHOOK_SECRET  "Any random string — run: openssl rand -hex 32"
check_env WARIO_GITHUB_LOGIN     "GitHub username of the Wario account"
check_env GITHUB_TOKEN           "Run: gh auth token — or create at GitHub Settings > Developer Settings > Tokens"
check_env NGROK_BASE_URL         "Claim a free domain at https://dashboard.ngrok.com/domains"
check_env OPENAI_API_KEY         "Get an API key at https://platform.openai.com/api-keys (starts with sk-)"
check_env MILVUS_TOKEN           "Sign up at https://cloud.zilliz.com/signup — copy your Personal Key"
check_env MILVUS_ADDRESS         "Your Zilliz Cloud endpoint — find it in the cluster details page"
echo ""

# ── Phase 6: Validate project access ──────────────────────────────

# Skip validation and launch setup assistant if env vars or projects.yaml need fixing
if [ $env_errors -gt 0 ] || [ "$needs_setup" = true ]; then
  echo ""

  missing_vars=""
  for var in JIRA_BASE_URL JIRA_USER_EMAIL JIRA_API_TOKEN WARIO_JIRA_ACCOUNT_ID GITHUB_WEBHOOK_SECRET WARIO_GITHUB_LOGIN GITHUB_TOKEN NGROK_BASE_URL OPENAI_API_KEY MILVUS_TOKEN MILVUS_ADDRESS; do
    val="${!var}"
    [ -z "$val" ] && missing_vars="$missing_vars $var"
  done

  setup_context="The .env file is at: $(pwd)/.env. The projects.yaml file is at: $(pwd)/projects.yaml."
  setup_prompt="Help me set up Wario v2."

  if [ -n "$missing_vars" ]; then
    setup_prompt="$setup_prompt The missing environment variables are:$missing_vars."
    setup_context="$setup_context The following env variables are missing:$missing_vars."
  fi

  if [ "$needs_setup" = true ]; then
    setup_prompt="$setup_prompt Also, projects.yaml needs to be configured — help me create or fix it."
    setup_context="$setup_context projects.yaml is missing or incomplete and needs to be configured."
  fi

  setup_prompt="$setup_prompt Walk me through everything: env vars, webhooks, and project configuration as described in your instructions."

  echo "Launching setup assistant..."
  echo ""

  set +e
  claude "$setup_prompt" \
    --system-prompt-file "$(pwd)/prompts/agents/wario-setup.md" \
    --append-system-prompt "$setup_context"
  claude_exit=$?
  set -e

  if [ $claude_exit -ne 0 ]; then
    echo ""
    echo "Setup assistant exited. Run ./scripts/start.sh again when you're ready."
    exit 0
  fi

  echo ""
  echo "Re-running preflight checks..."
  exec "$0" "$@"
fi

echo "Project access:"
project_errors=0

# Validate JIRA credentials
jira_ok=false
jira_response=$(curl -s -w "\n%{http_code}" -u "$JIRA_USER_EMAIL:$JIRA_API_TOKEN" "$JIRA_BASE_URL/rest/api/3/myself" 2>/dev/null)
jira_status=$(echo "$jira_response" | tail -1)
if [ "$jira_status" = "200" ]; then
  jira_name=$(echo "$jira_response" | sed '$d' | grep -o '"displayName":"[^"]*"' | head -1 | cut -d'"' -f4)
  ok "JIRA API ($jira_name)"
  jira_ok=true
else
  fail "JIRA API returned $jira_status" "Check JIRA_BASE_URL, JIRA_USER_EMAIL, and JIRA_API_TOKEN"
  project_errors=$((project_errors + 1))
fi

# Validate GitHub token
gh_response=$(curl -s -w "\n%{http_code}" -H "Authorization: token $GITHUB_TOKEN" "https://api.github.com/user" 2>/dev/null)
gh_status=$(echo "$gh_response" | tail -1)
if [ "$gh_status" = "200" ]; then
  gh_login=$(echo "$gh_response" | sed '$d' | grep -o '"login":"[^"]*"' | head -1 | cut -d'"' -f4)
  ok "GitHub API ($gh_login)"
else
  fail "GitHub API returned $gh_status" "Check GITHUB_TOKEN has repo scope"
  project_errors=$((project_errors + 1))
fi

# Validate each project in projects.yaml
if [ -f projects.yaml ] && command -v node >/dev/null 2>&1; then
  # Parse projects.yaml and validate each project
  node -e "
    const fs = require('fs');
    const yaml = require('yaml');
    const { execSync } = require('child_process');
    const parsed = yaml.parse(fs.readFileSync('projects.yaml', 'utf-8'));
    const projects = parsed?.projects || [];
    if (projects.length === 0) {
      console.log('FAIL:No projects defined in projects.yaml');
      process.exit(0);
    }
    for (const p of projects) {
      const key = p.jiraProjectKey;
      // Check local repo exists
      if (!p.localRepoPath || !fs.existsSync(p.localRepoPath)) {
        console.log('FAIL:' + key + ' — localRepoPath not found: ' + (p.localRepoPath || '(empty)'));
        continue;
      }
      if (!fs.existsSync(p.localRepoPath + '/.git')) {
        console.log('FAIL:' + key + ' — ' + p.localRepoPath + ' is not a git repo');
        continue;
      }
      // Check GitHub repo accessible
      try {
        execSync('gh repo view ' + p.github.owner + '/' + p.github.repo + ' --json name', { stdio: 'pipe', timeout: 10000 });
      } catch {
        console.log('FAIL:' + key + ' — cannot access GitHub repo ' + p.github.owner + '/' + p.github.repo);
        continue;
      }
      // Check upstream branch exists
      try {
        execSync('git -C \"' + p.localRepoPath + '\" rev-parse --verify origin/' + p.upstreamBranch, { stdio: 'pipe', timeout: 10000 });
      } catch {
        console.log('FAIL:' + key + ' — upstream branch origin/' + p.upstreamBranch + ' not found (try: git -C ' + p.localRepoPath + ' fetch origin)');
        continue;
      }
      console.log('OK:' + key + ' — ' + p.github.owner + '/' + p.github.repo + ' (' + p.upstreamBranch + ')');
    }
  " 2>/dev/null | while IFS=: read -r status msg; do
    if [ "$status" = "OK" ]; then
      ok "Project $msg"
    else
      fail "Project $msg"
      # Can't increment project_errors from subshell, use a file
      echo 1 >> /tmp/wario_project_errors
    fi
  done
  if [ -f /tmp/wario_project_errors ]; then
    project_errors=$((project_errors + $(wc -l < /tmp/wario_project_errors)))
    rm -f /tmp/wario_project_errors
  fi
fi
echo ""

if [ $project_errors -gt 0 ]; then
  needs_setup=true
  echo "Found $project_errors project access issue(s)."

  setup_context="The .env file is at: $(pwd)/.env. The projects.yaml file is at: $(pwd)/projects.yaml."
  setup_prompt="Some project access checks failed. Help me fix the issues — validate and correct my .env credentials and projects.yaml configuration."

  echo "Launching setup assistant..."
  echo ""

  set +e
  claude "$setup_prompt" \
    --system-prompt-file "$(pwd)/prompts/agents/wario-setup.md" \
    --append-system-prompt "$setup_context Project validation failed with $project_errors error(s). Read the .env and projects.yaml files, identify the issues, and help the user fix them."
  claude_exit=$?
  set -e

  if [ $claude_exit -ne 0 ]; then
    echo ""
    echo "Setup assistant exited. Run ./scripts/start.sh again when you're ready."
    exit 0
  fi

  echo ""
  echo "Re-running preflight checks..."
  exec "$0" "$@"
fi

echo "All checks passed!"
echo ""

# ── Kill previous processes ────────────────────────────────────────

pkill -f "ngrok http 8788" 2>/dev/null || true
pkill -f "orchestrator/index.ts" 2>/dev/null || true
lsof -ti :8788 | xargs kill 2>/dev/null || true
sleep 1

# ── Start ──────────────────────────────────────────────────────────

echo "Starting ngrok tunnel on port 8788..."
ngrok http 8788 --url="$NGROK_BASE_URL" --log=stdout --log-level=warn > /tmp/ngrok-wario.log 2>&1 &
NGROK_PID=$!

sleep 2
echo "ngrok running (PID $NGROK_PID, log at /tmp/ngrok-wario.log)"
echo "Webhook URL: $NGROK_BASE_URL"
echo ""

echo "Starting Wario orchestrator..."
npx tsx orchestrator/index.ts "$@"

# Cleanup on exit
kill $NGROK_PID 2>/dev/null || true
