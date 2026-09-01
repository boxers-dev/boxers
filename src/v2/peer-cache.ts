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

/** Maintain remote projections off the list request path using watch streams. */
export function startPeerObservers(
  onChanged: () => void,
  debug: (message: string) => void = () => undefined,
): PeerObserverHandle {
  const children = new Map<string, ChildProcess>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let closed = false;

  const refresh = async (machine: RemoteMachine, reason: string): Promise<void> => {
    debug(`Polling peer ${JSON.stringify(machine.name)} because ${reason}.`);
    const next = await queryRemoteMachine(machine);
    writeCachedPeerView(machine, next);
    debug(`Updated peer projection for ${JSON.stringify(machine.name)} (${next.connection}).`);
    onChanged();
  };

  const start = (machine: RemoteMachine, attempt = 0): void => {
    if (
      closed ||
      children.has(machine.id) ||
      !listRemoteMachines().some((candidate) => candidate.id === machine.id)
    )
      return;
    void refresh(machine, attempt ? `watch reconnect attempt ${attempt}` : "the observer started");
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
            void refresh(
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
      void refresh(machine, "the watch connection closed");
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
      clearInterval(interval);
      for (const timer of retryTimers.values()) clearTimeout(timer);
      for (const child of children.values()) child.kill();
      retryTimers.clear();
      children.clear();
    },
  };
}
