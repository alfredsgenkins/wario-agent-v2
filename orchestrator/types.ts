export interface ProjectConfig {
  jiraProjectKey: string;
  github: { owner: string; repo: string };
  localRepoPath: string;
  upstreamBranch: string;
  instructions?: string;
  maxBudgetUsd?: number;
}

export interface ProjectsYaml {
  projects: ProjectConfig[];
}

export interface SessionRecord {
  issueKey: string;
  projectKey: string;
  sessionId: string;
  status: "active" | "idle" | "dead";
  createdAt: string;
  lastEventAt: string;
}

export interface WebhookEvent {
  source: "jira" | "github";
  eventType: string;
  issueKey: string;
  projectKey: string;
  message: string;
}
