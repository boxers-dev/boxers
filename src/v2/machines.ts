import { spawn, spawnSync } from "node:child_process";
import { subscribeDaemonChanges } from "./daemon-client.ts";
import { localMachineIdentity } from "./registry.ts";
import { readFleet } from "./fleet.ts";
import type { MachineView, RemoteSnapshot } from "./types.ts";
import { captureStateProjection } from "./projection.ts";
import { isTaskState } from "./state.ts";
import { isTaskView } from "./task-view.ts";
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
  if (snapshot.protocolVersion !== 3)
    throw new Error(
      `Unsupported remote task-view protocol version ${String(snapshot.protocolVersion)}; upgrade both Boxers hosts.`,
    );
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
  if (
    snapshot.boxersUpdate !== undefined &&
    (typeof snapshot.boxersUpdate.desiredBuildId !== "string" ||
      typeof snapshot.boxersUpdate.desiredVersion !== "string" ||
      !["current", "pending", "failed"].includes(snapshot.boxersUpdate.status) ||
      (snapshot.boxersUpdate.detail !== undefined &&
        typeof snapshot.boxersUpdate.detail !== "string"))
  )
    throw new Error("Remote returned an invalid Boxers update observation.");
  for (const task of snapshot.tasks) {
    if (
      !task ||
      typeof task !== "object" ||
      Object.keys(task).some(
        (key) =>
          ![
            "id",
            "projectId",
            "project",
            "name",
            "agent",
            "runtime",
            "view",
            "runtimeState",
            "stateObservedAt",
            "runtimeObservedAt",
            "activityObservedAt",
            "workspaceObservedAt",
            "internal",
          ].includes(key),
      ) ||
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
      !isTaskView(task.view) ||
      (task.runtimeState !== undefined && typeof task.runtimeState !== "string") ||
      (task.stateObservedAt !== undefined && typeof task.stateObservedAt !== "string") ||
      (task.runtimeObservedAt !== undefined && typeof task.runtimeObservedAt !== "string") ||
      (task.activityObservedAt !== undefined && typeof task.activityObservedAt !== "string") ||
      (task.workspaceObservedAt !== undefined && typeof task.workspaceObservedAt !== "string") ||
      (task.internal !== undefined &&
        (!task.internal ||
          typeof task.internal !== "object" ||
          !isTaskState(task.internal.state, task.id)))
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
    const incompatible = detail.startsWith("Unsupported remote task-view protocol version");
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
      "CHANGES",
      "CHECKS",
      "NEXT",
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
        "—",
        view.detail?.replace(/\s+/g, " ") ?? "—",
      ]);
      continue;
    }
    if (!view.snapshot.tasks.length) {
      rows.push([
        view.name,
        view.connection,
        "—",
        "—",
        "—",
        "—",
        "—",
        "—",
        "—",
        view.detail ?? "—",
      ]);
      continue;
    }
    for (const [index, task] of view.snapshot.tasks.entries()) {
      const project = view.snapshot.projects?.find((candidate) => candidate.id === task.projectId);
      const sourceParts = project?.source?.split("/").filter(Boolean);
      const logicalProject =
        sourceParts && sourceParts.length >= 2 ? sourceParts.slice(1).join("/") : task.project;
      const detail = task.view.issues[0]?.message ?? task.view.operations[0]?.detail ?? "";
      rows.push([
        groupByProject || !index ? view.name : "",
        groupByProject || !index ? view.connection : "",
        logicalProject,
        task.name,
        task.view.agent.label,
        task.view.changes.state === "unmerged"
          ? "Unmerged"
          : task.view.changes.state === "none"
            ? "None"
            : task.view.changes.state === "conflicted"
              ? "Conflicted"
              : task.view.changes.state === "unknown"
                ? "Unknown"
                : "Working",
        task.view.checks.state.startsWith("awaiting_")
          ? "Waiting"
          : task.view.checks.state === "not_configured"
            ? "None"
            : task.view.checks.state.replace(/^./, (letter) => letter.toUpperCase()),
        task.view.actions[0]?.kind ?? "—",
        task.view.preview?.urls?.[0] ?? task.view.preview?.state ?? "—",
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
    { authoritativeOnly: true },
  );
  const heartbeat = setInterval(
    () => process.stdout.write(`${JSON.stringify({ protocolVersion: 1, type: "heartbeat" })}\n`),
    heartbeatMs,
  );
  heartbeat.unref();
  return await new Promise<number>(() => undefined);
}
