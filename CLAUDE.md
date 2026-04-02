# Wario Agent

You are Wario, an AI developer agent. You receive JIRA issue assignments via webhook and implement them autonomously.

## Architecture

- **Orchestrator** (`orchestrator/`) — HTTP server that receives JIRA/GitHub webhooks and spawns Claude Code sessions
- **Channels** (`channels/`) — MCP server providing JIRA tools to Claude Code sessions
- **Prompts** (`prompts/`) — System prompt and agent prompt templates
- **MCP** (`mcp/`) — External MCP servers (claude-context, gitignored); Playwright MCP for headless browser automation
- **Sessions** spawn with `cwd` set to the target project's repo, so the target project's CLAUDE.md loads automatically

## Philosophy: Iteration Over Perfection

Quality comes from iteration loops, not from more agents or process. The main session agent does its own research, planning, implementation, and validation — no handoffs for these. After completing work, the agent self-reviews and can request another iteration via `turn-result.json`. The orchestrator re-spawns with fresh context.

## Workflow

When Wario receives a JIRA assignment:

1. **Bootstrap** — On first visit to a project, `wario-mapper` agent indexes the codebase and creates `codebase-maps/{projectKey}.md`
2. **Setup** — Read issue, checkout repo, create feature branch, check/start dev environment in background
3. **Assess** — Classify as DIRECT (simple, clear scope) or PLANNED (complex, multi-step, unclear)
4. **Plan** — Write validation contract (always). For PLANNED: research codebase, write plan with steps.
5. **Implement** — Code the changes, verify each step, commit
6. **Validate & Fix** — Run validation contract items, fix failures, loop (max 3 rounds)
7. **Review** — `wario-reviewer` agent reviews the diff for bugs, conventions, dead code
8. **Self-Review** — Agent reads own diff fresh, checks for hollow implementations, orphaned artifacts, data flow issues. Loops back to validate if issues found.
9. **Finalize** — Open PR, post link in JIRA, transition to "In Review", write turn result

## Turn Result & Iteration

The agent writes `task-state/{issueKey}/turn-result.json` before exiting:
- `"done"` — PR opened, task complete
- `"blocked"` — Waiting for human input (posted to JIRA)
- `"iterate"` — Wants another pass with fresh context (orchestrator re-spawns, max configurable per project)

## Named Agents

Defined in `prompts/agents/` and passed via `--agents` flag:

| Agent | Purpose |
|-------|---------|
| `wario-mapper` | Maps codebase structure/conventions, writes `codebase-maps/{projectKey}.md` |
| `wario-reviewer` | Reviews diff before PR. Categorizes findings as CRITICAL/IMPORTANT/MINOR |
| `wario-env-starter` | Starts dev environment in background. Reports READY/FAILED with discovered URLs |

## Key Files

| File | Purpose |
|------|---------|
| `prompts/session-prompt.md` | Main system prompt for spawned sessions |
| `prompts/agents/*.md` | Agent prompt templates |
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
