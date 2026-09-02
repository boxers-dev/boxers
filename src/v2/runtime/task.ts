import type { StreamingCommandOptions } from "../process.ts";
import type { TaskManifest } from "../types.ts";
import { registeredRuntimes, runtimeForTask, runtimeHandleForTask } from "./registry.ts";
import type { RuntimeGitStatus, RuntimeHandle, RuntimeInfo, RuntimeJobRequest } from "./types.ts";

export type TaskRuntimeInfo = RuntimeInfo;
export type TaskGitStatusObservation = RuntimeGitStatus;

export function taskRuntimeId(task: TaskManifest): string {
  return runtimeHandleForTask(task).id;
}

export function taskRuntimeHandle(task: TaskManifest): RuntimeHandle {
  return runtimeHandleForTask(task);
}

export function runtimeInventoryKey(kind: string, id: string): string {
  return `${kind}\0${id}`;
}

export function taskRuntimeKey(task: TaskManifest): string {
  const handle = runtimeHandleForTask(task);
  return runtimeInventoryKey(handle.kind, handle.id);
}

export function findTaskRuntime(
  inventory: readonly RuntimeInfo[],
  task: TaskManifest,
): RuntimeInfo | undefined {
  const key = taskRuntimeKey(task);
  return inventory.find((item) => runtimeInventoryKey(item.kind, item.id) === key);
}

export function runtimeInventory(): RuntimeInfo[] {
  return registeredRuntimes().flatMap((runtime) => runtime.inventory());
}

export async function runtimeInventoryAsync(): Promise<RuntimeInfo[]> {
  const inventories = await Promise.all(
    registeredRuntimes().map(async (runtime) => await runtime.inventoryAsync()),
  );
  return inventories.flat();
}

export function isRuntimeRunning(info: RuntimeInfo | undefined): boolean {
  return info?.state === "running";
}

export function createTaskEnvironment(task: TaskManifest, seedPath: string): void {
  runtimeForTask(task).create({
    id: taskRuntimeId(task),
    agent: task.agent,
    seedPath,
    ...(task.template ? { template: task.template } : {}),
  });
}

export function destroyTaskEnvironment(task: TaskManifest): void {
  runtimeForTask(task).destroy(task);
}

export function suspendTaskEnvironment(task: TaskManifest): void {
  runtimeForTask(task).suspend(task);
}

export function taskWorkspacePatch(task: TaskManifest, targetOid: string): string {
  return runtimeForTask(task).workspacePatch(task, targetOid);
}

export function taskGitStatus(task: TaskManifest, base: string, targetOid: string) {
  return runtimeForTask(task).gitStatus(task, base, targetOid);
}

export function taskConflictPaths(task: TaskManifest): string[] {
  return runtimeForTask(task).conflictPaths(task);
}

export function reconcileTaskWorkspace(
  task: TaskManifest,
  base: string,
  oldTargetOid: string,
  targetOid: string,
  candidateRef: string,
) {
  return runtimeForTask(task).reconcileWorkspace(task, base, oldTargetOid, targetOid, candidateRef);
}

export function advanceTaskWorkspace(
  task: TaskManifest,
  base: string,
  integratedCommit: string,
): boolean {
  return runtimeForTask(task).advanceWorkspace(task, base, integratedCommit);
}

export function runTaskShell(task: TaskManifest, script: string) {
  return runtimeForTask(task).runShell(task, script);
}

export function runTaskShellStreaming(
  task: TaskManifest,
  script: string,
  options: StreamingCommandOptions = {},
) {
  return runtimeForTask(task).executeStreaming(task, script, options);
}

export function runTaskShellStreamingAt(
  task: TaskManifest,
  directory: string,
  script: string,
  options: StreamingCommandOptions = {},
) {
  return runtimeForTask(task).executeStreamingAt(task, directory, script, options);
}

export function taskWorkspaceTreeAt(task: TaskManifest, directory: string): string {
  return runtimeForTask(task).workspaceTreeAt(task, directory);
}

export function taskWorkspacePath(task: TaskManifest): string {
  return runtimeForTask(task).workspacePath(task);
}

export function runTaskSetupStreaming(
  task: TaskManifest,
  command: string,
  options: StreamingCommandOptions = {},
) {
  return runtimeForTask(task).runSetup(task, command, options);
}

export function startTaskJob(task: TaskManifest, request: RuntimeJobRequest): void {
  runtimeForTask(task).startJob(task, request);
}

export function inspectTaskJob(task: TaskManifest, jobId: string) {
  return runtimeForTask(task).inspectJob(task, jobId);
}

export function taskJobLogs(task: TaskManifest, jobId: string) {
  return runtimeForTask(task).jobLogs(task, jobId);
}

export function cancelTaskJob(task: TaskManifest, jobId: string): boolean {
  return runtimeForTask(task).cancelJob(task, jobId);
}

export function startTaskPreview(task: TaskManifest, run: string) {
  return runtimeForTask(task).startPreview(task, run);
}

export function stopTaskPreview(task: TaskManifest, jobId: string): boolean {
  return runtimeForTask(task).stopPreview(task, jobId);
}

export function taskPreviewLogs(task: TaskManifest, jobId: string) {
  return runtimeForTask(task).previewLogs(task, jobId);
}

export function openTaskShell(task: TaskManifest): number {
  return runtimeForTask(task).openShell(task);
}

export function taskPublishedUrls(task: TaskManifest): string[] {
  return runtimeForTask(task).publishedUrls(task);
}

export function publishTaskPorts(task: TaskManifest, ports: readonly number[]): string[] {
  return runtimeForTask(task).publishPorts(task, ports);
}

export function assertTaskAgentCredential(task: TaskManifest): void {
  runtimeForTask(task).assertAgentCredential(task);
}
