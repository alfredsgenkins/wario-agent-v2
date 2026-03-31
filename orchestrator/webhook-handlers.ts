import crypto from "node:crypto";
import type { WebhookEvent } from "./types.js";

const VARIO_DISPLAY_NAME = process.env.VARIO_DISPLAY_NAME || "Wario";
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_APP_WEBHOOK_SECRET;
const WARIO_BRANCH_PREFIX = "wario/";

/** Extract plain text from Atlassian Document Format */
function extractTextFromAdf(adf: any): string {
  if (!adf) return "";
  if (typeof adf === "string") return adf;
  if (adf.type === "text") return adf.text || "";
  if (adf.content) {
    return adf.content.map(extractTextFromAdf).join("");
  }
  return "";
}

/** Parse a JIRA webhook payload into a WebhookEvent (or null to skip) */
export function parseJiraWebhook(payload: any): WebhookEvent | null {
  const event = payload.webhookEvent;
  const issue = payload.issue;
  if (!issue?.key) return null;

  const issueKey = issue.key;
  const projectKey = issueKey.split("-")[0];

  if (event === "comment_created") {
    const commentAuthor = payload.comment?.author?.displayName;
    // Ignore our own comments
    if (commentAuthor === VARIO_DISPLAY_NAME) return null;

    const body = extractTextFromAdf(payload.comment?.body);
    return {
      source: "jira",
      eventType: "comment",
      issueKey,
      projectKey,
      message: `New JIRA comment on ${issueKey} by ${commentAuthor}:\n\n${body}\n\nUse jira_get_comments for full context and continue your work.`,
    };
  }

  // Any other event — treat as assignment/new work
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
export function parseGitHubWebhook(
  githubEvent: string,
  payload: any
): WebhookEvent | null {
  const pr = payload.pull_request;
  if (!pr) return null;

  const branch = pr.head?.ref || "";
  if (!branch.startsWith(WARIO_BRANCH_PREFIX)) return null;

  const issueKey = branch.slice(WARIO_BRANCH_PREFIX.length);
  const projectKey = issueKey.split("-")[0];
  const prNumber = pr.number;

  if (githubEvent === "pull_request_review") {
    const review = payload.review;
    if (!review) return null;

    return {
      source: "github",
      eventType: "pr_review",
      issueKey,
      projectKey,
      message: `PR review on #${prNumber} (${issueKey}) by ${review.user?.login}.\nState: ${review.state}\n\n${review.body || "(no body)"}\n\nAddress the review feedback: cd to the worktree, make changes, commit, and push.`,
    };
  }

  if (githubEvent === "pull_request_review_comment") {
    const comment = payload.comment;
    if (!comment) return null;

    return {
      source: "github",
      eventType: "pr_comment",
      issueKey,
      projectKey,
      message: `Review comment on PR #${prNumber} (${issueKey}) by ${comment.user?.login}:\nFile: ${comment.path}:${comment.line || comment.original_line || "?"}\n\n${comment.body}\n\nAddress this comment: make the change, commit, and push.`,
    };
  }

  if (githubEvent === "issue_comment" && pr) {
    const comment = payload.comment;
    if (!comment) return null;

    return {
      source: "github",
      eventType: "pr_comment",
      issueKey,
      projectKey,
      message: `Comment on PR #${prNumber} (${issueKey}) by ${comment.user?.login}:\n\n${comment.body}\n\nRespond or address the comment as needed.`,
    };
  }

  return null;
}
