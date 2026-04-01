export interface RepoConfig {
  name: string;
  github: { owner: string; repo: string };
  path: string; // relative to localRepoPath (e.g. "." or "./real-melrose")
  upstreamBranch: string;
}

export interface ProjectConfig {
  jiraProjectKey: string;
  localRepoPath: string;
  instructions?: string;
  maxBudgetUsd?: number;

  // Multi-repo (preferred)
  repos?: RepoConfig[];

  // Single-repo (backward compat — normalized to repos[] at load time)
  github?: { owner: string; repo: string };
  upstreamBranch?: string;
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
