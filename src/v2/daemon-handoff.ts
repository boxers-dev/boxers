import { existsSync } from "node:fs";
import { atomicWriteJson, daemonHandoffPath, readJson } from "./paths.ts";
import type { RestartBlocker } from "./restart-boundary.ts";

export interface DaemonHandoffState {
  version: 1;
  desiredBuildId: string;
  status: "waiting" | "restarting" | "active" | "failed";
  blockers: RestartBlocker[];
  updatedAt: string;
  lastError?: string;
}

export function readDaemonHandoffState(): DaemonHandoffState | undefined {
  const path = daemonHandoffPath();
  if (!existsSync(path)) return undefined;
  try {
    const value = readJson<DaemonHandoffState>(path);
    if (
      value.version !== 1 ||
      !/^[a-f0-9]{64}$/.test(value.desiredBuildId) ||
      !["waiting", "restarting", "active", "failed"].includes(value.status) ||
      !Array.isArray(value.blockers) ||
      value.blockers.some(
        (blocker) =>
          !blocker ||
          ![
            "working",
            "unknown_activity",
            "active_intent",
            "background_work",
            "uncommitted_input",
            "lifecycle_failure",
            "superseded",
          ].includes(blocker.kind) ||
          typeof blocker.detail !== "string" ||
          (blocker.task !== undefined && typeof blocker.task !== "string"),
      ) ||
      !Number.isFinite(Date.parse(value.updatedAt))
    )
      return undefined;
    return value;
  } catch {
    return undefined;
  }
}

export function recordDaemonHandoff(
  desiredBuildId: string,
  status: DaemonHandoffState["status"],
  blockers: RestartBlocker[] = [],
  lastError?: string,
): DaemonHandoffState {
  const state: DaemonHandoffState = {
    version: 1,
    desiredBuildId,
    status,
    blockers,
    updatedAt: new Date().toISOString(),
    ...(lastError ? { lastError: lastError.slice(0, 2_000) } : {}),
  };
  atomicWriteJson(daemonHandoffPath(), state);
  return state;
}
