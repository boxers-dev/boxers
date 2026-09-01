import { describe, expect, it } from "vitest";
import { formatMachineViews, parseRemoteSnapshot } from "../../src/v2/machines.ts";
import type { RemoteSnapshot } from "../../src/v2/types.ts";

const snapshot: RemoteSnapshot = {
  protocolVersion: 2,
  machine: {
    version: 1,
    id: "host-id",
    name: "desktop",
    createdAt: "2026-08-10T00:00:00.000Z",
    boxersVersion: "0.2.0",
  },
  observedAt: "2026-08-10T00:00:01.000Z",
  projects: [
    {
      id: "project-id",
      name: "boxers",
      source: "github.com/owner/boxers",
      base: "main",
      integration: "remote",
    },
  ],
  tasks: [
    {
      id: "task-id",
      projectId: "project-id",
      project: "boxers",
      name: "multi-host",
      agent: "codex",
      phase: "needs_input",
      activity: "awaiting_input",
      runtimeState: "running",
    },
  ],
};

describe("multi-machine protocol", () => {
  it("accepts protocol v2 and rejects malformed or incompatible snapshots", () => {
    expect(parseRemoteSnapshot(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(
      parseRemoteSnapshot(
        JSON.stringify({
          ...snapshot,
          tasks: [
            {
              ...snapshot.tasks[0],
              lastDelivery: { ref: "main", oid: "abc123", subject: "Improve status" },
            },
          ],
        }),
      ).tasks[0]?.lastDelivery,
    ).toEqual({ ref: "main", oid: "abc123", subject: "Improve status" });
    const flattened = {
      ...snapshot,
      tasks: snapshot.tasks.map(({ runtimeState: _runtimeState, ...task }) => ({
        ...task,
        runtimeState: "running",
      })),
    };
    expect(parseRemoteSnapshot(JSON.stringify(flattened)).tasks[0]).toMatchObject({
      runtimeState: "running",
    });
    expect(() => parseRemoteSnapshot("not json")).toThrow("invalid JSON");
    expect(() => parseRemoteSnapshot(JSON.stringify({ ...snapshot, protocolVersion: 1 }))).toThrow(
      "Unsupported remote protocol version 1",
    );
    expect(() => parseRemoteSnapshot(JSON.stringify({ protocolVersion: 2 }))).toThrow(
      "invalid snapshot",
    );
    expect(() =>
      parseRemoteSnapshot(
        JSON.stringify({
          ...snapshot,
          tasks: [{ ...snapshot.tasks[0], state: { version: 1, taskId: "wrong" } }],
        }),
      ),
    ).toThrow("invalid task snapshot");
    const withHostStatus = {
      ...snapshot,
      hostStatus: {
        version: 1,
        observedAt: "2026-08-10T00:00:02.000Z",
        boxersVersion: "0.2.0",
        health: "healthy",
        daemon: "running",
        authentication: { codex: "configured", claude: "missing" },
        checks: [],
      },
    } as const;
    expect(parseRemoteSnapshot(JSON.stringify(withHostStatus)).hostStatus).toEqual(
      withHostStatus.hostStatus,
    );
    expect(() =>
      parseRemoteSnapshot(
        JSON.stringify({
          ...withHostStatus,
          hostStatus: { ...withHostStatus.hostStatus, health: "fine" },
        }),
      ),
    ).toThrow("invalid host status");
    expect(() =>
      parseRemoteSnapshot(
        JSON.stringify({
          ...snapshot,
          tasks: [{ ...snapshot.tasks[0], lastDelivery: { ref: "main", oid: "abc123" } }],
        }),
      ),
    ).toThrow("invalid task snapshot");
  });

  it("renders current tasks and does not show stale tasks for offline machines", () => {
    const output = formatMachineViews([
      { id: "host-id", name: "desktop", connection: "online", snapshot },
      { id: "laptop-id", name: "laptop", connection: "offline" },
    ]);
    expect(output).toContain("desktop");
    expect(output).toContain("multi-host");
    expect(output).toContain("NEEDS_ATTENTION");
    expect(output).toContain("UNMERGED_CHANGES");
    expect(output).toMatch(/multi-host\s+codex\s+yes/);
    expect(output).toMatch(/laptop\s+offline\s+—/);
  });

  it("renders unmerged-work state directly", () => {
    const output = formatMachineViews([
      {
        id: "host-id",
        name: "desktop",
        connection: "online",
        snapshot: {
          ...snapshot,
          tasks: [
            { ...snapshot.tasks[0]!, name: "integrated", hasUnmergedChanges: false },
            { ...snapshot.tasks[0]!, name: "outstanding", hasUnmergedChanges: true },
          ],
        },
      },
    ]);
    expect(output).toMatch(/integrated\s+codex\s+yes\s+no/);
    expect(output).toMatch(/outstanding\s+codex\s+yes\s+yes/);
  });

  it("describes the last delivery for a task with no other changes", () => {
    const output = formatMachineViews([
      {
        id: "host-id",
        name: "desktop",
        connection: "online",
        snapshot: {
          ...snapshot,
          tasks: [
            {
              ...snapshot.tasks[0]!,
              hasUnmergedChanges: false,
              lastDelivery: { ref: "main", oid: "abc123", subject: "Improve task status" },
            },
          ],
        },
      },
    ]);
    expect(output).toContain("Last commit on main; no other changes by this task");
    expect(output).not.toContain("Improve task status");
  });
});
