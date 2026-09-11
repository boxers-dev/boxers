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
    if (deadOwner(readOwner(path))) unlinkSync(path);
  } finally {
    unlinkSync(join(recovery, "owner"));
    rmdirSync(recovery);
  }
  return true;
}

export function acquirePidFileLock(path: string, timeoutMs = 5_000): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();
  const owner = `${process.pid}\n${token}\n`;
  const temporary = `${path}.${token}.tmp`;
  writeFileSync(temporary, owner, { flag: "wx", mode: 0o600 });
  try {
    for (;;) {
      try {
        linkSync(temporary, path);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (deadOwner(readOwner(path))) reclaimDeadOwner(path);
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}.`);
      Atomics.wait(LOCK_WAIT, 0, 0, Math.min(50, deadline - Date.now()));
    }
  } finally {
    unlinkSync(temporary);
  }
  return () => {
    if (readOwner(path) === owner) unlinkSync(path);
  };
}

export function withPidFileLock<T>(path: string, action: () => T, timeoutMs = 5_000): T {
  const release = acquirePidFileLock(path, timeoutMs);
  try {
    return action();
  } finally {
    release();
  }
}
