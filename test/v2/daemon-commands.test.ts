import { createServer, type Server } from "node:net";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  daemonRestart,
  daemonStart,
  daemonStatus,
  daemonStop,
  isBoxersDaemonCommand,
  type PreparedShutdownResult,
  runDaemonReplacement,
  tailDaemonLog,
  waitForProcessExit,
} from "../../src/v2/daemon-commands.ts";
import {
  daemonLockPath,
  daemonLogPath,
  daemonPidPath,
  daemonSocketPath,
} from "../../src/v2/paths.ts";
import type { ShutdownReason } from "../../src/v2/daemon-protocol.ts";

const previousHome = process.env.BOXERS_HOME;
let home: string | undefined;
let server: Server | undefined;

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (server)
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
  server = undefined;
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
  if (previousHome === undefined) delete process.env.BOXERS_HOME;
  else process.env.BOXERS_HOME = previousHome;
});

async function activityFixture(
  response: unknown,
  recordedPid = 424_242,
): Promise<ReturnType<typeof vi.spyOn>> {
  home = mkdtempSync(join(tmpdir(), "boxers-daemon-stop-"));
  process.env.BOXERS_HOME = home;
  const pid = 424_242;
  writeFileSync(daemonPidPath(), `${recordedPid}\n`);
  server = createServer((socket) => {
    socket.once("data", (chunk) => {
      if ((response as { type?: string }).type !== "sessions") {
        socket.end(`${JSON.stringify(response)}\n`);
        return;
      }
      const request = JSON.parse(String(chunk)) as { type: string; requestId: string };
      if (request.type !== "prepare_shutdown") {
        socket.end(`${JSON.stringify(response)}\n`);
        return;
      }
      const activity = response as { pid: number };
      socket.end(
        `${JSON.stringify({ type: "shutdown_started", requestId: request.requestId, pid: activity.pid })}\n`,
      );
      stopped = true;
    });
  });
  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject);
    server?.listen(daemonSocketPath(), resolve);
  });
  let stopped = false;
  return vi.spyOn(process, "kill").mockImplementation((target, signal) => {
    if (target === recordedPid && recordedPid !== pid && signal === 0)
      throw Object.assign(new Error("stale pid"), { code: "ESRCH" });
    if (target !== pid) throw Object.assign(new Error("unexpected pid"), { code: "ESRCH" });
    if (signal === "SIGTERM") {
      stopped = true;
      return true;
    }
    if (signal === 0 && stopped) throw Object.assign(new Error("stopped"), { code: "ESRCH" });
    return true;
  });
}

describe("daemon lifecycle safety", () => {
  it("retires a daemon replacement whose build was superseded", async () => {
    const buildId = "a".repeat(64);
    const newerBuildId = "b".repeat(64);
    const kill = vi.spyOn(process, "kill");

    await expect(runDaemonReplacement(buildId, () => newerBuildId)).resolves.toBe(0);

    expect(kill).not.toHaveBeenCalled();
  });

  it("performs one bounded stop and start for the activated build", async () => {
    const buildId = "a".repeat(64);
    const requests: string[] = [];
    const requestShutdown = vi.fn(
      async (reason: ShutdownReason): Promise<PreparedShutdownResult> => {
        requests.push(reason);
        return { status: "started", pid: 424_242 };
      },
    );
    const start = vi.fn(async () => 0);

    await expect(
      runDaemonReplacement(buildId, () => buildId, {
        requestShutdown,
        waitForExit: async () => undefined,
        start,
      }),
    ).resolves.toBe(0);

    expect(requests).toEqual(["update"]);
    expect(start).toHaveBeenCalledOnce();
  });

  it("keeps a service waiter alive until the existing daemon exits", async () => {
    vi.useFakeTimers();
    let alive = true;
    let settled = false;
    const waiting = waitForProcessExit(424_242, () => alive, 100).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBe(false);
    alive = false;
    await vi.advanceTimersByTimeAsync(100);
    await waiting;
    expect(settled).toBe(true);
  });

  it("starts the daemon through the readiness-checked background path", async () => {
    home = mkdtempSync(join(tmpdir(), "boxers-daemon-start-"));
    process.env.BOXERS_HOME = home;
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await expect(
      daemonStart(async () => {
        writeFileSync(daemonPidPath(), "424242\n");
      }),
    ).resolves.toBe(0);

    expect(write).toHaveBeenCalledWith("Started the boxers daemon (pid 424242).\n");
  });

  it("restarts by completing the safe stop before starting a replacement", async () => {
    const order: string[] = [];
    await expect(
      daemonRestart(
        false,
        async (force) => {
          order.push(`stop:${force}`);
          return 0;
        },
        async () => {
          order.push("start");
          return 0;
        },
      ),
    ).resolves.toBe(0);
    expect(order).toEqual(["stop:false", "start"]);
  });

  it("does not start a replacement when safe shutdown is refused", async () => {
    const start = vi.fn(async () => 0);
    await expect(
      daemonRestart(
        false,
        async () => {
          throw new Error("daemon still owns live work");
        },
        start,
      ),
    ).rejects.toThrow(/still owns live work/);
    expect(start).not.toHaveBeenCalled();
  });

  it("recognizes the internal and foreground Boxers daemon entrypoints", () => {
    expect(
      isBoxersDaemonCommand(
        "/usr/bin/node /usr/local/lib/node_modules/@boxers-dev/boxers/dist/index.mjs __daemon-run",
      ),
    ).toBe(true);
    expect(isBoxersDaemonCommand("/usr/local/bin/boxers debug daemon")).toBe(true);
    expect(isBoxersDaemonCommand("/usr/bin/node /srv/other/index.mjs debug daemon")).toBe(false);
    expect(isBoxersDaemonCommand("/usr/local/bin/boxers doctor")).toBe(false);
  });

  it("tails recent and appended output from an existing daemon until it stops", async () => {
    home = mkdtempSync(join(tmpdir(), "boxers-daemon-tail-"));
    process.env.BOXERS_HOME = home;
    writeFileSync(
      daemonLogPath(),
      `${Array.from({ length: 25 }, (_, index) => `line ${index + 1}`).join("\n")}\n`,
    );
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    let alive = true;
    vi.useFakeTimers();

    const tailing = tailDaemonLog(daemonLogPath(), 424_242, () => alive);
    let output = write.mock.calls.map((call) => String(call[0])).join("");
    expect(output).not.toContain("line 5\n");
    expect(output).toContain("line 6\n");
    expect(output).toContain("line 25\n");

    appendFileSync(daemonLogPath(), "new output\n");
    await vi.advanceTimersByTimeAsync(250);
    output = write.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("new output\n");

    alive = false;
    await vi.advanceTimersByTimeAsync(250);
    await expect(tailing).resolves.toBe(0);
    expect(write).toHaveBeenCalledWith("The boxers daemon (pid 424242) stopped.\n");
  });

  it("stops even while daemon-owned work is active", async () => {
    const kill = await activityFixture({
      type: "sessions",
      pid: 424_242,
      sessions: [{ sessionId: "task", state: "running", viewers: 1 }],
      intents: [{ task: "reviewing" }],
      backgroundWork: 1,
    });
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await expect(daemonStop()).resolves.toBe(0);
    expect(kill.mock.calls.some((call: unknown[]) => call[1] === 0)).toBe(true);
  });

  it("stops the live socket owner when the PID file is stale", async () => {
    const kill = await activityFixture(
      {
        type: "sessions",
        pid: 424_242,
        sessions: [],
        intents: [],
      },
      424_243,
    );
    vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await expect(daemonStop()).resolves.toBe(0);
    expect(kill.mock.calls.some((call: unknown[]) => call[0] === 424_242 && call[1] === 0)).toBe(
      true,
    );
  });

  it("force-stops a verified daemon without querying its socket", async () => {
    const kill = await activityFixture({ type: "unresponsive-daemon" });
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await expect(
      daemonStop(
        true,
        () =>
          "/usr/bin/node /usr/local/lib/node_modules/@boxers-dev/boxers/dist/index.mjs __daemon-run",
      ),
    ).resolves.toBe(0);
    expect(kill.mock.calls.some((call: unknown[]) => call[1] === "SIGTERM")).toBe(true);
  });

  it("refuses to force-stop a PID whose process identity is unrelated", async () => {
    const kill = await activityFixture({ type: "ignored" });

    await expect(
      daemonStop(true, () => "/usr/bin/node /srv/other/index.mjs __daemon-run"),
    ).rejects.toThrow(/could not be verified as a Boxers daemon/);
    expect(kill.mock.calls.some((call: unknown[]) => call[1] === "SIGTERM")).toBe(false);
  });

  it("escalates a verified daemon that ignores SIGTERM", async () => {
    home = mkdtempSync(join(tmpdir(), "boxers-daemon-stop-"));
    process.env.BOXERS_HOME = home;
    writeFileSync(daemonPidPath(), "424242\n");
    let killed = false;
    const kill = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
      if (target !== 424_242) throw Object.assign(new Error("unexpected pid"), { code: "ESRCH" });
      if (signal === "SIGKILL") {
        killed = true;
        return true;
      }
      if (signal === 0 && killed) throw Object.assign(new Error("stopped"), { code: "ESRCH" });
      return true;
    });
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.useFakeTimers();

    const stopping = daemonStop(true, () => "/usr/local/bin/boxers debug daemon");
    await vi.advanceTimersByTimeAsync(4_100);
    await expect(stopping).resolves.toBe(0);
    expect(kill.mock.calls.some((call: unknown[]) => call[1] === "SIGKILL")).toBe(true);
  });

  it("force-stops a verified lock owner when the PID file is stale", async () => {
    home = mkdtempSync(join(tmpdir(), "boxers-daemon-stop-"));
    process.env.BOXERS_HOME = home;
    writeFileSync(daemonPidPath(), "424243\n");
    writeFileSync(daemonLockPath(), "424242\n");
    let stopped = false;
    const kill = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
      if (target === 424_243 && signal === 0)
        throw Object.assign(new Error("stale pid"), { code: "ESRCH" });
      if (target !== 424_242) throw Object.assign(new Error("unexpected pid"), { code: "ESRCH" });
      if (signal === "SIGTERM") {
        stopped = true;
        return true;
      }
      if (signal === 0 && stopped) throw Object.assign(new Error("stopped"), { code: "ESRCH" });
      return true;
    });
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await expect(daemonStop(true, () => "/usr/local/bin/boxers debug daemon")).resolves.toBe(0);
    expect(
      kill.mock.calls.some((call: unknown[]) => call[0] === 424_242 && call[1] === "SIGTERM"),
    ).toBe(true);
  });

  it("reports an active but unresponsive daemon accurately", async () => {
    await activityFixture({ type: "unresponsive-daemon" });
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await expect(daemonStatus(true)).resolves.toBe(1);
    const output = write.mock.calls.map((call) => String(call[0])).join("");
    expect(JSON.parse(output)).toMatchObject({
      running: true,
      responsive: false,
      pid: 424_242,
    });
  });

  it("points an unverifiable normal stop at explicit force recovery", async () => {
    await activityFixture({ type: "unresponsive-daemon" });

    await expect(daemonStop()).rejects.toThrow(/boxers daemon stop --force/);
  });
});
