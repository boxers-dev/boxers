import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { readVersion } from "../core/version.ts";
import {
  ensureFleet,
  enrollFleetMember,
  localFleetMember,
  localHostKey,
  mergeFleetSnapshot,
  readFleet,
  renameLocalFleetMember,
  removeFleetMember,
  updateLocalFleetMember,
  validateFleetMember,
} from "./fleet.ts";
import { isMachineSetupComplete } from "./machine-setup.ts";
import { localMachineIdentity } from "./registry.ts";
import { listRemoteMachines, queryRemoteMachine, type RemoteMachine } from "./machines.ts";
import type { FleetMember, FleetRemoval, PeerRole } from "./types.ts";
import {
  mergeFleetUpdateState,
  createFleetReleaseIntent,
  acknowledgeFleetRelease,
  readFleetUpdateState,
  type FleetUpdateState,
} from "./fleet-update.ts";
import type { RuntimeDiagnostic } from "./runtime/types.ts";
import { activateHostRelease } from "./host-release.ts";
import { activeReleaseBuildId, createReleaseCapsule, decodeReleaseCapsule } from "./release.ts";
import {
  confirmFleetDowngrade,
  newerRelease,
  sendFleetReleaseWithBootstrap,
} from "./fleet-release.ts";
import { bootstrapHostRelease } from "./release-bootstrap.ts";
import {
  authorizeManagedPeer,
  encodePeerAuthorization,
  ensureManagedSshIdentity,
  reconcileManagedPeerAuthorizations,
  revokeManagedPeer,
} from "./ssh-identity.ts";
import { captureSsh } from "./ssh-transport.ts";

const CONNECT_TIMEOUT_MS = 30_000;

function executablePath(value: string): string {
  return value.includes("/") ? resolve(value) : value;
}

export interface RemoteIdentity {
  protocolVersion: 1;
  machine: ReturnType<typeof localMachineIdentity>;
  publicKey: string;
  boxersVersion: string;
  buildId?: string | undefined;
  executable: string;
  setupComplete: boolean;
  fleetId?: string;
  reverseCandidate?: string;
  diagnostics: RuntimeDiagnostic[];
}

function runSshCaptured(
  host: string,
  args: readonly string[],
  input?: string,
  timeout = CONNECT_TIMEOUT_MS,
): Promise<string> {
  return captureSsh(host, args, {
    managed: false,
    timeout,
    ...(input === undefined ? {} : { input }),
  });
}

function runManagedSshCaptured(
  host: string,
  args: readonly string[],
  timeout = CONNECT_TIMEOUT_MS,
): Promise<string> {
  return captureSsh(host, args, { timeout, description: "Managed remote operation" });
}

function parseManagedSshIdentity(text: string): { publicKey: string; fingerprint: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Remote managed SSH identity response was not valid JSON.");
  }
  const identity = value as { version?: unknown; publicKey?: unknown; fingerprint?: unknown };
  if (
    identity.version !== 1 ||
    typeof identity.publicKey !== "string" ||
    typeof identity.fingerprint !== "string"
  )
    throw new Error("Remote managed SSH identity response was invalid.");
  return { publicKey: identity.publicKey, fingerprint: identity.fingerprint };
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

async function discoverOrInstall(
  host: string,
  install: boolean,
  capsule: Buffer,
): Promise<{ identity: RemoteIdentity; allowDowngrade: boolean }> {
  const expected = decodeReleaseCapsule(capsule).manifest;
  process.stdout.write(`Checking Boxers on ${host}...\n`);
  let identity: RemoteIdentity | undefined;
  let reason: string;
  try {
    identity = parseIdentity(
      await runSshCaptured(host, ["boxers", "remote", "identity"], undefined, 12_000),
    );
    reason = `remote build ${identity.buildId ?? "unknown"} does not match ${expected.buildId}`;
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  if (!install) {
    if (identity?.buildId === expected.buildId) return { identity, allowDowngrade: false };
    throw new Error(
      `Boxers is not compatible on ${host}: ${reason}. Re-run without --no-install to align the exact build.`,
    );
  }
  let allowDowngrade = false;
  if (identity && newerRelease(identity.boxersVersion, expected.packageVersion)) {
    allowDowngrade = await confirmFleetDowngrade(expected.packageVersion, [
      {
        machine: { id: identity.machine.id, name: identity.machine.name, sshHost: host },
        version: identity.boxersVersion,
      },
    ]);
    if (!allowDowngrade)
      throw new Error("Connection cancelled because it would downgrade the remote Boxers release.");
  }
  // Re-activate even an identical build to repair its launcher and daemon.
  process.stdout.write(
    `Aligning Boxers ${expected.packageVersion} (${expected.buildId.slice(0, 8)}) on ${host}...\n`,
  );
  const installed = parseIdentity(await bootstrapHostRelease(host, capsule));
  if (installed.buildId !== expected.buildId || installed.boxersVersion !== expected.packageVersion)
    throw new Error("Remote Boxers activation did not confirm the requested build.");
  return { identity: installed, allowDowngrade };
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
    buildId: activeReleaseBuildId(),
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
  update?: FleetUpdateState | undefined;
  sentAt: string;
}

export function currentFleetSyncPayload(): FleetSyncPayload | undefined {
  const fleet = readFleet();
  if (!fleet) return undefined;
  const update = readFleetUpdateState();
  return {
    version: 1,
    fleetId: fleet.fleetId,
    members: fleet.members,
    removedMembers: fleet.removedMembers ?? [],
    ...(update.desired ? { update } : {}),
    sentAt: new Date().toISOString(),
  };
}

export function renameLocalHost(name: string): FleetSyncPayload {
  renameLocalFleetMember(name);
  return currentFleetSyncPayload() as FleetSyncPayload;
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
  mergeFleetUpdateState(payload.update);
  const current = currentFleetSyncPayload() as FleetSyncPayload;
  reconcileManagedPeerAuthorizations(current.members, current.removedMembers);
  return current;
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
        const response = await runManagedSshCaptured(
          machine.sshHost,
          ["remote", "sync-fleet", encodeFleetSync(payload)],
          CONNECT_TIMEOUT_MS,
        );
        if (response.trim()) acceptFleetSyncResponse(response);
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
  const member = readFleet()?.members.find(
    (candidate) =>
      candidate.hostId.toLowerCase() === reference.toLowerCase() ||
      candidate.name.toLowerCase() === reference.toLowerCase(),
  );
  if (member) revokeManagedPeer(member.hostId);
  removeFleetMember(reference);
}

export async function verifyEnrolledPeer(
  reference: string,
  acceptNewHostKey = false,
): Promise<number> {
  const normalized = reference.toLowerCase();
  const machine = listRemoteMachines().find(
    (candidate) =>
      candidate.id.toLowerCase() === normalized || candidate.name.toLowerCase() === normalized,
  );
  if (!machine) throw new Error(`Unknown enrolled peer "${reference}".`);
  const view = await queryRemoteMachine(machine, false, acceptNewHostKey);
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
    activateRelease: typeof activateHostRelease;
    createCapsule: typeof createReleaseCapsule;
  } = { activateRelease: activateHostRelease, createCapsule: createReleaseCapsule },
): Promise<number> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._@:-]*$/.test(options.host))
    throw new Error("SSH host must be a non-option SSH host or config alias.");
  if (options.reverseHost && !/^[a-zA-Z0-9][a-zA-Z0-9._@:-]*$/.test(options.reverseHost))
    throw new Error("Reverse SSH host must be a non-option SSH host or config alias.");
  const capsule = dependencies.createCapsule();
  const local = await dependencies.activateRelease(capsule);
  const localExecutable = local.stableExecutable;
  const discovered = await discoverOrInstall(options.host, options.install, capsule);
  const remote = await ensureRemoteSetup(options.host, discovered.identity);
  const localSsh = ensureManagedSshIdentity();
  const remoteSsh = parseManagedSshIdentity(
    await runSshCaptured(options.host, [remote.executable, "remote", "ssh-identity"]),
  );
  const fleet = ensureFleet(remote.fleetId);
  const remoteRoles: PeerRole[] = options.admin ? ["observe", "operate", "admin"] : ["observe"];
  const remoteMember: FleetMember = {
    hostId: remote.machine.id,
    name: options.name ?? remote.machine.name,
    publicKey: remote.publicKey,
    ssh: { version: 1, publicKey: remoteSsh.publicKey, fingerprint: remoteSsh.fingerprint },
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
  const previouslyEnrolled = fleet.members.some((member) => member.hostId === remoteMember.hostId);
  let reciprocalFleet: string | undefined;
  try {
    await runSshCaptured(options.host, [
      remote.executable,
      "remote",
      "authorize-peer",
      encodePeerAuthorization(localMachineIdentity().id, localSsh.publicKey),
    ]);
    authorizeManagedPeer(remoteMember.hostId, remoteSsh.publicKey, localExecutable ?? "boxers");
    await runSshCaptured(options.host, [
      remote.executable,
      "remote",
      "enroll",
      encodeEnrollment({ fleetId: fleet.fleetId, member: localMember, recipient: remoteMember }),
    ]);
    enrollFleetMember(fleet.fleetId, remoteMember);
    const initialSync = currentFleetSyncPayload();
    reciprocalFleet = initialSync
      ? await runManagedSshCaptured(
          options.host,
          ["remote", "sync-fleet", encodeFleetSync(initialSync)],
          CONNECT_TIMEOUT_MS,
        )
      : undefined;
    // Learn any pending generation before publishing the selected build. Otherwise
    // a reconnect can immediately roll back to the fleet's previous desired build.
    if (reciprocalFleet) acceptFleetSyncResponse(reciprocalFleet);
    createFleetReleaseIntent(local.manifest, discovered.allowDowngrade);
    const releaseState = acknowledgeFleetRelease();
    await sendFleetReleaseWithBootstrap(
      {
        id: remoteMember.hostId,
        name: remoteMember.name,
        sshHost: options.host,
        executable: remote.executable,
      },
      releaseState,
      capsule,
    );
    await runManagedSshCaptured(
      options.host,
      ["remote", "verify-peer", localMachineIdentity().id, "--accept-new-host-key"],
      CONNECT_TIMEOUT_MS,
    );
    updateLocalFleetMember(localMember);
  } catch (error) {
    if (!previouslyEnrolled) {
      try {
        await runSshCaptured(options.host, [
          remote.executable,
          "remote",
          "unenroll",
          localMachineIdentity().id,
        ]);
      } catch {
        // The peer may not have reached the enrollment stage.
      }
      try {
        await runSshCaptured(options.host, [
          remote.executable,
          "remote",
          "revoke-peer",
          localMachineIdentity().id,
        ]);
      } catch {
        // Preserve the primary enrollment failure below.
      }
      revokeManagedPeer(remoteMember.hostId);
      removeFleetMember(remoteMember.hostId);
    }
    throw new Error(
      `Could not establish managed reciprocal SSH between ${options.host} and ${reverseTarget}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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
  return remote.diagnostics.some((diagnostic) => diagnostic.status === "failed") ? 1 : 0;
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
      await runManagedSshCaptured(machine.sshHost, [
        "remote",
        "unenroll",
        localMachineIdentity().id,
      ]);
    } catch (error) {
      reciprocalWarning = error instanceof Error ? error.message : String(error);
    }
  }
  revokeManagedPeer(member.hostId);
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

export async function renameHost(reference: string, name: string): Promise<number> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name))
    throw new Error("Machine names may contain letters, numbers, dots, underscores, and hyphens.");
  const fleet = readFleet();
  if (!fleet) throw new Error("This host is not enrolled in a Boxers fleet.");
  const normalized = reference.toLowerCase();
  const localId = localMachineIdentity().id;
  const matches = fleet.members.filter(
    (candidate) =>
      (normalized === "local" && candidate.hostId === localId) ||
      candidate.hostId.toLowerCase() === normalized ||
      candidate.name.toLowerCase() === normalized ||
      candidate.endpoints.some((endpoint) => endpoint.target.toLowerCase() === normalized),
  );
  if (!matches.length) throw new Error(`Unknown fleet host "${reference}".`);
  if (matches.length > 1) throw new Error(`Fleet host reference "${reference}" is ambiguous.`);
  const member = matches[0]!;
  const collision = fleet.members.find(
    (candidate) =>
      candidate.hostId !== member.hostId && candidate.name.toLowerCase() === name.toLowerCase(),
  );
  if (collision) throw new Error(`Fleet host name "${name}" is already in use.`);

  if (member.hostId === localId) {
    renameLocalHost(name);
  } else {
    const machine = listRemoteMachines().find((candidate) => candidate.id === member.hostId);
    if (!machine) throw new Error(`Fleet host "${reference}" has no SSH endpoint.`);
    const response = await runManagedSshCaptured(machine.sshHost, ["remote", "rename-host", name]);
    acceptFleetSyncResponse(response);
  }

  const renamed = readFleet()?.members.find((candidate) => candidate.hostId === member.hostId);
  if (renamed?.name !== name)
    throw new Error(`Fleet host "${reference}" did not confirm its new name.`);
  const gossip = await gossipFleetMembership();
  process.stdout.write(`Renamed ${member.name} to ${name}.\n`);
  for (const failure of gossip.failures)
    process.stderr.write(
      `warning: ${failure.machine.name} did not receive the renamed fleet member yet; daemon gossip will retry: ${failure.detail}\n`,
    );
  return 0;
}
