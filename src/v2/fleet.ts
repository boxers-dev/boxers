import { generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import {
  atomicWriteJson,
  fleetLockPath,
  fleetPath,
  hostKeyLockPath,
  hostKeyPath,
  readJson,
} from "./paths.ts";
import { withPidFileLock } from "./lock.ts";
import { localMachineIdentity, renameLocalMachine } from "./registry.ts";
import { notifyDaemonStateChanged } from "./daemon-client.ts";
import type { FleetManifest, FleetMember, FleetRemoval, PeerRole } from "./types.ts";
import {
  canonicalSshPublicKey,
  ensureManagedSshIdentity,
  sshPublicKeyFingerprint,
} from "./ssh-identity.ts";

interface HostKey {
  version: 1;
  publicKey: string;
  privateKey: string;
  createdAt: string;
}

function readHostKey(path: string): HostKey {
  const key = readJson<HostKey>(path);
  if (key.version !== 1 || !key.publicKey || !key.privateKey)
    throw new Error(`Invalid Boxers host key at ${path}.`);
  return key;
}

export function localHostKey(): HostKey {
  const path = hostKeyPath();
  if (existsSync(path)) return readHostKey(path);
  return withPidFileLock(hostKeyLockPath(), () => {
    if (existsSync(path)) return readHostKey(path);
    const pair = generateKeyPairSync("ed25519");
    const key: HostKey = {
      version: 1,
      publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
      privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      createdAt: new Date().toISOString(),
    };
    atomicWriteJson(path, key);
    return key;
  });
}

export function localFleetMember(
  endpoints: FleetMember["endpoints"] = [],
  roles: PeerRole[] = ["observe", "operate", "admin"],
  enrolledAt?: string,
): FleetMember {
  const identity = localMachineIdentity();
  const ssh = ensureManagedSshIdentity();
  return {
    hostId: identity.id,
    name: identity.name,
    publicKey: localHostKey().publicKey,
    ssh: { version: 1, publicKey: ssh.publicKey, fingerprint: ssh.fingerprint },
    endpoints,
    roles,
    enrolledAt: enrolledAt ?? identity.createdAt,
  };
}

function timestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${label} timestamp.`);
  return parsed;
}

export function validateFleetMember(member: FleetMember, allowLegacySsh = false): void {
  if (!member || typeof member !== "object" || !member.hostId)
    throw new Error("Invalid fleet member host ID.");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(member.name))
    throw new Error(
      "Fleet member names may contain letters, numbers, dots, underscores, and hyphens.",
    );
  if (
    !member.publicKey ||
    (!allowLegacySsh && member.ssh?.version !== 1) ||
    (member.ssh !== undefined &&
      (member.ssh.version !== 1 ||
        typeof member.ssh.publicKey !== "string" ||
        typeof member.ssh.fingerprint !== "string")) ||
    !Array.isArray(member.endpoints) ||
    !Array.isArray(member.roles)
  )
    throw new Error("Invalid fleet member identity.");
  if (member.ssh) {
    const sshPublicKey = canonicalSshPublicKey(member.ssh.publicKey, `boxers:${member.hostId}`);
    if (
      member.ssh.publicKey !== sshPublicKey ||
      member.ssh.fingerprint !== sshPublicKeyFingerprint(sshPublicKey)
    )
      throw new Error("Invalid fleet member managed SSH identity.");
  }
  timestamp(member.enrolledAt, "fleet enrollment");
  if (member.roles.some((role) => role !== "observe" && role !== "operate" && role !== "admin"))
    throw new Error("Invalid fleet member role.");
  for (const endpoint of member.endpoints) {
    if (endpoint?.transport !== "ssh" || !/^[a-zA-Z0-9][a-zA-Z0-9._@:-]*$/.test(endpoint.target))
      throw new Error("Fleet SSH endpoints must be non-option SSH hosts or config aliases.");
    if (endpoint.executable !== undefined && !/^[a-zA-Z0-9_./+-]+$/.test(endpoint.executable))
      throw new Error("Fleet executables must be paths without spaces or shell syntax.");
  }
}

function validateRemoval(removal: FleetRemoval): void {
  if (!removal || typeof removal.hostId !== "string" || !removal.hostId)
    throw new Error("Invalid fleet removal host ID.");
  timestamp(removal.removedAt, "fleet removal");
}

function newestMember(left: FleetMember, right: FleetMember): FleetMember {
  const leftTime = timestamp(left.enrolledAt, "fleet enrollment");
  const rightTime = timestamp(right.enrolledAt, "fleet enrollment");
  let newest: FleetMember;
  // A managed identity upgrades the otherwise same legacy enrollment record.
  // Prefer it even when an older Boxers version rewrote that record later.
  if (Boolean(left.ssh) !== Boolean(right.ssh)) newest = right.ssh ? right : left;
  else if (rightTime !== leftTime) newest = rightTime > leftTime ? right : left;
  // Equal timestamps should normally be the same enrollment payload. A stable
  // tie-break keeps independently received snapshots convergent if they are not.
  else newest = JSON.stringify(right) > JSON.stringify(left) ? right : left;
  const older = newest === right ? left : right;
  const endpointKeys = new Set(
    newest.endpoints.map((endpoint) => `${endpoint.transport}\0${endpoint.target}`),
  );
  return {
    ...newest,
    endpoints: [
      ...newest.endpoints,
      ...older.endpoints.filter(
        (endpoint) => !endpointKeys.has(`${endpoint.transport}\0${endpoint.target}`),
      ),
    ],
  };
}

function mergeFleetUnlocked(
  fleet: FleetManifest,
  incomingMembers: readonly FleetMember[],
  incomingRemovals: readonly FleetRemoval[],
  preserveLocalMember: boolean,
): FleetManifest {
  const localId = localMachineIdentity().id;
  const members = new Map(fleet.members.map((member) => [member.hostId, member]));
  const removals = new Map(
    (fleet.removedMembers ?? []).map((removal) => [removal.hostId, removal]),
  );

  for (const removal of incomingRemovals) {
    validateRemoval(removal);
    if (removal.hostId === localId) continue;
    const previous = removals.get(removal.hostId);
    if (
      !previous ||
      timestamp(removal.removedAt, "fleet removal") > timestamp(previous.removedAt, "fleet removal")
    )
      removals.set(removal.hostId, removal);
  }

  for (const member of incomingMembers) {
    validateFleetMember(member);
    const previous = members.get(member.hostId);
    if (previous && previous.publicKey !== member.publicKey)
      throw new Error(`Host identity collision for ${member.hostId}.`);
    if (previous?.ssh && previous.ssh.publicKey !== member.ssh?.publicKey)
      throw new Error(`Host managed SSH identity collision for ${member.hostId}.`);
    if (preserveLocalMember && member.hostId === localId) continue;
    members.set(member.hostId, previous ? newestMember(previous, member) : member);
  }

  removals.delete(localId);
  for (const [hostId, member] of members) {
    if (hostId === localId) continue;
    const removal = removals.get(hostId);
    if (!removal) continue;
    if (
      timestamp(member.enrolledAt, "fleet enrollment") >
      timestamp(removal.removedAt, "fleet removal")
    )
      removals.delete(hostId);
    else members.delete(hostId);
  }

  const updated: FleetManifest = {
    ...fleet,
    members: [...members.values()].sort((left, right) => left.hostId.localeCompare(right.hostId)),
    removedMembers: [...removals.values()].sort((left, right) =>
      left.hostId.localeCompare(right.hostId),
    ),
    updatedAt: new Date().toISOString(),
  };
  const comparable = (value: FleetManifest): Omit<FleetManifest, "updatedAt"> => {
    const { updatedAt: _updatedAt, ...rest } = value;
    return rest;
  };
  if (isDeepStrictEqual(comparable(fleet), comparable(updated))) return fleet;
  atomicWriteJson(fleetPath(), updated);
  notifyDaemonStateChanged();
  return updated;
}

function mergeFleet(
  fleet: FleetManifest,
  incomingMembers: readonly FleetMember[],
  incomingRemovals: readonly FleetRemoval[],
  preserveLocalMember: boolean,
): FleetManifest {
  return withPidFileLock(fleetLockPath(), () => {
    const current = readFleetUnlocked();
    if (!current || current.fleetId !== fleet.fleetId)
      throw new Error(`Fleet ${fleet.fleetId} changed while recording membership.`);
    return mergeFleetUnlocked(current, incomingMembers, incomingRemovals, preserveLocalMember);
  });
}

function readFleetUnlocked(): FleetManifest | undefined {
  const path = fleetPath();
  if (!existsSync(path)) return undefined;
  let fleet = readJson<FleetManifest>(path);
  if (fleet.version !== 1 || typeof fleet.fleetId !== "string" || !Array.isArray(fleet.members))
    throw new Error(`Invalid fleet manifest at ${path}.`);
  for (const member of fleet.members) validateFleetMember(member, true);
  if (fleet.removedMembers !== undefined && !Array.isArray(fleet.removedMembers))
    throw new Error(`Invalid fleet manifest at ${path}.`);
  for (const removal of fleet.removedMembers ?? []) validateRemoval(removal);
  const localId = localMachineIdentity().id;
  let migrated = false;
  const members = fleet.members.map((member) => {
    if (
      member &&
      typeof member === "object" &&
      member.hostId === localId &&
      member.ssh === undefined &&
      member.publicKey === localHostKey().publicKey
    ) {
      const ssh = ensureManagedSshIdentity();
      migrated = true;
      return {
        ...member,
        ssh: { version: 1 as const, publicKey: ssh.publicKey, fingerprint: ssh.fingerprint },
      };
    }
    return member;
  });
  if (migrated) {
    fleet = { ...fleet, members, updatedAt: new Date().toISOString() };
    atomicWriteJson(path, fleet);
    notifyDaemonStateChanged();
  }
  return fleet;
}

export function readFleet(): FleetManifest | undefined {
  if (!existsSync(fleetPath())) return undefined;
  return withPidFileLock(fleetLockPath(), readFleetUnlocked);
}

export function ensureFleet(fleetId?: string): FleetManifest {
  return withPidFileLock(fleetLockPath(), () => {
    const existing = readFleetUnlocked();
    if (existing) {
      if (fleetId && existing.fleetId !== fleetId)
        throw new Error(
          `This host belongs to fleet ${existing.fleetId}, not requested fleet ${fleetId}.`,
        );
      return existing;
    }
    const now = new Date().toISOString();
    const fleet: FleetManifest = {
      version: 1,
      fleetId: fleetId ?? randomUUID(),
      members: [localFleetMember()],
      removedMembers: [],
      updatedAt: now,
    };
    atomicWriteJson(fleetPath(), fleet);
    notifyDaemonStateChanged();
    return fleet;
  });
}

export function enrollFleetMember(fleetId: string, member: FleetMember): FleetManifest {
  const fleet = ensureFleet(fleetId);
  return mergeFleet(fleet, [member], [], true);
}

/** Record an explicitly configured local endpoint without trusting peer gossip. */
export function updateLocalFleetMember(member: FleetMember): FleetManifest {
  const fleet = ensureFleet();
  const ssh = ensureManagedSshIdentity();
  if (
    member.hostId !== localMachineIdentity().id ||
    member.publicKey !== localHostKey().publicKey ||
    member.ssh?.publicKey !== ssh.publicKey
  )
    throw new Error("Local fleet member identity does not match this host.");
  return mergeFleet(fleet, [member], [], false);
}

/** Rename this host's durable identity and publish a fresh fleet membership record. */
export function renameLocalFleetMember(name: string): FleetManifest {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name))
    throw new Error("Machine names may contain letters, numbers, dots, underscores, and hyphens.");
  return withPidFileLock(fleetLockPath(), () => {
    const fleet = readFleetUnlocked();
    if (!fleet) throw new Error("This host is not enrolled in a Boxers fleet.");
    const localId = localMachineIdentity().id;
    const member = fleet.members.find((candidate) => candidate.hostId === localId);
    if (!member) throw new Error("The local host is missing from its Boxers fleet.");
    const collision = fleet.members.find(
      (candidate) =>
        candidate.hostId !== localId && candidate.name.toLowerCase() === name.toLowerCase(),
    );
    if (collision) throw new Error(`Fleet host name "${name}" is already in use.`);
    renameLocalMachine(name);
    if (member.name === name) return fleet;
    const enrolledAt = new Date(
      Math.max(Date.now(), timestamp(member.enrolledAt, "fleet enrollment") + 1),
    ).toISOString();
    return mergeFleetUnlocked(fleet, [{ ...member, name, enrolledAt }], [], false);
  });
}

export function mergeFleetSnapshot(
  fleetId: string,
  members: readonly FleetMember[],
  removedMembers: readonly FleetRemoval[],
): FleetManifest {
  const fleet = ensureFleet(fleetId);
  return mergeFleet(fleet, members, removedMembers, true);
}

export function removeFleetMember(reference: string): boolean {
  return withPidFileLock(fleetLockPath(), () => {
    const fleet = readFleetUnlocked();
    if (!fleet) return false;
    const localId = localMachineIdentity().id;
    const members = fleet.members.filter(
      (member) =>
        member.hostId === localId ||
        (member.hostId.toLowerCase() !== reference.toLowerCase() &&
          member.name.toLowerCase() !== reference.toLowerCase()),
    );
    if (members.length === fleet.members.length) return false;
    const removed = fleet.members.find((member) => !members.includes(member));
    const removedAt = new Date().toISOString();
    atomicWriteJson(fleetPath(), {
      ...fleet,
      members,
      removedMembers: [
        ...(fleet.removedMembers ?? []).filter((candidate) => candidate.hostId !== removed?.hostId),
        ...(removed ? [{ hostId: removed.hostId, removedAt }] : []),
      ],
      updatedAt: removedAt,
    });
    notifyDaemonStateChanged();
    return true;
  });
}

export function recordFleetRemoval(fleetId: string, removal: FleetRemoval): FleetManifest {
  const fleet = ensureFleet(fleetId);
  return mergeFleet(fleet, [], [removal], true);
}

export function signHostProjection(payload: string): string {
  return sign(null, Buffer.from(payload), localHostKey().privateKey).toString("base64");
}

export function verifyHostProjection(
  payload: string,
  signature: string,
  publicKey: string,
): boolean {
  try {
    return verify(null, Buffer.from(payload), publicKey, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}
