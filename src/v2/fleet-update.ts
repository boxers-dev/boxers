import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { localMachineIdentity } from "./registry.ts";
import { readFleet, signHostProjection, verifyHostProjection } from "./fleet.ts";
import { atomicWriteJson, fleetUpdateLockPath, fleetUpdatePath, readJson } from "./paths.ts";
import { withPidFileLock } from "./lock.ts";
import { notifyDaemonStateChanged } from "./daemon-client.ts";
import type { ReleaseManifest } from "./release.ts";

export interface FleetReleaseIntentBody {
  version: 1;
  fleetId: string;
  generation: number;
  issuerHostId: string;
  issuedAt: string;
  allowDowngrade: boolean;
  release: ReleaseManifest;
}

export interface SignedFleetReleaseIntent {
  body: FleetReleaseIntentBody;
  signature: string;
}

export interface FleetReleaseAckBody {
  version: 1;
  fleetId: string;
  hostId: string;
  generation: number;
  buildId: string;
  status: "installed" | "failed";
  detail?: string;
  activatedAt: string;
}

export interface SignedFleetReleaseAck {
  body: FleetReleaseAckBody;
  signature: string;
}

export interface FleetUpdateState {
  version: 1;
  desired?: SignedFleetReleaseIntent | undefined;
  acknowledgements: SignedFleetReleaseAck[];
  updatedAt: string;
}

function emptyState(): FleetUpdateState {
  return {
    version: 1,
    acknowledgements: [],
    updatedAt: new Date(0).toISOString(),
  };
}

function signed<T extends object>(body: T): { body: T; signature: string } {
  return { body, signature: signHostProjection(JSON.stringify(body)) };
}

function currentFleet() {
  const fleet = readFleet();
  if (!fleet) throw new Error("This host is not enrolled in a Boxers fleet.");
  return fleet;
}

function validateIntent(intent: SignedFleetReleaseIntent): boolean {
  const fleet = currentFleet();
  const body = intent?.body;
  const issuer = fleet.members.find((member) => member.hostId === body?.issuerHostId);
  if (
    body?.version !== 1 ||
    body.fleetId !== fleet.fleetId ||
    !Number.isSafeInteger(body.generation) ||
    body.generation <= 0 ||
    !Number.isFinite(Date.parse(body.issuedAt)) ||
    typeof body.allowDowngrade !== "boolean" ||
    body.release?.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(body.release.buildId) ||
    !/^[a-f0-9]{64}$/.test(body.release.runtimeHash)
  )
    throw new Error("Invalid or unauthorized Boxers fleet release intent.");
  if (!issuer || !issuer.roles.includes("admin")) return false;
  if (!verifyHostProjection(JSON.stringify(body), intent.signature, issuer.publicKey))
    throw new Error("Invalid or unauthorized Boxers fleet release intent.");
  return true;
}

function validateAck(
  ack: SignedFleetReleaseAck,
  desired: SignedFleetReleaseIntent,
): "valid" | "removed" {
  const fleet = currentFleet();
  const body = ack?.body;
  const member = fleet.members.find((candidate) => candidate.hostId === body?.hostId);
  if (
    body?.version !== 1 ||
    body.fleetId !== fleet.fleetId ||
    body.generation !== desired.body.generation ||
    body.buildId !== desired.body.release.buildId ||
    (body.status !== "installed" && body.status !== "failed") ||
    (body.detail !== undefined && typeof body.detail !== "string") ||
    !Number.isFinite(Date.parse(body.activatedAt))
  )
    throw new Error("Invalid Boxers fleet release acknowledgement.");
  if (!member) return "removed";
  if (!verifyHostProjection(JSON.stringify(body), ack.signature, member.publicKey))
    throw new Error("Invalid Boxers fleet release acknowledgement.");
  return "valid";
}

function normalizeState(state: FleetUpdateState): FleetUpdateState {
  if (state?.version !== 1 || !Array.isArray(state.acknowledgements))
    throw new Error("Invalid Boxers fleet update state.");
  if (!state.desired) {
    if (state.acknowledgements.length) throw new Error("Invalid Boxers fleet update state.");
    return state;
  }
  if (!validateIntent(state.desired)) return emptyState();
  return {
    ...state,
    acknowledgements: state.acknowledgements.filter(
      (acknowledgement) => validateAck(acknowledgement, state.desired!) === "valid",
    ),
  };
}

function readUnlocked(): FleetUpdateState {
  const path = fleetUpdatePath();
  if (!existsSync(path)) return emptyState();
  return normalizeState(readJson<FleetUpdateState>(path));
}

export function readFleetUpdateState(): FleetUpdateState {
  return readUnlocked();
}

function compareIntent(
  left: SignedFleetReleaseIntent | undefined,
  right: SignedFleetReleaseIntent | undefined,
): number {
  if (!left) return right ? -1 : 0;
  if (!right) return 1;
  return (
    left.body.generation - right.body.generation ||
    left.body.issuerHostId.localeCompare(right.body.issuerHostId) ||
    left.body.release.buildId.localeCompare(right.body.release.buildId)
  );
}

function writeIfChanged(previous: FleetUpdateState, next: FleetUpdateState): FleetUpdateState {
  const comparable = (state: FleetUpdateState): Omit<FleetUpdateState, "updatedAt"> => {
    const { updatedAt: _updatedAt, ...rest } = state;
    return rest;
  };
  if (isDeepStrictEqual(comparable(previous), comparable(next))) return previous;
  const updated = { ...next, updatedAt: new Date().toISOString() };
  atomicWriteJson(fleetUpdatePath(), updated);
  notifyDaemonStateChanged();
  return updated;
}

export function createFleetReleaseIntent(
  release: ReleaseManifest,
  allowDowngrade = false,
): FleetUpdateState {
  const fleet = currentFleet();
  return withPidFileLock(fleetUpdateLockPath(), () => {
    const previous = readUnlocked();
    const body: FleetReleaseIntentBody = {
      version: 1,
      fleetId: fleet.fleetId,
      generation: (previous.desired?.body.generation ?? 0) + 1,
      issuerHostId: localMachineIdentity().id,
      issuedAt: new Date().toISOString(),
      allowDowngrade,
      release,
    };
    const desired = signed(body);
    return writeIfChanged(previous, {
      version: 1,
      desired,
      acknowledgements: [],
      updatedAt: previous.updatedAt,
    });
  });
}

function recordFleetReleaseStatus(
  status: "installed" | "failed",
  detail?: string,
): FleetUpdateState {
  const fleet = currentFleet();
  return withPidFileLock(fleetUpdateLockPath(), () => {
    const previous = readUnlocked();
    const desired = previous.desired;
    if (!desired) throw new Error("No Boxers fleet release is awaiting acknowledgement.");
    const hostId = localMachineIdentity().id;
    const body: FleetReleaseAckBody = {
      version: 1,
      fleetId: fleet.fleetId,
      hostId,
      generation: desired.body.generation,
      buildId: desired.body.release.buildId,
      status,
      ...(detail ? { detail: detail.slice(0, 2_000) } : {}),
      activatedAt: new Date().toISOString(),
    };
    const acknowledgement = signed(body);
    return writeIfChanged(previous, {
      ...previous,
      acknowledgements: [
        ...previous.acknowledgements.filter((candidate) => candidate.body.hostId !== hostId),
        acknowledgement,
      ].sort((left, right) => left.body.hostId.localeCompare(right.body.hostId)),
    });
  });
}

export function acknowledgeFleetRelease(): FleetUpdateState {
  return recordFleetReleaseStatus("installed");
}

export function recordFleetReleaseFailure(detail?: string): FleetUpdateState {
  return recordFleetReleaseStatus("failed", detail);
}

export function mergeFleetUpdateState(incoming: FleetUpdateState | undefined): FleetUpdateState {
  if (!incoming) return readUnlocked();
  incoming = normalizeState(incoming);
  return withPidFileLock(fleetUpdateLockPath(), () => {
    const previous = readUnlocked();
    const comparison = compareIntent(previous.desired, incoming.desired);
    if (!incoming.desired || comparison > 0) return previous;
    if (!previous.desired || comparison < 0)
      return writeIfChanged(previous, {
        ...incoming,
        acknowledgements: [...incoming.acknowledgements].sort((left, right) =>
          left.body.hostId.localeCompare(right.body.hostId),
        ),
      });
    const acknowledgements = new Map(
      previous.acknowledgements.map((acknowledgement) => [
        acknowledgement.body.hostId,
        acknowledgement,
      ]),
    );
    for (const acknowledgement of incoming.acknowledgements) {
      const current = acknowledgements.get(acknowledgement.body.hostId);
      if (
        !current ||
        acknowledgement.body.activatedAt > current.body.activatedAt ||
        (acknowledgement.body.activatedAt === current.body.activatedAt &&
          acknowledgement.body.status === "failed" &&
          current.body.status !== "failed")
      )
        acknowledgements.set(acknowledgement.body.hostId, acknowledgement);
    }
    return writeIfChanged(previous, {
      ...previous,
      acknowledgements: [...acknowledgements.values()].sort((left, right) =>
        left.body.hostId.localeCompare(right.body.hostId),
      ),
    });
  });
}

export function fleetReleaseIsAcknowledged(
  hostId: string,
  state = readFleetUpdateState(),
): boolean {
  return Boolean(
    state.desired &&
    state.acknowledgements.some(
      (ack) => ack.body.hostId === hostId && ack.body.status === "installed",
    ),
  );
}
