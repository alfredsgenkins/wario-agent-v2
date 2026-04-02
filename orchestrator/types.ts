export interface RepoConfig {
  name: string;
  github: { owner: string; repo: string };
  path: string; // relative to localRepoPath (e.g. "." or "./real-melrose")
  upstreamBranch: string;
  prTargetBranch?: string; // optional — PR base branch (defaults to upstreamBranch)
}

export interface ValidationFlow {
  name: string;
  path: string;
  description: string;
}

export interface ValidationConfig {
  type: "cma" | "docker-compose" | "custom";
  statusCommand: string;
  startCommand: string;
  adminUri?: string;
  credentials?: {
    username: string;
    password: string;
  };
  commonFlows?: ValidationFlow[];
}

export interface ProjectConfig {
  jiraProjectKey: string;
  localRepoPath: string;
  instructions?: string;
  maxBudgetUsd?: number;
  maxIterations?: number; // max self-iteration loops per task (default: 3)
  validation?: ValidationConfig;

  // Multi-repo (preferred)
  repos?: RepoConfig[];

  // Single-repo (backward compat — normalized to repos[] at load time)
  github?: { owner: string; repo: string };
  upstreamBranch?: string;
  prTargetBranch?: string;
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
  source: "jira" | "github" | "human" | "self";
  eventType: string;
  issueKey: string;
  projectKey: string;
  message: string;
}
