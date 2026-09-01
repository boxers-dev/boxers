export const MIN_SBX_VERSION = "0.37.0";

export type Agent = "codex" | "claude";
export type IntegrationMode = "local" | "remote";

export type TaskPhase =
  | "creating"
  | "active"
  | "working"
  | "reconciling"
  | "setting_up"
  | "checking"
  | "needs_input"
  | "reviewed"
  | "idle"
  | "failed"
  | "stopped";

export interface CheckDefinition {
  name: string;
  run: string;
  timeoutMs: number;
}

export interface ProjectConfig {
  version: 3;
  integration?: { mode: "local"; base: string } | { mode: "remote"; base: string; remote: string };
  setup?: { run: string; timeoutMs: number };
  check?: {
    setup?: string;
    commands: CheckDefinition[];
  };
  preview?: { run: string; ports: number[] };
  defaults?: { agent?: Agent; model?: string; effort?: string; fast?: boolean };
}

export interface SetupStatus {
  state: "running" | "passed" | "failed" | "timed_out";
  command: string;
  startedAt: string;
  finishedAt?: string;
  pid?: number;
  exitCode?: number;
  logPath: string;
}

export interface CheckResult {
  name: string;
  command: string;
  status: "passed" | "failed" | "timed_out";
  exitCode?: number;
  durationMs: number;
  logPath?: string;
}

export interface CheckRun {
  status: "passed" | "failed";
  targetOid: string;
  candidateTreeOid: string;
  configHash: string;
  results: CheckResult[];
}

export interface CandidateCommitMessage {
  targetOid: string;
  candidateTreeOid: string;
  conversationHighWaterSequence: number;
  subject: string;
  note?: string | undefined;
}

export type AgentTurnState = "not_started" | "working" | "awaiting_input" | "exited" | "unknown";

export type SettlementPhase =
  | "none"
  | "queued"
  | "refreshing"
  | "reconciling"
  | "capturing"
  | "checking"
  | "generating"
  | "ready"
  | "needs_input"
  | "cancelled"
  | "failed";

export type TaskProjectionPhase =
  | TaskPhase
  | "awaiting_input"
  | "settling"
  | "queued"
  | "refreshing"
  | "capturing"
  | "generating"
  | "ready"
  | "cancelled"
  | "check_failed"
  | "settlement_failed";

export interface PersistedSettlementState {
  runId: string;
  phase: SettlementPhase;
  triggerSequence: number;
  startedAt: string;
  updatedAt: string;
  targetOid?: string;
  candidateTreeOid?: string;
  finishedAt?: string;
  failure?: string;
}

export interface PreviewStatus {
  state: "stopped" | "starting" | "running" | "failed";
  pid?: number | undefined;
  urls?: string[] | undefined;
  failure?: string | undefined;
}

export type ObservationSource = "command" | "daemon" | "worker" | "git" | "initial";

export interface Observation<T> {
  value: T;
  observedAt: string;
  source: ObservationSource;
}

export type WorkspaceRelation =
  | "on_base"
  | "not_on_base"
  | "reconcile_pending"
  | "conflicted"
  | "unknown";

export interface TaskState {
  version: 3;
  taskId: string;
  revision: number;
  updatedAt: string;
  agentTurnState: AgentTurnState;
  conversationHighWaterSequence: number;
  lifecycleDrainSequence: number;
  promotionConversationCheckpoint: number;
  providerSessionId?: string | undefined;
  providerTurnId?: string | undefined;
  lastLifecycleEventKind?: "user_prompt" | "turn_finished" | undefined;
  lastLifecycleEventAt?: string | undefined;
  settlement?: PersistedSettlementState | undefined;
  lifecycleDiagnostic?: string | undefined;
  hasUnmergedChanges: Observation<boolean | "unknown">;
  baseOid?: string | undefined;
  candidateTreeOid?: string | undefined;
  lastDelivery?: Observation<{ ref: string; oid: string; subject: string }> | undefined;
  setup?: SetupStatus | undefined;
  check?: CheckRun | undefined;
  commitMessage?: CandidateCommitMessage | undefined;
  summary?: string | undefined;
  failure?: string | undefined;
}

export interface TaskSnapshot {
  phase: TaskPhase;
  summary?: string | undefined;
  report?: string | undefined;
  question?: string | undefined;
  failure?: string | undefined;
  agent: Agent;
  targetOid?: string | undefined;
  candidateTreeOid?: string | undefined;
  check?: CheckRun | undefined;
  preview?: PreviewStatus | undefined;
  setup?: SetupStatus | undefined;
  runtimeState?: string | undefined;
}

export interface ProjectManifest {
  version: 1;
  id: string;
  root: string;
  seedPath: string;
  source?: string | undefined;
  integration: { mode: "local"; base: string } | { mode: "remote"; base: string; remote: string };
  createdAt: string;
}

export interface TaskManifest {
  version: 3;
  id: string;
  projectId: string;
  name: string;
  runtime: { kind: string; id: string };
  agent: Agent;
  template?: string | undefined;
  model?: string | undefined;
  effort?: string | undefined;
  fast?: boolean | undefined;
  creationPid?: number | undefined;
  sessionMode: "native";
  sessionStartedAt?: string | undefined;
  lifecycleBridgeToken: string;
  createdAt: string;
  lastSnapshot?: TaskSnapshot | undefined;
}

export interface MachineIdentity {
  version: 1;
  id: string;
  name: string;
  createdAt: string;
}

export type PeerRole = "observe" | "operate" | "admin";

export interface FleetMember {
  hostId: string;
  name: string;
  publicKey: string;
  ssh: {
    version: 1;
    publicKey: string;
    fingerprint: string;
  };
  endpoints: { transport: "ssh"; target: string; executable?: string | undefined }[];
  roles: PeerRole[];
  enrolledAt: string;
}

export interface FleetRemoval {
  hostId: string;
  removedAt: string;
}

export interface FleetManifest {
  version: 1;
  fleetId: string;
  members: FleetMember[];
  removedMembers?: FleetRemoval[] | undefined;
  updatedAt: string;
}

export interface RemoteTaskSnapshot {
  id: string;
  projectId: string;
  project: string;
  name: string;
  agent: Agent;
  runtime?: { kind: string; id: string } | undefined;
  phase: TaskProjectionPhase;
  activity: AgentTurnState;
  needsAttention?: boolean | undefined;
  hasUnmergedChanges?: boolean | undefined;
  runtimeState?: string | undefined;
  stateObservedAt?: string | undefined;
  runtimeObservedAt?: string | undefined;
  activityObservedAt?: string | undefined;
  workspaceObservedAt?: string | undefined;
  state?: TaskState | undefined;
  preview?: PreviewStatus | undefined;
  lastDelivery?: { ref: string; oid: string; subject: string } | undefined;
  summary?: string | undefined;
}

export interface RemoteProjectSnapshot {
  id: string;
  name: string;
  source?: string | undefined;
  base: string;
  integration: IntegrationMode;
}

export type HostCheckStatus = "ok" | "warning" | "failed" | "unknown";
export type HostHealth = "healthy" | "degraded" | "unhealthy" | "unknown";
export type AuthenticationStatus = "configured" | "missing" | "unknown";

export interface HostStatusCheck {
  id: string;
  category: "health" | "authentication";
  status: HostCheckStatus;
  detail: string;
  remediation?: {
    kind: "command" | "url" | "manual";
    value: string;
    privileged?: boolean;
    interactive?: boolean;
  };
}

export interface HostStatusObservation {
  version: 1;
  observedAt: string;
  boxersVersion: string;
  health: HostHealth;
  daemon: "running" | "stopped" | "unknown";
  authentication: Record<Agent, AuthenticationStatus>;
  checks: HostStatusCheck[];
}

export interface RemoteSnapshot {
  protocolVersion: 2;
  machine: MachineIdentity & { boxersVersion: string };
  observedAt: string;
  servedAt?: string | undefined;
  projects?: RemoteProjectSnapshot[] | undefined;
  hostStatus?: HostStatusObservation | undefined;
  tasks: RemoteTaskSnapshot[];
}

export interface MachineView {
  id: string;
  name: string;
  connection: "online" | "offline" | "stale" | "authentication" | "incompatible" | "error";
  snapshot?: RemoteSnapshot | undefined;
  detail?: string | undefined;
}

export function isAgent(value: string): value is Agent {
  return value === "codex" || value === "claude";
}
