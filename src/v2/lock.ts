import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Serialize short synchronous state transactions and recover locks left by dead writers. */
export function withPidFileLock<T>(path: string, action: () => T, timeoutMs = 5_000): T {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  let descriptor: number | undefined;
  while (descriptor === undefined) {
    try {
      descriptor = openSync(path, "wx", 0o600);
      try {
        writeFileSync(descriptor, `${process.pid}\n`);
      } catch (error) {
        closeSync(descriptor);
        descriptor = undefined;
        try {
          unlinkSync(path);
        } catch {
          // Preserve the write error below.
        }
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner = 0;
      try {
        owner = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
      } catch {
        // An interrupted writer left a recoverable lock.
      }
      if (!Number.isInteger(owner) || owner <= 0 || !processAlive(owner)) {
        try {
          unlinkSync(path);
        } catch {
          // Another writer recovered it first; retry below.
        }
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for state lock ${path}.`);
      Atomics.wait(LOCK_WAIT, 0, 0, 10);
    }
  }
  try {
    return action();
  } finally {
    closeSync(descriptor);
    try {
      unlinkSync(path);
    } catch {
      // A process exit also leaves a recoverable PID lock.
    }
  }
}
