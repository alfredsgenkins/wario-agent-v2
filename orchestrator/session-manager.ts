import { spawn, type ChildProcess, execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
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
  humanChatActive: boolean;
  iterationCount: number;
}

const sessions = new Map<string, ManagedSession>();

/** Tracks which project (by jiraProjectKey) currently has a running session.
 *  Since we no longer use worktrees, only one issue per project can run at a time
 *  to avoid branch/repo conflicts in the shared working directory. */
const activeProjectLock = new Map<string, string>(); // projectKey -> issueKey

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
        args: [path.join(ROOT, "mcp", "claude-context", "packages", "mcp", "dist", "index.js")],
        env: {
          OPENAI_API_KEY: "${OPENAI_API_KEY}",
          MILVUS_TOKEN: "${MILVUS_TOKEN}",
          MILVUS_ADDRESS: "${MILVUS_ADDRESS}",
        },
      },
      playwright: {
        command: "npx",
        args: ["@playwright/mcp@latest", "--headless"],
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
    { name: "wario-reviewer", file: "wario-reviewer.md", description: "Reviews code changes before PR" },
    { name: "wario-mapper", file: "wario-mapper.md", description: "Maps a codebase structure and conventions" },
    { name: "wario-env-starter", file: "wario-env-starter.md", description: "Starts the project dev environment in the background" },
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

/** Build the append-system-prompt with project/repo context */
function buildAppendPrompt(managed: ManagedSession, project: ProjectConfig): string {
  const repos = project.repos || [];
  const repoLines = repos.map((r) =>
    `- **${r.name}**: path=\`${r.path}\`, GitHub=${r.github.owner}/${r.github.repo}, upstream=\`${r.upstreamBranch}\`${r.prTargetBranch ? `, prTarget=\`${r.prTargetBranch}\`` : ""}`
  ).join("\n");

  return [
    `Issue: ${managed.issueKey}. Project key: ${managed.projectKey}. Wario root: ${ROOT}.`,
    repos.length === 1
      ? `Upstream branch: ${repos[0].upstreamBranch}.${repos[0].prTargetBranch ? ` PR target branch: ${repos[0].prTargetBranch}.` : ""} GitHub: ${repos[0].github.owner}/${repos[0].github.repo}.`
      : `This project has ${repos.length} repos:\n${repoLines}\nCreate branches and PRs for each repo that has changes.`,
    project.instructions || "",
  ].filter(Boolean).join("\n\n");
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

/** Build the prompt for a forced iteration turn */
function buildIterationPrompt(iteration: number, max: number, prevStatus: string, prevPhase: string, issueKey: string): string {
  const taskStateDir = `task-state/${issueKey}`;

  if (iteration === 1) {
    // Second pass (iteration 0 was the first implementation pass)
    return [
      `Iteration ${iteration}/${max}. You just finished your first pass. Now review your own work with fresh eyes.`,
      ``,
      `1. Read your validation contract at ${taskStateDir}/validation-contract.md`,
      `2. Read your diff: git diff {upstreamBranch}...HEAD`,
      `3. CRITICAL: Does your validation contract test the ACTUAL FEATURE BEHAVIOR? If every item is a compilation/syntax/config check, your contract is garbage — rewrite it with functional tests that prove the feature works.`,
      `4. Run the functional tests. Did you actually exercise the feature with real data? If not, do it now.`,
      `5. Fix any issues you find, commit, and push.`,
      ``,
      `Write turn-result.json when done. "blocked" if you need external input. Otherwise the orchestrator will keep iterating.`,
    ].join("\n");
  }

  if (iteration >= max - 1) {
    // Final iteration — wrap up
    return [
      `Iteration ${iteration}/${max} (FINAL). Last chance to catch issues before this ships.`,
      ``,
      `1. Read git diff one more time. Check for hollow implementations, orphaned artifacts, missing acceptance criteria.`,
      `2. Verify your validation contract items still pass.`,
      `3. If you haven't opened a PR yet, do it now (Phase 8).`,
      `4. If the PR is already open, verify it's correct and the description is accurate.`,
      ``,
      `Write turn-result.json when done.`,
    ].join("\n");
  }

  // Middle iterations
  return [
    `Iteration ${iteration}/${max}. Continue improving your work.`,
    ``,
    `1. Read ${taskStateDir}/turn-result.json for where you left off${prevPhase ? ` (${prevPhase})` : ""}.`,
    `2. Check git status and your validation contract.`,
    `3. Run validation tests — did they actually prove the feature works?`,
    `4. Fix issues, commit, push.`,
    ``,
    `Write turn-result.json when done. "blocked" if you need external input.`,
  ].join("\n");
}

/** Check if a human chat lock file exists for this issue */
function isHumanChatLocked(issueKey: string): boolean {
  return fs.existsSync(path.join(ROOT, `.human-chat-${issueKey}`));
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

  // Same issue busy — queue the event
  if (managed.status === "active" || isHumanChatLocked(issueKey)) {
    if (isHumanChatLocked(issueKey)) managed.humanChatActive = true;
    log(issueKey, `Session busy, queueing: ${event.eventType}`);
    managed.eventQueue.push(event);
    return;
  }

  // Different issue in same project is active — queue until it finishes
  // (only one issue per project can run at a time since they share a working directory)
  const lockHolder = activeProjectLock.get(event.projectKey);
  if (lockHolder && lockHolder !== issueKey) {
    log(issueKey, `Received ${event.eventType} but project ${event.projectKey} is busy (${lockHolder} is active). Queued — will start when ${lockHolder} finishes.`);
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
    humanChatActive: false,
    iterationCount: 0,
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

  log(issueKey, `Session initialized (${sessionId})`);
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
          buildAppendPrompt(managed, project),
        ]),
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-budget-usd",
    String(project.maxBudgetUsd || 5),
  ];

  log(issueKey, `${isResume ? "Resuming" : "Starting new"} session: ${event.eventType}`);

  // For follow-up/recovery turns, ensure the repo is on the correct branch.
  // New assignments (isResume=false) handle branch creation in Phase 1.
  if (isResume) {
    const branch = `wario/${issueKey}`;
    try {
      execSync(`git checkout ${branch}`, {
        cwd: project.localRepoPath, encoding: "utf-8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"],
      });
      log(issueKey, `Checked out ${branch}`);
    } catch (err: any) {
      log(issueKey, `Warning: could not checkout ${branch}: ${err.message?.split("\n")[0]}`);
      // Continue anyway — the agent can handle this, or it may be a new session
    }
  }

  managed.status = "active";
  store.updateStatus(issueKey, "active");
  activeProjectLock.set(managed.projectKey, issueKey);

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

    // Forced iteration loop: always re-spawn unless blocked or iteration limit reached.
    // The agent doesn't decide when to stop — the orchestrator does.
    const turnResultPath = path.join(ROOT, "task-state", issueKey, "turn-result.json");
    const maxIterations = project.maxIterations ?? 3;
    const iterCount = managed.iterationCount ?? 0;

    // Read turn-result if it exists (agent may signal blocked)
    let turnStatus = "done";
    let turnMessage = "";
    let turnPhase = "";
    if (fs.existsSync(turnResultPath)) {
      try {
        const turnResult = JSON.parse(fs.readFileSync(turnResultPath, "utf-8"));
        turnStatus = turnResult.status || "done";
        turnMessage = turnResult.message || "";
        turnPhase = turnResult.phase || "";
      } catch (err: any) {
        log(issueKey, `Could not parse turn-result.json: ${err.message}`);
      }
    }

    if (!budgetExhausted && turnStatus === "blocked") {
      // Agent is blocked — stop iterating, wait for external input
      log(issueKey, `Agent is blocked: ${turnMessage}. Pick up: ./scripts/chat.sh ${issueKey}`);
    } else if (!budgetExhausted && iterCount < maxIterations) {
      // Force another iteration regardless of what the agent thinks
      managed.iterationCount = iterCount + 1;
      const isFirst = iterCount === 0; // first pass just completed
      const isFinal = managed.iterationCount >= maxIterations;

      log(issueKey, `Iteration ${managed.iterationCount}/${maxIterations}${isFinal ? " (final)" : ""}: ${turnStatus === "iterate" ? turnMessage || "agent requested" : "forced by orchestrator"}`);

      managed.eventQueue.unshift({
        source: "self",
        eventType: "self_iteration",
        issueKey,
        projectKey: managed.projectKey,
        message: buildIterationPrompt(managed.iterationCount, maxIterations, turnStatus, turnPhase, issueKey),
      });
    } else if (iterCount >= maxIterations) {
      log(issueKey, `All ${maxIterations} iterations complete. Pick up: ./scripts/chat.sh ${issueKey}`);
    }

    // Process queued events for this issue first
    if (managed.eventQueue.length > 0) {
      const next = managed.eventQueue.shift()!;
      log(issueKey, `Processing queued event: ${next.eventType}`);
      runTurn(managed, next);
    } else {
      // This issue is fully idle — release project lock and drain waiting issues
      log(issueKey, `Session idle. To pick up where the agent left off: ./scripts/chat.sh ${issueKey}`);
      releaseProjectLock(managed.projectKey, issueKey);
    }
  });

  child.on("error", (err) => {
    log(issueKey, `Process error: ${err.message}`);
    managed.process = null;
    managed.status = "idle";
    store.updateStatus(issueKey, "idle");
    releaseProjectLock(managed.projectKey, issueKey);
  });
}

/** Release the project lock and start the next queued issue for the same project (if any) */
function releaseProjectLock(projectKey: string, issueKey: string): void {
  if (activeProjectLock.get(projectKey) === issueKey) {
    activeProjectLock.delete(projectKey);
    log(issueKey, `Finished — project ${projectKey} is now available`);

    // Find the next waiting session for this project and kick it off
    for (const [, waiting] of sessions) {
      if (waiting.projectKey === projectKey && waiting.eventQueue.length > 0 && waiting.status === "idle") {
        const next = waiting.eventQueue.shift()!;
        log(waiting.issueKey, `Project ${projectKey} is now free, starting queued ${next.eventType}`);
        runTurn(waiting, next);
        break; // only start one
      }
    }
  }
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
  activeProjectLock.clear();
}

/** Recover sessions on startup: fix stale state + pick up missed JIRA assignments */
export async function recoverSessions(projects: ProjectConfig[], issueFilter?: string): Promise<void> {
  // Part 0: Clean up stale human-chat lock files
  const staleChats = fs.readdirSync(ROOT).filter(f => f.startsWith(".human-chat-"));
  for (const f of staleChats) {
    fs.unlinkSync(path.join(ROOT, f));
  }
  if (staleChats.length > 0) {
    console.log(`[Recovery] Cleaned up ${staleChats.length} stale human-chat lock(s)`);
  }

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
    const jql = `assignee=${accountId} AND status IN ("New","To Do","In Progress")${issueFilter ? ` AND key = "${issueFilter}"` : ""} ORDER BY updated DESC`;
    const result = await jira.searchIssues(jql);
    console.log(`[Recovery] Found ${result.issues.length} assigned issue(s) in JIRA`);

    for (const issue of result.issues) {
      const issueKey = issue.key;
      const projectKey = issueKey.split("-")[0];
      const project = projects.find((p) => p.jiraProjectKey === projectKey);
      if (!project) {
        console.log(
          `[Recovery] ${issueKey}: project "${projectKey}" is not configured. To add it, clone the repo locally, then run: ./scripts/add-project.sh`
        );
        continue;
      }

      // Check if PR already exists in any of the project's repos
      const repos = project.repos || [];
      let prExists = false;
      for (const repo of repos) {
        try {
          const prJson = execSync(
            `gh pr list --repo ${repo.github.owner}/${repo.github.repo} --head wario/${issueKey} --state open --json number`,
            { encoding: "utf-8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] }
          ).trim();
          if (prJson !== "[]" && prJson.length > 2) {
            prExists = true;
            break;
          }
        } catch {
          // gh not available or error — assume no PR
        }
      }

      if (prExists) {
        console.log(`[Recovery] ${issueKey}: PR exists, skipping`);
        continue;
      }

      // Check if branch exists (interrupted mid-work)
      const hasBranch = (() => {
        try {
          return execSync(`git branch --list wario/${issueKey}`, {
            cwd: project.localRepoPath, encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
          }).trim().length > 0;
        } catch { return false; }
      })();
      const existingSession = store.getSession(issueKey);

      if (existingSession && hasBranch) {
        console.log(`[Recovery] ${issueKey}: Resuming interrupted session`);
        const planFile = path.join(ROOT, "task-state", issueKey, "plan.md");
        const hasPlan = fs.existsSync(planFile);
        const steps = [
          ...(hasPlan ? [`Read your plan at ${planFile}`] : []),
          "Check git status",
          "Continue from where you left off — don't restart from scratch.",
        ].map((s, i) => `${i + 1}. ${s}`).join("\n");
        dispatchEvent(
          {
            source: "jira",
            eventType: "recovery_resume",
            issueKey,
            projectKey,
            message: `You were interrupted mid-task on ${issueKey}. Check your progress:\n${steps}`,
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

/** Periodic health check: detect dead/stuck processes and human chat end */
export function startHealthCheck(): void {
  setInterval(() => {
    const now = Date.now();
    for (const [key, managed] of sessions) {
      // Detect ended human chat: lock gone but flag still set
      if (managed.humanChatActive && !isHumanChatLocked(key) && managed.status === "idle" && !managed.process) {
        managed.humanChatActive = false;
        log(key, "Human chat ended, sending JIRA summary turn");

        managed.eventQueue.unshift({
          source: "human",
          eventType: "human_chat_ended",
          issueKey: key,
          projectKey: managed.projectKey,
          message: "A human just finished chatting with you directly. Post a brief JIRA comment summarizing what was discussed and any decisions made. Then continue with any remaining work.",
        });
        const next = managed.eventQueue.shift()!;
        runTurn(managed, next);
        continue;
      }

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
        } else {
          releaseProjectLock(managed.projectKey, key);
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
        const stuckPlanFile = path.join(ROOT, "task-state", key, "plan.md");
        const stuckHasPlan = fs.existsSync(stuckPlanFile);
        const stuckSteps = [
          ...(stuckHasPlan ? [`Read your plan at ${stuckPlanFile}`] : []),
          "Check git status",
          "Continue from where you left off — don't restart from scratch.",
        ].map((s, i) => `${i + 1}. ${s}`).join("\n");
        managed.eventQueue.unshift({
          source: "jira",
          eventType: "stuck_recovery",
          issueKey: key,
          projectKey: managed.projectKey,
          message: `Your previous session appears to have stalled. Check your progress:\n${stuckSteps}`,
        });

        if (managed.eventQueue.length > 0) {
          const next = managed.eventQueue.shift()!;
          log(key, `Processing queued event: ${next.eventType}`);
          runTurn(managed, next);
        }
      }
    }
  }, 30_000);
}

function log(issueKey: string, message: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${issueKey}] ${message}`);
}
