import { spawn, type ChildProcess, execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import os from "node:os";
import type { ProjectConfig, WebhookEvent } from "./types.js";
import * as store from "./session-store.js";
import { JiraClient } from "../lib/jira-client.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const PROMPT_FILE = path.join(ROOT, "prompts", "session-prompt.md");
const AGENTS_DIR = path.join(ROOT, "prompts", "agents");
const LOGS_DIR = path.join(ROOT, "logs");

fs.mkdirSync(LOGS_DIR, { recursive: true });

const DEBOUNCE_MS = 4000;
const STUCK_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes with no output = stuck

interface ManagedSession {
  issueKey: string;
  projectKey: string;
  project: ProjectConfig;
  sessionId: string;
  process: ChildProcess | null;
  logStream: fs.WriteStream;
  status: "active" | "idle";
  eventQueue: WebhookEvent[];
  debounceTimer: NodeJS.Timeout | null;
  lastActivityAt: number;
}

const sessions = new Map<string, ManagedSession>();

/** Build MCP config JSON with absolute paths */
function buildMcpConfig(): string {
  const config = {
    mcpServers: {
      jira: {
        command: "npx",
        args: ["tsx", path.join(ROOT, "channels", "jira-tools.ts")],
        env: {
          JIRA_BASE_URL: "${JIRA_BASE_URL}",
          JIRA_USER_EMAIL: "${JIRA_USER_EMAIL}",
          JIRA_API_TOKEN: "${JIRA_API_TOKEN}",
        },
      },
      "claude-context": {
        command: "node",
        args: [path.join(os.homedir(), "Projects", "claude-context", "packages", "mcp", "dist", "index.js")],
        env: {
          OPENAI_API_KEY: "${OPENAI_API_KEY}",
          MILVUS_TOKEN: "${MILVUS_TOKEN}",
          MILVUS_ADDRESS: "${MILVUS_ADDRESS}",
        },
      },
    },
  };
  const tmpPath = path.join(ROOT, "mcp-configs", ".generated-mcp.json");
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
  return tmpPath;
}

/** Load agent definitions from prompts/agents/*.md */
function buildAgentsJson(): string {
  const agents: Record<string, { description: string; prompt: string }> = {};
  const agentFiles = [
    { name: "wario-implementer", file: "wario-implementer.md", description: "Implements one step of a development plan" },
    { name: "wario-reviewer", file: "wario-reviewer.md", description: "Reviews code changes before PR" },
    { name: "wario-mapper", file: "wario-mapper.md", description: "Maps a codebase structure and conventions" },
  ];
  for (const agent of agentFiles) {
    const filePath = path.join(AGENTS_DIR, agent.file);
    if (fs.existsSync(filePath)) {
      agents[agent.name] = {
        description: agent.description,
        prompt: fs.readFileSync(filePath, "utf-8"),
      };
    }
  }
  return JSON.stringify(agents);
}

/** Deterministic UUID v5 from issue key */
function issueKeyToUUID(issueKey: string): string {
  const namespace = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
  const hash = crypto
    .createHash("sha1")
    .update(Buffer.from(namespace.replace(/-/g, ""), "hex"))
    .update(`wario:${issueKey}`)
    .digest("hex");

  return (
    hash.slice(0, 8) +
    "-" +
    hash.slice(8, 12) +
    "-5" +
    hash.slice(13, 16) +
    "-" +
    ((parseInt(hash[16], 16) & 0x3) | 0x8).toString(16) +
    hash.slice(17, 20) +
    "-" +
    hash.slice(20, 32)
  );
}

/** Dispatch an event: start new session or send to existing one */
export function dispatchEvent(
  event: WebhookEvent,
  project: ProjectConfig
): void {
  const { issueKey } = event;
  let managed = sessions.get(issueKey);

  if (!managed) {
    managed = initSession(event, project);
  }

  if (managed.status === "active") {
    log(issueKey, `Session busy, queueing: ${event.eventType}`);
    managed.eventQueue.push(event);
    return;
  }

  // Idle — debounce to batch rapid-fire events (e.g. simultaneous PR review + comments)
  managed.eventQueue.push(event);
  if (managed.debounceTimer) clearTimeout(managed.debounceTimer);
  log(issueKey, `Debouncing: ${event.eventType} (${DEBOUNCE_MS}ms window)`);
  managed.debounceTimer = setTimeout(() => {
    managed!.debounceTimer = null;
    const pending = managed!.eventQueue.splice(0);
    if (pending.length === 0) return;
    const combined = pending.length === 1 ? pending[0] : combineEvents(pending);
    runTurn(managed!, combined);
  }, DEBOUNCE_MS);
}

function combineEvents(events: WebhookEvent[]): WebhookEvent {
  const first = events[0];
  const body = events
    .map((e, i) => `[Event ${i + 1}: ${e.eventType}]\n${e.message}`)
    .join("\n\n---\n\n");
  return {
    ...first,
    message: `${events.length} events received together:\n\n${body}`,
  };
}

function initSession(event: WebhookEvent, project: ProjectConfig): ManagedSession {
  const { issueKey, projectKey } = event;
  const sessionId = issueKeyToUUID(issueKey);

  const logStream = fs.createWriteStream(
    path.join(LOGS_DIR, `${issueKey}.log`),
    { flags: "a" }
  );

  const managed: ManagedSession = {
    issueKey,
    projectKey,
    project,
    sessionId,
    process: null,
    logStream,
    status: "idle",
    eventQueue: [],
    debounceTimer: null,
    lastActivityAt: Date.now(),
  };

  sessions.set(issueKey, managed);

  store.setSession({
    issueKey,
    projectKey,
    sessionId,
    status: "idle",
    createdAt: new Date().toISOString(),
    lastEventAt: new Date().toISOString(),
  });

  log(issueKey, `New session created (${sessionId})`);
  return managed;
}

/** Run a single claude -p turn for a session */
function runTurn(managed: ManagedSession, event: WebhookEvent): void {
  const { issueKey, sessionId, project } = managed;

  // Check if this is a resume (session file exists from a previous turn)
  // Session files are stored under ~/.claude/projects/ keyed by the cwd path
  const projectPathKey = project.localRepoPath.replace(/\//g, "-");
  const isResume = store.getSession(issueKey) !== null && managed.process === null
    ? fs.existsSync(
        path.join(
          process.env.HOME || "~",
          `.claude/projects/${projectPathKey}`,
          `${sessionId}.jsonl`
        )
      )
    : false;

  const mcpConfig = buildMcpConfig();
  const agentsJson = buildAgentsJson();

  const args = [
    "-p",
    event.message,
    ...(isResume ? ["--resume", sessionId] : ["--session-id", sessionId]),
    "--name",
    `wario-${issueKey}`,
    "--dangerously-skip-permissions",
    "--mcp-config",
    mcpConfig,
    "--agents",
    agentsJson,
    "--add-dir",
    ROOT,
    ...(isResume
      ? []
      : [
          "--system-prompt-file",
          PROMPT_FILE,
          "--append-system-prompt",
          `Issue: ${issueKey}. Project key: ${managed.projectKey}. Upstream branch: ${project.upstreamBranch}. GitHub: ${project.github.owner}/${project.github.repo}. Wario root: ${ROOT}. ${project.instructions || ""}`,
        ]),
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-budget-usd",
    String(project.maxBudgetUsd || 5),
  ];

  log(issueKey, `Running turn: ${event.eventType} (resume: ${isResume})`);
  managed.status = "active";
  store.updateStatus(issueKey, "active");

  const child = spawn("claude", args, {
    cwd: project.localRepoPath,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  managed.process = child;

  // Close stdin immediately — we pass the prompt as an arg
  child.stdin!.end();

  // Stream stdout to log file and parse events
  let budgetExhausted = false;
  const rl = readline.createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    managed.logStream.write(line + "\n");
    managed.lastActivityAt = Date.now();
    try {
      const evt = JSON.parse(line);
      if (evt.type === "result") {
        const cost = evt.total_cost_usd ? `$${evt.total_cost_usd.toFixed(4)}` : "?";
        log(issueKey, `Turn complete. Cost: ${cost}. Turns: ${evt.num_turns || "?"}`);
        // Detect budget exhaustion
        const resultText = (evt.result || "") as string;
        if (resultText.includes("Exceeded USD budget") || resultText.includes("budget")) {
          budgetExhausted = true;
          log(issueKey, "Budget exhausted — work may be incomplete");
        }
      }
      if (evt.type === "assistant" && evt.message?.content) {
        for (const block of evt.message.content) {
          if (block.type === "text" && block.text) {
            const snippet = block.text.slice(0, 100).replace(/\n/g, " ");
            log(issueKey, `Claude: ${snippet}${block.text.length > 100 ? "..." : ""}`);
          }
        }
      }
    } catch {
      // Not JSON
    }
  });

  // Log stderr
  const stderrRl = readline.createInterface({ input: child.stderr! });
  stderrRl.on("line", (line) => {
    managed.logStream.write(`[stderr] ${line}\n`);
    if (line.includes("Error") || line.includes("error")) {
      log(issueKey, `[stderr] ${line}`);
    }
  });

  // Handle exit
  child.on("exit", (code, signal) => {
    log(issueKey, `Process exited (code: ${code}, signal: ${signal})`);
    managed.process = null;
    managed.status = "idle";
    store.updateStatus(issueKey, "idle");

    // If budget was exhausted, queue a recovery turn to finalize
    if (budgetExhausted) {
      log(issueKey, "Dispatching budget recovery turn");
      managed.eventQueue.unshift({
        source: "jira",
        eventType: "budget_recovery",
        issueKey,
        projectKey: managed.projectKey,
        message: `Your previous session ran out of budget. You must wrap up NOW with minimal token usage:\n1. Check git status — if there are uncommitted changes, commit them\n2. If changes are committed but not pushed, push\n3. If pushed but no PR, open the PR\n4. Post a JIRA comment summarizing the current state\nDo NOT continue implementation — just finalize what exists.`,
      });
    }

    // Process queued events
    if (managed.eventQueue.length > 0) {
      const next = managed.eventQueue.shift()!;
      log(issueKey, `Processing queued event: ${next.eventType}`);
      runTurn(managed, next);
    }
  });

  child.on("error", (err) => {
    log(issueKey, `Process error: ${err.message}`);
    managed.process = null;
    managed.status = "idle";
    store.updateStatus(issueKey, "idle");
  });
}

export function listActiveSessions(): Array<{
  issueKey: string;
  sessionId: string;
  status: string;
  queueLength: number;
}> {
  return Array.from(sessions.entries()).map(([key, s]) => ({
    issueKey: key,
    sessionId: s.sessionId,
    status: s.status,
    queueLength: s.eventQueue.length,
  }));
}

/** Kill all active child processes and clear debounce timers */
export function shutdown(): void {
  for (const [key, managed] of sessions) {
    if (managed.debounceTimer) clearTimeout(managed.debounceTimer);
    if (managed.process) {
      log(key, "Killing child process");
      managed.process.kill();
    }
    managed.logStream.end();
  }
}

/** Recover sessions on startup: fix stale state + pick up missed JIRA assignments */
export async function recoverSessions(projects: ProjectConfig[]): Promise<void> {
  // Part 1: Fix stale active sessions (orchestrator just started, nothing is running)
  const allSessions = store.getAllSessions();
  let staleCount = 0;
  for (const record of Object.values(allSessions)) {
    if (record.status === "active") {
      store.updateStatus(record.issueKey, "idle");
      staleCount++;
    }
  }
  if (staleCount > 0) {
    console.log(`[Recovery] Reset ${staleCount} stale active session(s) to idle`);
  }

  // Part 2: Query JIRA for tasks assigned to Wario
  const jira = JiraClient.fromEnv();
  const accountId = process.env.WARIO_JIRA_ACCOUNT_ID;
  if (!jira || !accountId) {
    console.log("[Recovery] JIRA credentials or account ID not set, skipping JIRA poll");
    return;
  }

  try {
    const jql = `assignee=${accountId} AND status IN ("New","To Do","In Progress") ORDER BY updated DESC`;
    const result = await jira.searchIssues(jql);
    console.log(`[Recovery] Found ${result.issues.length} assigned issue(s) in JIRA`);

    for (const issue of result.issues) {
      const issueKey = issue.key;
      const projectKey = issueKey.split("-")[0];
      const project = projects.find((p) => p.jiraProjectKey === projectKey);
      if (!project) continue;

      // Check if PR already exists
      let prExists = false;
      try {
        const prJson = execSync(
          `gh pr list --repo ${project.github.owner}/${project.github.repo} --head wario/${issueKey} --state open --json number`,
          { encoding: "utf-8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] }
        ).trim();
        prExists = prJson !== "[]" && prJson.length > 2;
      } catch {
        // gh not available or error — assume no PR
      }

      if (prExists) {
        console.log(`[Recovery] ${issueKey}: PR exists, skipping`);
        continue;
      }

      // Check if worktree exists (interrupted mid-work)
      const worktreePath = path.join(
        path.dirname(project.localRepoPath),
        "worktrees",
        issueKey
      );
      const hasWorktree = fs.existsSync(worktreePath);
      const existingSession = store.getSession(issueKey);

      if (existingSession && hasWorktree) {
        console.log(`[Recovery] ${issueKey}: Resuming interrupted session`);
        dispatchEvent(
          {
            source: "jira",
            eventType: "recovery_resume",
            issueKey,
            projectKey,
            message: `You were interrupted mid-task on ${issueKey}. Check your progress:\n1. Read the plan file at ${ROOT}/task-state/${issueKey}/plan.md if it exists\n2. Check git status in your worktree at ${worktreePath}\n3. Continue from where you left off — don't restart from scratch.`,
          },
          project
        );
      } else {
        const summary = issue.fields?.summary || "N/A";
        console.log(`[Recovery] ${issueKey}: Dispatching missed assignment`);
        dispatchEvent(
          {
            source: "jira",
            eventType: "assigned",
            issueKey,
            projectKey,
            message: `You have been assigned ${issueKey}: "${summary}". Use jira_get_issue to read the full details and begin implementation following your system prompt instructions.`,
          },
          project
        );
      }
    }
  } catch (err: any) {
    console.error(`[Recovery] JIRA query failed: ${err.message}`);
  }
}

/** Periodic health check: detect dead and stuck child processes */
export function startHealthCheck(): void {
  setInterval(() => {
    const now = Date.now();
    for (const [key, managed] of sessions) {
      if (managed.status !== "active" || !managed.process) continue;

      // Dead process: exited without triggering handler
      if (managed.process.exitCode !== null || managed.process.killed) {
        log(key, `Dead process detected (exit: ${managed.process.exitCode}), cleaning up`);
        managed.process = null;
        managed.status = "idle";
        store.updateStatus(key, "idle");

        if (managed.eventQueue.length > 0) {
          const next = managed.eventQueue.shift()!;
          log(key, `Processing queued event: ${next.eventType}`);
          runTurn(managed, next);
        }
        continue;
      }

      // Stuck process: alive but no output for too long
      const idleMs = now - managed.lastActivityAt;
      if (idleMs > STUCK_TIMEOUT_MS) {
        log(key, `Stuck process detected (no output for ${Math.round(idleMs / 60_000)}min), killing`);
        managed.process.kill();
        managed.process = null;
        managed.status = "idle";
        store.updateStatus(key, "idle");

        // Queue a recovery turn
        managed.eventQueue.unshift({
          source: "jira",
          eventType: "stuck_recovery",
          issueKey: key,
          projectKey: managed.projectKey,
          message: `Your previous session appears to have stalled. Check your progress:\n1. Read the plan file at ${ROOT}/task-state/${key}/plan.md if it exists\n2. Check git status in your worktree\n3. Continue from where you left off — don't restart from scratch.`,
        });

        if (managed.eventQueue.length > 0) {
          const next = managed.eventQueue.shift()!;
          log(key, `Processing queued event: ${next.eventType}`);
          runTurn(managed, next);
        }
      }
    }
  }, 60_000);
}

function log(issueKey: string, message: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${issueKey}] ${message}`);
}
