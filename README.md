# Wario

AI developer agent that receives JIRA assignments and implements them autonomously via Claude Code.

## How it works

1. JIRA assigns an issue to Wario
2. A webhook fires to the orchestrator
3. The orchestrator spawns a Claude Code session that reads the issue, creates a feature branch, implements changes, opens a PR, and transitions the ticket to "In Review"

## Prerequisites

- Node.js 20+ and pnpm
- [Claude Code](https://code.claude.com/docs/en/quickstart) installed and authenticated
- [GitHub CLI](https://docs.github.com/en/github-cli/github-cli/quickstart) installed and authenticated
- [ngrok](https://ngrok.com/docs/agent) with a static domain
- A JIRA Cloud instance with webhook access

See [docs/SETUP.md](docs/SETUP.md) for detailed setup instructions.

## Quick start

```bash
git clone <this-repo>
cd wario-v2
npm install

# Clone and build the claude-context MCP server
git clone git@github.com:alfredsgenkins/claude-context.git mcp/claude-context
cd mcp/claude-context && pnpm install && pnpm build:mcp && cd ../..

# Configure environment and projects
cp .env.example .env    # fill in your values
vim projects.yaml       # map JIRA projects to repos
```

## Configuration

### Environment variables

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Description |
|----------|----------|-------------|
| `JIRA_BASE_URL` | Yes | e.g. `https://yourorg.atlassian.net` |
| `JIRA_USER_EMAIL` | Yes | Service account email |
| `JIRA_API_TOKEN` | Yes | [Atlassian API token](https://id.atlassian.com/manage-profile/security/api-tokens) |
| `WARIO_JIRA_ACCOUNT_ID` | Yes | Wario's JIRA account ID (used to filter assignments) |
| `GITHUB_WEBHOOK_SECRET` | Yes | Shared secret for GitHub webhook HMAC verification |
| `WARIO_GITHUB_LOGIN` | Yes | Wario's GitHub username |
| `GITHUB_TOKEN` | Yes | GitHub personal access token for API calls |
| `NGROK_BASE_URL` | Yes | Your ngrok static domain |
| `OPENAI_API_KEY` | Yes | [OpenAI API key](https://platform.openai.com/api-keys) for code embeddings |
| `MILVUS_TOKEN` | Yes | [Zilliz Cloud](https://cloud.zilliz.com/signup) Personal Key |
| `MILVUS_ADDRESS` | Yes | Zilliz Cloud cluster public endpoint |
| `WEBHOOK_PORT` | No | HTTP port (default: 8788) |

### projects.yaml

Maps JIRA project keys to GitHub repos and local clones:

```yaml
projects:
  - jiraProjectKey: "PROJ"
    github:
      owner: "your-org"
      repo: "your-repo"
    localRepoPath: "/absolute/path/to/local/clone"
    upstreamBranch: "main"
    # prTargetBranch: "staging"  # optional — PR base branch (defaults to upstreamBranch)
    instructions: |
      Optional project-specific context for Claude.
      Build commands, testing instructions, etc.
    maxBudgetUsd: 5.00
```

- `jiraProjectKey` must match the prefix of JIRA issue keys (e.g., `PROJ` for `PROJ-42`)
- `localRepoPath` must be a pre-cloned git repository (absolute path)
- Feature branches (`wario/{ISSUE-KEY}`) are created directly in the repo at `localRepoPath`

## Usage

```bash
# Start with all webhooks active
./scripts/start.sh

# Start filtered to a specific issue
./scripts/start.sh --issue PROJ-42
```

The `--issue` flag filters all incoming webhooks and JIRA recovery to only the specified issue. Useful for testing or focusing on a single task.

## Webhooks

Wario needs two webhooks configured:

**JIRA** (requires admin) — `https://<ngrok-domain>/webhooks/jira-webhook`
- Events: Issue created, Issue updated, Comment created

**GitHub** (per-repo webhook, not a GitHub App) — `https://<ngrok-domain>/webhooks/github`
- Content type: `application/json`
- Secret: same as `GITHUB_WEBHOOK_SECRET` in `.env`
- Events: Pull request reviews, Pull request review comments, Issue comments

## File structure

```
orchestrator/   # HTTP server, webhook handlers, session management
channels/       # MCP server providing JIRA tools to Claude sessions
lib/            # Shared libraries (JIRA client)
prompts/        # System prompt and agent templates
mcp/         # Vendored dependencies (claude-context, gitignored)
scripts/        # start.sh launcher
docs/           # Setup guide and documentation
projects.yaml   # Maps JIRA projects to local repos
logs/           # Per-issue session logs (gitignored)
```
