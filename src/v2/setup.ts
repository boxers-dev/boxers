import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeStderr } from "../core/output.ts";
import { atomicWriteJson, readJson, taskDir } from "./paths.ts";
import { listProjects, listTasks, updateTask } from "./registry.ts";
import { notifyDaemonSetupCompleted, notifyDaemonStateChanged } from "./daemon-client.ts";
import { runTaskSetupStreaming, runTaskShell, startTaskPreview } from "./runtime/task.ts";
import type { ProjectConfig, SetupStatus, TaskManifest } from "./types.ts";

function statusPath(task: TaskManifest): string {
  return join(taskDir(task.projectId, task.id), "setup.json");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readSetupStatus(task: TaskManifest): SetupStatus | undefined {
  const path = statusPath(task);
  if (!existsSync(path)) return undefined;
  const status = readJson<SetupStatus>(path);
  if (status.state === "running" && status.pid && !alive(status.pid)) {
    const failed: SetupStatus = {
      ...status,
      state: "failed",
      finishedAt: new Date().toISOString(),
    };
    atomicWriteJson(path, failed);
    return failed;
  }
  return status;
}

export function startBackgroundSetup(
  task: TaskManifest,
  setup: NonNullable<ProjectConfig["setup"]>,
  previewRun?: string,
): SetupStatus {
  const directory = taskDir(task.projectId, task.id);
  const logPath = join(directory, "setup.log");
  writeFileSync(logPath, "", { mode: 0o600 });
  const startedAt = new Date().toISOString();
  const initial: SetupStatus = {
    state: "running",
    command: setup.run,
    startedAt,
    logPath,
  };
  atomicWriteJson(statusPath(task), initial);
  const project = listProjects().find((candidate) => candidate.id === task.projectId);
  if (project)
    updateTask(
      project,
      task,
      {
        ...(task.lastSnapshot ?? { phase: "idle", agent: task.agent }),
        setup: initial,
      },
      undefined,
      "worker",
    );
  notifyDaemonStateChanged();
  const entry = process.argv[1];
  if (!entry) throw new Error("Could not locate the boxers executable for background setup.");
  const child = spawn(
    process.execPath,
    [
      ...process.execArgv,
      entry,
      "__setup-worker",
      task.projectId,
      task.id,
      setup.run,
      String(setup.timeoutMs),
      startedAt,
      ...(previewRun ? [previewRun] : []),
    ],
    { detached: true, stdio: "ignore" },
  );
  child.on("error", (error) => {
    atomicWriteJson(statusPath(task), {
      ...initial,
      state: "failed",
      finishedAt: new Date().toISOString(),
    });
    writeFileSync(logPath, `${error.message}\n`, { flag: "a" });
    notifyDaemonStateChanged();
    notifyDaemonSetupCompleted(task.name);
  });
  child.unref();
  const running: SetupStatus = {
    ...initial,
    ...(child.pid === undefined ? {} : { pid: child.pid }),
  };
  return running;
}

export async function runSetupWorker(
  projectId: string,
  taskId: string,
  run: string,
  timeoutMs: number,
  startedAt: string,
  previewRun?: string,
): Promise<number> {
  const project = listProjects().find((candidate) => candidate.id === projectId);
  const task = project && listTasks(project).find((candidate) => candidate.id === taskId);
  if (!task) throw new Error("Background setup task no longer exists.");
  const logPath = join(taskDir(projectId, taskId), "setup.log");
  atomicWriteJson(statusPath(task), {
    state: "running",
    command: run,
    startedAt,
    pid: process.pid,
    logPath,
  } satisfies SetupStatus);
  runTaskShell(task, "mkdir -p .git/boxers && printf 'running\\n' > .git/boxers/setup-status");
  const stream = (chunk: string) => writeFileSync(logPath, chunk, { flag: "a" });
  const result = await runTaskSetupStreaming(task, run, {
    timeout: timeoutMs,
    onStdout: stream,
    onStderr: stream,
  });
  const status: SetupStatus = {
    state: result.timedOut ? "timed_out" : result.status === 0 ? "passed" : "failed",
    command: run,
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: result.status,
    logPath,
  };
  atomicWriteJson(statusPath(task), status);
  let current = listTasks(project).find((candidate) => candidate.id === taskId);
  if (current) {
    let preview = current.lastSnapshot?.preview;
    if (previewRun && status.state === "passed") {
      try {
        startTaskPreview(current, previewRun);
        preview = {
          state: "running",
          ...(preview?.urls ? { urls: preview.urls } : {}),
        };
      } catch (error) {
        preview = {
          state: "failed",
          ...(preview?.urls ? { urls: preview.urls } : {}),
          failure: error instanceof Error ? error.message : String(error),
        };
      }
    } else if (previewRun) {
      preview = {
        state: "failed",
        ...(preview?.urls ? { urls: preview.urls } : {}),
        failure: `Preview was not started because setup ${status.state}.`,
      };
    }
    updateTask(
      project,
      current,
      {
        ...(current.lastSnapshot ?? { phase: "idle", agent: current.agent }),
        setup: status,
        ...(preview ? { preview } : {}),
      },
      undefined,
      "worker",
    );
  }
  runTaskShell(
    task,
    `mkdir -p .git/boxers && printf '${status.state}\\n' > .git/boxers/setup-status`,
  );
  notifyDaemonSetupCompleted(task.name);
  return result.timedOut || result.status !== 0 ? 1 : 0;
}

export async function waitForSetup(task: TaskManifest): Promise<SetupStatus | undefined> {
  let status = readSetupStatus(task);
  if (status?.state === "running") writeStderr("Waiting for background setup to finish...\n");
  while (status?.state === "running") {
    await new Promise((resolve) => setTimeout(resolve, 250));
    status = readSetupStatus(task);
  }
  return status;
}
