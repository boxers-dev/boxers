import { randomUUID } from "node:crypto";

let enabled = false;

/** Only daemon workers participate; direct command/unit-test callers do not use IPC. */
export function enableWorkerWorkspaceOwnership(): void {
  if (enabled) return;
  enabled = true;
  // A group SIGTERM also stops synchronous Git children. Defer the worker's
  // exit until its JS stack unwinds, so completed seed transactions release
  // their locks. SIGKILL still leaves an intentionally non-reclaimable lock.
  process.once("SIGTERM", () => process.exit(143));
}

function transfer(action: "acquire" | "release"): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.connected || !process.send) {
      reject(new Error("Daemon disconnected before transferring workspace ownership."));
      return;
    }
    const id = randomUUID();
    const cleanup = (): void => {
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
    };
    const onMessage = (message: unknown): void => {
      if (!message || typeof message !== "object") return;
      const reply = message as { type?: string; id?: string };
      if (reply.type !== "boxers-worker-ownership-ack" || reply.id !== id) return;
      cleanup();
      resolve();
    };
    const onDisconnect = (): void => {
      cleanup();
      reject(new Error("Daemon disconnected while transferring workspace ownership."));
    };
    process.on("message", onMessage);
    process.once("disconnect", onDisconnect);
    process.send({ type: "boxers-worker-ownership", id, action }, (error) => {
      if (!error) return;
      cleanup();
      reject(error);
    });
  });
}

/** Input/cancellation must wait until the worker acknowledges a safe boundary. */
export async function withWorkerWorkspaceMutation<T>(action: () => T | Promise<T>): Promise<T> {
  if (!enabled) return action();
  await transfer("acquire");
  try {
    return await action();
  } finally {
    await transfer("release");
  }
}
