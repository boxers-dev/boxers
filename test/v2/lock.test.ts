import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { acquirePidFileLock, withPidFileLock } from "../../src/v2/lock.ts";

const directories: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const closed = once(child, "close");
    child.kill("SIGKILL");
    await closed;
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "boxers-lock-test-"));
  directories.push(path);
  return path;
}

function worker(script: string) {
  const module = pathToFileURL(join(process.cwd(), "src/v2/lock.ts")).href;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import { acquirePidFileLock, withPidFileLock } from ${JSON.stringify(module)};\n${script}`,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  children.push(child);
  let stderr = "";
  child.stderr!.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const done = once(child, "close").then(([code, signal]) => ({ code, signal, stderr }));
  return { child, done };
}

describe("PID file locking", () => {
  it("releases on action failure and removes publication files", () => {
    const root = directory();
    expect(() =>
      withPidFileLock(join(root, "lock"), () => {
        throw new Error("action failed");
      }),
    ).toThrow("action failed");
    expect(readdirSync(root)).toEqual([]);
  });

  it("never steals a live owner and releases idempotently", () => {
    const root = directory();
    const path = join(root, "lock");
    const release = acquirePidFileLock(path);
    const owner = readFileSync(path, "utf8");
    expect(() => acquirePidFileLock(path, 25)).toThrow("Timed out");
    expect(readFileSync(path, "utf8")).toBe(owner);
    release();
    const next = acquirePidFileLock(path);
    release();
    expect(readFileSync(path, "utf8")).not.toBe(owner);
    next();
    expect(readdirSync(root)).toEqual([]);
  });

  it("does not interpret malformed ownership as a dead writer", () => {
    const root = directory();
    const path = join(root, "lock");
    writeFileSync(path, "");
    expect(() => acquirePidFileLock(path, 25)).toThrow("Timed out");
    expect(readFileSync(path, "utf8")).toBe("");
    expect(readdirSync(root)).toEqual(["lock"]);
  });

  it("does not guess how to recover an interrupted reclamation", async () => {
    const root = directory();
    const path = join(root, "lock");
    const holder = worker(
      `acquirePidFileLock(${JSON.stringify(path)}); process.send('ready'); setInterval(() => {}, 1000);`,
    );
    await once(holder.child, "message");
    holder.child.kill("SIGKILL");
    expect((await holder.done).signal).toBe("SIGKILL");
    mkdirSync(`${path}.recovery`);
    const owner = readFileSync(path, "utf8");
    expect(() => acquirePidFileLock(path, 25)).toThrow("Recovery ownership");
    expect(readFileSync(path, "utf8")).toBe(owner);
  });

  it("serializes competing processes reclaiming a dead owner", async () => {
    const root = directory();
    const path = join(root, "lock");
    const holder = worker(
      `acquirePidFileLock(${JSON.stringify(path)}); process.send('ready'); setInterval(() => {}, 1000);`,
    );
    await once(holder.child, "message");
    holder.child.kill("SIGKILL");
    expect((await holder.done).signal).toBe("SIGKILL");
    const counter = join(root, "counter");
    writeFileSync(counter, "0");
    const contenders = Array.from({ length: 8 }, () =>
      worker(`
      import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
      for (let i = 0; i < 30; i++) withPidFileLock(${JSON.stringify(path)}, () => {
        const sentinel = ${JSON.stringify(join(root, "exclusive"))};
        const fd = openSync(sentinel, 'wx');
        const value = Number(readFileSync(${JSON.stringify(counter)}, 'utf8'));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
        writeFileSync(${JSON.stringify(counter)}, String(value + 1));
        closeSync(fd);
        unlinkSync(sentinel);
      });
      process.disconnect();
    `),
    );
    for (const result of await Promise.all(contenders.map((contender) => contender.done)))
      expect(result).toEqual({ code: 0, signal: null, stderr: "" });
    expect(readFileSync(counter, "utf8")).toBe("240");
    expect(readdirSync(root)).toEqual(["counter"]);
  }, 20_000);
});
