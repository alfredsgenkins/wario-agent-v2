/**
 * Shared JIRA REST client and helpers.
 * Used by both the orchestrator and the MCP tools server.
 */

export interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    status: { name: string };
    project: { key: string };
    assignee?: { accountId: string; displayName: string };
  };
}

export interface JiraSearchResult {
  issues: JiraIssue[];
  total: number;
}

export class JiraApiError extends Error {
  constructor(message: string, public responseData?: any) {
    super(message);
  }
}

export class JiraClient {
  private baseUrl: string;
  private authHeader: string;

  constructor(baseUrl: string, email: string, apiToken: string) {
    this.baseUrl = baseUrl;
    this.authHeader = `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`;
  }

  static fromEnv(): JiraClient | null {
    const baseUrl = process.env.JIRA_BASE_URL;
    const email = process.env.JIRA_USER_EMAIL;
    const token = process.env.JIRA_API_TOKEN;
    if (!baseUrl || !email || !token) return null;
    return new JiraClient(baseUrl, email, token);
  }

  async get(path: string, params?: Record<string, string>): Promise<any> {
    const url = new URL(`${this.baseUrl}/rest/api/3${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    }
    const resp = await fetch(url, {
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
      },
    });
    if (!resp.ok) await this.throwApiError(resp);
    return resp.json();
  }

  async post(path: string, body: any): Promise<any> {
    const resp = await fetch(`${this.baseUrl}/rest/api/3${path}`, {
      method: "POST",
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) await this.throwApiError(resp);
    const text = await resp.text();
    return text ? JSON.parse(text) : undefined;
  }

  async downloadUrl(url: string): Promise<Buffer> {
    const resp = await fetch(url, {
      headers: { Authorization: this.authHeader },
    });
    if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
  }

  async searchIssues(jql: string, fields = "summary,status,project,assignee"): Promise<JiraSearchResult> {
    return this.get("/search/jql", { jql, fields, maxResults: "50" });
  }

  private async throwApiError(resp: Response): Promise<never> {
    const data = await resp.json().catch(() => ({}));
    const msg =
      data.errorMessages?.join(", ") ||
      (data.errors ? JSON.stringify(data.errors) : `${resp.status} ${resp.statusText}`);
    throw new JiraApiError(msg, data);
  }
}

/** Extract plain text from Atlassian Document Format */
export function extractTextFromAdf(adf: any): string {
  if (!adf) return "";
  if (typeof adf === "string") return adf;
  if (adf.type === "text") return adf.text || "";
  if (adf.content) {
    return adf.content.map(extractTextFromAdf).join("");
  }
  return "";
}
