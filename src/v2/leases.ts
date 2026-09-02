import { existsSync, unlinkSync } from "node:fs";
import { readJson, taskIntentLeasePath } from "./paths.ts";
import type { RecordedTaskOperation, TaskOperationKind } from "./types.ts";

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Check a cross-process intent lease and recover it when its owner is gone. */
export function taskIntentLeaseActive(taskName: string): boolean {
  const path = taskIntentLeasePath(taskName);
  if (!existsSync(path)) return false;
  try {
    const lease = readJson<{ daemonPid: number; childPid?: number }>(path);
    if (processAlive(lease.childPid ?? lease.daemonPid)) return true;
  } catch {
    // Invalid and stale leases are recovered below.
  }
  try {
    unlinkSync(path);
  } catch {
    // A concurrent intent may have replaced it; the next check is conservative.
  }
  return false;
}

interface IntentLease {
  daemonPid: number;
  childPid?: number;
  kind?: TaskOperationKind;
  state?: "queued" | "running" | "cancelling";
  startedAt?: string;
  detail?: string;
  intentId?: string;
  operations?: RecordedTaskOperation[];
}

/** Return a live recorded operation, recovering dead-owner leases first. */
export function readTaskIntentOperation(taskName: string): RecordedTaskOperation | undefined {
  return readTaskIntentOperations(taskName)[0];
}

/** Return every live running or queued operation owned by the task lease. */
export function readTaskIntentOperations(taskName: string): RecordedTaskOperation[] {
  if (!taskIntentLeaseActive(taskName)) return [];
  try {
    const lease = readJson<IntentLease>(taskIntentLeasePath(taskName));
    if (Array.isArray(lease.operations)) return lease.operations;
    if (!lease.kind) return [];
    return [
      {
        kind: lease.kind,
        state: lease.state ?? "running",
        ...(lease.startedAt ? { startedAt: lease.startedAt } : {}),
        ...(lease.detail ? { detail: lease.detail } : {}),
        ...(lease.intentId ? { intentId: lease.intentId } : {}),
      },
    ];
  } catch {
    return [];
  }
}
