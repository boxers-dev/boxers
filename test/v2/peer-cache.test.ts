import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atomicWriteJson, peerCachePath } from "../../src/v2/paths.ts";
import { readCachedPeerView, writeCachedPeerView } from "../../src/v2/peer-cache-store.ts";
import type { RemoteSnapshot } from "../../src/v2/types.ts";

const taskView = (working: boolean) => ({
  agent: {
    state: working ? ("working" as const) : ("not_started" as const),
    label: working ? "Generating" : "Not started",
  },
  operations: [],
  setup: { state: "not_configured" as const },
  reconciliation: { state: "not_needed" as const },
  changes: { state: "unknown" as const },
  checks: { state: "not_configured" as const },
  removal: {
    state: working ? ("blocked_by_activity" as const) : ("verification_required" as const),
    reason: "recorded",
  },
  issues: [],
  actions: [
    { kind: working ? ("wait" as const) : ("attach" as const), label: "Next", reason: "Continue" },
  ],
});

const originalHome = process.env.BOXERS_HOME;
const cleanup: string[] = [];

afterEach(() => {
  if (originalHome === undefined) delete process.env.BOXERS_HOME;
  else process.env.BOXERS_HOME = originalHome;
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("peer projection cache", () => {
  it("ages an online projection into explicit stale state", () => {
    const home = mkdtempSync(join(tmpdir(), "boxers-peer-cache-"));
    cleanup.push(home);
    process.env.BOXERS_HOME = home;
    const machine = {
      id: "peer-id",
      name: "peer",
      sshHost: "peer.example",
      createdAt: "2026-08-26T00:00:00.000Z",
    };
    const snapshot: RemoteSnapshot = {
      protocolVersion: 3,
      machine: {
        version: 1,
        id: machine.id,
        name: machine.name,
        createdAt: machine.createdAt,
        boxersVersion: "1.2.3",
      },
      observedAt: "2026-08-26T00:00:01.000Z",
      tasks: [],
    };
    const first = writeCachedPeerView(machine, {
      id: machine.id,
      name: machine.name,
      connection: "online",
      snapshot,
    });
    expect(first.changed).toBe(true);
    expect(readCachedPeerView(machine).connection).toBe("online");

    atomicWriteJson(peerCachePath(machine.id), {
      version: 1,
      updatedAt: "2026-08-26T00:00:00.000Z",
      view: { id: machine.id, name: machine.name, connection: "online", snapshot },
    });
    expect(readCachedPeerView(machine)).toMatchObject({
      connection: "stale",
      snapshot,
      detail: expect.stringContaining("heartbeat is stale"),
    });
  });

  it("uses the fleet name instead of a stale name stored in the peer cache", () => {
    const home = mkdtempSync(join(tmpdir(), "boxers-peer-cache-rename-"));
    cleanup.push(home);
    process.env.BOXERS_HOME = home;
    const snapshot: RemoteSnapshot = {
      protocolVersion: 3,
      machine: {
        version: 1,
        id: "peer-id",
        name: "old-name",
        createdAt: "2026-08-26T00:00:00.000Z",
        boxersVersion: "1.2.3",
      },
      observedAt: new Date().toISOString(),
      tasks: [],
    };
    atomicWriteJson(peerCachePath("peer-id"), {
      version: 1,
      updatedAt: new Date().toISOString(),
      view: {
        id: "peer-id",
        name: "old-name",
        connection: "online",
        snapshot,
      },
    });

    const view = readCachedPeerView({ id: "peer-id", name: "home-linux-server" });

    expect(view.name).toBe("home-linux-server");
    expect(view.snapshot?.machine.name).toBe("home-linux-server");
  });

  it("does not let a late older refresh roll back the recorded projection", () => {
    const home = mkdtempSync(join(tmpdir(), "boxers-peer-cache-order-"));
    cleanup.push(home);
    process.env.BOXERS_HOME = home;
    const machine = {
      id: "peer-id",
      name: "peer",
      sshHost: "peer.example",
      createdAt: "2026-08-26T00:00:00.000Z",
    };
    const projection = (observedAt: string, phase: "idle" | "working"): RemoteSnapshot => ({
      protocolVersion: 3,
      machine: {
        version: 1,
        id: machine.id,
        name: machine.name,
        createdAt: machine.createdAt,
        boxersVersion: "1.2.3",
      },
      observedAt,
      tasks: [
        {
          id: "task-id",
          projectId: "project-id",
          project: "project",
          name: "task",
          agent: "codex",
          view: taskView(phase === "working"),
          runtimeState: "running",
        },
      ],
    });
    const newer = projection("2026-08-26T00:00:02.000Z", "working");
    writeCachedPeerView(machine, {
      id: machine.id,
      name: machine.name,
      connection: "online",
      snapshot: newer,
    });
    writeCachedPeerView(machine, {
      id: machine.id,
      name: machine.name,
      connection: "online",
      snapshot: projection("2026-08-26T00:00:01.000Z", "idle"),
    });
    expect(readCachedPeerView(machine).snapshot).toEqual(newer);
  });

  it("refreshes volatile service times without reporting a visible change", () => {
    const home = mkdtempSync(join(tmpdir(), "boxers-peer-cache-volatile-"));
    cleanup.push(home);
    process.env.BOXERS_HOME = home;
    const machine = { id: "peer-id", name: "peer", sshHost: "peer.example" };
    const snapshot = (servedAt: string): RemoteSnapshot => ({
      protocolVersion: 3,
      machine: {
        version: 1,
        id: machine.id,
        name: machine.name,
        createdAt: "2026-08-26T00:00:00.000Z",
        boxersVersion: "1.2.3",
      },
      observedAt: servedAt,
      servedAt,
      tasks: [],
    });
    expect(
      writeCachedPeerView(machine, {
        id: machine.id,
        name: machine.name,
        connection: "online",
        snapshot: snapshot("2026-08-26T00:00:01.000Z"),
      }).changed,
    ).toBe(true);
    expect(
      writeCachedPeerView(machine, {
        id: machine.id,
        name: machine.name,
        connection: "online",
        snapshot: snapshot("2026-08-26T00:00:02.000Z"),
      }).changed,
    ).toBe(false);
  });
});
