import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  enrollFleetMember,
  ensureFleet,
  localFleetMember,
  localHostKey,
  readFleet,
  recordFleetRemoval,
  signHostProjection,
  updateLocalFleetMember,
  verifyHostProjection,
} from "../../src/v2/fleet.ts";
import { decodeAdminRequest, encodeAdminRequest } from "../../src/v2/fleet-admin.ts";
import { fleetAdminStateLockPath, fleetLockPath, fleetPath } from "../../src/v2/paths.ts";
import {
  acceptEnrollment,
  acceptFleetSync,
  currentFleetSyncPayload,
  encodeEnrollment,
  encodeFleetSync,
} from "../../src/v2/fleet-connect.ts";

const directories: string[] = [];
const originalHome = process.env.BOXERS_HOME;

function stateDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "boxers-fleet-test-"));
  directories.push(directory);
  process.env.BOXERS_AUTHORIZED_KEYS ??= join(directory, "authorized_keys");
  return directory;
}

afterEach(() => {
  if (originalHome === undefined) delete process.env.BOXERS_HOME;
  else process.env.BOXERS_HOME = originalHome;
  delete process.env.BOXERS_AUTHORIZED_KEYS;
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("fleet identity and administration", () => {
  it("migrates a persisted local member that predates managed SSH", () => {
    process.env.BOXERS_HOME = stateDirectory();
    const fleet = ensureFleet();
    const legacy = {
      ...fleet,
      members: fleet.members.map(({ ssh: _ssh, ...member }) => member),
    };
    writeFileSync(fleetPath(), `${JSON.stringify(legacy, null, 2)}\n`);

    const migrated = readFleet();

    expect(migrated?.members[0]?.ssh).toMatchObject({ version: 1 });
    expect(JSON.parse(readFileSync(fleetPath(), "utf8")).members[0].ssh).toMatchObject({
      version: 1,
    });
  });

  it("keeps legacy remote members readable until their managed identity arrives", () => {
    const localHome = stateDirectory();
    const remoteHome = stateDirectory();
    process.env.BOXERS_HOME = localHome;
    const fleet = ensureFleet();

    process.env.BOXERS_HOME = remoteHome;
    ensureFleet(fleet.fleetId);
    const remote = localFleetMember([{ transport: "ssh", target: "remote" }]);

    process.env.BOXERS_HOME = localHome;
    enrollFleetMember(fleet.fleetId, remote);
    const persisted = readFleet()!;
    writeFileSync(
      fleetPath(),
      `${JSON.stringify({
        ...persisted,
        members: persisted.members.map(({ ssh: _ssh, ...member }) => member),
      })}\n`,
    );

    const legacy = readFleet()!;
    expect(legacy.members.find((member) => member.hostId === remote.hostId)?.ssh).toBeUndefined();

    enrollFleetMember(fleet.fleetId, remote);
    expect(readFleet()?.members.find((member) => member.hostId === remote.hostId)?.ssh).toEqual(
      remote.ssh,
    );
  });

  it("recovers a fleet lock left by a dead writer", () => {
    process.env.BOXERS_HOME = stateDirectory();
    writeFileSync(fleetLockPath(), "2147483647\n");
    expect(ensureFleet().members).toHaveLength(1);
  });

  it("persists an Ed25519 identity and verifies signed payloads", () => {
    process.env.BOXERS_HOME = stateDirectory();
    const first = localHostKey();
    const second = localHostKey();
    expect(second).toEqual(first);

    const payload = "recorded host projection";
    const signature = signHostProjection(payload);
    expect(verifyHostProjection(payload, signature, first.publicKey)).toBe(true);
    expect(verifyHostProjection(`${payload}!`, signature, first.publicKey)).toBe(false);
  });

  it("rejects a reused host ID with a different public key", () => {
    process.env.BOXERS_HOME = stateDirectory();
    const fleet = ensureFleet();
    const member = localFleetMember();
    expect(() =>
      enrollFleetMember(fleet.fleetId, {
        ...member,
        publicKey: "-----BEGIN PUBLIC KEY-----\ninvalid\n-----END PUBLIC KEY-----\n",
      }),
    ).toThrow("identity collision");
  });

  it("accepts a signed admin request once and rejects replay", () => {
    const senderHome = stateDirectory();
    const receiverHome = stateDirectory();

    process.env.BOXERS_HOME = senderHome;
    const senderFleet = ensureFleet();
    const sender = localFleetMember([], ["observe", "operate", "admin"]);

    process.env.BOXERS_HOME = receiverHome;
    ensureFleet(senderFleet.fleetId);
    enrollFleetMember(senderFleet.fleetId, sender);

    process.env.BOXERS_HOME = senderHome;
    const encoded = encodeAdminRequest("1.2.3");

    process.env.BOXERS_HOME = receiverHome;
    writeFileSync(fleetAdminStateLockPath(), "2147483647\n");
    expect(decodeAdminRequest(encoded)).toMatchObject({
      fleetId: senderFleet.fleetId,
      requesterHostId: sender.hostId,
      version: "1.2.3",
    });
    expect(() => decodeAdminRequest(encoded)).toThrow("already used");
  });

  it("converges reciprocal membership across three hosts", () => {
    const homes = [stateDirectory(), stateDirectory(), stateDirectory()];
    process.env.BOXERS_HOME = homes[0];
    const fleet = ensureFleet();
    const first = localFleetMember();

    process.env.BOXERS_HOME = homes[1];
    ensureFleet(fleet.fleetId);
    acceptEnrollment(encodeEnrollment({ fleetId: fleet.fleetId, member: first }));
    const second = localFleetMember();

    process.env.BOXERS_HOME = homes[0];
    acceptEnrollment(encodeEnrollment({ fleetId: fleet.fleetId, member: second }));

    process.env.BOXERS_HOME = homes[2];
    ensureFleet(fleet.fleetId);
    acceptEnrollment(encodeEnrollment({ fleetId: fleet.fleetId, member: first }));
    acceptEnrollment(encodeEnrollment({ fleetId: fleet.fleetId, member: second }));
    const third = localFleetMember();

    for (const home of homes.slice(0, 2)) {
      process.env.BOXERS_HOME = home;
      acceptEnrollment(encodeEnrollment({ fleetId: fleet.fleetId, member: third }));
    }
    for (const home of homes) {
      process.env.BOXERS_HOME = home;
      expect(
        readFleet()
          ?.members.map((member) => member.hostId)
          .sort(),
      ).toEqual([first.hostId, second.hostId, third.hostId].sort());
    }
  });

  it("preserves the receiver's own member record during full-fleet synchronization", () => {
    const senderHome = stateDirectory();
    const receiverHome = stateDirectory();

    process.env.BOXERS_HOME = senderHome;
    const fleet = ensureFleet();

    process.env.BOXERS_HOME = receiverHome;
    ensureFleet(fleet.fleetId);
    const receiver = localFleetMember(
      [{ transport: "ssh", target: "receiver", executable: "boxers" }],
      ["observe", "operate", "admin"],
      "2027-01-01T00:00:00.000Z",
    );
    updateLocalFleetMember(receiver);

    process.env.BOXERS_HOME = senderHome;
    enrollFleetMember(fleet.fleetId, {
      ...receiver,
      name: "stale-receiver-name",
      endpoints: [{ transport: "ssh", target: "wrong-endpoint" }],
      roles: ["observe"],
      enrolledAt: "2028-01-01T00:00:00.000Z",
    });
    const payload = currentFleetSyncPayload();
    expect(payload).toBeDefined();

    process.env.BOXERS_HOME = receiverHome;
    acceptFleetSync(encodeFleetSync(payload!));
    expect(readFleet()?.members.find((member) => member.hostId === receiver.hostId)).toEqual(
      receiver,
    );
  });

  it("reconciles managed SSH authorizations from membership and tombstones", () => {
    const senderHome = stateDirectory();
    const receiverHome = stateDirectory();
    const authorizedKeys = process.env.BOXERS_AUTHORIZED_KEYS!;

    process.env.BOXERS_HOME = senderHome;
    const fleet = ensureFleet();
    const sender = localFleetMember(
      [{ transport: "ssh", target: "sender" }],
      ["observe", "operate", "admin"],
    );

    process.env.BOXERS_HOME = receiverHome;
    ensureFleet(fleet.fleetId);
    acceptFleetSync(
      encodeFleetSync({
        version: 1,
        fleetId: fleet.fleetId,
        members: [sender],
        removedMembers: [],
        sentAt: new Date().toISOString(),
      }),
    );
    expect(readFileSync(authorizedKeys, "utf8")).toContain(`# boxers-managed ${sender.hostId}`);

    acceptFleetSync(
      encodeFleetSync({
        version: 1,
        fleetId: fleet.fleetId,
        members: [],
        removedMembers: [{ hostId: sender.hostId, removedAt: new Date().toISOString() }],
        sentAt: new Date().toISOString(),
      }),
    );
    expect(readFileSync(authorizedKeys, "utf8")).not.toContain(sender.hostId);
  });

  it("keeps previously learned direct endpoints when a member is refreshed", () => {
    process.env.BOXERS_HOME = stateDirectory();
    ensureFleet();
    const first = localFleetMember(
      [{ transport: "ssh", target: "host-on-lan" }],
      ["observe"],
      "2027-01-01T00:00:00.000Z",
    );
    updateLocalFleetMember(first);
    updateLocalFleetMember({
      ...first,
      endpoints: [{ transport: "ssh", target: "host-on-tailnet" }],
      enrolledAt: "2028-01-01T00:00:00.000Z",
    });
    expect(
      readFleet()?.members.find((member) => member.hostId === first.hostId)?.endpoints,
    ).toEqual([
      { transport: "ssh", target: "host-on-tailnet" },
      { transport: "ssh", target: "host-on-lan" },
    ]);
  });

  it("lets a tombstone beat stale offline membership and a later reconnect beat the tombstone", () => {
    const homes = [stateDirectory(), stateDirectory(), stateDirectory()];
    process.env.BOXERS_HOME = homes[0];
    const fleet = ensureFleet();
    const first = localFleetMember();

    process.env.BOXERS_HOME = homes[1];
    ensureFleet(fleet.fleetId);
    const second = localFleetMember();

    process.env.BOXERS_HOME = homes[2];
    ensureFleet(fleet.fleetId);
    const third = localFleetMember();

    for (const home of homes) {
      process.env.BOXERS_HOME = home;
      for (const member of [first, second, third]) enrollFleetMember(fleet.fleetId, member);
    }

    // The second host is offline while the first removes the third, so it still
    // carries the old active membership and can only send a stale snapshot.
    process.env.BOXERS_HOME = homes[1];
    const stalePayload = currentFleetSyncPayload();
    expect(stalePayload).toBeDefined();

    const removedAt = "2027-01-01T00:00:00.000Z";
    process.env.BOXERS_HOME = homes[0];
    recordFleetRemoval(fleet.fleetId, { hostId: third.hostId, removedAt });
    acceptFleetSync(encodeFleetSync(stalePayload!));
    expect(readFleet()?.members.some((member) => member.hostId === third.hostId)).toBe(false);
    expect(readFleet()?.removedMembers).toContainEqual({ hostId: third.hostId, removedAt });

    const removalPayload = currentFleetSyncPayload();
    process.env.BOXERS_HOME = homes[1];
    acceptFleetSync(encodeFleetSync(removalPayload!));
    expect(readFleet()?.members.some((member) => member.hostId === third.hostId)).toBe(false);

    // The third host also returns with its pre-disconnect view. Its old self
    // enrollment cannot resurrect it on either peer.
    process.env.BOXERS_HOME = homes[2];
    const returningStalePayload = currentFleetSyncPayload();
    process.env.BOXERS_HOME = homes[0];
    acceptFleetSync(encodeFleetSync(returningStalePayload!));
    expect(readFleet()?.members.some((member) => member.hostId === third.hostId)).toBe(false);

    // An explicit reconnect records a genuinely newer enrollment and wins.
    const reconnected = { ...third, enrolledAt: "2028-01-01T00:00:00.000Z" };
    process.env.BOXERS_HOME = homes[2];
    updateLocalFleetMember(reconnected);
    const reconnectPayload = currentFleetSyncPayload();
    process.env.BOXERS_HOME = homes[0];
    acceptFleetSync(encodeFleetSync(reconnectPayload!));
    const active = readFleet()?.members.find((member) => member.hostId === third.hostId);
    expect(active?.enrolledAt).toBe(reconnected.enrolledAt);
    expect(readFleet()?.removedMembers?.some((item) => item.hostId === third.hostId)).toBe(false);
  });

  it("records a fresh local member when accepting an explicit reconnect enrollment", () => {
    const senderHome = stateDirectory();
    const receiverHome = stateDirectory();

    process.env.BOXERS_HOME = senderHome;
    const fleet = ensureFleet();
    const sender = localFleetMember();

    process.env.BOXERS_HOME = receiverHome;
    ensureFleet(fleet.fleetId);
    const refreshedReceiver = localFleetMember(
      [{ transport: "ssh", target: "receiver-host" }],
      ["observe", "operate"],
      "2028-01-01T00:00:00.000Z",
    );
    acceptEnrollment(
      encodeEnrollment({
        fleetId: fleet.fleetId,
        member: sender,
        recipient: refreshedReceiver,
      }),
    );
    expect(
      readFleet()?.members.find((member) => member.hostId === refreshedReceiver.hostId),
    ).toEqual(refreshedReceiver);
  });
});
