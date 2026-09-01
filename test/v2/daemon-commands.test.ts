import { createServer, type Server } from "node:net";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  daemonRestart,
  daemonStart,
  daemonStatus,
  daemonStop,
  isBoxersDaemonCommand,
  tailDaemonLog,
  waitForProcessExit,
} from "../../src/v2/daemon-commands.ts";
import {
  daemonLogPath,
  daemonPidPath,
  daemonSocketPath,
  taskStatePath,
} from "../../src/v2/paths.ts";
import type { AgentTurnState } from "../../src/v2/types.ts";

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

async function activityFixture(response: unknown): Promise<ReturnType<typeof vi.spyOn>> {
  home = mkdtempSync(join(tmpdir(), "boxers-daemon-stop-"));
  process.env.BOXERS_HOME = home;
  const pid = 424_242;
  writeFileSync(daemonPidPath(), `${pid}\n`);
  server = createServer((socket) => {
    socket.once("data", () => socket.end(`${JSON.stringify(response)}\n`));
  });
  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject);
    server?.listen(daemonSocketPath(), resolve);
  });
  let stopped = false;
  return vi.spyOn(process, "kill").mockImplementation((target, signal) => {
    if (target !== pid) throw Object.assign(new Error("unexpected pid"), { code: "ESRCH" });
    if (signal === "SIGTERM") {
      stopped = true;
      return true;
    }
    if (signal === 0 && stopped) throw Object.assign(new Error("stopped"), { code: "ESRCH" });
    return true;
  });
}

function registerSessionTask(sessionId: string, agentTurnState: AgentTurnState): void {
  if (!home) throw new Error("Activity fixture has not been initialized.");
  const project = join(home, "projects", "project-id");
  const task = join(project, "tasks", "task-id");
  mkdirSync(task, { recursive: true });
  writeFileSync(
    join(project, "project.json"),
    `${JSON.stringify({
      version: 1,
      id: "project-id",
      root: "/tmp/project",
      seedPath: "/tmp/seed",
      integration: { mode: "local", base: "main" },
      createdAt: "2026-08-31T00:00:00.000Z",
    })}\n`,
  );
  writeFileSync(
    join(task, "task.json"),
    `${JSON.stringify({
      version: 3,
      id: "task-id",
      projectId: "project-id",
      name: "restart-boundary",
      runtime: { kind: "docker-sandboxes", id: sessionId },
      agent: "codex",
      sessionMode: "native",
      lifecycleBridgeToken: "0123456789abcdef0123456789abcdef",
      createdAt: "2026-08-31T00:00:00.000Z",
    })}\n`,
  );
  writeFileSync(
    taskStatePath("project-id", "task-id"),
    `${JSON.stringify({
      version: 3,
      taskId: "task-id",
      revision: 1,
      updatedAt: "2026-08-31T00:00:00.000Z",
      agentTurnState,
      conversationHighWaterSequence: agentTurnState === "not_started" ? 0 : 1,
      lifecycleDrainSequence: agentTurnState === "not_started" ? 0 : 1,
      promotionConversationCheckpoint: 0,
      hasUnmergedChanges: {
        value: "unknown",
        observedAt: "2026-08-31T00:00:00.000Z",
        source: "initial",
      },
    })}\n`,
  );
}

describe("daemon lifecycle safety", () => {
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

  it("refuses to stop while an agent session is running", async () => {
    const kill = await activityFixture({
      type: "sessions",
      pid: 424_242,
      sessions: [{ sessionId: "task", state: "running", viewers: 0 }],
      intents: [],
    });
    await expect(daemonStop()).rejects.toThrow(/1 agent session.*task activity unknown.*0 intent/s);
    expect(kill.mock.calls.some((call: unknown[]) => call[1] === "SIGTERM")).toBe(false);
  });

  it("stops when every running session has reached awaiting input", async () => {
    const sessionId = "boxers-project-restart-boundary";
    const kill = await activityFixture({
      type: "sessions",
      pid: 424_242,
      sessions: [{ sessionId, state: "running", viewers: 0 }],
      intents: [],
    });
    registerSessionTask(sessionId, "awaiting_input");
    vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await expect(daemonStop()).resolves.toBe(0);
    expect(kill.mock.calls.some((call: unknown[]) => call[1] === "SIGTERM")).toBe(true);
  });

  it("identifies a working task that prevents normal restart", async () => {
    const sessionId = "boxers-project-restart-boundary";
    const kill = await activityFixture({
      type: "sessions",
      pid: 424_242,
      sessions: [{ sessionId, state: "running", viewers: 0 }],
      intents: [],
    });
    registerSessionTask(sessionId, "working");

    await expect(daemonStop()).rejects.toThrow(
      /boxers-project-restart-boundary \(restart-boundary: working\)/,
    );
    expect(kill.mock.calls.some((call: unknown[]) => call[1] === "SIGTERM")).toBe(false);
  });

  it("refuses to stop while a durable intent is running", async () => {
    const kill = await activityFixture({
      type: "sessions",
      pid: 424_242,
      sessions: [],
      intents: [{ task: "reviewing" }],
    });
    await expect(daemonStop()).rejects.toThrow(/0 agent session.*1 intent/s);
    expect(kill.mock.calls.some((call: unknown[]) => call[1] === "SIGTERM")).toBe(false);
  });

  it("stops only after the daemon reports no live work", async () => {
    const kill = await activityFixture({
      type: "sessions",
      pid: 424_242,
      sessions: [],
      intents: [],
    });
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await expect(daemonStop()).resolves.toBe(0);
    expect(kill.mock.calls.some((call: unknown[]) => call[1] === "SIGTERM")).toBe(true);
  });

  it("refuses to signal a PID file that does not own the daemon socket", async () => {
    const kill = await activityFixture({
      type: "sessions",
      pid: 424_243,
      sessions: [],
      intents: [],
    });
    await expect(daemonStop()).rejects.toThrow(/socket belongs to PID 424243/);
    expect(kill.mock.calls.some((call: unknown[]) => call[1] === "SIGTERM")).toBe(false);
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
    ).rejects.toThrow(/could not be verified as an Boxers daemon/);
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
