import { describe, expect, it } from "vitest";
import { formatMachineViews, parseRemoteSnapshot } from "../../src/v2/machines.ts";
import type { RemoteSnapshot, TaskView } from "../../src/v2/types.ts";

const view = (changes: TaskView["changes"]["state"] = "unknown"): TaskView => ({
  agent: { state: "awaiting_input", label: "Ready for input" },
  operations: [],
  setup: { state: "not_configured" },
  reconciliation: { state: "not_needed" },
  changes: { state: changes },
  checks: { state: "not_configured" },
  removal: { state: "verification_required", reason: "verification required" },
  issues: [],
  actions: [
    { kind: "attach", label: "Attach", command: "boxers task attach", reason: "Continue." },
  ],
});

const snapshot: RemoteSnapshot = {
  protocolVersion: 3,
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
      view: view(),
      runtimeState: "running",
    },
  ],
};

describe("multi-machine protocol", () => {
  it("accepts protocol v3 and rejects flattened or incompatible snapshots", () => {
    expect(parseRemoteSnapshot(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(
      parseRemoteSnapshot(
        JSON.stringify({
          ...snapshot,
          tasks: [
            {
              ...snapshot.tasks[0],
              view: {
                ...snapshot.tasks[0]!.view,
                delivery: {
                  ref: "main",
                  oid: "abc123",
                  subject: "Improve status",
                  deliveredAt: "2026-08-10T00:00:00.000Z",
                  conversationSequence: 1,
                  checks: "passed",
                },
              },
            },
          ],
        }),
      ).tasks[0]?.view.delivery,
    ).toMatchObject({ ref: "main", oid: "abc123", subject: "Improve status", checks: "passed" });
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
      "Unsupported remote task-view protocol version 1",
    );
    expect(() => parseRemoteSnapshot(JSON.stringify({ protocolVersion: 3 }))).toThrow(
      "invalid snapshot",
    );
    expect(() =>
      parseRemoteSnapshot(
        JSON.stringify({
          ...snapshot,
          tasks: [{ ...snapshot.tasks[0], internal: { state: { version: 1, taskId: "wrong" } } }],
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
    const withPendingActivation = {
      ...snapshot,
      boxersUpdate: {
        desiredBuildId: "a".repeat(64),
        desiredVersion: "0.3.0",
        status: "pending",
        activation: "waiting",
        blockers: [{ kind: "working", task: "multi-host", detail: "still working" }],
      },
    } as const;
    expect(parseRemoteSnapshot(JSON.stringify(withPendingActivation)).boxersUpdate).toEqual(
      withPendingActivation.boxersUpdate,
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
          tasks: [{ ...snapshot.tasks[0], phase: "needs_input", needsAttention: true }],
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
    expect(output).toContain("CHANGES");
    expect(output).toContain("CHECKS");
    expect(output).toContain("NEXT");
    expect(output).toMatch(/multi-host\s+Ready for input\s+Unknown/);
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
            { ...snapshot.tasks[0]!, name: "integrated", view: view("none") },
            { ...snapshot.tasks[0]!, name: "outstanding", view: view("unmerged") },
          ],
        },
      },
    ]);
    expect(output).toMatch(/integrated\s+Ready for input\s+None/);
    expect(output).toMatch(/outstanding\s+Ready for input\s+Unmerged/);
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
              view: {
                ...view("none"),
                delivery: {
                  ref: "main",
                  oid: "abc123",
                  subject: "Improve task status",
                  deliveredAt: "2026-08-10T00:00:00.000Z",
                  conversationSequence: 1,
                  checks: "passed",
                },
              },
            },
          ],
        },
      },
    ]);
    expect(output).toContain("None");
    expect(output).not.toContain("Improve task status");
  });
});
