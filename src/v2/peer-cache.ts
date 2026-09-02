import { spawn, type ChildProcess } from "node:child_process";
import {
  listRemoteMachines,
  queryRemoteMachine,
  remoteArgs,
  type RemoteMachine,
} from "./machines.ts";
import { writeCachedPeerView } from "./peer-cache-store.ts";

export interface PeerObserverHandle {
  reconcile(): void;
  close(): void;
}

interface PendingRefresh {
  machine: RemoteMachine;
  reason: string;
  generation: number;
}

interface PeerRefreshState {
  running: boolean;
  pending: PendingRefresh | undefined;
  generation: number;
  enabled: boolean;
}

export interface PeerRefreshCoordinatorOptions {
  onChanged: () => void;
  debug?: (message: string) => void;
  query?: (machine: RemoteMachine) => Promise<Awaited<ReturnType<typeof queryRemoteMachine>>>;
  write?: typeof writeCachedPeerView;
}

/** Single-flight peer snapshots with one coalesced follow-up per peer. */
export class PeerRefreshCoordinator {
  readonly #states = new Map<string, PeerRefreshState>();
  readonly #onChanged: () => void;
  readonly #debug: (message: string) => void;
  readonly #query: NonNullable<PeerRefreshCoordinatorOptions["query"]>;
  readonly #write: NonNullable<PeerRefreshCoordinatorOptions["write"]>;
  #closed = false;

  constructor(options: PeerRefreshCoordinatorOptions) {
    this.#onChanged = options.onChanged;
    this.#debug = options.debug ?? (() => undefined);
    this.#query = options.query ?? queryRemoteMachine;
    this.#write = options.write ?? writeCachedPeerView;
  }

  request(machine: RemoteMachine, reason: string): void {
    if (this.#closed) return;
    const state = this.#states.get(machine.id) ?? {
      running: false,
      pending: undefined,
      generation: 0,
      enabled: true,
    };
    state.enabled = true;
    state.pending = { machine, reason, generation: state.generation };
    this.#states.set(machine.id, state);
    if (!state.running) void this.#drain(machine.id, state);
  }

  forget(machineId: string): void {
    const state = this.#states.get(machineId);
    if (!state) return;
    state.enabled = false;
    state.generation++;
    state.pending = undefined;
    if (!state.running) this.#states.delete(machineId);
  }

  close(): void {
    this.#closed = true;
    this.#states.clear();
  }

  async #drain(machineId: string, state: PeerRefreshState): Promise<void> {
    state.running = true;
    try {
      while (!this.#closed && this.#states.get(machineId) === state && state.pending) {
        const { machine, reason, generation } = state.pending;
        state.pending = undefined;
        this.#debug(`Polling peer ${JSON.stringify(machine.name)} because ${reason}.`);
        try {
          const next = await this.#query(machine);
          if (this.#closed || this.#states.get(machineId) !== state) return;
          if (!state.enabled || generation !== state.generation) continue;
          const result = this.#write(machine, next);
          this.#debug(
            `Updated peer projection for ${JSON.stringify(machine.name)} (${next.connection}).`,
          );
          if (result.changed) this.#onChanged();
        } catch (error) {
          this.#debug(
            `Peer projection refresh failed for ${JSON.stringify(machine.name)}: ${JSON.stringify(error instanceof Error ? error.message : String(error))}.`,
          );
        }
      }
    } finally {
      state.running = false;
      if (this.#states.get(machineId) === state && !state.pending) this.#states.delete(machineId);
    }
  }
}

/** Maintain remote projections off the list request path using watch streams. */
export function startPeerObservers(
  onChanged: () => void,
  debug: (message: string) => void = () => undefined,
): PeerObserverHandle {
  const children = new Map<string, ChildProcess>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let closed = false;
  const refreshes = new PeerRefreshCoordinator({ onChanged, debug });

  const start = (machine: RemoteMachine, attempt = 0): void => {
    if (
      closed ||
      children.has(machine.id) ||
      !listRemoteMachines().some((candidate) => candidate.id === machine.id)
    )
      return;
    refreshes.request(
      machine,
      attempt ? `watch reconnect attempt ${attempt}` : "the observer started",
    );
    debug(`Watching peer ${JSON.stringify(machine.name)} for state changes.`);
    const child = spawn("ssh", remoteArgs(machine, "watch"), {
      stdio: ["ignore", "pipe", "ignore"],
    });
    children.set(machine.id, child);
    let buffer = "";
    let ready = false;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const event = JSON.parse(line) as { protocolVersion?: unknown; type?: unknown };
          if (event.protocolVersion === 1 && event.type === "ready") ready = true;
          if (
            event.protocolVersion === 1 &&
            (event.type === "ready" || event.type === "changed" || event.type === "heartbeat")
          )
            refreshes.request(
              machine,
              event.type === "ready"
                ? "the watch became ready"
                : event.type === "changed"
                  ? "the peer reported a change"
                  : "the peer sent a heartbeat",
            );
        } catch {
          // Reconnection will replace malformed streams.
        }
      }
    });
    child.on("error", () => undefined);
    child.on("close", () => {
      children.delete(machine.id);
      if (closed || !listRemoteMachines().some((candidate) => candidate.id === machine.id)) return;
      refreshes.request(machine, "the watch connection closed");
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(ready ? 0 : attempt, 5));
      debug(`Peer watch for ${JSON.stringify(machine.name)} closed; retrying in ${delay}ms.`);
      const timer = setTimeout(() => {
        retryTimers.delete(machine.id);
        start(machine, ready ? 0 : attempt + 1);
      }, delay);
      timer.unref();
      retryTimers.set(machine.id, timer);
    });
  };

  const reconcile = (): void => {
    const current = new Set(listRemoteMachines().map((machine) => machine.id));
    for (const [id, child] of children) {
      if (current.has(id)) continue;
      child.kill();
      children.delete(id);
      refreshes.forget(id);
    }
    for (const [id, timer] of retryTimers) {
      if (current.has(id)) continue;
      clearTimeout(timer);
      retryTimers.delete(id);
    }
    for (const machine of listRemoteMachines()) start(machine);
  };
  reconcile();
  const interval = setInterval(reconcile, 30_000);
  interval.unref();

  return {
    reconcile,
    close() {
      closed = true;
      refreshes.close();
      clearInterval(interval);
      for (const timer of retryTimers.values()) clearTimeout(timer);
      for (const child of children.values()) child.kill();
      retryTimers.clear();
      children.clear();
    },
  };
}
