export type Agent = "codex" | "claude";

export interface CheckDefinition {
  name: string;
  run: string;
  timeoutMs: number;
}

export interface ProjectConfig {
  version: 1;
  integration?: { remote?: string; branch?: string };
  agent?: { default?: Agent; model?: string; effort?: string };
  sandbox?: { template?: string };
  setup?: { run: string; timeoutMs: number };
  checks: CheckDefinition[];
  preview?: {
    run: string;
    ports: number[];
    reviewMode: "snapshot" | "live";
    setup?: string;
  };
}

export interface HerdrInvocationContext {
  workspace_id?: string;
  workspace_cwd?: string;
  focused_pane_id?: string;
  focused_pane_cwd?: string;
}

export interface HerdrProject {
  version: 1;
  id: string;
  root: string;
  mirrorPath: string;
  targetUrl: string;
  targetBranch: string;
  targetOid: string;
  configHash: string;
  updatedAt: string;
}

export interface HerdrCheckResult {
  name: string;
  passed: boolean;
  exitCode: number;
  targetOid: string;
  candidateTreeOid: string;
  configHash: string;
  startedAt: string;
  finishedAt: string;
  logPath: string;
}

export interface HerdrReview {
  version: 1;
  id: string;
  projectId: string;
  sandboxId: string;
  agent: Agent;
  paneId?: string;
  targetUrl: string;
  targetBranch: string;
  targetOid: string;
  candidateTreeOid: string;
  transportCommitOid: string;
  configHash: string;
  capturedAt: string;
  setup?: HerdrCheckResult;
  checks: HerdrCheckResult[];
  checksSkipped?: boolean;
  preview?: { mode: "live" | "snapshot"; state: string; urls: string[] };
}

export interface HerdrDelivery {
  version: 1;
  reviewId: string;
  targetOid: string;
  candidateTreeOid: string;
  commitOid: string;
  state: "pending" | "rejected" | "accepted" | "reconciled";
  message: string;
  createdAt: string;
  acceptedAt?: string;
  reconciledAt?: string;
  reconciliationError?: string;
}

export interface HerdrTask {
  version: 1;
  id: string;
  projectId: string;
  sandboxId: string;
  agent: Agent;
  agentModel?: string;
  agentEffort?: string;
  projectRoot: string;
  mirrorPath: string;
  workspaceId?: string;
  sourcePaneId?: string;
  paneId?: string;
  createdAt: string;
  sessionStartedAt?: string;
  runtimeState?: "running" | "stopped" | "missing" | "unknown";
  conflicts?: string[];
  review?: HerdrReview;
  delivery?: HerdrDelivery;
  preview?: {
    mode: "live" | "snapshot";
    state: "running" | "stopped" | "unknown";
    urls: string[];
    candidateTreeOid?: string;
  };
}

export interface HerdrPluginState {
  version: 1;
  projects: HerdrProject[];
  tasks: HerdrTask[];
}
