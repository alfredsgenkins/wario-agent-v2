#!/usr/bin/env npx tsx
/**
 * JIRA tools-only MCP server.
 * Provides JIRA API tools to Claude Code sessions via --mcp-config.
 * No webhook listener, no channel capability — just tools.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { markdownToAdf as marklassianConvert } from "marklassian";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JiraClient, extractTextFromAdf } from "../lib/jira-client.js";

// --- JIRA API client ---
const jira = JiraClient.fromEnv()!;

// --- MCP Server (tools only) ---
const mcp = new Server(
  { name: "jira-tools", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// --- Tool definitions ---
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
    description:
      "Post a comment on a JIRA issue. Body accepts Markdown: **bold**, *italic*, `code`, # headings, - lists, | tables |. To mention a user, first call jira_find_user to get their accountId, then write @[Display Name](accountId) in the body.",
    inputSchema: {
      type: "object" as const,
      properties: {
        issue_key: {
          type: "string",
          description: "The issue key, e.g. INTERNAL-42",
        },
        body: {
          type: "string",
          description:
            "The comment body in Markdown. Use @[Display Name](accountId) for mentions.",
        },
      },
      required: ["issue_key", "body"],
    },
  },
  {
    name: "jira_find_user",
    description:
      "Search for a Jira user by name or email to get their accountId for @mentions in comments.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Name or email address to search for",
        },
      },
      required: ["query"],
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
        const data = await jira.get(`/issue/${issue_key}`, {
          fields:
            "summary,description,status,assignee,labels,components,issuetype,priority,comment",
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
        const data = await jira.get(`/issue/${issue_key}/comment`);
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
          body: markdownToAdf(body),
        });
        return { content: [{ type: "text", text: "Comment posted." }] };
      }

      case "jira_find_user": {
        const { query } = args as { query: string };
        const data = await jira.get("/user/search", {
          query,
          maxResults: "10",
        });
        const users = (data as any[]).map((u) => ({
          accountId: u.accountId,
          displayName: u.displayName,
          emailAddress: u.emailAddress,
        }));
        return {
          content: [{ type: "text", text: JSON.stringify(users, null, 2) }],
        };
      }

      case "jira_get_attachments": {
        const { issue_key } = args as { issue_key: string };
        const data = await jira.get(`/issue/${issue_key}`, {
          fields: "attachment",
        });
        const attachments = (data.fields.attachment || []).map((a: any) => ({
          id: a.id,
          filename: a.filename,
          mimeType: a.mimeType,
          size: a.size,
          content: a.content,
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
        const buffer = await jira.downloadUrl(attachment_url);
        const tmpDir = path.join(os.tmpdir(), "wario-attachments");
        await fs.mkdir(tmpDir, { recursive: true });
        const filePath = path.join(tmpDir, filename);
        await fs.writeFile(filePath, buffer);
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
        const transData = await jira.get(
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
    return { content: [{ type: "text", text: `Error: ${error.message}` }] };
  }
});

// --- Helper: convert Markdown to ADF, with @[Name](accountId) mention support ---
const MENTION_SENTINEL = "\x00MENTION";

function markdownToAdf(markdown: string): any {
  // Extract @[Name](accountId) mentions before marklassian sees them,
  // replacing each with a unique sentinel string it will pass through as text.
  const mentions: Array<{ id: string; text: string }> = [];
  const processed = markdown.replace(
    /@\[([^\]]+)\]\(([^)]+)\)/g,
    (_, name, accountId) => {
      const idx = mentions.length;
      mentions.push({ id: accountId, text: `@${name}` });
      return `${MENTION_SENTINEL}${idx}\x00`;
    }
  );

  const adf = marklassianConvert(processed);

  if (mentions.length > 0) {
    replaceMentionSentinels(adf, mentions);
  }

  return adf;
}

// Walk ADF and split any text node containing sentinels into text + mention nodes.
function replaceMentionSentinels(
  node: any,
  mentions: Array<{ id: string; text: string }>
): void {
  if (!node?.content) return;

  const sentinelRe = new RegExp(`${MENTION_SENTINEL}(\\d+)\x00`, "g");

  for (let i = 0; i < node.content.length; i++) {
    const child = node.content[i];

    if (child.type === "text" && sentinelRe.test(child.text)) {
      sentinelRe.lastIndex = 0;
      const newNodes: any[] = [];
      let last = 0;
      let m: RegExpExecArray | null;

      while ((m = sentinelRe.exec(child.text)) !== null) {
        if (m.index > last) {
          newNodes.push({ ...child, text: child.text.slice(last, m.index) });
        }
        const mention = mentions[parseInt(m[1])];
        newNodes.push({ type: "mention", attrs: { id: mention.id, text: mention.text } });
        last = m.index + m[0].length;
      }
      if (last < child.text.length) {
        newNodes.push({ ...child, text: child.text.slice(last) });
      }

      node.content.splice(i, 1, ...newNodes);
      i += newNodes.length - 1;
    } else {
      replaceMentionSentinels(child, mentions);
    }
  }
}

// --- Connect over stdio ---
await mcp.connect(new StdioServerTransport());
