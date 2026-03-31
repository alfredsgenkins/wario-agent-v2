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
import axios, { type AxiosInstance } from "axios";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// --- Config from env ---
const JIRA_BASE_URL = process.env.JIRA_BASE_URL!;
const JIRA_USER_EMAIL = process.env.JIRA_USER_EMAIL!;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN!;

// --- JIRA API client ---
const jira: AxiosInstance = axios.create({
  baseURL: `${JIRA_BASE_URL}/rest/api/3`,
  auth: { username: JIRA_USER_EMAIL, password: JIRA_API_TOKEN },
  headers: { "Content-Type": "application/json", Accept: "application/json" },
});

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
    const message =
      error.response?.data?.errorMessages?.join(", ") ||
      (error.response?.data?.errors
        ? JSON.stringify(error.response.data.errors)
        : error.message);
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

// --- Connect over stdio ---
await mcp.connect(new StdioServerTransport());
