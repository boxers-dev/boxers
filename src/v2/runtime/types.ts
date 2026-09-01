import type { Agent, TaskManifest } from "../types.ts";
import type { CommandResult, StreamingCommandOptions, StreamingCommandResult } from "../process.ts";

export type RuntimeAuthMode = "oauth" | "api-key";

export interface RuntimeProcessSpec {
  command: string;
  args: string[];
}

export interface RuntimeCapabilities {
  durableWorkspace: true;
  durableAgentSession: true;
  cloneIsolation: true;
  publishedPorts: boolean;
  lifecycleEvents: boolean;
  suspension: boolean;
}

export interface RuntimeHandle {
  kind: string;
  id: string;
}

export interface RuntimeInfo {
  kind: string;
  id: string;
  state: "running" | "stopped" | "missing" | "unknown";
  rawState?: string;
  ports?: unknown;
}

export interface RuntimeGitStatus {
  targetOid: string;
  headOid: string;
  uncommitted: boolean;
  committedAhead: number;
  committedBehind: number;
}

export interface RuntimeCheckWorkspace {
  path: string;
  candidateTreeOid: string;
}

export interface RuntimeReconciliationResult {
  status: "clean" | "conflicted";
  conflicts: string[];
}

export interface RuntimeDiagnostic {
  component: string;
  status: "ok" | "warning" | "failed";
  detail: string;
  remediation?: {
    kind: "command" | "url" | "manual";
    value: string;
    privileged?: boolean;
    interactive?: boolean;
  };
}

export interface RuntimeDiagnosticOptions {
  agent?: Agent;
  acknowledgeOpenNetwork?: boolean;
}

export interface TaskEnvironmentSpec {
  id: string;
  agent: Agent;
  seedPath: string;
  template?: string;
}

export interface TaskRuntime {
  readonly kind: string;
  capabilities(): RuntimeCapabilities;
  diagnose(options?: RuntimeDiagnosticOptions): RuntimeDiagnostic[];
  globalCredentialServices(): string[];
  authenticateGlobal(agent: Agent, mode: RuntimeAuthMode): number;
  authenticateSubscription(runtimeId: string, agent: Agent): void;
  create(spec: TaskEnvironmentSpec): RuntimeHandle;
  inventory(): RuntimeInfo[];
  inventoryAsync(): Promise<RuntimeInfo[]>;
  ensureAvailable(task: TaskManifest): void;
  execute(task: TaskManifest, args: readonly string[]): CommandResult;
  executeAsync(task: TaskManifest, args: readonly string[]): Promise<CommandResult>;
  executeWithInput(task: TaskManifest, args: readonly string[], input: string): CommandResult;
  executeStreaming(
    task: TaskManifest,
    script: string,
    options?: StreamingCommandOptions,
  ): Promise<StreamingCommandResult>;
  executeStreamingAt(
    task: TaskManifest,
    directory: string,
    script: string,
    options?: StreamingCommandOptions,
  ): Promise<StreamingCommandResult>;
  runSetup(
    task: TaskManifest,
    command: string,
    options?: StreamingCommandOptions,
  ): Promise<StreamingCommandResult>;
  publishPorts(task: TaskManifest, ports: readonly number[]): string[];
  publishedUrls(task: TaskManifest): string[];
  workspacePatch(task: TaskManifest, targetOid: string): string;
  gitStatus(task: TaskManifest, base: string, targetOid: string): Promise<RuntimeGitStatus>;
  prepareCheckWorkspace(
    task: TaskManifest,
    base: string,
    targetOid: string,
    candidateTreeOid: string,
    candidatePatch: string,
  ): RuntimeCheckWorkspace;
  workspaceTreeAt(task: TaskManifest, directory: string): string;
  conflictPaths(task: TaskManifest): string[];
  reconcileWorkspace(
    task: TaskManifest,
    base: string,
    oldTargetOid: string,
    targetOid: string,
    candidateRef: string,
  ): RuntimeReconciliationResult;
  advanceWorkspace(task: TaskManifest, base: string, integratedCommit: string): boolean;
  runShell(task: TaskManifest, script: string): CommandResult;
  startPreview(task: TaskManifest, run: string): void;
  stopPreview(task: TaskManifest): void;
  previewLogs(task: TaskManifest): CommandResult;
  openShell(task: TaskManifest): number;
  suspend(task: TaskManifest): void;
  assertAgentCredential(task: TaskManifest): void;
  workspacePath(task: TaskManifest): string;
  agentLaunchSpec(task: TaskManifest, args: readonly string[]): RuntimeProcessSpec;
  destroy(task: TaskManifest): void;
}
