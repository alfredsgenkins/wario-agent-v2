import crypto from "node:crypto";
import type { WebhookEvent } from "./types.js";
import { extractTextFromAdf } from "../lib/jira-client.js";

const WARIO_JIRA_ACCOUNT_ID = process.env.WARIO_JIRA_ACCOUNT_ID;
const WARIO_GITHUB_LOGIN = process.env.WARIO_GITHUB_LOGIN;
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const WARIO_BRANCH_PREFIX = "wario/";

/** Check if a JIRA user is Wario by account ID */
function isWarioUser(accountId?: string): boolean {
  if (!WARIO_JIRA_ACCOUNT_ID) return false;
  return accountId === WARIO_JIRA_ACCOUNT_ID;
}

/** Parse a JIRA webhook payload into a WebhookEvent (or null to skip) */
export function parseJiraWebhook(payload: any, { noFilterSelf = false } = {}): WebhookEvent | null {
  const event = payload.webhookEvent;
  const issue = payload.issue;
  if (!issue?.key) return null;

  const issueKey = issue.key;
  const projectKey = issueKey.split("-")[0];

  // Only process issues assigned to Wario
  const assigneeId = issue.fields?.assignee?.accountId;
  if (!isWarioUser(assigneeId)) return null;

  if (event === "comment_created") {
    const commentAuthorId = payload.comment?.author?.accountId;
    // Ignore our own comments (unless --no-filter-self)
    if (!noFilterSelf && isWarioUser(commentAuthorId)) return null;

    const body = extractTextFromAdf(payload.comment?.body);
    return {
      source: "jira",
      eventType: "comment",
      issueKey,
      projectKey,
      message: `New JIRA comment on ${issueKey} by ${payload.comment?.author?.displayName}:\n\n${body}\n\nUse jira_get_comments for full context and continue your work.`,
    };
  }

  // Any other event — treat as assignment/new work
  // Skip events triggered by Wario itself (e.g. status transitions)
  if (!noFilterSelf && isWarioUser(payload.user?.accountId)) return null;

  const summary = issue.fields?.summary || "N/A";
  return {
    source: "jira",
    eventType: "assigned",
    issueKey,
    projectKey,
    message: `You have been assigned ${issueKey}: "${summary}". Use jira_get_issue to read the full details and begin implementation following your system prompt instructions.`,
  };
}

/** Verify GitHub webhook HMAC signature */
export function verifyGitHubSignature(
  body: string,
  signature: string | undefined
): boolean {
  if (!GITHUB_WEBHOOK_SECRET || !signature) return !GITHUB_WEBHOOK_SECRET;
  const expected =
    "sha256=" +
    crypto
      .createHmac("sha256", GITHUB_WEBHOOK_SECRET)
      .update(body)
      .digest("hex");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signature)
    );
  } catch {
    return false;
  }
}

/** Parse a GitHub webhook payload into a WebhookEvent (or null to skip) */
export async function parseGitHubWebhook(
  githubEvent: string,
  payload: any,
  { noFilterSelf = false } = {}
): Promise<WebhookEvent | null> {
  // issue_comment events store PR info differently — resolve it first
  let pr = payload.pull_request;
  if (!pr && githubEvent === "issue_comment" && payload.issue?.pull_request) {
    // Minimal PR object — fetch full PR to get branch info
    const prUrl = payload.issue.pull_request.url; // https://api.github.com/repos/.../pulls/N
    try {
      const resp = await fetch(prUrl, {
        headers: { Authorization: `token ${process.env.GITHUB_TOKEN}` },
      });
      if (resp.ok) pr = await resp.json();
    } catch {}
  }
  if (!pr) return null;

  const branch = pr.head?.ref || "";
  if (!branch.startsWith(WARIO_BRANCH_PREFIX)) return null;

  const issueKey = branch.slice(WARIO_BRANCH_PREFIX.length);
  const projectKey = issueKey.split("-")[0];
  const prNumber = pr.number;

  if (githubEvent === "pull_request_review") {
    const review = payload.review;
    if (!review) return null;
    if (!noFilterSelf && WARIO_GITHUB_LOGIN && review.user?.login === WARIO_GITHUB_LOGIN) return null;

    return {
      source: "github",
      eventType: "pr_review",
      issueKey,
      projectKey,
      message: `PR review on #${prNumber} (${issueKey}) by ${review.user?.login}.\nState: ${review.state}\n\n${review.body || "(no body)"}\n\nAddress the review feedback: make the requested changes, commit, and push. Then post a summary comment on the PR explaining what you changed.`,
    };
  }

  if (githubEvent === "pull_request_review_comment") {
    const comment = payload.comment;
    if (!comment) return null;
    if (!noFilterSelf && WARIO_GITHUB_LOGIN && comment.user?.login === WARIO_GITHUB_LOGIN) return null;

    return {
      source: "github",
      eventType: "pr_comment",
      issueKey,
      projectKey,
      message: `Inline review comment on PR #${prNumber} (${issueKey}) by ${comment.user?.login}:\nFile: ${comment.path}:${comment.line || comment.original_line || "?"}\nComment ID: ${comment.id}\n\n${comment.body}\n\nAddress this comment: make the change, commit, and push. Then reply to the comment using:\ngh api repos/{owner}/{repo}/pulls/${prNumber}/comments/${comment.id}/replies -f body="your reply"`,
    };
  }

  if (githubEvent === "issue_comment") {
    const comment = payload.comment;
    if (!comment) return null;
    if (!noFilterSelf && WARIO_GITHUB_LOGIN && comment.user?.login === WARIO_GITHUB_LOGIN) return null;

    return {
      source: "github",
      eventType: "pr_comment",
      issueKey,
      projectKey,
      message: `Comment on PR #${prNumber} (${issueKey}) by ${comment.user?.login}:\nComment ID: ${comment.id}\n\n${comment.body}\n\nRespond or address the comment as needed. Reply using:\ngh pr comment ${prNumber} --body "your reply"`,
    };
  }

  return null;
}
