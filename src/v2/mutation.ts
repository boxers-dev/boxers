import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWriteText, taskMutationBarrierPath } from "./paths.ts";
import { runtimeForTask } from "./runtime/registry.ts";
import type { TaskManifest } from "./types.ts";

const depths = new Map<string, number>();
const runIds = new Map<string, string>();

function ownerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseMutationMarker(marker: string): { pid: number; canonical: string } | undefined {
  const value = JSON.parse(marker) as Record<string, unknown>;
  if (typeof value["pid"] !== "number") return undefined;
  return { pid: value["pid"], canonical: `${JSON.stringify(value)}\n` };
}

/** Asynchronous hot-path variant used before forwarding terminal input. */
export async function taskMutationBarrierActiveAsync(task: TaskManifest): Promise<boolean> {
  const path = taskMutationBarrierPath(task.name);
  let marker: string;
  let canonical: string;
  try {
    marker = await readFile(path, "utf8");
    const parsed = parseMutationMarker(marker);
    if (!parsed) return true;
    if (ownerAlive(parsed.pid)) return true;
    canonical = parsed.canonical;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    // Never clear a companion when the marker cannot prove its owner is dead.
    return true;
  }
  if (!(await clearSandboxMarkerAsync(task, canonical))) return true;
  try {
    await unlink(path);
  } catch {
    // A concurrent writer may have replaced it; the next input check retries.
  }
  return false;
}

function sandboxMarker(task: TaskManifest, marker: string): void {
  const runtime = runtimeForTask(task);
  const result = runtime.executeWithInput(
    task,
    [
      "sh",
      "-c",
      'set -eu; git_dir=$(git -C "$1" rev-parse --absolute-git-dir); mkdir -p "$git_dir/boxers"; umask 077; temp="$git_dir/boxers/mutation.json.$$"; cat > "$temp"; mv "$temp" "$git_dir/boxers/mutation.json"',
      "boxers-mutation-start",
      runtime.workspacePath(task),
    ],
    marker,
  );
  if (result.status !== 0)
    throw new Error(
      `Could not publish the task mutation marker: ${(result.stderr || result.stdout).trim()}`,
    );
}

function sandboxMarkerRemovalArguments(task: TaskManifest, marker?: string): string[] {
  const runtime = runtimeForTask(task);
  return [
    "sh",
    "-c",
    'git_dir=$(git -C "$1" rev-parse --absolute-git-dir 2>/dev/null) || exit 0; path="$git_dir/boxers/mutation.json"; [ -e "$path" ] || exit 0; if [ -n "$2" ] && ! printf "%s" "$2" | cmp -s - "$path"; then exit 3; fi; rm -f "$path"',
    "boxers-mutation-finish",
    runtime.workspacePath(task),
    marker ?? "",
  ];
}

function clearSandboxMarker(task: TaskManifest, marker?: string): boolean {
  return (
    runtimeForTask(task).execute(task, sandboxMarkerRemovalArguments(task, marker)).status === 0
  );
}

async function clearSandboxMarkerAsync(task: TaskManifest, marker?: string): Promise<boolean> {
  try {
    return (
      (await runtimeForTask(task).executeAsync(task, sandboxMarkerRemovalArguments(task, marker)))
        .status === 0
    );
  } catch {
    return false;
  }
}

/** Clear a crash-left companion only after the host marker proves its owner is dead. */
export function recoverTaskMutationBarrier(task: TaskManifest): boolean {
  const path = taskMutationBarrierPath(task.name);
  if (!existsSync(path)) return false;
  let pid: number;
  let marker: string;
  let canonical: string;
  try {
    marker = readFileSync(path, "utf8");
    const parsed = parseMutationMarker(marker);
    if (!parsed) return false;
    ({ pid, canonical } = parsed);
  } catch {
    return false;
  }
  if (ownerAlive(pid)) return false;
  if (!clearSandboxMarker(task, canonical)) return false;
  try {
    unlinkSync(path);
  } catch {
    // Another recovery boundary may have completed first.
  }
  return true;
}

/**
 * Publish the narrow cross-process input barrier used by the daemon. Nested
 * capture/reconciliation helpers share one marker and remove it in `finally`.
 */
export function withTaskMutationBarrier<T>(task: TaskManifest, action: () => T): T {
  const key = task.name.toLowerCase();
  const depth = depths.get(key) ?? 0;
  depths.set(key, depth + 1);
  const path = taskMutationBarrierPath(key);
  let marker: string | undefined;
  if (depth === 0) {
    const runId = randomUUID();
    runIds.set(key, runId);
    const value = {
      version: 1,
      task: task.name,
      runId,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    marker = `${JSON.stringify(value)}\n`;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // The Sandbox companion is compared byte-for-byte during cleanup. Publish
    // the same canonical bytes on both sides so crash recovery can prove that
    // it is removing the marker for this exact mutation run.
    atomicWriteText(path, marker);
    try {
      sandboxMarker(task, marker);
    } catch (error) {
      runIds.delete(key);
      try {
        unlinkSync(path);
      } catch {
        // Preserve the original marker-publication failure.
      }
      throw error;
    }
  } else {
    const runId = runIds.get(key);
    if (runId) {
      const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      marker = `${JSON.stringify(value)}\n`;
    }
  }
  try {
    return action();
  } finally {
    const remaining = (depths.get(key) ?? 1) - 1;
    if (remaining > 0) depths.set(key, remaining);
    else {
      depths.delete(key);
      runIds.delete(key);
      if (clearSandboxMarker(task, marker)) {
        try {
          unlinkSync(path);
        } catch {
          // Discard can remove task-owned state while unwinding.
        }
      }
    }
  }
}
