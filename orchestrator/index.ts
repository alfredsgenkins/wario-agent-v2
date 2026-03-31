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
} from "./session-manager.js";

// Load .env
dotenvLoad();

const PORT = parseInt(process.env.WEBHOOK_PORT || "8788", 10);
const ROOT = path.resolve(import.meta.dirname, "..");

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

      console.log(
        `[JIRA] ${event.eventType} on ${event.issueKey} (${event.projectKey})`
      );

      const project = findProject(event.projectKey);
      if (!project) {
        console.log(
          `[JIRA] No project configured for key: ${event.projectKey}`
        );
        return;
      }

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
      const event = parseGitHubWebhook(githubEvent, payload);
      if (!event) return;

      console.log(
        `[GitHub] ${event.eventType} on ${event.issueKey} (PR event: ${githubEvent})`
      );

      const project = findProject(event.projectKey);
      if (!project) {
        console.log(
          `[GitHub] No project configured for key: ${event.projectKey}`
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
});
