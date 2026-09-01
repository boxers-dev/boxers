import { humanTimestamp } from "../core/time.ts";
import { collectHostStatus, readHostStatus } from "./host-status.ts";
import { listRemoteMachines, queryRemoteMachine, type RemoteMachine } from "./machines.ts";
import { readCachedPeerView, writeCachedPeerView } from "./peer-cache-store.ts";
import { localMachineIdentity } from "./registry.ts";
import type { HostStatusObservation, MachineView } from "./types.ts";

export interface FleetHostStatusView {
  id: string;
  name: string;
  connection: "local" | MachineView["connection"];
  observedAt?: string;
  status?: HostStatusObservation;
  detail?: string;
}

function matches(machine: RemoteMachine, reference: string): boolean {
  const normalized = reference.toLowerCase();
  return (
    machine.id.toLowerCase() === normalized ||
    machine.name.toLowerCase() === normalized ||
    machine.sshHost.toLowerCase() === normalized
  );
}

export async function fleetHostStatusViews(options: {
  refresh: boolean;
  host?: string;
  all: boolean;
}): Promise<FleetHostStatusView[]> {
  const identity = localMachineIdentity();
  const localSelected =
    !options.host ||
    options.host.toLowerCase() === "local" ||
    options.host.toLowerCase() === identity.id.toLowerCase() ||
    options.host.toLowerCase() === identity.name.toLowerCase();
  const machines = listRemoteMachines().filter(
    (machine) => options.all || (!options.host ? false : matches(machine, options.host)),
  );
  if (options.host && !localSelected && !machines.length)
    throw new Error(`Unknown host "${options.host}".`);
  const views: FleetHostStatusView[] = [];
  if (localSelected) {
    const recorded = readHostStatus();
    const status = options.refresh || !recorded ? collectHostStatus() : recorded;
    views.push({
      id: identity.id,
      name: `${identity.name} (local)`,
      connection: "local",
      ...(status ? { status, observedAt: status.observedAt } : {}),
    });
  }
  const remotes = await Promise.all(
    machines.map(async (machine) => {
      const view = options.refresh
        ? writeCachedPeerView(machine, await queryRemoteMachine(machine, true))
        : readCachedPeerView(machine);
      return {
        id: machine.id,
        name: machine.name,
        connection: view.connection,
        ...(view.snapshot?.hostStatus
          ? { status: view.snapshot.hostStatus, observedAt: view.snapshot.hostStatus.observedAt }
          : view.snapshot
            ? { observedAt: view.snapshot.observedAt }
            : {}),
        ...(view.detail ? { detail: view.detail } : {}),
      } satisfies FleetHostStatusView;
    }),
  );
  views.push(...remotes);
  return views;
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? "").length)),
  );
  return `${rows
    .map((row) =>
      row
        .map((cell, column) =>
          column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0),
        )
        .join("  ")
        .trimEnd(),
    )
    .join("\n")}\n`;
}

export async function showFleetStatus(options: {
  refresh: boolean;
  host?: string;
  json: boolean;
}): Promise<number> {
  const views = await fleetHostStatusViews({
    refresh: options.refresh,
    ...(options.host ? { host: options.host } : {}),
    all: !options.host,
  });
  if (options.json) process.stdout.write(`${JSON.stringify({ hosts: views })}\n`);
  else {
    const rows = [
      [
        "HOST",
        "CONNECTION",
        "OBSERVED",
        "HEALTH",
        "VERSION",
        "DAEMON",
        "CODEX",
        "CLAUDE",
        "DETAIL",
      ],
    ];
    for (const view of views)
      rows.push([
        view.name,
        view.connection,
        view.observedAt ? humanTimestamp(view.observedAt) : "never",
        view.status?.health ?? "unknown",
        view.status?.boxersVersion ?? "unknown",
        view.status?.daemon ?? "unknown",
        view.status?.authentication.codex ?? "unknown",
        view.status?.authentication.claude ?? "unknown",
        view.detail?.replace(/\s+/g, " ") ?? "—",
      ]);
    process.stdout.write(table(rows));
  }
  return views.some(
    (view) =>
      view.status?.health === "unhealthy" ||
      ["authentication", "incompatible", "error"].includes(view.connection),
  )
    ? 1
    : 0;
}

export async function showAuthenticationStatus(options: {
  refresh: boolean;
  host?: string;
  all: boolean;
  json: boolean;
}): Promise<number> {
  const views = await fleetHostStatusViews(options);
  const result = views.map((view) => ({
    id: view.id,
    name: view.name,
    connection: view.connection,
    observedAt: view.observedAt,
    authentication: view.status?.authentication ?? { codex: "unknown", claude: "unknown" },
  }));
  if (options.json) process.stdout.write(`${JSON.stringify({ hosts: result })}\n`);
  else {
    const rows = [["HOST", "CONNECTION", "OBSERVED", "CODEX", "CLAUDE"]];
    for (const view of result)
      rows.push([
        view.name,
        view.connection,
        view.observedAt ? humanTimestamp(view.observedAt) : "never",
        view.authentication.codex,
        view.authentication.claude,
      ]);
    process.stdout.write(table(rows));
  }
  return result.some(
    (view) => view.authentication.codex === "missing" || view.authentication.claude === "missing",
  )
    ? 1
    : 0;
}
