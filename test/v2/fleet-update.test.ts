import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  enrollFleetMember,
  ensureFleet,
  localFleetMember,
  recordFleetRemoval,
} from "../../src/v2/fleet.ts";
import {
  acknowledgeFleetRelease,
  createFleetReleaseIntent,
  fleetReleaseIsAcknowledged,
  mergeFleetUpdateState,
  readFleetUpdateState,
  recordFleetReleaseFailure,
} from "../../src/v2/fleet-update.ts";
import type { ReleaseManifest } from "../../src/v2/release.ts";
import {
  acceptFleetSync,
  currentFleetSyncPayload,
  encodeFleetSync,
} from "../../src/v2/fleet-connect.ts";

const directories: string[] = [];
const originalHome = process.env.BOXERS_HOME;

function home(): string {
  const directory = mkdtempSync(join(tmpdir(), "boxers-fleet-update-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  if (originalHome === undefined) delete process.env.BOXERS_HOME;
  else process.env.BOXERS_HOME = originalHome;
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const release: ReleaseManifest = {
  version: 1,
  packageName: "@boxers-dev/boxers",
  packageVersion: "1.2.3",
  buildId: "a".repeat(64),
  runtimeHash: "b".repeat(64),
  dependencies: {},
  files: [],
};

function fleetPair(): {
  firstHome: string;
  secondHome: string;
  firstId: string;
  secondId: string;
} {
  const firstHome = home();
  const secondHome = home();
  process.env.BOXERS_HOME = firstHome;
  const fleet = ensureFleet();
  const first = localFleetMember();
  process.env.BOXERS_HOME = secondHome;
  ensureFleet(fleet.fleetId);
  const second = localFleetMember();
  enrollFleetMember(fleet.fleetId, first);
  process.env.BOXERS_HOME = firstHome;
  enrollFleetMember(fleet.fleetId, second);
  return {
    firstHome,
    secondHome,
    firstId: first.hostId,
    secondId: second.hostId,
  };
}

describe("durable fleet release state", () => {
  it("signs, merges, and acknowledges a desired release", () => {
    const pair = fleetPair();
    process.env.BOXERS_HOME = pair.firstHome;
    const created = createFleetReleaseIntent(release);
    expect(created.desired?.body.generation).toBe(1);

    process.env.BOXERS_HOME = pair.secondHome;
    const received = mergeFleetUpdateState(created);
    expect(received.desired?.body.release.buildId).toBe(release.buildId);
    const acknowledged = acknowledgeFleetRelease();
    expect(fleetReleaseIsAcknowledged(pair.secondId, acknowledged)).toBe(true);

    process.env.BOXERS_HOME = pair.firstHome;
    const converged = mergeFleetUpdateState(acknowledged);
    expect(fleetReleaseIsAcknowledged(pair.secondId, converged)).toBe(true);
  });

  it("increments generations and rejects a modified signed intent", () => {
    const pair = fleetPair();
    process.env.BOXERS_HOME = pair.firstHome;
    expect(createFleetReleaseIntent(release).desired?.body.generation).toBe(1);
    const second = createFleetReleaseIntent({
      ...release,
      buildId: "c".repeat(64),
    });
    expect(second.desired?.body.generation).toBe(2);

    process.env.BOXERS_HOME = pair.secondHome;
    const tampered = structuredClone(second);
    tampered.desired!.body.release.packageVersion = "9.9.9";
    expect(() => mergeFleetUpdateState(tampered)).toThrow("unauthorized");
    expect(readFleetUpdateState().desired).toBeUndefined();
  });

  it("rejects malformed release identities even when the intent is signed", () => {
    const pair = fleetPair();
    process.env.BOXERS_HOME = pair.firstHome;
    const malformed = createFleetReleaseIntent({
      ...release,
      runtimeHash: "not-a-hash",
    });

    process.env.BOXERS_HOME = pair.secondHome;
    expect(() => mergeFleetUpdateState(malformed)).toThrow("unauthorized");
  });

  it("does not allow downgrade permission to be added after signing", () => {
    const pair = fleetPair();
    process.env.BOXERS_HOME = pair.firstHome;
    const created = createFleetReleaseIntent(release);
    const tampered = structuredClone(created);
    tampered.desired!.body.allowDowngrade = true;

    process.env.BOXERS_HOME = pair.secondHome;
    expect(() => mergeFleetUpdateState(tampered)).toThrow("unauthorized");
  });

  it("drops acknowledgements from removed machines without poisoning desired state", () => {
    const pair = fleetPair();
    process.env.BOXERS_HOME = pair.firstHome;
    const created = createFleetReleaseIntent(release);
    process.env.BOXERS_HOME = pair.secondHome;
    mergeFleetUpdateState(created);
    const acknowledged = acknowledgeFleetRelease();

    process.env.BOXERS_HOME = pair.firstHome;
    mergeFleetUpdateState(acknowledged);
    recordFleetRemoval(ensureFleet().fleetId, {
      hostId: pair.secondId,
      removedAt: new Date(Date.now() + 1_000).toISOString(),
    });
    const current = readFleetUpdateState();
    expect(current.desired?.body.release.buildId).toBe(release.buildId);
    expect(fleetReleaseIsAcknowledged(pair.secondId, current)).toBe(false);
  });

  it("cancels desired state when the issuing administrator is removed", () => {
    const pair = fleetPair();
    process.env.BOXERS_HOME = pair.firstHome;
    const created = createFleetReleaseIntent(release);

    process.env.BOXERS_HOME = pair.secondHome;
    mergeFleetUpdateState(created);
    recordFleetRemoval(ensureFleet().fleetId, {
      hostId: pair.firstId,
      removedAt: new Date(Date.now() + 1_000).toISOString(),
    });

    expect(readFleetUpdateState().desired).toBeUndefined();
  });

  it("lets a newer signed failure retract an installed acknowledgement", () => {
    const pair = fleetPair();
    process.env.BOXERS_HOME = pair.firstHome;
    createFleetReleaseIntent(release);
    expect(fleetReleaseIsAcknowledged(pair.firstId, acknowledgeFleetRelease())).toBe(true);
    expect(fleetReleaseIsAcknowledged(pair.firstId, recordFleetReleaseFailure())).toBe(false);
  });

  it("carries desired releases and acknowledgements through fleet gossip", () => {
    const pair = fleetPair();
    process.env.BOXERS_HOME = pair.firstHome;
    createFleetReleaseIntent(release);
    acknowledgeFleetRelease();
    const payload = currentFleetSyncPayload()!;
    expect(payload.update?.desired?.body.release.buildId).toBe(release.buildId);

    process.env.BOXERS_HOME = pair.secondHome;
    acceptFleetSync(encodeFleetSync(payload));
    expect(readFleetUpdateState().desired?.body.release.buildId).toBe(release.buildId);
    expect(fleetReleaseIsAcknowledged(pair.firstId)).toBe(true);
  });
});
