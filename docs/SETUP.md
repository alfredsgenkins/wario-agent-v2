# Wario v2 Setup Guide

## Prerequisites

Install these tools before proceeding:

| Tool | Version | Install | Docs |
|------|---------|---------|------|
| Node.js | >= 20 | `brew install node` | https://nodejs.org |
| pnpm | latest | `npm install -g pnpm` | https://pnpm.io |
| git | any | `brew install git` | https://git-scm.com |
| GitHub CLI | any | `brew install gh` | https://docs.github.com/en/github-cli/github-cli/quickstart |
| Claude Code | latest | See install guide | https://code.claude.com/docs/en/quickstart |
| ngrok | any | `brew install ngrok` | https://ngrok.com/docs/agent |

After installing, authenticate:

```bash
gh auth login          # Follow prompts to authenticate with GitHub
claude                 # Opens browser for Claude authentication on first run
ngrok config add-authtoken YOUR_TOKEN   # From https://dashboard.ngrok.com
```

## 1. Clone and install

```bash
git clone <wario-v2-repo-url>
cd wario-v2
npm install
```

### Build the claude-context MCP server

Wario uses a fork of [claude-context](https://github.com/zilliztech/claude-context) for semantic code search. Clone it into `vendor/`:

```bash
git clone git@github.com:alfredsgenkins/claude-context.git mcp/claude-context
cd mcp/claude-context
pnpm install
pnpm build:mcp
cd ../..
```

The `mcp/` directory is gitignored. This step is required even if you don't plan to use semantic search — the MCP config references it.

## 2. Environment variables

```bash
cp .env.example .env
```

Fill in each variable:

### JIRA (required)

| Variable | Description | How to get it |
|----------|-------------|---------------|
| `JIRA_BASE_URL` | Your Atlassian instance URL, e.g. `https://yourorg.atlassian.net` | From your browser address bar |
| `JIRA_USER_EMAIL` | Email of the JIRA service account Wario will use | The account that will be assigned tasks |
| `JIRA_API_TOKEN` | API token for that account | Create at https://id.atlassian.com/manage-profile/security/api-tokens (tokens expire after 1 year by default) |
| `WARIO_JIRA_ACCOUNT_ID` | The JIRA account ID of the Wario user | See [Finding your JIRA account ID](#finding-your-jira-account-id) below |

### GitHub (required)

| Variable | Description | How to get it |
|----------|-------------|---------------|
| `GITHUB_WEBHOOK_SECRET` | Shared secret for webhook HMAC-SHA256 verification | Choose any random string (e.g. `openssl rand -hex 32`). Use the same value when creating the GitHub webhook. |
| `WARIO_GITHUB_LOGIN` | Wario's GitHub username | The GitHub account that will push branches and open PRs |
| `GITHUB_TOKEN` | Personal access token (classic) with **`repo`** scope. Needed for pushing branches, creating PRs, and posting comments. | Run `gh auth token` if already authenticated, or create at https://github.com/settings/tokens/new (select `repo` scope) |

### ngrok (required)

| Variable | Description | How to get it |
|----------|-------------|---------------|
| `NGROK_BASE_URL` | Your ngrok static domain, e.g. `https://wario.ngrok-free.dev` | Claim a free static domain at https://dashboard.ngrok.com/domains or use a paid plan |

### Codebase semantic search (required)

Used by the claude-context MCP server to index codebases and provide semantic search to Claude sessions.

| Variable | Description | How to get it |
|----------|-------------|---------------|
| `OPENAI_API_KEY` | OpenAI API key for generating code embeddings | Create at https://platform.openai.com/api-keys (starts with `sk-`) |
| `MILVUS_TOKEN` | Zilliz Cloud API key (Personal Key) | Sign up at https://cloud.zilliz.com/signup (free tier available), copy your Personal Key from the dashboard |
| `MILVUS_ADDRESS` | Zilliz Cloud public endpoint | Create a cluster in Zilliz Cloud dashboard, copy the Public Endpoint from cluster details |

### Finding your JIRA account ID

Use the JIRA REST API to look up the account ID:

```bash
curl -s -u "your-email@example.com:YOUR_API_TOKEN" \
  "https://yourorg.atlassian.net/rest/api/3/myself" | python3 -m json.tool
```

The `accountId` field in the response is what you need for `WARIO_JIRA_ACCOUNT_ID`.

## 3. Configure projects.yaml

This file maps JIRA project keys to GitHub repos and local clones. Edit `projects.yaml`:

```yaml
projects:
  - jiraProjectKey: "PROJ"                    # Must match the prefix of JIRA issue keys
    github:
      owner: "your-github-user"               # GitHub org or user
      repo: "your-repo"                       # Repository name
    localRepoPath: "/absolute/path/to/repo"   # Pre-cloned local git repo (absolute path)
    upstreamBranch: "main"                    # Base branch for PRs
    instructions: |                           # Optional: project context for Claude sessions
      Brief description of the project.
      How to build: npm run build
      How to test: npm test
    maxBudgetUsd: 5.00                        # Optional: Claude API spend limit per session (default: 5)
```

**Important notes:**
- `jiraProjectKey` must match the prefix of issue keys. If issues are `PROJ-1`, `PROJ-2`, etc., use `"PROJ"`.
- `localRepoPath` must already exist as a cloned git repository. Wario does not clone repos.
- Worktrees are created at `../worktrees/{ISSUE-KEY}` relative to `localRepoPath`.
- You can list multiple projects. Wario matches incoming webhooks to projects by the issue key prefix.

## 4. Configure Claude Code settings

Add the following to `~/.claude/settings.json` so Wario's commits and PRs don't include Claude attribution messages:

```json
{
  "attribution": {
    "commit": "",
    "pr": ""
  }
}
```

## 5. Set up ngrok

ngrok creates a public tunnel to your local machine so JIRA and GitHub can send webhooks to it.

### Get your auth token

1. Sign up or log in at https://dashboard.ngrok.com
2. Go to **Your Authtoken** (https://dashboard.ngrok.com/get-started/your-authtoken)
3. Copy the token and run:
   ```bash
   ngrok config add-authtoken YOUR_TOKEN
   ```

### Claim a static domain (recommended)

A static domain means your webhook URLs stay the same across restarts — you configure JIRA and GitHub once.

1. Go to https://dashboard.ngrok.com/domains
2. Click **Create Domain** (one free static domain is included on the free plan)
3. You'll get a domain like `your-name.ngrok-free.dev`
4. Set `NGROK_BASE_URL=https://your-name.ngrok-free.dev` in your `.env`

### Test the tunnel

```bash
ngrok http 8788 --url=your-name.ngrok-free.dev
```

You should see the tunnel status in the terminal. Press `Ctrl+C` to stop — `start.sh` will launch ngrok automatically.

Without a static domain, ngrok assigns a random URL each restart. You'd need to update your JIRA and GitHub webhook URLs every time, which is impractical.

## 6. Configure JIRA webhook

> Requires JIRA admin access. If you don't have admin access, ask your JIRA administrator to set this up for you.

1. Go to **JIRA Settings** > **System** > **Advanced** > **WebHooks**
   (Direct URL: `https://yourorg.atlassian.net/plugins/servlet/webhooks`)
2. Click **Create a WebHook**
3. Configure:
   - **Name:** Wario Agent
   - **URL:** `https://<your-ngrok-domain>/webhooks/jira-webhook`
   - **Events:**
     - Issue: created
     - Issue: updated
     - Comment: created
4. Save

For more details, see [Atlassian's webhook documentation](https://support.atlassian.com/jira-cloud-administration/docs/manage-webhooks/).

**Note:** JIRA webhooks do not work on port 80. ngrok handles this by tunneling through port 443.

## 7. Configure GitHub repo webhook

This is a per-repo webhook — no GitHub App required.

1. Go to your repo on GitHub > **Settings** > **Webhooks** > **Add webhook**
2. Configure:
   - **Payload URL:** `https://<your-ngrok-domain>/webhooks/github`
   - **Content type:** `application/json`
   - **Secret:** The same value you set for `GITHUB_WEBHOOK_SECRET` in `.env`
   - **Which events:** Select individual events:
     - Pull request reviews
     - Pull request review comments
     - Issue comments
3. Click **Add webhook**

GitHub will send a ping event to verify the URL is reachable. Make sure ngrok and the orchestrator are running.

For more details, see [GitHub's webhook documentation](https://docs.github.com/en/webhooks/using-webhooks/creating-webhooks).

**Repeat this for each repository** listed in `projects.yaml`.

## 8. Start Wario

```bash
# Start with all webhooks active
./scripts/start.sh

# Start filtered to a specific issue (useful for testing)
./scripts/start.sh --issue PROJ-42
```

The start script runs preflight checks, launches ngrok, and starts the orchestrator. If any prerequisite is missing, it will tell you what to fix.

### Monitoring

```bash
# Check health
curl http://127.0.0.1:8788/health

# List active sessions
curl http://127.0.0.1:8788/sessions

# Stream logs for a specific issue
curl http://127.0.0.1:8788/logs/PROJ-42
```

Log files are also written to `logs/{ISSUE-KEY}.log`.

## Troubleshooting

**Preflight check fails with "ngrok not found"**
Install ngrok: `brew install ngrok` or see https://ngrok.com/docs/agent

**"gh not authenticated"**
Run `gh auth login` and follow the prompts.

**JIRA webhook not arriving**
- Check the webhook log in JIRA (Settings > Webhooks > your webhook > Recent Deliveries)
- Verify ngrok is running and the URL matches
- Ensure the webhook events include "Issue: updated" and "Comment: created"

**GitHub webhook returns 401**
- The `GITHUB_WEBHOOK_SECRET` in `.env` must exactly match the secret in the repo webhook settings
- Check the webhook delivery log in GitHub (repo Settings > Webhooks > Recent Deliveries)

**"No project configured for key: PROJ"**
- The JIRA project key in the issue (e.g., `PROJ` from `PROJ-42`) doesn't match any `jiraProjectKey` in `projects.yaml`

**Session spawns but Claude fails immediately**
- Ensure `claude` CLI is authenticated: run `claude` in a terminal
- Check that `localRepoPath` in `projects.yaml` exists and is a git repository
- Check the log file at `logs/{ISSUE-KEY}.log` for details

**"claude-context not found" in preflight**
Run the clone and build steps:
```bash
git clone git@github.com:alfredsgenkins/claude-context.git mcp/claude-context
cd mcp/claude-context && pnpm install && pnpm build:mcp
```
