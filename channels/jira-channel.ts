#!/usr/bin/env npx tsx
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import axios, { type AxiosInstance } from "axios";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

// --- Config from env ---
const JIRA_BASE_URL = process.env.JIRA_BASE_URL!;
const JIRA_USER_EMAIL = process.env.JIRA_USER_EMAIL!;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN!;
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_APP_WEBHOOK_SECRET;
const WEBHOOK_PORT = parseInt(process.env.WEBHOOK_PORT || "8788", 10);
const VARIO_DISPLAY_NAME = process.env.VARIO_DISPLAY_NAME || "Wario";
const WARIO_BRANCH_PREFIX = "wario/";

// --- JIRA API client ---
const jira: AxiosInstance = axios.create({
  baseURL: `${JIRA_BASE_URL}/rest/api/3`,
  auth: { username: JIRA_USER_EMAIL, password: JIRA_API_TOKEN },
  headers: { "Content-Type": "application/json", Accept: "application/json" },
});

// --- MCP Server ---
const mcp = new Server(
  { name: "wario", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `Events arrive as <channel source="wario" ...> tags from JIRA and GitHub.

## JIRA Events

When event_type="assigned":
  1. Use jira_get_issue to read the full issue details
  2. Read projects.yaml to find the matching project config by jiraProjectKey
  3. Navigate to the project's localRepoPath
  4. git fetch origin, checkout the upstream branch, pull latest
  5. Create a worktree: git worktree add ../worktrees/{issueKey} -b wario/{issueKey} {upstreamBranch}
  6. cd into the worktree
  7. Read the project's CLAUDE.md or README if they exist for project-specific guidance
  8. Analyze the issue and explore the codebase
  9. If anything is unclear or ambiguous, use jira_add_comment to ask a clarifying question, then wait for a comment event
  10. Implement the changes following existing code patterns
  11. Stage, commit with message: {issueKey}: description of changes
  12. Push: git push -u origin wario/{issueKey}
  13. Open a PR: gh pr create --base {upstreamBranch} --title "{issueKey}: summary" --body "description"
  14. Post the PR link as a JIRA comment using jira_add_comment
  15. Transition the issue to "In Review" using jira_transition_issue

When event_type="comment" (JIRA):
  Use jira_get_comments to read the latest comments, then continue implementing from where you left off.

## GitHub Events

When event_type="pr_review" or event_type="pr_comment":
  These are review comments on a PR you opened. The issue_key is extracted from the branch name.
  1. cd into the worktree for that issue (../worktrees/{issueKey})
  2. Read the review comments to understand the feedback
  3. Make the requested changes
  4. Commit and push (the PR updates automatically)
  5. If a comment is just a question or discussion, reply to it using: gh pr comment {prNumber} --body "response"

## Rules
- One task at a time. Finish or pause the current task before starting another.
- Make focused, minimal changes. Don't refactor unrelated code.
- Follow existing code patterns in the target repo.
- If unsure about something, ask in JIRA rather than guessing.
- Only react to GitHub events on branches starting with "wario/" — these are ours.`,
  }
);

// --- JIRA Tools ---

const TOOLS = [
  {
    name: "jira_get_issue",
    description:
      "Fetch a JIRA issue's details including summary, description, status, assignee, labels, and components",
    inputSchema: {
      type: "object" as const,
      properties: {
        issue_key: {
          type: "string",
          description: "The issue key, e.g. INTERNAL-42",
        },
      },
      required: ["issue_key"],
    },
  },
  {
    name: "jira_get_comments",
    description: "Get all comments on a JIRA issue",
    inputSchema: {
      type: "object" as const,
      properties: {
        issue_key: {
          type: "string",
          description: "The issue key, e.g. INTERNAL-42",
        },
      },
      required: ["issue_key"],
    },
  },
  {
    name: "jira_add_comment",
    description: "Post a comment on a JIRA issue",
    inputSchema: {
      type: "object" as const,
      properties: {
        issue_key: {
          type: "string",
          description: "The issue key, e.g. INTERNAL-42",
        },
        body: {
          type: "string",
          description: "The comment text to post",
        },
      },
      required: ["issue_key", "body"],
    },
  },
  {
    name: "jira_get_attachments",
    description:
      "List all attachments on a JIRA issue, returning their filenames, URLs, and mime types",
    inputSchema: {
      type: "object" as const,
      properties: {
        issue_key: {
          type: "string",
          description: "The issue key, e.g. INTERNAL-42",
        },
      },
      required: ["issue_key"],
    },
  },
  {
    name: "jira_download_attachment",
    description:
      "Download a JIRA attachment to a local temp file. Returns the local file path. Use the Read tool to view images after downloading.",
    inputSchema: {
      type: "object" as const,
      properties: {
        attachment_url: {
          type: "string",
          description: "The attachment content URL from jira_get_attachments",
        },
        filename: {
          type: "string",
          description: "The filename for the downloaded file",
        },
      },
      required: ["attachment_url", "filename"],
    },
  },
  {
    name: "jira_transition_issue",
    description:
      'Transition a JIRA issue to a new status (e.g. "In Progress", "In Review", "Done")',
    inputSchema: {
      type: "object" as const,
      properties: {
        issue_key: {
          type: "string",
          description: "The issue key, e.g. INTERNAL-42",
        },
        status_name: {
          type: "string",
          description: "The target status name",
        },
      },
      required: ["issue_key", "status_name"],
    },
  },
];

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  try {
    switch (name) {
      case "jira_get_issue": {
        const { issue_key } = args as { issue_key: string };
        const { data } = await jira.get(`/issue/${issue_key}`, {
          params: {
            fields:
              "summary,description,status,assignee,labels,components,issuetype,priority,comment",
          },
        });
        const fields = data.fields;
        const result = {
          key: data.key,
          summary: fields.summary,
          description: fields.description,
          status: fields.status?.name,
          assignee: fields.assignee?.displayName,
          issueType: fields.issuetype?.name,
          priority: fields.priority?.name,
          labels: fields.labels,
          components: fields.components?.map((c: any) => c.name),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "jira_get_comments": {
        const { issue_key } = args as { issue_key: string };
        const { data } = await jira.get(`/issue/${issue_key}/comment`);
        const comments = data.comments.map((c: any) => ({
          id: c.id,
          author: c.author?.displayName,
          created: c.created,
          body: extractTextFromAdf(c.body),
        }));
        return {
          content: [{ type: "text", text: JSON.stringify(comments, null, 2) }],
        };
      }

      case "jira_add_comment": {
        const { issue_key, body } = args as {
          issue_key: string;
          body: string;
        };
        await jira.post(`/issue/${issue_key}/comment`, {
          body: {
            type: "doc",
            version: 1,
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: body }],
              },
            ],
          },
        });
        return { content: [{ type: "text", text: "Comment posted." }] };
      }

      case "jira_get_attachments": {
        const { issue_key } = args as { issue_key: string };
        const { data } = await jira.get(`/issue/${issue_key}`, {
          params: { fields: "attachment" },
        });
        const attachments = (data.fields.attachment || []).map((a: any) => ({
          id: a.id,
          filename: a.filename,
          mimeType: a.mimeType,
          size: a.size,
          content: a.content, // This is the download URL
          created: a.created,
        }));
        return {
          content: [{ type: "text", text: JSON.stringify(attachments, null, 2) }],
        };
      }

      case "jira_download_attachment": {
        const { attachment_url, filename } = args as {
          attachment_url: string;
          filename: string;
        };
        const response = await axios.get(attachment_url, {
          auth: { username: JIRA_USER_EMAIL, password: JIRA_API_TOKEN },
          responseType: "arraybuffer",
        });
        const tmpDir = path.join(os.tmpdir(), "wario-attachments");
        await fs.mkdir(tmpDir, { recursive: true });
        const filePath = path.join(tmpDir, filename);
        await fs.writeFile(filePath, response.data);
        return {
          content: [
            {
              type: "text",
              text: `Downloaded to ${filePath}. Use the Read tool to view this file.`,
            },
          ],
        };
      }

      case "jira_transition_issue": {
        const { issue_key, status_name } = args as {
          issue_key: string;
          status_name: string;
        };
        const { data: transData } = await jira.get(
          `/issue/${issue_key}/transitions`
        );
        const transition = transData.transitions.find(
          (t: any) => t.name.toLowerCase() === status_name.toLowerCase()
        );
        if (!transition) {
          const available = transData.transitions
            .map((t: any) => t.name)
            .join(", ");
          return {
            content: [
              {
                type: "text",
                text: `Transition "${status_name}" not found. Available: ${available}`,
              },
            ],
          };
        }
        await jira.post(`/issue/${issue_key}/transitions`, {
          transition: { id: transition.id },
        });
        return {
          content: [
            {
              type: "text",
              text: `Issue transitioned to "${status_name}".`,
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    const message = error.response?.data?.errorMessages?.join(", ") ||
      error.response?.data?.errors
        ? JSON.stringify(error.response.data.errors)
        : error.message;
    return { content: [{ type: "text", text: `Error: ${message}` }] };
  }
});

// --- Helper: extract plain text from Atlassian Document Format ---
function extractTextFromAdf(adf: any): string {
  if (!adf) return "";
  if (typeof adf === "string") return adf;
  if (adf.type === "text") return adf.text || "";
  if (adf.content) {
    return adf.content.map(extractTextFromAdf).join("");
  }
  return "";
}

// --- Helper: verify GitHub webhook signature ---
function verifyGitHubSignature(body: string, signature: string | undefined): boolean {
  if (!GITHUB_WEBHOOK_SECRET || !signature) return !GITHUB_WEBHOOK_SECRET;
  const expected = "sha256=" + crypto
    .createHmac("sha256", GITHUB_WEBHOOK_SECRET)
    .update(body)
    .digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

// --- Connect to Claude Code over stdio ---
await mcp.connect(new StdioServerTransport());

// --- HTTP webhook listener ---
const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
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

  // Route to the right handler
  if (pathname === "/webhooks/jira-webhook") {
    res.writeHead(200);
    res.end("ok");
    try {
      await handleJiraWebhook(JSON.parse(body));
    } catch (e: any) {
      process.stderr.write(`JIRA webhook error: ${e.message}\n`);
    }
  } else if (pathname === "/webhooks/github") {
    // Verify signature
    const sig = req.headers["x-hub-signature-256"] as string | undefined;
    if (!verifyGitHubSignature(body, sig)) {
      res.writeHead(401);
      res.end("Invalid signature");
      return;
    }
    res.writeHead(200);
    res.end("ok");
    try {
      const event = req.headers["x-github-event"] as string;
      await handleGitHubWebhook(event, JSON.parse(body));
    } catch (e: any) {
      process.stderr.write(`GitHub webhook error: ${e.message}\n`);
    }
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(WEBHOOK_PORT, "127.0.0.1", () => {
  process.stderr.write(
    `Wario channel listener on http://127.0.0.1:${WEBHOOK_PORT}\n`
  );
  process.stderr.write(`  JIRA:   /webhooks/jira-webhook\n`);
  process.stderr.write(`  GitHub: /webhooks/github\n`);
});

// --- JIRA webhook handler ---
async function handleJiraWebhook(payload: any): Promise<void> {
  const event = payload.webhookEvent;
  const issue = payload.issue;
  if (!issue?.key) return;

  const issueKey = issue.key;
  const jiraProjectKey = issueKey.split("-")[0];

  process.stderr.write(`JIRA event: ${event}, issue: ${issueKey}\n`);

  if (event === "comment_created") {
    const commentAuthor = payload.comment?.author?.displayName;
    if (commentAuthor === VARIO_DISPLAY_NAME) return;

    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: `New comment on ${issueKey} by ${commentAuthor}:\n${extractTextFromAdf(payload.comment?.body)}`,
        meta: {
          event_type: "comment",
          source: "jira",
          issue_key: issueKey,
          project_key: jiraProjectKey,
          comment_author: commentAuthor || "unknown",
        },
      },
    });
  } else {
    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: `Issue ${issueKey} needs attention.\nSummary: ${issue.fields?.summary || "N/A"}`,
        meta: {
          event_type: "assigned",
          source: "jira",
          issue_key: issueKey,
          project_key: jiraProjectKey,
        },
      },
    });
  }
}

// --- GitHub webhook handler ---
async function handleGitHubWebhook(event: string, payload: any): Promise<void> {
  // Only handle PR-related events
  const pr = payload.pull_request;
  if (!pr) return;

  const branch = pr.head?.ref || "";

  // Only react to PRs on our branches (wario/ISSUE-KEY)
  if (!branch.startsWith(WARIO_BRANCH_PREFIX)) {
    process.stderr.write(`GitHub: ignoring PR on non-wario branch: ${branch}\n`);
    return;
  }

  // Extract issue key from branch name: wario/INTERNAL-42 → INTERNAL-42
  const issueKey = branch.slice(WARIO_BRANCH_PREFIX.length);
  const prNumber = pr.number;
  const repo = payload.repository?.full_name || "";

  process.stderr.write(`GitHub event: ${event}, PR #${prNumber}, branch: ${branch}\n`);

  if (event === "pull_request_review") {
    const review = payload.review;
    if (!review) return;

    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: `PR review on #${prNumber} (${issueKey}) by ${review.user?.login}:\nState: ${review.state}\n\n${review.body || "(no body)"}`,
        meta: {
          event_type: "pr_review",
          source: "github",
          issue_key: issueKey,
          pr_number: String(prNumber),
          repo,
          reviewer: review.user?.login || "unknown",
          review_state: review.state,
        },
      },
    });
  } else if (event === "pull_request_review_comment") {
    const comment = payload.comment;
    if (!comment) return;

    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: `Review comment on PR #${prNumber} (${issueKey}) by ${comment.user?.login}:\nFile: ${comment.path}:${comment.line || comment.original_line || "?"}\n\n${comment.body}`,
        meta: {
          event_type: "pr_comment",
          source: "github",
          issue_key: issueKey,
          pr_number: String(prNumber),
          repo,
          commenter: comment.user?.login || "unknown",
          file_path: comment.path || "",
        },
      },
    });
  } else if (event === "issue_comment" && pr) {
    // General PR comment (not on a specific line)
    const comment = payload.comment;
    if (!comment) return;

    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: `Comment on PR #${prNumber} (${issueKey}) by ${comment.user?.login}:\n\n${comment.body}`,
        meta: {
          event_type: "pr_comment",
          source: "github",
          issue_key: issueKey,
          pr_number: String(prNumber),
          repo,
          commenter: comment.user?.login || "unknown",
        },
      },
    });
  }
}
