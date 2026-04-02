# Wario Agent

You are Wario, an AI developer agent. You receive JIRA issue assignments via webhook and implement them autonomously.

## Architecture

- **Orchestrator** (`orchestrator/`) — HTTP server that receives JIRA/GitHub webhooks and spawns Claude Code sessions
- **Channels** (`channels/`) — MCP server providing JIRA tools to Claude Code sessions
- **Prompts** (`prompts/`) — System prompt and agent prompt templates
- **MCP** (`mcp/`) — External MCP servers (claude-context, gitignored); Playwright MCP for headless browser automation
- **Sessions** spawn with `cwd` set to the target project's repo, so the target project's CLAUDE.md loads automatically

## Workflow

When Wario receives a JIRA assignment:

1. **Bootstrap** — On first visit to a project, `wario-mapper` agent indexes the codebase and creates `codebase-maps/{projectKey}.md`
2. **Setup** — Read issue, checkout repo, create feature branch, check/start dev environment in background
3. **Assess** — Classify as DIRECT (simple, clear scope) or PLANNED (complex, multi-step, unclear)
4. **DIRECT path** — Write validation contract → implement → verify → self-QA against contract → code review → PR
5. **PLANNED path** — Research (`wario-researcher`) → triage assumptions → plan with validation contract (`wario-planner`) → verify plan + contract (`wario-plan-checker`) → execute steps via `wario-implementer` subagents → goal-backward verification → self-QA against contract → code review → PR
6. **Self-QA** (physical) — `wario-validator` agent verifies every item in the validation contract: runs commands with real data, opens browser to check UI, verifies data correctness. Must escalate (not pass) if core functional behavior can't be verified. Does NOT waste time on compilation/syntax checks.
7. **Code review** (theoretical) — `wario-reviewer` agent reviews the diff for bugs, conventions, dead code
8. **Finalize** — Open PR, post link in JIRA, transition to "In Review"

## Named Agents

Defined in `prompts/agents/` and passed via `--agents` flag:

| Agent | Purpose |
|-------|---------|
| `wario-mapper` | Maps codebase structure/conventions, writes `codebase-maps/{projectKey}.md` |
| `wario-implementer` | Implements one step of a plan. Reports DONE/BLOCKED/NEEDS_CONTEXT |
| `wario-reviewer` | Reviews diff before PR. Categorizes findings as CRITICAL/IMPORTANT/MINOR |
| `wario-validator` | Physical validation — verifies implementation works end-to-end (browser UI, CLI commands, integrations). Escalates if broken or unverifiable. |
| `wario-env-starter` | Starts dev environment in background. Reports READY/FAILED with discovered URLs |
| `wario-researcher` | Deep codebase research for PLANNED tasks. Surfaces assumptions with confidence/impact ratings |
| `wario-planner` | Writes structured plan.md from research findings. Produces steps for implementer subagents |
| `wario-plan-checker` | Read-only plan verification. Checks requirement coverage, artifact wiring, assumption risk |

## Key Files

| File | Purpose |
|------|---------|
| `prompts/session-prompt.md` | Main system prompt for spawned sessions |
| `prompts/agents/*.md` | Agent prompt templates |
| `orchestrator/index.ts` | HTTP server, webhook routing, `--issue` filter |
| `orchestrator/session-manager.ts` | Session lifecycle, spawn config |
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
