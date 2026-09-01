import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { readPackageName, readVersion } from "../core/version.ts";
import {
  ensureFleet,
  enrollFleetMember,
  localFleetMember,
  localHostKey,
  mergeFleetSnapshot,
  readFleet,
  removeFleetMember,
  updateLocalFleetMember,
  validateFleetMember,
} from "./fleet.ts";
import { isMachineSetupComplete } from "./machine-setup.ts";
import { localMachineIdentity } from "./registry.ts";
import { listRemoteMachines, queryRemoteMachine, type RemoteMachine } from "./machines.ts";
import type { FleetMember, FleetRemoval, PeerRole } from "./types.ts";
import type { RuntimeDiagnostic } from "./runtime/types.ts";
import { installDaemonService } from "./service.ts";

const CONNECT_TIMEOUT_MS = 30_000;

function executablePath(value: string): string {
  return value.includes("/") ? resolve(value) : value;
}

export interface RemoteIdentity {
  protocolVersion: 1;
  machine: ReturnType<typeof localMachineIdentity>;
  publicKey: string;
  boxersVersion: string;
  executable: string;
  setupComplete: boolean;
  fleetId?: string;
  reverseCandidate?: string;
  diagnostics: RuntimeDiagnostic[];
}

function runSshCaptured(
  host: string,
  remoteArgs: readonly string[],
  input?: string,
  timeoutMs = CONNECT_TIMEOUT_MS,
  batchMode = false,
  streamStderr = false,
  description = "Remote operation",
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ssh",
      [
        ...(batchMode ? ["-o", "BatchMode=yes"] : []),
        "-o",
        "ConnectTimeout=8",
        "--",
        host,
        ...remoteArgs,
      ],
      { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(stdout);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`${description} on ${host} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => (stdout += chunk));
    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
      if (streamStderr) process.stderr.write(chunk);
    });
    child.on("error", (error) =>
      finish(new Error(`${description} on ${host} could not start SSH: ${error.message}`)),
    );
    child.on("close", (code) =>
      finish(
        code === 0
          ? undefined
          : new Error(
              `${description} on ${host} failed (exit ${code ?? 1})${
                (stderr || stdout).trim() ? `:\n${(stderr || stdout).trim()}` : "."
              }`,
            ),
      ),
    );
    if (input !== undefined) child.stdin!.end(input);
  });
}

function parseIdentity(text: string): RemoteIdentity {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Remote Boxers identity response was not valid JSON.");
  }
  const identity = value as Partial<RemoteIdentity>;
  if (
    identity.protocolVersion !== 1 ||
    !identity.machine ||
    typeof identity.machine.id !== "string" ||
    typeof identity.machine.name !== "string" ||
    typeof identity.publicKey !== "string" ||
    typeof identity.boxersVersion !== "string" ||
    typeof identity.executable !== "string" ||
    typeof identity.setupComplete !== "boolean" ||
    !/^[a-zA-Z0-9_./+-]+$/.test(identity.executable) ||
    !Array.isArray(identity.diagnostics)
  )
    throw new Error("Remote Boxers identity response was invalid.");
  return identity as RemoteIdentity;
}

function managedBootstrapScript(): string {
  const packageName = readPackageName();
  return [
    "set -eu",
    'version="$1"',
    'printf "Checking Node.js and npm on the remote machine...\\n" >&2',
    'command -v node >/dev/null 2>&1 || { printf "Node.js 20 or newer is required but node was not found.\\n" >&2; exit 1; }',
    'command -v npm >/dev/null 2>&1 || { printf "npm is required but was not found.\\n" >&2; exit 1; }',
    `node -e 'if (Number(process.versions.node.split(".")[0]) < 20) { console.error("Node.js 20 or newer is required; found " + process.version + "."); process.exit(1) }'`,
    'install_root="${XDG_DATA_HOME:-$HOME/.local/share}/boxers/managed/$version"',
    'mkdir -p "$install_root"',
    `printf "Installing ${packageName}@%s...\\n" "$version" >&2`,
    `npm install --no-audit --no-fund --omit=dev --prefix "$install_root" "${packageName}@$version" >&2`,
    'executable="$install_root/node_modules/.bin/boxers"',
    'test -x "$executable" || { printf "npm completed but did not create the Boxers executable at %s.\\n" "$executable" >&2; exit 1; }',
    'installed_version="$("$executable" --version)"',
    'test "$installed_version" = "$version" || { printf "Installed Boxers version %s, expected %s.\\n" "$installed_version" "$version" >&2; exit 1; }',
    'bin_dir="$HOME/.local/bin"',
    'mkdir -p "$bin_dir"',
    'temporary="$bin_dir/.boxers.$$.tmp"',
    "trap 'rm -f \"$temporary\"' EXIT",
    'ln -s "$executable" "$temporary"',
    'mv -f "$temporary" "$bin_dir/boxers"',
    "trap - EXIT",
    'printf "Installed Boxers %s at %s.\\n" "$version" "$bin_dir/boxers" >&2',
    'printf "Reading the remote Boxers identity...\\n" >&2',
    'BOXERS_EXECUTABLE="$bin_dir/boxers" exec "$bin_dir/boxers" remote identity',
    "",
  ].join("\n");
}

function runSshInteractive(host: string, remoteArgs: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", ["-t", "-o", "ConnectTimeout=8", "--", host, ...remoteArgs], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Remote interactive setup exited ${code ?? 1}.`));
    });
  });
}

async function ensureRemoteSetup(host: string, identity: RemoteIdentity): Promise<RemoteIdentity> {
  if (identity.setupComplete) return identity;
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      `The remote machine needs its one-time interactive setup. Run \`boxers connect ${host}\` from an interactive terminal.`,
    );
  process.stdout.write(`Starting one-time Boxers setup on ${host}.\n`);
  await runSshInteractive(host, [identity.executable, "init"]);
  const refreshed = parseIdentity(
    await runSshCaptured(host, [identity.executable, "remote", "identity"], undefined, 12_000),
  );
  if (!refreshed.setupComplete)
    throw new Error("Remote Boxers setup finished without recording successful initialization.");
  return refreshed;
}

async function discoverOrInstall(host: string, install: boolean): Promise<RemoteIdentity> {
  process.stdout.write(`Checking Boxers on ${host}...\n`);
  let installReason: string | undefined;
  try {
    const identity = parseIdentity(
      await runSshCaptured(host, ["boxers", "remote", "identity"], undefined, 12_000),
    );
    if (identity.boxersVersion === readVersion()) return identity;
    installReason = `remote version ${identity.boxersVersion} does not match local ${readVersion()}`;
  } catch (error) {
    installReason = error instanceof Error ? error.message : String(error);
  }
  if (!install)
    throw new Error(`Boxers is not available on ${host}: ${installReason ?? "unknown reason"}`);
  const version = readVersion();
  if (!/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version))
    throw new Error(`Cannot remotely install non-release Boxers version ${version}.`);
  process.stdout.write(
    `Remote Boxers installation is required: ${installReason ?? "not available"}.\n`,
  );
  const output = await runSshCaptured(
    host,
    ["sh", "-s", "--", version],
    managedBootstrapScript(),
    180_000,
    false,
    true,
    `Boxers ${version} installation`,
  );
  return parseIdentity(output);
}

export function remoteIdentity(): RemoteIdentity {
  const connection = process.env.SSH_CONNECTION?.trim().split(/\s+/);
  const fleet = readFleet();
  const reverseCandidate = connection?.[0];
  const setupComplete = isMachineSetupComplete();
  return {
    protocolVersion: 1,
    machine: localMachineIdentity(),
    publicKey: localHostKey().publicKey,
    boxersVersion: readVersion(),
    executable: executablePath(process.env.BOXERS_EXECUTABLE ?? process.argv[1] ?? "boxers"),
    setupComplete,
    ...(fleet ? { fleetId: fleet.fleetId } : {}),
    ...(reverseCandidate ? { reverseCandidate } : {}),
    // Identity discovery is part of bootstrapping and must stay fast. Live
    // runtime diagnostics can block while Docker Sandboxes is uninstalled or
    // unhealthy; the interactive machine setup performs those checks instead.
    diagnostics: [],
  };
}

interface EnrollmentPayload {
  fleetId: string;
  member: FleetMember;
  recipient?: FleetMember;
}

export function encodeEnrollment(payload: EnrollmentPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function acceptEnrollment(encoded: string): void {
  let payload: EnrollmentPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as EnrollmentPayload;
  } catch {
    throw new Error("Invalid fleet enrollment payload.");
  }
  if (
    !payload?.fleetId ||
    !payload.member?.hostId ||
    !payload.member.name ||
    !payload.member.publicKey ||
    !Array.isArray(payload.member.endpoints) ||
    !Array.isArray(payload.member.roles)
  )
    throw new Error("Invalid fleet enrollment payload.");
  validateFleetMember(payload.member);
  ensureFleet(payload.fleetId);
  if (payload.recipient) {
    validateFleetMember(payload.recipient);
    updateLocalFleetMember(payload.recipient);
  }
  enrollFleetMember(payload.fleetId, payload.member);
}

export interface FleetSyncPayload {
  version: 1;
  fleetId: string;
  members: FleetMember[];
  removedMembers: FleetRemoval[];
  sentAt: string;
}

export function currentFleetSyncPayload(): FleetSyncPayload | undefined {
  const fleet = readFleet();
  if (!fleet) return undefined;
  return {
    version: 1,
    fleetId: fleet.fleetId,
    members: fleet.members,
    removedMembers: fleet.removedMembers ?? [],
    sentAt: new Date().toISOString(),
  };
}

export function encodeFleetSync(payload: FleetSyncPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function parseFleetSync(value: string, encoded: boolean): FleetSyncPayload {
  let payload: FleetSyncPayload;
  try {
    payload = JSON.parse(
      encoded ? Buffer.from(value, "base64url").toString("utf8") : value,
    ) as FleetSyncPayload;
  } catch {
    throw new Error("Invalid fleet synchronization payload.");
  }
  if (
    payload?.version !== 1 ||
    !payload.fleetId ||
    !Array.isArray(payload.members) ||
    !Array.isArray(payload.removedMembers) ||
    !Number.isFinite(Date.parse(payload.sentAt))
  )
    throw new Error("Invalid fleet synchronization payload.");
  return payload;
}

export function acceptFleetSync(encoded: string): FleetSyncPayload {
  return acceptFleetSyncPayload(parseFleetSync(encoded, true));
}

function acceptFleetSyncPayload(payload: FleetSyncPayload): FleetSyncPayload {
  mergeFleetSnapshot(payload.fleetId, payload.members, payload.removedMembers);
  return currentFleetSyncPayload() as FleetSyncPayload;
}

export function acceptFleetSyncResponse(response: string): FleetSyncPayload {
  return acceptFleetSyncPayload(parseFleetSync(response, false));
}

export async function gossipFleetMembership(): Promise<{
  attempted: number;
  failures: { machine: RemoteMachine; detail: string }[];
}> {
  const payload = currentFleetSyncPayload();
  if (!payload) return { attempted: 0, failures: [] };
  const memberIds = new Set(payload.members.map((member) => member.hostId));
  const machines = listRemoteMachines().filter((machine) => memberIds.has(machine.id));
  const results = await Promise.all(
    machines.map(async (machine) => {
      try {
        await runSshCaptured(
          machine.sshHost,
          [machine.executable ?? "boxers", "remote", "sync-fleet", encodeFleetSync(payload)],
          undefined,
          CONNECT_TIMEOUT_MS,
          true,
        );
        return undefined;
      } catch (error) {
        return {
          machine,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  return {
    attempted: machines.length,
    failures: results.filter((result) => result !== undefined),
  };
}

export function acceptUnenrollment(reference: string): void {
  removeFleetMember(reference);
}

export async function verifyEnrolledPeer(reference: string): Promise<number> {
  const normalized = reference.toLowerCase();
  const machine = listRemoteMachines().find(
    (candidate) =>
      candidate.id.toLowerCase() === normalized || candidate.name.toLowerCase() === normalized,
  );
  if (!machine) throw new Error(`Unknown enrolled peer "${reference}".`);
  const view = await queryRemoteMachine(machine);
  process.stdout.write(`${JSON.stringify(view)}\n`);
  return view.connection === "online" ? 0 : 1;
}

export async function connectHost(
  options: {
    host: string;
    name?: string;
    reverseHost?: string;
    install: boolean;
    admin: boolean;
  },
  dependencies: {
    installService: typeof installDaemonService;
  } = { installService: installDaemonService },
): Promise<number> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._@:-]*$/.test(options.host))
    throw new Error("SSH host must be a non-option SSH host or config alias.");
  if (options.reverseHost && !/^[a-zA-Z0-9][a-zA-Z0-9._@:-]*$/.test(options.reverseHost))
    throw new Error("Reverse SSH host must be a non-option SSH host or config alias.");
  const localExecutableValue = process.env.BOXERS_EXECUTABLE ?? process.argv[1];
  const localExecutable = localExecutableValue ? executablePath(localExecutableValue) : undefined;
  let localServiceWarning: string | undefined;
  if (localExecutable && !localExecutable.endsWith(".ts")) {
    try {
      dependencies.installService(localExecutable);
    } catch (error) {
      localServiceWarning = error instanceof Error ? error.message : String(error);
    }
  }
  const remote = await ensureRemoteSetup(
    options.host,
    await discoverOrInstall(options.host, options.install),
  );
  const fleet = ensureFleet(remote.fleetId);
  const remoteRoles: PeerRole[] = options.admin ? ["observe", "operate", "admin"] : ["observe"];
  const remoteMember: FleetMember = {
    hostId: remote.machine.id,
    name: options.name ?? remote.machine.name,
    publicKey: remote.publicKey,
    endpoints: [{ transport: "ssh", target: options.host, executable: remote.executable }],
    roles: remoteRoles,
    enrolledAt: new Date().toISOString(),
  };
  const reverseTarget =
    options.reverseHost ??
    (remote.reverseCandidate ? `${userInfo().username}@${remote.reverseCandidate}` : undefined);
  if (!reverseTarget)
    throw new Error(
      "Could not infer how the remote host can connect back. Re-run with --reverse-host <ssh-target>.",
    );
  const localMember = localFleetMember(
    reverseTarget
      ? [
          {
            transport: "ssh",
            target: reverseTarget,
            executable: localExecutable ?? "boxers",
          },
        ]
      : [],
    fleet.members.find((member) => member.hostId === localMachineIdentity().id)?.roles ?? [
      "observe",
      "operate",
      "admin",
    ],
    new Date().toISOString(),
  );
  validateFleetMember(remoteMember);
  validateFleetMember(localMember);
  await runSshCaptured(options.host, [
    remote.executable,
    "remote",
    "enroll",
    encodeEnrollment({ fleetId: fleet.fleetId, member: localMember, recipient: remoteMember }),
  ]);
  const initialSync = currentFleetSyncPayload();
  const reciprocalFleet = initialSync
    ? await runSshCaptured(options.host, [
        remote.executable,
        "remote",
        "sync-fleet",
        encodeFleetSync(initialSync),
      ])
    : undefined;
  let serviceWarning: string | undefined;
  try {
    await runSshCaptured(options.host, [
      remote.executable,
      "remote",
      "verify-peer",
      localMachineIdentity().id,
    ]);
  } catch (error) {
    try {
      await runSshCaptured(options.host, [
        remote.executable,
        "remote",
        "unenroll",
        localMachineIdentity().id,
      ]);
    } catch {
      // Report the reciprocal verification failure; a repeated connect repairs enrollment.
    }
    throw new Error(
      `The remote host could not connect back through ${reverseTarget}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    await runSshCaptured(options.host, [
      remote.executable,
      "service",
      "install",
      "--executable",
      remote.executable,
    ]);
  } catch (error) {
    serviceWarning = error instanceof Error ? error.message : String(error);
  }
  if (reciprocalFleet) acceptFleetSyncResponse(reciprocalFleet);
  updateLocalFleetMember(localMember);
  enrollFleetMember(fleet.fleetId, remoteMember);
  const gossip = await gossipFleetMembership();
  for (const failure of gossip.failures)
    process.stderr.write(
      `warning: ${failure.machine.name} is enrolled but did not receive the latest fleet membership: ${failure.detail}\n`,
    );
  process.stdout.write(
    `Connected ${remoteMember.name} (${options.host}) to fleet ${fleet.fleetId} with verified reciprocal enrollment.\n`,
  );
  for (const diagnostic of remote.diagnostics)
    process.stdout.write(
      `${diagnostic.status === "ok" ? "ok" : diagnostic.status.toUpperCase()}  ${remoteMember.name} ${diagnostic.component}: ${diagnostic.detail}\n`,
    );
  if (serviceWarning)
    process.stderr.write(
      `warning: reciprocal enrollment succeeded, but the remote daemon service could not be installed: ${serviceWarning}\n`,
    );
  if (localServiceWarning)
    process.stderr.write(
      `warning: reciprocal enrollment succeeded, but the local daemon service could not be installed: ${localServiceWarning}\n`,
    );
  return serviceWarning ||
    localServiceWarning ||
    remote.diagnostics.some((diagnostic) => diagnostic.status === "failed")
    ? 1
    : 0;
}

export async function disconnectHost(reference: string): Promise<number> {
  const fleet = readFleet();
  const normalized = reference.toLowerCase();
  const member = fleet?.members.find(
    (candidate) =>
      candidate.hostId.toLowerCase() === normalized || candidate.name.toLowerCase() === normalized,
  );
  if (!member || member.hostId === localMachineIdentity().id)
    throw new Error(`Unknown fleet host "${reference}".`);
  const machine = listRemoteMachines().find((candidate) => candidate.id === member.hostId);
  let reciprocalWarning: string | undefined;
  if (machine) {
    try {
      await runSshCaptured(machine.sshHost, [
        machine.executable ?? "boxers",
        "remote",
        "unenroll",
        localMachineIdentity().id,
      ]);
    } catch (error) {
      reciprocalWarning = error instanceof Error ? error.message : String(error);
    }
  }
  removeFleetMember(member.hostId);
  const gossip = await gossipFleetMembership();
  process.stdout.write(`Disconnected ${member.name}.\n`);
  if (reciprocalWarning)
    process.stderr.write(
      `warning: local enrollment was removed, but ${member.name} could not be updated: ${reciprocalWarning}\n`,
    );
  for (const failure of gossip.failures)
    process.stderr.write(
      `warning: ${failure.machine.name} did not receive the fleet removal yet; daemon gossip will retry: ${failure.detail}\n`,
    );
  return 0;
}
