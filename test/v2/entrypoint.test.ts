import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isDaemonBackedTaskInvocation } from "../../src/core/entrypoint.ts";

let stateDir: string | undefined;
let server: Server | undefined;
let child: ChildProcess | undefined;

afterEach(async () => {
  child?.kill("SIGKILL");
  child = undefined;
  if (server)
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
  server = undefined;
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  stateDir = undefined;
});

describe("CLI daemon boundary", () => {
  it("keeps daemon lifecycle commands on the direct CLI path", () => {
    expect(isDaemonBackedTaskInvocation(["feature", "check"])).toBe(true);
    expect(isDaemonBackedTaskInvocation(["feature", "status", "--refresh"])).toBe(true);
    expect(isDaemonBackedTaskInvocation(["daemon", "stop"])).toBe(false);
    expect(isDaemonBackedTaskInvocation(["daemon", "start"])).toBe(false);
    expect(isDaemonBackedTaskInvocation(["daemon", "stop", "--force"])).toBe(false);
    expect(isDaemonBackedTaskInvocation(["daemon", "status"])).toBe(false);
    expect(isDaemonBackedTaskInvocation(["server/task", "review"])).toBe(false);
    expect(isDaemonBackedTaskInvocation(["server/task", "status", "--refresh"])).toBe(false);
  });

  it("keeps plain recorded-state views off the daemon intent path", () => {
    expect(isDaemonBackedTaskInvocation(["list"])).toBe(false);
    expect(isDaemonBackedTaskInvocation(["ls"])).toBe(false);
    expect(isDaemonBackedTaskInvocation(["task", "status"])).toBe(false);
    expect(isDaemonBackedTaskInvocation(["task", "status", "--refresh"])).toBe(true);
  });

  it("lets doctor diagnose an unresponsive daemon without negotiating with it", async () => {
    stateDir = mkdtempSync(join(tmpdir(), "boxers-doctor-entrypoint-"));
    const socketPath = join(stateDir, "daemon.sock");
    writeFileSync(join(stateDir, "daemon.pid"), `${process.pid}\n`);

    let connections = 0;
    server = createServer(() => {
      connections++;
      // Model a wedged daemon that accepts the socket without answering; normal
      // negotiation would wait until the client timeout.
    });
    await new Promise<void>((resolve, reject) => {
      server?.once("error", reject);
      server?.listen(socketPath, resolve);
    });

    const binDir = join(stateDir, "bin");
    mkdirSync(binDir);
    for (const command of ["git", "sbx", "systemctl"]) {
      const path = join(binDir, command);
      writeFileSync(path, "#!/bin/sh\nexit 1\n");
      chmodSync(path, 0o755);
    }

    child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", "doctor", "--json"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOXERS_HOME: stateDir,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child?.kill("SIGKILL");
    }, 2_000);
    const code = await new Promise<number | null>((resolve) => child?.once("close", resolve));
    clearTimeout(timeout);

    expect(timedOut, stderr).toBe(false);
    expect(code).toBe(1);
    expect(connections).toBe(0);
    const result = JSON.parse(stdout) as {
      checks: { name: string; ok: boolean; detail: string; remediation?: { value: string } }[];
    };
    expect(result.checks).toContainEqual(
      expect.objectContaining({ name: "daemon process", ok: true }),
    );
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        name: "daemon protocol",
        ok: false,
        detail: expect.stringContaining("protocol unknown"),
        remediation: expect.objectContaining({ value: expect.stringContaining("daemon stop") }),
      }),
    );
  });
});
