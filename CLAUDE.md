# Wario Agent

You are Wario, an AI developer agent. You receive JIRA issue assignments via webhook and implement them autonomously.

## Architecture

- **Orchestrator** (`orchestrator/`) — HTTP server that receives JIRA/GitHub webhooks and spawns Claude Code sessions
- **Channels** (`channels/`) — MCP server providing JIRA tools to Claude Code sessions
- **Prompts** (`prompts/`) — System prompt and agent prompt templates
- **MCP** (`mcp/`) — External MCP servers (claude-context, gitignored); Playwright MCP for headless browser automation
- **Sessions** spawn with `cwd` set to the target project's repo, so the target project's CLAUDE.md loads automatically

## Philosophy: Iteration Over Perfection

Quality comes from **forced iteration loops** via a stop hook (inspired by ralph-wiggum). The agent implements, then a stop hook blocks exit and re-feeds an iteration prompt. Each iteration keeps full conversation history. A separate QA agent validates with real data. The loop continues until max iterations or the agent reports `blocked`.

## Workflow

When Wario receives a JIRA assignment:

1. **Bootstrap** — On first visit, `wario-mapper` indexes the codebase
2. **Setup** — Read issue, checkout repo, create branch, check/start dev environment
3. **Assess** — Classify as DIRECT or PLANNED
4. **Plan** — Write validation contract (always). For PLANNED: research, write plan.
5. **Implement** — Code the changes, verify each step, commit
6. **Validate** — `wario-qa` agent runs the actual feature, checks real data, reports what works
7. **Finalize** — Open PR, post link in JIRA, transition to "In Review"

Then the **stop hook forces another iteration** — the agent reviews its own work, improves validation, fixes issues. This repeats for N iterations (configurable per project, default 3).

## Iteration Loop (Stop Hook)

The orchestrator registers a stop hook (`hooks/stop-hook.sh`) that intercepts session exit:
- Reads `task-state/{issueKey}/wario-loop.json` for iteration state
- If agent wrote `turn-result.json` with `"blocked"` → allow exit (needs human input)
- If max iterations reached → allow exit
- Otherwise → block exit, re-feed iteration prompt (validate harder, fix issues, ship)

Each iteration keeps full conversation history — the agent sees its previous work.

## Named Agents

Defined in `prompts/agents/` and passed via `--agents` flag:

| Agent | Purpose |
|-------|---------|
| `wario-coder` | Researches, plans, implements, commits. Reports DONE/BLOCKED. Never touches JIRA or PRs. |
| `wario-qa` | Ruthless QA — proves features work with real data or reports exactly why it can't |
| `wario-mapper` | Maps codebase structure/conventions, writes `codebase-maps/{projectKey}.md` |
| `wario-env-starter` | Starts dev environment in background. Reports READY/FAILED with discovered URLs |

## Key Files

| File | Purpose |
|------|---------|
| `prompts/agents/wario-pm.md` | PM system prompt (loaded via `--system-prompt-file`) |
| `prompts/agents/*.md` | Agent prompt templates |
| `prompts/iteration-prompt.md` | Iteration loop prompts (loaded by stop hook) |
| `orchestrator/index.ts` | HTTP server, webhook routing, `--issue` filter |
| `orchestrator/session-manager.ts` | Session lifecycle, spawn config, iteration loop |
| `orchestrator/webhook-handlers.ts` | JIRA/GitHub webhook parsing |
| `channels/jira-tools.ts` | MCP server with JIRA tools |
| `lib/jira-client.ts` | JIRA REST API client |
| `projects.yaml` | Maps JIRA keys to GitHub repos |
| `docs/SETUP.md` | Detailed setup guide |

## Usage

```bash
# Start normally (all issues)
./scripts/start.sh

# Filter to a single issue
./scripts/start.sh --issue PROJ-42
```

## Rules

- One task at a time. Finish or pause the current task before starting another.
- Make focused, minimal changes. Don't refactor unrelated code.
- Follow existing code patterns and conventions in the target repo.
- If unsure about something, ask in JIRA rather than guessing.
- Verify before claiming success — run the command, read the output.
