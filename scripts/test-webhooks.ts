#!/usr/bin/env npx tsx
/**
 * Lightweight webhook test server.
 * Listens on port 8788, records incoming webhooks, exposes /status.
 * Used by the setup agent to verify JIRA and GitHub webhooks are working.
 *
 * Usage: npx tsx scripts/test-webhooks.ts [--timeout 120]
 */
import http from "node:http";
import crypto from "node:crypto";

const TIMEOUT_SEC = parseInt(
  process.argv[process.argv.indexOf("--timeout") + 1] || "120",
  10
);
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;

interface WebhookHit {
  source: string;
  event: string;
  detail: string;
  at: string;
}

const hits: WebhookHit[] = [];

function verifyGitHubSig(body: string, sig: string | undefined): boolean {
  if (!GITHUB_WEBHOOK_SECRET || !sig) return !GITHUB_WEBHOOK_SECRET;
  const expected =
    "sha256=" +
    crypto
      .createHmac("sha256", GITHUB_WEBHOOK_SECRET)
      .update(body)
      .digest("hex");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(sig)
    );
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/status") {
    const jiraHits = hits.filter((h) => h.source === "jira");
    const githubHits = hits.filter((h) => h.source === "github");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        {
          jira: jiraHits.length > 0 ? jiraHits : null,
          github: githubHits.length > 0 ? githubHits : null,
          totalHits: hits.length,
        },
        null,
        2
      )
    );
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "test-server", hits: hits.length }));
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString("utf-8");
  const pathname = req.url?.split("?")[0];

  if (pathname === "/webhooks/jira-webhook") {
    res.writeHead(200);
    res.end("ok");
    try {
      const payload = JSON.parse(body);
      const event = payload.webhookEvent || "unknown";
      const issueKey = payload.issue?.key || "?";
      const hit: WebhookHit = {
        source: "jira",
        event,
        detail: `${event} on ${issueKey}`,
        at: new Date().toISOString(),
      };
      hits.push(hit);
      console.log(`✓ JIRA webhook received: ${hit.detail}`);
    } catch (e: any) {
      console.log(`✗ JIRA webhook received but failed to parse: ${e.message}`);
    }
    return;
  }

  if (pathname === "/webhooks/github") {
    const sig = req.headers["x-hub-signature-256"] as string | undefined;
    if (!verifyGitHubSig(body, sig)) {
      res.writeHead(401);
      res.end("Invalid signature");
      console.log(
        "✗ GitHub webhook received but signature verification FAILED — check GITHUB_WEBHOOK_SECRET"
      );
      hits.push({
        source: "github",
        event: "signature_failed",
        detail: "Signature verification failed — wrong secret?",
        at: new Date().toISOString(),
      });
      return;
    }

    res.writeHead(200);
    res.end("ok");
    try {
      const githubEvent = req.headers["x-github-event"] as string;
      const payload = JSON.parse(body);
      const repoName = payload.repository?.full_name || "unknown";
      const hit: WebhookHit = {
        source: "github",
        event: githubEvent,
        detail: `${githubEvent} from ${repoName}`,
        at: new Date().toISOString(),
      };
      hits.push(hit);
      console.log(`✓ GitHub webhook received: ${hit.detail}`);
    } catch (e: any) {
      console.log(
        `✗ GitHub webhook received but failed to parse: ${e.message}`
      );
    }
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

// Check if port is already in use (orchestrator running)
const testConn = http.get("http://127.0.0.1:8788/health", (res) => {
  let body = "";
  res.on("data", (c) => (body += c));
  res.on("end", () => {
    if (body.includes("test-server")) {
      console.log("Test server already running on :8788");
      process.exit(0);
    }
    console.error(
      "Port 8788 is in use (likely the orchestrator). Stop it first, or use the orchestrator's /webhooks/test endpoint."
    );
    process.exit(1);
  });
});
testConn.on("error", () => {
  // Port is free — start the server
  server.listen(8788, "127.0.0.1", () => {
    console.log("Webhook test server listening on http://127.0.0.1:8788");
    console.log(`Will auto-exit after ${TIMEOUT_SEC}s. Check status: curl http://127.0.0.1:8788/status`);
    console.log("Waiting for webhooks...\n");
  });
});

// Auto-exit after timeout
setTimeout(() => {
  console.log(`\nTimeout (${TIMEOUT_SEC}s). Received ${hits.length} webhook(s).`);
  const jiraOk = hits.some((h) => h.source === "jira");
  const githubOk = hits.some(
    (h) => h.source === "github" && h.event !== "signature_failed"
  );
  if (jiraOk && githubOk) {
    console.log("✓ Both JIRA and GitHub webhooks are working!");
  } else {
    if (!jiraOk) console.log("✗ No JIRA webhook received");
    if (!githubOk) console.log("✗ No GitHub webhook received (or signature failed)");
  }
  process.exit(jiraOk && githubOk ? 0 : 1);
}, TIMEOUT_SEC * 1000);

// Clean exit on ctrl+c
process.on("SIGINT", () => {
  console.log("\nStopped.");
  process.exit(0);
});
