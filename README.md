# Wario

AI developer agent that receives JIRA assignments and implements them autonomously via Claude Code.

## How it works

1. JIRA assigns an issue to Wario
2. A webhook fires → Wario's channel receives it
3. Claude Code reads the issue, clones a worktree, implements the changes, opens a PR, and transitions the ticket to "In Review"

## Prerequisites

- [Claude Code](https://claude.ai/code) installed and authenticated
- [ngrok](https://ngrok.com) with a static domain
- Node.js 18+
- A GitHub App with repo access (for webhook signature verification)

## Setup

### 1. Clone and install

```bash
git clone <this-repo>
cd wario-v2
npm install
```

### 2. Configure secrets

Copy the example env file and fill in your values:

```bash
cp .env.example .env
```

| Variable | Description |
|----------|-------------|
| `JIRA_BASE_URL` | e.g. `https://yourorg.atlassian.net` |
| `JIRA_USER_EMAIL` | Service account email |
| `JIRA_API_TOKEN` | Atlassian API token |
| `GITHUB_APP_WEBHOOK_SECRET` | GitHub App webhook secret |
| `NGROK_BASE_URL` | Your ngrok static domain, e.g. `https://wario.ngrok.io` |

### 3. Configure target projects

Edit `projects.yaml` to map JIRA project keys to local repos:

```yaml
projects:
  - jiraProjectKey: "MYPROJECT"
    github:
      owner: "your-org"
      repo: "your-repo"
    localRepoPath: "/absolute/path/to/local/clone"
    upstreamBranch: "main"
```

Make sure each `localRepoPath` is already cloned locally.

### 4. Configure Claude Code (global settings)

Add the following to `~/.claude/settings.json` so Wario's commits and PRs don't include Claude attribution:

```json
{
  "attribution": {
    "commit": "",
    "pr": ""
  }
}
```

### 5. Configure JIRA webhook

In your JIRA project → Settings → Webhooks, create a webhook pointing to:

```
https://<your-ngrok-domain>/webhooks/jira-webhook
```

Events to enable: **Issue updated** (assignment), **Comment created**.

### 6. Start Wario

```bash
./scripts/start.sh
```

Then in a separate terminal, start Claude Code in channel mode:

```bash
claude --channel wario
```

## File structure

```
channels/       # MCP channel server (JIRA + GitHub webhooks)
orchestrator/   # (optional) multi-task orchestration
prompts/        # System prompt for the Wario agent
projects.yaml   # Maps JIRA projects to local repos
scripts/        # start.sh launcher
mcp-configs/    # MCP server config snippets
worktrees/      # Git worktrees created per issue (gitignored)
```
