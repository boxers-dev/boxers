import type { TaskManifest } from "../types.ts";
import { dockerSandboxesRuntime } from "./docker-sandboxes.ts";
import type { RuntimeHandle, TaskRuntime } from "./types.ts";

const runtimes = new Map<string, TaskRuntime>([
  [dockerSandboxesRuntime.kind, dockerSandboxesRuntime],
]);

export function defaultRuntime(): TaskRuntime {
  return dockerSandboxesRuntime;
}

export function runtimeForKind(kind: string): TaskRuntime {
  const runtime = runtimes.get(kind);
  if (!runtime) throw new Error(`Unsupported task runtime "${kind}".`);
  return runtime;
}

export function runtimeForTask(task: TaskManifest): TaskRuntime {
  return runtimeForKind(runtimeHandleForTask(task).kind);
}

export function runtimeHandleForTask(task: TaskManifest): RuntimeHandle {
  return task.runtime;
}

export function registeredRuntimes(): TaskRuntime[] {
  return [...runtimes.values()];
}
