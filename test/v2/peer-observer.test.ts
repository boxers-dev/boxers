import { describe, expect, it } from "vitest";
import { PeerRefreshCoordinator } from "../../src/v2/peer-cache.ts";
import type { RemoteMachine } from "../../src/v2/machines.ts";
import type { MachineView } from "../../src/v2/types.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => (resolve = accept));
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for peer refresh state.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const machine: RemoteMachine = {
  id: "peer-id",
  name: "peer",
  sshHost: "peer.example",
};

const online: MachineView = {
  id: machine.id,
  name: machine.name,
  connection: "online",
  snapshot: {
    protocolVersion: 3,
    machine: {
      version: 1,
      id: machine.id,
      name: machine.name,
      createdAt: "2026-09-02T00:00:00.000Z",
      boxersVersion: "1.0.0",
    },
    observedAt: "2026-09-02T00:00:00.000Z",
    servedAt: "2026-09-02T00:00:00.000Z",
    tasks: [],
  },
};

describe("peer refresh coordinator", () => {
  it("bounds a burst to one active snapshot and one coalesced follow-up", async () => {
    const gates = [deferred<MachineView>(), deferred<MachineView>()];
    let calls = 0;
    let active = 0;
    let maximumActive = 0;
    let changes = 0;
    const coordinator = new PeerRefreshCoordinator({
      onChanged: () => changes++,
      query: async () => {
        const gate = gates[calls++];
        if (!gate) throw new Error("Unexpected extra peer query.");
        active++;
        maximumActive = Math.max(maximumActive, active);
        try {
          return await gate.promise;
        } finally {
          active--;
        }
      },
      write: (_peer, view) => ({ view, changed: true }),
    });

    coordinator.request(machine, "initial observation");
    await waitUntil(() => calls === 1);
    for (let index = 0; index < 100; index++) coordinator.request(machine, `event ${index}`);
    expect(calls).toBe(1);
    expect(active).toBe(1);

    gates[0]!.resolve(online);
    await waitUntil(() => calls === 2);
    expect(maximumActive).toBe(1);
    gates[1]!.resolve(online);
    await waitUntil(() => active === 0);

    expect(calls).toBe(2);
    expect(changes).toBe(2);
    coordinator.close();
  });

  it("drops pending work and late results after close", async () => {
    const gate = deferred<MachineView>();
    let calls = 0;
    let writes = 0;
    let changes = 0;
    const coordinator = new PeerRefreshCoordinator({
      onChanged: () => changes++,
      query: async () => {
        calls++;
        return await gate.promise;
      },
      write: (_peer, view) => {
        writes++;
        return { view, changed: true };
      },
    });

    coordinator.request(machine, "initial observation");
    await waitUntil(() => calls === 1);
    coordinator.request(machine, "queued change");
    coordinator.close();
    gate.resolve(online);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(calls).toBe(1);
    expect(writes).toBe(0);
    expect(changes).toBe(0);
  });

  it("keeps a removed and re-added peer single-flight", async () => {
    const gates = [deferred<MachineView>(), deferred<MachineView>()];
    let calls = 0;
    let active = 0;
    let maximumActive = 0;
    let writes = 0;
    const coordinator = new PeerRefreshCoordinator({
      onChanged: () => undefined,
      query: async () => {
        const gate = gates[calls++];
        if (!gate) throw new Error("Unexpected extra peer query.");
        active++;
        maximumActive = Math.max(maximumActive, active);
        try {
          return await gate.promise;
        } finally {
          active--;
        }
      },
      write: (_peer, view) => {
        writes++;
        return { view, changed: true };
      },
    });

    coordinator.request(machine, "initial observation");
    await waitUntil(() => calls === 1);
    coordinator.forget(machine.id);
    coordinator.request(machine, "peer re-added");
    expect(calls).toBe(1);
    gates[0]!.resolve(online);
    await waitUntil(() => calls === 2);
    expect(writes).toBe(0);
    gates[1]!.resolve(online);
    await waitUntil(() => active === 0);

    expect(maximumActive).toBe(1);
    expect(writes).toBe(1);
    coordinator.close();
  });
});
