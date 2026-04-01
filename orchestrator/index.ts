#!/usr/bin/env npx tsx
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { dotenvLoad } from "./env.js";
import type { ProjectConfig, ProjectsYaml } from "./types.js";
import {
  parseJiraWebhook,
  parseGitHubWebhook,
  verifyGitHubSignature,
} from "./webhook-handlers.js";
import {
  dispatchEvent,
  listActiveSessions,
  shutdown,
  recoverSessions,
  startHealthCheck,
} from "./session-manager.js";

// Load .env
dotenvLoad();

const PORT = parseInt(process.env.WEBHOOK_PORT || "8788", 10);
const ROOT = path.resolve(import.meta.dirname, "..");

// Parse --issue filter from argv
const issueArgIdx = process.argv.indexOf("--issue");
const issueFilter = issueArgIdx !== -1 ? process.argv[issueArgIdx + 1] : undefined;
if (issueFilter) {
  console.log(`Filtering to issue: ${issueFilter}`);
}

// Load project registry
function loadProjects(): ProjectConfig[] {
  const raw = fs.readFileSync(path.join(ROOT, "projects.yaml"), "utf-8");
  const parsed = parseYaml(raw) as ProjectsYaml;
  return parsed.projects || [];
}

function findProject(projectKey: string): ProjectConfig | undefined {
  const projects = loadProjects();
  return projects.find((p) => p.jiraProjectKey === projectKey);
}

// HTTP server
const server = http.createServer(async (req, res) => {
  // Health / status endpoints
  if (req.method === "GET") {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
      return;
    }
    if (req.url === "/sessions") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(listActiveSessions(), null, 2));
      return;
    }
    // Stream log file
    const logMatch = req.url?.match(/^\/logs\/([A-Z]+-\d+)$/);
    if (logMatch) {
      const logPath = path.join(ROOT, "logs", `${logMatch[1]}.log`);
      if (fs.existsSync(logPath)) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        fs.createReadStream(logPath).pipe(res);
        return;
      }
      res.writeHead(404);
      res.end("Log not found");
      return;
    }
  }

  if (req.method !== "POST") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  // Read body
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString("utf-8");
  const pathname = req.url?.split("?")[0];

  // JIRA webhook
  if (pathname === "/webhooks/jira-webhook") {
    res.writeHead(200);
    res.end("ok");

    try {
      const payload = JSON.parse(body);
      const event = parseJiraWebhook(payload);
      if (!event) return;
      if (issueFilter && event.issueKey !== issueFilter) return;

      const project = findProject(event.projectKey);
      if (!project) {
        console.log(
          `[JIRA] Received ${event.eventType} for ${event.issueKey}, but project "${event.projectKey}" is not configured.`
        );
        console.log(
          `       To make Wario work on this project, clone the repo locally, then run: ./scripts/add-project.sh`
        );
        return;
      }

      console.log(`[JIRA] ${event.eventType} on ${event.issueKey}`);
      dispatchEvent(event, project);
    } catch (e: any) {
      console.error(`[JIRA] Webhook error: ${e.message}`);
    }
    return;
  }

  // GitHub webhook
  if (pathname === "/webhooks/github") {
    const sig = req.headers["x-hub-signature-256"] as string | undefined;
    if (!verifyGitHubSignature(body, sig)) {
      res.writeHead(401);
      res.end("Invalid signature");
      return;
    }

    res.writeHead(200);
    res.end("ok");

    try {
      const githubEvent = req.headers["x-github-event"] as string;
      const payload = JSON.parse(body);
      const event = await parseGitHubWebhook(githubEvent, payload);
      if (!event) return;
      if (issueFilter && event.issueKey !== issueFilter) return;

      console.log(
        `[GitHub] ${event.eventType} on ${event.issueKey} (PR event: ${githubEvent})`
      );

      const project = findProject(event.projectKey);
      if (!project) {
        console.log(
          `[GitHub] Received ${event.eventType} for ${event.issueKey}, but project "${event.projectKey}" is not configured.`
        );
        console.log(
          `        To make Wario work on this project, clone the repo locally, then run: ./scripts/add-project.sh`
        );
        return;
      }

      dispatchEvent(event, project);
    } catch (e: any) {
      console.error(`[GitHub] Webhook error: ${e.message}`);
    }
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Wario orchestrator listening on http://127.0.0.1:${PORT}`);
  console.log(`  JIRA:     /webhooks/jira-webhook`);
  console.log(`  GitHub:   /webhooks/github`);
  console.log(`  Sessions: /sessions`);
  console.log(`  Logs:     /logs/{ISSUE-KEY}`);
  console.log(`  Health:   /health`);

  // Recover interrupted/missed sessions
  recoverSessions(loadProjects(), issueFilter).catch((err) => {
    console.error(`[Recovery] Failed: ${err.message}`);
  });

  // Start periodic health check for dead child processes
  startHealthCheck();
});

// Crash protection — log but don't die on stray errors
process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Unhandled rejection:", reason);
});

// Clean shutdown — kill child processes
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`\nReceived ${sig}, shutting down...`);
    shutdown();
    server.close(() => process.exit(0));
  });
}
