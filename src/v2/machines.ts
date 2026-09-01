import { spawn, spawnSync } from "node:child_process";
import { subscribeDaemonChanges } from "./daemon-client.ts";
import { localMachineIdentity } from "./registry.ts";
import { readFleet } from "./fleet.ts";
import type { MachineView, RemoteSnapshot } from "./types.ts";
import { captureStateProjection } from "./projection.ts";
import { isTaskState } from "./state.ts";
import { collectHostStatus, isHostStatusObservation, readHostStatus } from "./host-status.ts";
import { managedSshArgs } from "./ssh-transport.ts";
export type { MachineView } from "./types.ts";

const SNAPSHOT_TIMEOUT_MS = 10_000;
const WATCH_INTERVAL_MS = 2_000;

export interface RemoteMachine {
  id: string;
  name: string;
  sshHost: string;
  executable?: string;
}

export function listRemoteMachines(): RemoteMachine[] {
  const localId = localMachineIdentity().id;
  return (readFleet()?.members ?? []).flatMap((member) => {
    if (member.hostId === localId) return [];
    const endpoint = member.endpoints.find((candidate) => candidate.transport === "ssh");
    if (!endpoint) return [];
    return [
      {
        id: member.hostId,
        name: member.name,
        sshHost: endpoint.target,
        ...(endpoint.executable ? { executable: endpoint.executable } : {}),
      },
    ];
  });
}

export function parseRemoteSnapshot(text: string): RemoteSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Remote returned invalid JSON.");
  }
  const value = parsed;
  if (!value || typeof value !== "object")
    throw new Error("Remote returned a non-object snapshot.");
  const snapshot = value as Partial<RemoteSnapshot>;
  if (snapshot.protocolVersion !== 2)
    throw new Error(`Unsupported remote protocol version ${String(snapshot.protocolVersion)}.`);
  if (
    !snapshot.machine ||
    typeof snapshot.machine.id !== "string" ||
    typeof snapshot.machine.name !== "string" ||
    typeof snapshot.machine.boxersVersion !== "string" ||
    typeof snapshot.observedAt !== "string" ||
    !Array.isArray(snapshot.tasks)
  )
    throw new Error("Remote returned an invalid snapshot.");
  if (
    snapshot.projects !== undefined &&
    (!Array.isArray(snapshot.projects) ||
      snapshot.projects.some(
        (project) =>
          !project ||
          typeof project !== "object" ||
          typeof project.id !== "string" ||
          typeof project.name !== "string" ||
          typeof project.base !== "string" ||
          (project.integration !== "local" && project.integration !== "remote") ||
          (project.source !== undefined && typeof project.source !== "string"),
      ))
  )
    throw new Error("Remote returned an invalid project snapshot.");
  if (snapshot.hostStatus !== undefined && !isHostStatusObservation(snapshot.hostStatus))
    throw new Error("Remote returned an invalid host status observation.");
  const phases = new Set([
    "creating",
    "active",
    "working",
    "reconciling",
    "setting_up",
    "checking",
    "needs_input",
    "reviewed",
    "idle",
    "failed",
    "stopped",
    "awaiting_input",
    "settling",
    "queued",
    "refreshing",
    "capturing",
    "generating",
    "ready",
    "cancelled",
    "check_failed",
    "settlement_failed",
  ]);
  const activities = new Set(["not_started", "working", "awaiting_input", "exited", "unknown"]);
  for (const task of snapshot.tasks) {
    if (
      !task ||
      typeof task !== "object" ||
      typeof task.id !== "string" ||
      typeof task.projectId !== "string" ||
      typeof task.project !== "string" ||
      typeof task.name !== "string" ||
      (task.agent !== "codex" && task.agent !== "claude") ||
      (task.runtime !== undefined &&
        (!task.runtime ||
          typeof task.runtime !== "object" ||
          typeof task.runtime.kind !== "string" ||
          typeof task.runtime.id !== "string")) ||
      !phases.has(task.phase) ||
      !activities.has(task.activity) ||
      (task.runtimeState !== undefined && typeof task.runtimeState !== "string") ||
      (task.summary !== undefined && typeof task.summary !== "string") ||
      (task.needsAttention !== undefined && typeof task.needsAttention !== "boolean") ||
      (task.hasUnmergedChanges !== undefined && typeof task.hasUnmergedChanges !== "boolean") ||
      (task.stateObservedAt !== undefined && typeof task.stateObservedAt !== "string") ||
      (task.runtimeObservedAt !== undefined && typeof task.runtimeObservedAt !== "string") ||
      (task.activityObservedAt !== undefined && typeof task.activityObservedAt !== "string") ||
      (task.workspaceObservedAt !== undefined && typeof task.workspaceObservedAt !== "string") ||
      (task.lastDelivery !== undefined &&
        (!task.lastDelivery ||
          typeof task.lastDelivery !== "object" ||
          typeof task.lastDelivery.ref !== "string" ||
          typeof task.lastDelivery.oid !== "string" ||
          typeof task.lastDelivery.subject !== "string")) ||
      (task.state !== undefined && !isTaskState(task.state, task.id))
    )
      throw new Error("Remote returned an invalid task snapshot.");
  }
  return snapshot as RemoteSnapshot;
}

export function remoteArgs(
  machine: RemoteMachine,
  command: "snapshot" | "watch",
  refreshStatus = false,
  acceptNewHostKey = false,
): string[] {
  return managedSshArgs(
    machine.sshHost,
    ["remote", command, ...(command === "snapshot" && refreshStatus ? ["--refresh-status"] : [])],
    { connectTimeout: 5, acceptNewHostKey },
  );
}

function authenticationHelp(detail: string, host: string): string {
  if (!/permission denied|authentication failed/i.test(detail)) return detail;
  return `${detail}\nThe managed Boxers SSH authorization is missing or invalid. Re-run \`boxers connect ${host} --reverse-host <this-host-as-seen-by-${host}>\` to repair reciprocal access.`;
}

function runCaptured(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`Command timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(stdout);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => finish(error));
    child.on("close", (code) =>
      finish(
        code === 0
          ? undefined
          : new Error((stderr || stdout).trim() || `Command exited with status ${code ?? 1}.`),
      ),
    );
  });
}

export async function queryRemoteMachine(
  machine: RemoteMachine,
  refreshStatus = false,
  acceptNewHostKey = false,
): Promise<MachineView> {
  try {
    const output = await runCaptured(
      "ssh",
      remoteArgs(machine, "snapshot", refreshStatus, acceptNewHostKey),
      refreshStatus ? 30_000 : SNAPSHOT_TIMEOUT_MS,
    );
    const snapshot = parseRemoteSnapshot(output);
    return { id: machine.id, name: machine.name, connection: "online", snapshot };
  } catch (error) {
    const detail = authenticationHelp(
      error instanceof Error ? error.message : String(error),
      machine.sshHost,
    );
    const incompatible = detail.startsWith("Unsupported remote protocol version");
    const authentication = /permission denied|authentication failed/i.test(detail);
    const offline = /timed out|connection|no route|resolve hostname|host is down/i.test(detail);
    return {
      id: machine.id,
      name: machine.name,
      connection: incompatible
        ? "incompatible"
        : authentication
          ? "authentication"
          : offline
            ? "offline"
            : "error",
      detail,
    };
  }
}

export function formatMachineViews(views: readonly MachineView[], groupByProject = false): string {
  const rows: string[][] = [
    [
      "MACHINE",
      "CONNECTION",
      "PROJECT",
      "TASK",
      "AGENT",
      "NEEDS_ATTENTION",
      "UNMERGED_CHANGES",
      "PREVIEW",
      "DETAIL",
    ],
  ];
  for (const view of views) {
    if ((view.connection !== "online" && view.connection !== "stale") || !view.snapshot) {
      rows.push([
        view.name,
        view.connection,
        "—",
        "—",
        "—",
        "—",
        "—",
        "—",
        view.detail?.replace(/\s+/g, " ") ?? "—",
      ]);
      continue;
    }
    if (!view.snapshot.tasks.length) {
      rows.push([view.name, view.connection, "—", "—", "—", "—", "—", "—", view.detail ?? "—"]);
      continue;
    }
    for (const [index, task] of view.snapshot.tasks.entries()) {
      const project = view.snapshot.projects?.find((candidate) => candidate.id === task.projectId);
      const sourceParts = project?.source?.split("/").filter(Boolean);
      const logicalProject =
        sourceParts && sourceParts.length >= 2 ? sourceParts.slice(1).join("/") : task.project;
      const deliveryDetail =
        task.hasUnmergedChanges === false && task.lastDelivery
          ? `Last commit on ${project?.base ?? task.lastDelivery.ref}; no other changes by this task`
          : "";
      const summary = task.summary === task.lastDelivery?.subject ? "" : (task.summary ?? "");
      const detail = `${summary}${deliveryDetail ? `${summary ? " — " : ""}${deliveryDetail}` : ""}`;
      rows.push([
        groupByProject || !index ? view.name : "",
        groupByProject || !index ? view.connection : "",
        logicalProject,
        task.name,
        task.agent,
        (task.needsAttention ?? task.activity === "awaiting_input") ? "yes" : "no",
        task.hasUnmergedChanges === undefined ? "unknown" : task.hasUnmergedChanges ? "yes" : "no",
        task.preview?.urls?.[0] ?? task.preview?.state ?? "—",
        `${detail}${!index && view.connection === "stale" && view.detail ? `${detail ? " — " : ""}${view.detail}` : ""}`,
      ]);
    }
  }
  if (groupByProject)
    rows.splice(
      1,
      rows.length - 1,
      ...rows
        .slice(1)
        .sort(
          (left, right) =>
            (left[2] ?? "").localeCompare(right[2] ?? "") ||
            (left[0] ?? "").localeCompare(right[0] ?? "") ||
            (left[3] ?? "").localeCompare(right[3] ?? ""),
        ),
    );
  const widths = rows[0]!.map((_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? "").length)),
  );
  return `${rows
    .map((row) =>
      row
        .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]!)))
        .join("  ")
        .trimEnd(),
    )
    .join("\n")}\n`;
}

export function runRemoteTaskCommand(
  reference: string,
  task: string,
  args: readonly string[],
  tty = true,
): number {
  return runRemoteCommand(reference, [task, ...args], tty);
}

export function runRemoteCommand(reference: string, args: readonly string[], tty = true): number {
  const normalized = reference.toLowerCase();
  const matches = listRemoteMachines().filter(
    (machine) =>
      machine.id.toLowerCase() === normalized ||
      machine.name.toLowerCase() === normalized ||
      machine.sshHost.toLowerCase() === normalized,
  );
  if (!matches.length) throw new Error(`Unknown machine "${reference}".`);
  if (matches.length > 1) throw new Error(`Machine reference "${reference}" is ambiguous.`);
  const machine = matches[0]!;
  return (
    spawnSync("ssh", managedSshArgs(machine.sshHost, args, { tty }), {
      stdio: "inherit",
    }).status ?? 1
  );
}

export async function remoteSnapshot(refreshStatus = false): Promise<number> {
  if (refreshStatus || !readHostStatus()) collectHostStatus();
  process.stdout.write(`${JSON.stringify(captureStateProjection())}\n`);
  return 0;
}

export async function remoteWatch(intervalMs = WATCH_INTERVAL_MS): Promise<number> {
  const heartbeatMs = Math.max(intervalMs, 20_000);
  await subscribeDaemonChanges(
    () => process.stdout.write(`${JSON.stringify({ protocolVersion: 1, type: "ready" })}\n`),
    () => process.stdout.write(`${JSON.stringify({ protocolVersion: 1, type: "changed" })}\n`),
  );
  const heartbeat = setInterval(
    () => process.stdout.write(`${JSON.stringify({ protocolVersion: 1, type: "heartbeat" })}\n`),
    heartbeatMs,
  );
  heartbeat.unref();
  return await new Promise<number>(() => undefined);
}
