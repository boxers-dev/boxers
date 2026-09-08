import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function readOwner(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function deadOwner(owner: string | undefined): boolean {
  const match = owner && /^(\d+)\n[^\n]+\n$/.exec(owner);
  const pid = match ? Number(match[1]) : 0;
  // Malformed ownership is not proof that another process has stopped.
  return Number.isSafeInteger(pid) && pid > 0 && !processAlive(pid);
}

function reclaimDeadOwner(path: string): boolean {
  const recovery = `${path}.recovery`;
  try {
    mkdirSync(recovery, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    writeFileSync(join(recovery, "owner"), `${process.pid}\n`, { mode: 0o600 });
    // Re-read under exclusive reclamation ownership. A late contender must not
    // unlink the new live owner that replaced the dead owner it first observed.
    if (deadOwner(readOwner(path))) unlinkSync(path);
  } finally {
    unlinkSync(join(recovery, "owner"));
    rmdirSync(recovery);
  }
  return true;
}

interface LockOptions {
  /** False when child processes can outlive the lock-owning worker. */
  reclaimDeadOwner?: boolean;
}

/** Serialize synchronous transactions; PID death alone cannot stop child writers. */
export function acquirePidFileLock(
  path: string,
  timeoutMs = 5_000,
  options: LockOptions = {},
): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();
  const owner = `${process.pid}\n${token}\n`;
  const temporary = `${path}.${token}.tmp`;
  // Publish a complete owner atomically. open("wx") followed by a PID write
  // exposes an empty lock that another process might mistake for a dead writer.
  writeFileSync(temporary, owner, { flag: "wx", mode: 0o600 });
  try {
    for (;;) {
      let unresolvedRecovery = false;
      try {
        linkSync(temporary, path);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (deadOwner(readOwner(path))) {
          if (options.reclaimDeadOwner === false)
            throw new Error(
              `The owner of ${path} exited, but child processes may still be modifying the shared seed. Verify those processes have stopped and inspect the seed before explicitly removing this lock.`,
            );
          unresolvedRecovery = !reclaimDeadOwner(path);
        }
      }
      if (Date.now() >= deadline)
        throw new Error(
          `Timed out waiting for state lock ${path}.${unresolvedRecovery ? ` Recovery ownership at ${path}.recovery is unresolved; inspect it before retrying.` : ""}`,
        );
      Atomics.wait(LOCK_WAIT, 0, 0, 10);
    }
  } finally {
    unlinkSync(temporary);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (readOwner(path) === owner) unlinkSync(path);
  };
}

export function withPidFileLock<T>(
  path: string,
  action: () => T,
  timeoutMs = 5_000,
  options: LockOptions = {},
): T {
  const release = acquirePidFileLock(path, timeoutMs, options);
  try {
    return action();
  } finally {
    release();
  }
}
