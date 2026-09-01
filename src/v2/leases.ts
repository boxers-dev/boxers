import { existsSync, unlinkSync } from "node:fs";
import { readJson, taskIntentLeasePath } from "./paths.ts";

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
