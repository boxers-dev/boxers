import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeStderr } from "../core/output.ts";
import { atomicWriteJson, readJson, taskDir } from "./paths.ts";
import { listProjects, listTasks, updateTask } from "./registry.ts";
import { notifyDaemonSetupCompleted, notifyDaemonStateChanged } from "./daemon-client.ts";
import {
  inspectTaskJob,
  runTaskShell,
  startTaskJob,
  startTaskPreview,
  taskJobLogs,
  taskWorkspacePath,
  taskWorkspaceTreeAt,
} from "./runtime/task.ts";
import type { RuntimeJobRequest, RuntimeJobStatus } from "./runtime/types.ts";
import type { ProjectConfig, SetupStatus, TaskManifest } from "./types.ts";

function statusPath(task: TaskManifest): string {
  return join(taskDir(task.projectId, task.id), "setup.json");
}

function setupLogPath(task: TaskManifest): string {
  return join(taskDir(task.projectId, task.id), "setup.log");
}

function setupConfigHash(setup: NonNullable<ProjectConfig["setup"]>): string {
  return createHash("sha256").update(JSON.stringify(setup)).digest("hex");
}

/** Converge setup to the canonical configuration, starting a new durable job when needed. */
export function ensureCurrentSetup(
  task: TaskManifest,
  setup: ProjectConfig["setup"] | undefined,
  previewRun?: string,
): SetupStatus | undefined {
  const cached = refreshSetupStatus(task, previewRun);
  if (!setup) return cached;
  const configHash = setupConfigHash(setup);
  if (cached?.configHash === configHash) return cached;
  if (cached) {
    writeSetupObservation(
      task,
      { ...cached, state: "stale", finishedAt: new Date().toISOString() },
      previewRun,
    );
  }
  return submitSetupJob(task, setup, 1, 2, previewRun);
}

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function setupJobCommand(run: string): string {
  return `
set -o pipefail
mkdir -p .git/boxers
printf 'running\n' > .git/boxers/setup-status
set +e
bash -lc ${shellArgument(run)} 2>&1 | tee .git/boxers/setup.log
code=\${PIPESTATUS[0]}
set -e
if test "$code" -eq 0; then state=passed; else state=failed; fi
printf '%s\n' "$state" > .git/boxers/setup-status
exit "$code"
`;
}

export function readSetupStatus(task: TaskManifest): SetupStatus | undefined {
  const path = statusPath(task);
  return existsSync(path) ? readJson<SetupStatus>(path) : undefined;
}

function writeSetupObservation(task: TaskManifest, status: SetupStatus, previewRun?: string): void {
  const previous = readSetupStatus(task);
  const observation: SetupStatus = {
    ...status,
    observedAt: new Date().toISOString(),
    source: "worker",
  };
  atomicWriteJson(statusPath(task), observation);
  const project = listProjects().find((candidate) => candidate.id === task.projectId);
  const current = project && listTasks(project).find((candidate) => candidate.id === task.id);
  if (project && current) {
    let preview = current.lastSnapshot?.preview;
    if (previewRun && observation.state === "passed") {
      try {
        const handle = startTaskPreview(current, previewRun);
        preview = {
          state: "running",
          ...handle,
          observedAt: new Date().toISOString(),
          source: "worker",
          ...(preview?.urls ? { urls: preview.urls } : {}),
        };
      } catch (error) {
        preview = {
          state: "failed",
          ...(preview?.urls ? { urls: preview.urls } : {}),
          failure: error instanceof Error ? error.message : String(error),
        };
      }
    } else if (
      previewRun &&
      !["running", "passed"].includes(observation.state) &&
      preview?.state === "starting"
    ) {
      preview = {
        state: "failed",
        ...(preview.urls ? { urls: preview.urls } : {}),
        failure: `Preview was not started because setup ${observation.state}.`,
      };
    }
    updateTask(
      project,
      current,
      {
        ...(current.lastSnapshot ?? { phase: "idle", agent: current.agent }),
        setup: observation,
        ...(preview ? { preview } : {}),
      },
      undefined,
      "worker",
    );
  }
  notifyDaemonStateChanged();
  if (previous?.state === "running" && observation.state !== "running")
    notifyDaemonSetupCompleted(task.name);
}

function cachedStatusFromJob(cached: SetupStatus, job: RuntimeJobStatus): SetupStatus {
  const state = job.state === "queued" ? "running" : job.state;
  return {
    ...cached,
    state,
    ...(job.startedAt ? { startedAt: job.startedAt } : {}),
    ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
    ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
  };
}

/** Refresh the disposable host setup cache from the durable Sandbox job. */
export function refreshSetupStatus(
  task: TaskManifest,
  previewRun?: string,
): SetupStatus | undefined {
  const cached = readSetupStatus(task);
  if (!cached) return undefined;
  const observed = inspectTaskJob(task, cached.jobId);
  if (!observed) {
    // Detached exec can return just before its wrapper creates the job folder.
    if (cached.state !== "running" || Date.now() - Date.parse(cached.startedAt) < 5_000)
      return cached;
    const interrupted: SetupStatus = {
      ...cached,
      state: "interrupted",
      finishedAt: new Date().toISOString(),
    };
    writeSetupObservation(task, interrupted, previewRun);
    return interrupted;
  }
  const next = cachedStatusFromJob(cached, observed);
  const logs = taskJobLogs(task, cached.jobId);
  if (logs) writeFileSync(cached.logPath, `${logs.stdout}${logs.stderr}`, { mode: 0o600 });
  if (JSON.stringify(next) !== JSON.stringify(cached)) {
    writeSetupObservation(task, next, previewRun);
    if (next.state !== "running") {
      try {
        runTaskShell(
          task,
          `mkdir -p .git/boxers && printf '%s\\n' ${shellArgument(next.state)} > .git/boxers/setup-status`,
        );
      } catch {
        // The durable result remains inspectable if this agent convenience
        // marker cannot be repaired while the runtime is unavailable.
      }
    }
  }
  return next;
}

function submitSetupJob(
  task: TaskManifest,
  setup: NonNullable<ProjectConfig["setup"]>,
  attempt: number,
  maxAttempts: number,
  previewRun?: string,
): SetupStatus {
  const configHash = setupConfigHash(setup);
  const jobId = `setup-${configHash.slice(0, 24)}-${attempt}`;
  const startedAt = new Date().toISOString();
  const logPath = setupLogPath(task);
  writeFileSync(logPath, "", { mode: 0o600 });
  const initial: SetupStatus = {
    state: "running",
    command: setup.run,
    startedAt,
    logPath,
    jobId,
    configHash,
    attempt,
    maxAttempts,
  };
  writeSetupObservation(task, initial, previewRun);
  const directory = taskWorkspacePath(task);
  const request: RuntimeJobRequest = {
    version: 1,
    jobId,
    taskId: task.id,
    kind: "setup",
    semanticKey: configHash,
    conversationSequence: 0,
    targetOid: task.lastSnapshot?.targetOid ?? "",
    workspaceTreeOid: taskWorkspaceTreeAt(task, directory),
    configHash,
    command: setupJobCommand(setup.run),
    directory,
    timeoutMs: setup.timeoutMs,
    createdAt: startedAt,
  };
  try {
    startTaskJob(task, request);
  } catch (error) {
    const failed: SetupStatus = {
      ...initial,
      state: "failed",
      finishedAt: new Date().toISOString(),
    };
    writeFileSync(logPath, `${error instanceof Error ? error.message : String(error)}\n`, {
      flag: "a",
    });
    writeSetupObservation(task, failed, previewRun);
    throw error;
  }
  return initial;
}

export function startBackgroundSetup(
  task: TaskManifest,
  setup: NonNullable<ProjectConfig["setup"]>,
  previewRun?: string,
): SetupStatus {
  return submitSetupJob(task, setup, 1, 2, previewRun);
}

/** Rerun task setup and synchronously observe its Sandbox-owned result. */
export async function retryTaskSetup(
  task: TaskManifest,
  setup: NonNullable<ProjectConfig["setup"]>,
): Promise<number> {
  const previous = readSetupStatus(task);
  if (previous?.state === "running") throw new Error("Task setup is already running.");
  const attempt = (previous?.attempt ?? 0) + 1;
  const maxAttempts = Math.max(previous?.maxAttempts ?? 2, attempt);
  submitSetupJob(task, setup, attempt, maxAttempts);
  const status = await waitForSetup(task, true);
  return status?.state === "passed" ? 0 : 1;
}

export async function waitForSetup(
  task: TaskManifest,
  streamToTerminal = false,
  previewRun?: string,
): Promise<SetupStatus | undefined> {
  let status = readSetupStatus(task);
  if (status?.state === "running" && !streamToTerminal)
    writeStderr("Waiting for background setup to finish...\n");
  let streamedBytes = 0;
  while (status?.state === "running") {
    status = refreshSetupStatus(task, previewRun);
    if (streamToTerminal && status?.logPath && existsSync(status.logPath)) {
      const log = readFileSync(status.logPath, "utf8");
      if (log.length > streamedBytes) process.stdout.write(log.slice(streamedBytes));
      streamedBytes = log.length;
    }
    if (status?.state === "running") await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return status;
}
