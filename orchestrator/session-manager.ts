import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { ProjectConfig, WebhookEvent } from "./types.js";
import * as store from "./session-store.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const MCP_CONFIG = path.join(ROOT, "mcp-configs", "jira-tools.json");
const PROMPT_FILE = path.join(ROOT, "prompts", "session-prompt.md");
const LOGS_DIR = path.join(ROOT, "logs");

fs.mkdirSync(LOGS_DIR, { recursive: true });

const DEBOUNCE_MS = 4000;

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
}

const sessions = new Map<string, ManagedSession>();

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
  const isResume = store.getSession(issueKey) !== null && managed.process === null
    ? fs.existsSync(
        path.join(
          process.env.HOME || "~",
          ".claude/projects/-Users-alfredgenkin-Projects-wario-v2",
          `${sessionId}.jsonl`
        )
      )
    : false;

  const args = [
    "-p",
    event.message,
    ...(isResume ? ["--resume", sessionId] : ["--session-id", sessionId]),
    "--name",
    `wario-${issueKey}`,
    "--dangerously-skip-permissions",
    "--mcp-config",
    MCP_CONFIG,
    ...(isResume
      ? []
      : [
          "--system-prompt-file",
          PROMPT_FILE,
          "--append-system-prompt",
          `Issue: ${issueKey}. Project key: ${managed.projectKey}. Local repo: ${project.localRepoPath}. Upstream branch: ${project.upstreamBranch}. GitHub: ${project.github.owner}/${project.github.repo}. ${project.instructions || ""}`,
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
    cwd: ROOT,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  managed.process = child;

  // Close stdin immediately — we pass the prompt as an arg
  child.stdin!.end();

  // Stream stdout to log file and parse events
  const rl = readline.createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    managed.logStream.write(line + "\n");
    try {
      const evt = JSON.parse(line);
      if (evt.type === "result") {
        const cost = evt.total_cost_usd ? `$${evt.total_cost_usd.toFixed(4)}` : "?";
        log(issueKey, `Turn complete. Cost: ${cost}. Turns: ${evt.num_turns || "?"}`);
      }
      if (evt.type === "assistant" && evt.message?.content) {
        for (const block of evt.message.content) {
          if (block.type === "text" && block.text) {
            // Log a snippet of what Claude is saying
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

export function getSessionStatus(issueKey: string): string {
  const managed = sessions.get(issueKey);
  if (managed) return managed.status;
  const stored = store.getSession(issueKey);
  if (stored) return stored.status;
  return "unknown";
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

function log(issueKey: string, message: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${issueKey}] ${message}`);
}
