import { connect, type Socket } from "node:net";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { daemonMain, runDaemon, type DaemonHandle } from "../../src/v2/daemon.ts";
import {
  DAEMON_PROTOCOL_VERSION,
  encodeMessage,
  LineDecoder,
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
} from "../../src/v2/daemon-protocol.ts";
import {
  atomicWriteJson,
  daemonHealthPath,
  daemonLockPath,
  daemonPidPath,
  daemonSocketPath,
  fleetPath,
  orphanedTaskDir,
  taskReconciliationPath,
} from "../../src/v2/paths.ts";
import {
  createTaskManifest,
  initProject,
  listProjects,
  listTasks,
  refreshSeed,
  updateTask,
} from "../../src/v2/registry.ts";
import { readTaskState, recordLifecycleEvent, updateTaskState } from "../../src/v2/state.ts";
import { encodeLifecycleWakeFrame } from "../../src/v2/pty-control.ts";

const cleanupDirs: string[] = [];
let daemon: DaemonHandle | undefined;
const extraDaemons: DaemonHandle[] = [];
const sockets: Socket[] = [];
let previousBoxersHome: string | undefined;

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  if (daemon) {
    await daemon.close();
    daemon = undefined;
  }
  for (const extraDaemon of extraDaemons.splice(0)) await extraDaemon.close();
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (previousBoxersHome === undefined) delete process.env.BOXERS_HOME;
  else process.env.BOXERS_HOME = previousBoxersHome;
  previousBoxersHome = undefined;
});

function tempSocketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "boxers-daemon-test-"));
  cleanupDirs.push(dir);
  return join(dir, "daemon.sock");
}

function useTemporaryState(): string {
  const state = mkdtempSync(join(tmpdir(), "boxers-daemon-state-"));
  cleanupDirs.push(state);
  previousBoxersHome = process.env.BOXERS_HOME;
  process.env.BOXERS_HOME = state;
  return state;
}

function registerTask(state: string, name: string, runtimeId: string): void {
  const projectDir = join(state, "projects", "project-id");
  const taskDir = join(projectDir, "tasks", "task-id");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(
    join(projectDir, "project.json"),
    `${JSON.stringify({
      version: 1,
      id: "project-id",
      root: "/tmp/project",
      seedPath: "/tmp/seed",
      integration: { remote: "origin", base: "main" },
      createdAt: "2026-08-26T00:00:00.000Z",
    })}\n`,
  );
  writeFileSync(
    join(taskDir, "task.json"),
    `${JSON.stringify({
      version: 3,
      id: "task-id",
      projectId: "project-id",
      name,
      runtime: { kind: "docker-sandboxes", id: runtimeId },
      agent: "codex",
      sessionMode: "native",
      lifecycleBridgeToken: "0123456789abcdef0123456789abcdef",
      createdAt: "2026-08-26T00:00:00.000Z",
      lastSnapshot: { phase: "idle", agent: "codex", runtimeState: "running" },
    })}\n`,
  );
}

function targetChangeFixture() {
  const state = useTemporaryState();
  const root = join(state, "checkout");
  mkdirSync(root);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("commit", "--allow-empty", "-q", "-m", "base");
  const project = initProject({ base: "main", remote: root, cwd: root });
  const baseOid = git("rev-parse", "HEAD");
  const task = (name: string, runtimeState = "running") => {
    const created = createTaskManifest(project, name, "codex");
    return updateTask(project, created, {
      phase: "idle",
      agent: "codex",
      targetOid: baseOid,
      runtimeState,
    });
  };
  const advance = () => {
    git("commit", "--allow-empty", "-q", "-m", "upstream");
    return refreshSeed(project);
  };
  return { project, task, advance };
}

it("coalesces target hints, refreshes idle siblings, and defers working or stopped tasks", async () => {
  const fixture = targetChangeFixture();
  const accepted = fixture.task("accepted");
  const idle = fixture.task("idle");
  const working = fixture.task("working");
  const stopped = fixture.task("stopped", "stopped");
  recordLifecycleEvent(fixture.project, working, {
    version: 1,
    sequence: 1,
    event: {
      version: 1,
      kind: "user_prompt",
      provider: "codex",
      providerSessionId: "session",
      prompt: "work",
      recordedAt: new Date().toISOString(),
    },
    source: { provider: "codex", hookEvent: "UserPromptSubmit", rawBytes: 1 },
  });
  const targetOid = fixture.advance();
  updateTaskState(fixture.project, accepted, { baseOid: targetOid }, "git");
  const starts: { name: string; sequence: number; targetChanged?: boolean }[] = [];
  const socketPath = tempSocketPath();
  daemon = runDaemon(socketPath, {
    executePostTurn: async (name, sequence, _signal, _progress, targetChanged) => {
      starts.push({ name, sequence, targetChanged: Boolean(targetChanged) });
      return {};
    },
  });
  const client = await connectClient(socketPath);
  client.send({ type: "target_changed", projectId: fixture.project.id });
  client.send({ type: "target_changed", projectId: fixture.project.id });
  await waitUntil(() => starts.length === 1);
  expect(starts).toEqual([{ name: idle.name, sequence: 0, targetChanged: true }]);
  for (const task of [idle, working, stopped])
    expect(readTaskState(fixture.project, task).observedTargetOid).toBe(targetOid);

  fixture.advance();
  client.send({ type: "target_changed", projectId: fixture.project.id });
  await waitUntil(() => starts.length === 3); // Both formerly accepted and idle are now behind.
  expect(starts.filter((start) => start.name === idle.name)).toHaveLength(2);
  expect(starts.some((start) => [working.name, stopped.name].includes(start.name))).toBe(false);
});

it("drains the newest target after an explicit operation without canceling it", async () => {
  const fixture = targetChangeFixture();
  const task = fixture.task("busy");
  let release!: () => void;
  const operation = new Promise<void>((resolve) => {
    release = resolve;
  });
  let running = false;
  const starts: string[] = [];
  const socketPath = tempSocketPath();
  daemon = runDaemon(socketPath, {
    executeIntent: async () => {
      running = true;
      await operation;
      return 0;
    },
    executePostTurn: async () => {
      starts.push(readTaskState(fixture.project, task).observedTargetOid!);
      return {};
    },
  });
  const client = await connectClient(socketPath);
  client.send({
    type: "run_intent",
    intentId: "busy",
    task: task.name,
    intent: { kind: "review" },
  });
  await waitUntil(() => running);
  fixture.advance();
  client.send({ type: "target_changed", projectId: fixture.project.id });
  const latest = fixture.advance();
  client.send({ type: "target_changed", projectId: fixture.project.id });
  await waitUntil(() => readTaskState(fixture.project, task).observedTargetOid === latest);
  expect(starts).toEqual([]);
  release();
  await client.next((message) => message.type === "intent_exited");
  await waitUntil(() => starts.length === 1);
  expect(starts).toEqual([latest]);
});

it("retains a newer target while preparation runs and does not interrupt repair", async () => {
  const fixture = targetChangeFixture();
  const task = fixture.task("preparing");
  let release!: () => void;
  const operation = new Promise<void>((resolve) => {
    release = resolve;
  });
  const starts: string[] = [];
  let firstSignal: AbortSignal | undefined;
  const socketPath = tempSocketPath();
  daemon = runDaemon(socketPath, {
    executePostTurn: async (_name, _sequence, signal) => {
      const target = readTaskState(fixture.project, task).observedTargetOid!;
      starts.push(target);
      if (starts.length === 1) {
        firstSignal = signal;
        await operation;
      }
      updateTaskState(fixture.project, task, { baseOid: target }, "git");
      return { targetOid: target };
    },
  });
  const client = await connectClient(socketPath);
  const first = fixture.advance();
  client.send({ type: "target_changed", projectId: fixture.project.id });
  await waitUntil(() => starts.length === 1);
  const latest = fixture.advance();
  client.send({ type: "target_changed", projectId: fixture.project.id });
  await waitUntil(() => readTaskState(fixture.project, task).observedTargetOid === latest);
  expect(firstSignal?.aborted).toBe(false);
  release();
  await waitUntil(() => starts.length === 2);
  expect(starts).toEqual([first, latest]);
});

it("retains target work canceled by a command that does not prepare the candidate", async () => {
  const fixture = targetChangeFixture();
  const task = fixture.task("canceled-target");
  let launches = 0;
  const socketPath = tempSocketPath();
  daemon = runDaemon(socketPath, {
    executeIntent: async () => 0,
    executePostTurn: async (_name, _sequence, signal) => {
      launches++;
      if (launches === 1)
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      else
        updateTaskState(
          fixture.project,
          task,
          { baseOid: readTaskState(fixture.project, task).observedTargetOid! },
          "git",
        );
      return {};
    },
  });
  const client = await connectClient(socketPath);
  fixture.advance();
  client.send({ type: "target_changed", projectId: fixture.project.id });
  await waitUntil(() => launches === 1);
  client.send({
    type: "run_intent",
    intentId: "preview",
    task: task.name,
    intent: { kind: "preview", action: "logs" },
  });
  await client.next((message) => message.type === "intent_exited");
  await waitUntil(() => launches === 2);
});

it("drains a working task's pending target when its real Stop wake arrives", async () => {
  const fixture = targetChangeFixture();
  const task = fixture.task("working-target");
  recordLifecycleEvent(fixture.project, task, {
    version: 1,
    sequence: 1,
    event: {
      version: 1,
      kind: "user_prompt",
      provider: "codex",
      providerSessionId: "session",
      prompt: "work",
      recordedAt: new Date().toISOString(),
    },
    source: { provider: "codex", hookEvent: "UserPromptSubmit", rawBytes: 1 },
  });
  let launches = 0;
  const socketPath = tempSocketPath();
  daemon = runDaemon(socketPath, {
    ingestLifecycle: async (_name, through) => {
      if (through !== 2) return [];
      recordLifecycleEvent(fixture.project, task, {
        version: 1,
        sequence: 2,
        event: {
          version: 1,
          kind: "turn_finished",
          provider: "codex",
          providerSessionId: "session",
          recordedAt: new Date().toISOString(),
        },
        source: { provider: "codex", hookEvent: "Stop", rawBytes: 1 },
      });
      return [{ sequence: 2, kind: "turn_finished" }];
    },
    executePostTurn: async (_name, sequence, _signal, _progress, targetChanged) => {
      expect(sequence).toBe(2);
      expect(targetChanged).toBe(true);
      launches++;
      return {};
    },
  });
  const client = await connectClient(socketPath);
  const targetOid = fixture.advance();
  client.send({ type: "target_changed", projectId: fixture.project.id });
  await waitUntil(() => readTaskState(fixture.project, task).observedTargetOid === targetOid);
  expect(launches).toBe(0);
  const frame = encodeLifecycleWakeFrame(task.lifecycleBridgeToken!, 2);
  client.send({
    type: "start_session",
    requestId: "finish",
    sessionId: task.runtime.id,
    taskName: task.name,
    bridgeToken: task.lifecycleBridgeToken!,
    command: process.execPath,
    args: ["-e", `process.stdout.write(${JSON.stringify(frame)});setInterval(()=>{},1000)`],
    cols: 80,
    rows: 24,
  });
  await client.next((message) => message.type === "session_started");
  await waitUntil(() => launches === 1);
});

it("does not strand the daemon lock when synchronous startup fails", () => {
  useTemporaryState();
  atomicWriteJson(fleetPath(), {
    version: 1,
    fleetId: "invalid-fleet",
    members: [{}],
    removedMembers: [],
    updatedAt: "2026-09-01T00:00:00.000Z",
  });

  expect(() => daemonMain()).toThrow("Invalid fleet member host ID");
  expect(existsSync(daemonLockPath())).toBe(false);
  expect(existsSync(daemonSocketPath())).toBe(false);
});

it("does not steal a live daemon lock when command-line identity is obscured", () => {
  useTemporaryState();
  writeFileSync(daemonLockPath(), `${process.pid}\n`);
  writeFileSync(daemonPidPath(), `${process.pid}\n`);
  atomicWriteJson(daemonHealthPath(), { version: 1, pid: process.pid });

  expect(daemonMain()).toBe(false);
  expect(readFileSync(daemonLockPath(), "utf8")).toBe(`${process.pid}\n`);
  expect(existsSync(daemonSocketPath())).toBe(false);
});

interface Client {
  send: (message: ClientMessage) => void;
  next: (predicate?: (message: ServerMessage) => boolean) => Promise<ServerMessage>;
  socket: Socket;
}

function connectClient(socketPath: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    sockets.push(socket);
    const decoder = new LineDecoder();
    const pending: ((message: ServerMessage) => boolean)[] = [];
    const queue: ServerMessage[] = [];
    const waiters: {
      predicate: ((message: ServerMessage) => boolean) | undefined;
      resolve: (m: ServerMessage) => void;
    }[] = [];
    socket.setEncoding("utf8");
    socket.once("connect", () =>
      resolve({
        socket,
        send: (message) => socket.write(encodeMessage(message)),
        next: (predicate) =>
          new Promise((resolveNext) => {
            const index = queue.findIndex((m) => !predicate || predicate(m));
            if (index >= 0) {
              resolveNext(queue.splice(index, 1)[0] as ServerMessage);
              return;
            }
            waiters.push({ predicate, resolve: resolveNext });
          }),
      }),
    );
    socket.once("error", reject);
    socket.on("data", (chunk: string) => {
      for (const line of decoder.push(chunk)) {
        const message = parseServerMessage(line);
        if (!message) continue;
        const waiterIndex = waiters.findIndex((w) => !w.predicate || w.predicate(message));
        if (waiterIndex >= 0) waiters.splice(waiterIndex, 1)[0]?.resolve(message);
        else queue.push(message);
      }
    });
    void pending;
  });
}

// A tiny Node one-liner stands in for a long-running interactive agent: it
// prints a marker, then echoes stdin lines back so tests can prove input
// only reaches the pty from the currently-active viewer.
const ECHO_SCRIPT =
  "process.stdout.write('ready\\n');" +
  "process.stdin.on('data', (d) => process.stdout.write('echo:' + d));";

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for daemon state.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("daemon session lifecycle", () => {
  it("prepares shutdown for a fresh task and freezes new admission", async () => {
    const state = useTemporaryState();
    registerTask(state, "fresh", "runtime-fresh");
    const shutdowns: string[] = [];
    const drains: string[] = [];
    const socketPath = tempSocketPath();
    daemon = runDaemon(socketPath, {
      ingestLifecycle: async (taskName) => {
        drains.push(taskName);
        return [];
      },
      onPreparedShutdown: (reason) => shutdowns.push(reason),
    });
    const viewer = await connectClient(socketPath);
    viewer.send({
      type: "attach",
      sessionId: "runtime-fresh",
      taskName: "fresh",
      command: process.execPath,
      args: ["-e", ECHO_SCRIPT],
      cols: 80,
      rows: 24,
    });
    await viewer.next((message) => message.type === "output" || message.type === "replay");

    const control = await connectClient(socketPath);
    control.send({ type: "prepare_shutdown", requestId: "fresh-stop", reason: "restart" });
    await expect(
      control.next((message) => message.type === "shutdown_started"),
    ).resolves.toMatchObject({ type: "shutdown_started", requestId: "fresh-stop" });
    expect(shutdowns).toEqual(["restart"]);
    expect(drains).toContain("fresh");

    const rejected = await connectClient(socketPath);
    rejected.send({
      type: "start_session",
      requestId: "too-late",
      sessionId: "late",
      taskName: "fresh",
      bridgeToken: "0123456789abcdef0123456789abcdef",
      command: process.execPath,
      args: ["-e", ECHO_SCRIPT],
      cols: 80,
      rows: 24,
    });
    await expect(rejected.next((message) => message.type === "error")).resolves.toMatchObject({
      type: "error",
      requestId: "too-late",
      message: expect.stringContaining("draining"),
    });
  });

  it("treats a working provider PTY as disposable during shutdown", async () => {
    const state = useTemporaryState();
    registerTask(state, "working", "runtime-working");
    const project = listProjects()[0]!;
    const task = listTasks(project)[0]!;
    recordLifecycleEvent(project, task, {
      version: 1,
      sequence: 1,
      event: {
        version: 1,
        kind: "user_prompt",
        provider: "codex",
        providerSessionId: "session",
        providerTurnId: "turn",
        prompt: "work",
        recordedAt: "2030-01-01T00:00:00.000Z",
      },
      source: { provider: "codex", hookEvent: "UserPromptSubmit", rawBytes: 20 },
    });
    const socketPath = tempSocketPath();
    daemon = runDaemon(socketPath, {
      ingestLifecycle: async () => [],
      onPreparedShutdown: () => undefined,
    });
    const viewer = await connectClient(socketPath);
    viewer.send({
      type: "attach",
      sessionId: "runtime-working",
      taskName: "working",
      command: process.execPath,
      args: ["-e", ECHO_SCRIPT],
      cols: 80,
      rows: 24,
    });
    await viewer.next((message) => message.type === "output" || message.type === "replay");
    const control = await connectClient(socketPath);
    control.send({ type: "prepare_shutdown", requestId: "working-stop", reason: "restart" });
    await expect(
      control.next((message) => message.type === "shutdown_started"),
    ).resolves.toMatchObject({
      type: "shutdown_started",
      requestId: "working-stop",
    });
  });

  it("stops the provider runtime when disposing a daemon-owned PTY", async () => {
    const state = useTemporaryState();
    registerTask(state, "disposable", "runtime-disposable");
    const project = listProjects()[0]!;
    const task = listTasks(project)[0]!;
    const stopped: string[] = [];
    const socketPath = tempSocketPath();
    daemon = runDaemon(socketPath, {
      ingestLifecycle: async () => [],
      stopTaskRuntime: (candidate) => stopped.push(candidate.runtime.id),
    });
    const viewer = await connectClient(socketPath);
    viewer.send({
      type: "attach",
      sessionId: "runtime-disposable",
      taskName: "disposable",
      command: process.execPath,
      args: ["-e", ECHO_SCRIPT],
      cols: 80,
      rows: 24,
    });
    await viewer.next((message) => message.type === "output" || message.type === "replay");

    viewer.socket.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    await daemon.close();
    daemon = undefined;

    expect(stopped).toEqual(["runtime-disposable"]);
    expect(readTaskState(project, task).agentTurnState).toBe("exited");
  });

  it("stops an orphaned provider runtime during startup recovery", async () => {
    const state = useTemporaryState();
    registerTask(state, "orphan", "runtime-orphan");
    const project = listProjects()[0]!;
    const task = listTasks(project)[0]!;
    recordLifecycleEvent(project, task, {
      version: 1,
      sequence: 1,
      event: {
        version: 1,
        kind: "user_prompt",
        provider: "codex",
        providerSessionId: "session",
        providerTurnId: "turn",
        prompt: "work",
        recordedAt: "2030-01-01T00:00:00.000Z",
      },
      source: { provider: "codex", hookEvent: "UserPromptSubmit", rawBytes: 20 },
    });
    const stopped: string[] = [];
    daemon = runDaemon(tempSocketPath(), {
      startupInventory: async () => [
        { kind: "docker-sandboxes", id: "runtime-orphan", state: "running" },
      ],
      ingestLifecycle: async () => [],
      stopTaskRuntime: (candidate) => stopped.push(candidate.runtime.id),
    });

    for (let attempt = 0; attempt < 50 && !stopped.length; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));

    expect(stopped).toEqual(["runtime-orphan"]);
    expect(readTaskState(project, task).agentTurnState).toBe("exited");
  });

  it("archives task registrations whose runtime is missing during startup recovery", async () => {
    const state = useTemporaryState();
    registerTask(state, "missing", "runtime-missing");
    const project = listProjects()[0]!;
    const task = listTasks(project)[0]!;
    daemon = runDaemon(tempSocketPath(), {
      startupInventory: async () => [],
      ingestLifecycle: async () => [],
    });

    await waitUntil(() => listTasks(project).length === 0);

    expect(existsSync(orphanedTaskDir(project.id, task.id))).toBe(true);
  });

  it("drains a lifecycle wake and starts one post-turn job for a duplicate Stop", async () => {
    const token = "0123456789abcdef0123456789abcdef";
    const frame = encodeLifecycleWakeFrame(token, 7);
    const starts: number[] = [];
    const ingested: (number | undefined)[] = [];
    const debug: string[] = [];
    const socketPath = tempSocketPath();
    daemon = runDaemon(socketPath, {
      debug: (message) => debug.push(message),
      ingestLifecycle: async (_task, through) => {
        ingested.push(through);
        return through === undefined ? [] : [{ sequence: 7, kind: "turn_finished" }];
      },
      executePostTurn: async (_task, sequence) => {
        starts.push(sequence);
        return {};
      },
    });
    const client = await connectClient(socketPath);
    client.send({
      type: "attach",
      sessionId: "lifecycle",
      taskName: "lifecycle-task",
      bridgeToken: token,
      command: process.execPath,
      args: [
        "-e",
        `process.stdout.write(${JSON.stringify(frame + frame)});setInterval(()=>{},1000)`,
      ],
      cols: 80,
      rows: 24,
    });

    await waitUntil(() => ingested.filter((sequence) => sequence === 7).length === 2);
    await waitUntil(() => starts.length === 1);
    await waitUntil(() =>
      debug.some((message) => message.includes("Finished post-turn processing")),
    );
    expect(starts).toEqual([7]);
    expect(debug).toEqual(
      expect.arrayContaining([
        'Received attach command for sandbox "lifecycle-task".',
        'Polling lifecycle events for sandbox "lifecycle-task" because the provider signaled a lifecycle change (through sequence 7).',
        'Agent finished generating on sandbox "lifecycle-task".',
        'Started post-turn processing on sandbox "lifecycle-task".',
        'Finished post-turn processing on sandbox "lifecycle-task".',
      ]),
    );
  });

  it("accepts lifecycle frames from a viewerless daemon-owned session", async () => {
    const token = "abcdef0123456789abcdef0123456789";
    const frame = encodeLifecycleWakeFrame(token, 3);
    let settled = false;
    const socketPath = tempSocketPath();
    daemon = runDaemon(socketPath, {
      ingestLifecycle: async (_task, through) =>
        through === 3 ? [{ sequence: 3, kind: "turn_finished" }] : [],
      executePostTurn: async () => {
        settled = true;
        return {};
      },
    });
    const client = await connectClient(socketPath);
    client.send({
      type: "start_session",
      requestId: "viewerless-start",
      sessionId: "viewerless",
      taskName: "viewerless-task",
      bridgeToken: token,
      command: process.execPath,
      args: ["-e", `process.stdout.write(${JSON.stringify(frame)});setInterval(()=>{},1000)`],
      cols: 80,
      rows: 24,
    });
    await expect(
      client.next((message) => message.type === "session_started"),
    ).resolves.toMatchObject({
      requestId: "viewerless-start",
    });
    await waitUntil(() => settled);
  });

  it("reruns deferred post-turn work from the setup completion event", async () => {
    const stateDir = useTemporaryState();
    registerTask(stateDir, "setup-deferred", "runtime-setup-deferred");
    const project = listProjects()[0]!;
    const task = listTasks(project)[0]!;
    recordLifecycleEvent(project, task, {
      version: 1,
      sequence: 4,
      event: {
        version: 1,
        kind: "turn_finished",
        provider: "codex",
        providerSessionId: "session",
        recordedAt: "2030-01-01T00:00:00.000Z",
      },
      source: { provider: "codex", hookEvent: "Stop", rawBytes: 20 },
    });
    const token = task.lifecycleBridgeToken!;
    const frame = encodeLifecycleWakeFrame(token, 4);
    let starts = 0;
    const socketPath = tempSocketPath();
    daemon = runDaemon(socketPath, {
      ingestLifecycle: async (_task, through) =>
        through === 4 ? [{ sequence: 4, kind: "turn_finished" }] : [],
      executePostTurn: async () => {
        starts++;
        return starts === 1 ? { deferred: true } : {};
      },
    });
    const client = await connectClient(socketPath);
    client.send({
      type: "start_session",
      requestId: "setup-session",
      sessionId: "runtime-setup-deferred",
      taskName: "setup-deferred",
      bridgeToken: token,
      command: process.execPath,
      args: ["-e", `process.stdout.write(${JSON.stringify(frame)});setInterval(()=>{},1000)`],
      cols: 80,
      rows: 24,
    });
    await client.next((message) => message.type === "session_started");
    await waitUntil(() => starts === 1);
    client.send({ type: "setup_completed", taskName: "setup-deferred" });
    await waitUntil(() => starts === 2);
  });

  it("does not cancel post-turn work when a viewer attaches without input", async () => {
    const token = "fedcba9876543210fedcba9876543210";
    const frame = encodeLifecycleWakeFrame(token, 9);
    let postTurnSignal: AbortSignal | undefined;
    const socketPath = tempSocketPath();
    daemon = runDaemon(socketPath, {
      ingestLifecycle: async (_task, through) =>
        through === 9 ? [{ sequence: 9, kind: "turn_finished" }] : [],
      executePostTurn: async (_task, _sequence, signal) => {
        postTurnSignal = signal;
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
        return {};
      },
    });
    const first = await connectClient(socketPath);
    first.send({
      type: "start_session",
      requestId: "background",
      sessionId: "attach-no-input",
      taskName: "attach-no-input-task",
      bridgeToken: token,
      command: process.execPath,
      args: ["-e", `process.stdout.write(${JSON.stringify(frame)});setInterval(()=>{},1000)`],
      cols: 80,
      rows: 24,
    });
    await first.next((message) => message.type === "session_started");
    await waitUntil(() => postTurnSignal !== undefined);
    const viewer = await connectClient(socketPath);
    viewer.send({
      type: "attach",
      sessionId: "attach-no-input",
      taskName: "attach-no-input-task",
      bridgeToken: token,
      command: "unused",
      args: [],
      cols: 100,
      rows: 40,
    });
    viewer.send({
      type: "hello",
      requestId: "attached-without-input",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
    });
    await viewer.next(
      (message) => message.type === "hello" && message.requestId === "attached-without-input",
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(postTurnSignal?.aborted).toBe(false);
  });

  it("cancels post-turn work before a strong intent without restarting it", async () => {
    const state = useTemporaryState();
    registerTask(state, "strong-restart", "runtime-strong-restart");
    const project = listProjects()[0]!;
    const task = listTasks(project)[0]!;
    recordLifecycleEvent(project, task, {
      version: 1,
      sequence: 3,
      event: {
        version: 1,
        kind: "turn_finished",
        provider: "codex",
        providerSessionId: "session",
        providerTurnId: "turn-3",
        recordedAt: "2030-01-01T00:00:00.000Z",
      },
      source: { provider: "codex", hookEvent: "Stop", rawBytes: 20 },
    });
    let launches = 0;
    const debug: string[] = [];
    const socketPath = tempSocketPath();
    daemon = runDaemon(socketPath, {
      debug: (message) => debug.push(message),
      ingestLifecycle: async () => [],
      executeIntent: async () => 0,
      executePostTurn: async (_taskName, _sequence, signal) => {
        launches++;
        if (launches === 1)
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        return {};
      },
    });
    const client = await connectClient(socketPath);
    client.send({ type: "setup_completed", taskName: task.name });
    await waitUntil(() => launches === 1);
    client.send({
      type: "run_intent",
      intentId: "strong-review",
      task: task.name,
      intent: { kind: "review" },
    });
    await client.next(
      (message) => message.type === "intent_exited" && message.intentId === "strong-review",
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(debug).toEqual(
      expect.arrayContaining([
        'Received "review" command for sandbox "strong-restart".',
        'Running "review" command on sandbox "strong-restart".',
        'Finished "review" command on sandbox "strong-restart" with status 0.',
      ]),
    );
    expect(launches).toBe(1);
  });

  it("does not restart completed post-turn work after a successful refresh", async () => {
    const state = useTemporaryState();
    registerTask(state, "settled-refresh", "runtime-settled-refresh");
    const project = listProjects()[0]!;
    const task = listTasks(project)[0]!;
    recordLifecycleEvent(project, task, {
      version: 1,
      sequence: 4,
      event: {
        version: 1,
        kind: "turn_finished",
        provider: "codex",
        providerSessionId: "session",
        providerTurnId: "turn-4",
        recordedAt: "2030-01-01T00:00:00.000Z",
      },
      source: { provider: "codex", hookEvent: "Stop", rawBytes: 20 },
    });
    let launches = 0;
    const socketPath = tempSocketPath();
    daemon = runDaemon(socketPath, {
      ingestLifecycle: async () => [],
      executeIntent: async () => 0,
      executePostTurn: async () => {
        launches++;
        return {};
      },
    });
    const client = await connectClient(socketPath);
    client.send({ type: "setup_completed", taskName: task.name });
    await waitUntil(() => launches === 1);
    expect(launches).toBe(1);
    client.send({
      type: "run_intent",
      intentId: "settled-status-refresh",
      task: task.name,
      intent: { kind: "sync" },
    });
    await client.next(
      (message) =>
        message.type === "intent_exited" && message.intentId === "settled-status-refresh",
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(launches).toBe(1);
  });

  it("cancels post-turn work before forwarding the first raw input", async () => {
    const token = "00112233445566778899aabbccddeeff";
    const frame = encodeLifecycleWakeFrame(token, 11);
    let aborted = false;
    let started = false;
    const socketPath = tempSocketPath();
    daemon = runDaemon(socketPath, {
      ingestLifecycle: async (_task, through) =>
        through === 11 ? [{ sequence: 11, kind: "turn_finished" }] : [],
      executePostTurn: async (_task, _sequence, signal) => {
        started = true;
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve();
          }),
        );
        return {};
      },
    });
    const viewer = await connectClient(socketPath);
    viewer.send({
      type: "attach",
      sessionId: "cancel-before-input",
      taskName: "cancel-before-input-task",
      bridgeToken: token,
      command: process.execPath,
      args: [
        "-e",
        `process.stdout.write(${JSON.stringify(frame)});process.stdin.on('data',d=>process.stdout.write('echo:'+d))`,
      ],
      cols: 80,
      rows: 24,
    });
    await waitUntil(() => started);
    viewer.send({
      type: "input",
      sessionId: "cancel-before-input",
      dataBase64: Buffer.from("continue\n").toString("base64"),
    });
    const echoed = await viewer.next(
      (message) =>
        message.type === "output" &&
        Buffer.from(message.dataBase64, "base64").toString().includes("echo:continue"),
    );
    expect(echoed.type).toBe("output");
    expect(aborted).toBe(true);
  });

  it.each(["reconciliation", "delivery_advance"])(
    "holds agent input when interrupted %s has an uncertain outcome",
    async (kind) => {
      const state = useTemporaryState();
      registerTask(state, "interrupted", "boxers-interrupted");
      const socketPath = tempSocketPath();
      daemon = runDaemon(socketPath);
      const viewer = await connectClient(socketPath);
      const received = join(state, "received-input");
      viewer.send({
        type: "attach",
        sessionId: "interrupted-session",
        taskName: "interrupted",
        command: process.execPath,
        args: [
          "-e",
          `process.stdout.write('ready');process.stdin.on('data',d=>require('fs').writeFileSync(${JSON.stringify(received)},d))`,
        ],
        cols: 80,
        rows: 24,
      });
      await viewer.next((message) => message.type === "output");
      atomicWriteJson(taskReconciliationPath("project-id", "task-id"), {
        kind,
        oldTargetOid: "old",
        targetOid: "new",
        checkpointOid: "work",
      });
      viewer.send({
        type: "input",
        sessionId: "interrupted-session",
        dataBase64: Buffer.from("continue\n").toString("base64"),
      });
      await expect(viewer.next((message) => message.type === "error")).resolves.toMatchObject({
        type: "error",
        message: expect.stringContaining("unfinished reconciliation"),
      });
      expect(existsSync(received)).toBe(false);
    },
  );
  it.each(["attach", "start_session"] as const)(
    "refuses %s launch while delivery advancement is uncertain",
    async (type) => {
      const state = useTemporaryState();
      registerTask(state, "uncertain", "runtime-uncertain");
      atomicWriteJson(taskReconciliationPath("project-id", "task-id"), {
        kind: "delivery_advance",
        checkpointOid: "accepted",
      });
      const marker = join(state, "unexpected-agent");
      const socketPath = tempSocketPath();
      daemon = runDaemon(socketPath);
      const client = await connectClient(socketPath);
      const common = {
        sessionId: "runtime-uncertain",
        taskName: "uncertain",
        bridgeToken: "test-token",
        command: process.execPath,
        args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'started')`],
        cols: 80,
        rows: 24,
      };
      client.send(
        type === "attach" ? { type, ...common } : { type, requestId: "start", ...common },
      );
      await expect(client.next((message) => message.type === "error")).resolves.toMatchObject({
        message: expect.stringContaining("unfinished reconciliation"),
      });
      expect(existsSync(marker)).toBe(false);
    },
  );

  it.each(["check", "review"] as const)(
    "allows %s after terminal reports following a completed turn",
    async (kind) => {
      const state = useTemporaryState();
      registerTask(state, "reports", "runtime-reports");
      const token = "0123456789abcdef0123456789abcdef";
      const frame = encodeLifecycleWakeFrame(token, 2);
      let completed = false;
      let executions = 0;
      const socketPath = tempSocketPath();
      daemon = runDaemon(socketPath, {
        ingestLifecycle: async (_task, through) =>
          through === 2 ? [{ sequence: 2, kind: "turn_finished" }] : [],
        executePostTurn: async () => {
          completed = true;
          return {};
        },
        executeIntent: async () => {
          executions++;
          return 0;
        },
      });
      const viewer = await connectClient(socketPath);
      viewer.send({
        type: "attach",
        sessionId: "runtime-reports",
        taskName: "reports",
        bridgeToken: token,
        command: process.execPath,
        args: [
          "-e",
          `process.stdin.setRawMode(true);${ECHO_SCRIPT}process.stdout.write(${JSON.stringify(frame)});`,
        ],
        cols: 80,
        rows: 24,
      });
      await waitUntil(() => completed);
      const reports = "\x1b[O\x1b[I\x1b[12;80R\x1b]11;rgb:0000/0000/0000\x07";
      viewer.send({
        type: "input",
        sessionId: "runtime-reports",
        dataBase64: Buffer.from(reports).toString("base64"),
      });
      await viewer.next(
        (message) =>
          message.type === "output" &&
          Buffer.from(message.dataBase64, "base64").toString().includes("echo:"),
      );
      viewer.send({ type: "run_intent", intentId: kind, task: "reports", intent: { kind } });
      await expect(
        viewer.next((message) => message.type === "intent_exited" || message.type === "error"),
      ).resolves.toMatchObject({ type: "intent_exited", code: 0 });
      expect(executions).toBe(1);
    },
  );

  it.each(["initial_prompt", "forwarded_input"] as const)(
    "refuses strong commands while %s awaits its lifecycle hook",
    async (mode) => {
      const state = useTemporaryState();
      registerTask(state, "input-race", "runtime-input-race");
      let executions = 0;
      const socketPath = tempSocketPath();
      daemon = runDaemon(socketPath, {
        executeIntent: async () => {
          executions++;
          return 0;
        },
      });
      const viewer = await connectClient(socketPath);
      viewer.send({
        type: "attach",
        sessionId: "runtime-input-race",
        taskName: "input-race",
        startsTurn: mode === "initial_prompt",
        command: process.execPath,
        args: ["-e", ECHO_SCRIPT],
        cols: 80,
        rows: 24,
      });
      await viewer.next((message) => message.type === "output");
      if (mode === "forwarded_input") {
        viewer.send({
          type: "input",
          sessionId: "runtime-input-race",
          dataBase64: Buffer.from("continue\n").toString("base64"),
        });
        await viewer.next(
          (message) =>
            message.type === "output" &&
            Buffer.from(message.dataBase64, "base64").toString().includes("echo:"),
        );
      }
      // Terminal reports must not acknowledge an actual pending prompt.
      viewer.send({
        type: "input",
        sessionId: "runtime-input-race",
        dataBase64: Buffer.from("\x1b[O").toString("base64"),
      });
      viewer.send({
        type: "run_intent",
        intentId: "racing-sync",
        task: "input-race",
        intent: { kind: "sync" },
      });
      await expect(viewer.next((message) => message.type === "error")).resolves.toMatchObject({
        message: expect.stringContaining("input awaiting its lifecycle acknowledgment"),
      });
      expect(executions).toBe(0);
    },
  );

  it("negotiates protocol, serves a recorded snapshot, and publishes revisions", async () => {
    useTemporaryState();
    const socketPath = tempSocketPath();
    daemon = runDaemon(socketPath);
    const client = await connectClient(socketPath);
    client.send({
      type: "hello",
      requestId: "hello-1",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
    });
    const hello = await client.next((message) => message.type === "hello");
    expect(hello).toMatchObject({
      type: "hello",
      requestId: "hello-1",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      revision: 0,
    });
    if (hello.type !== "hello") throw new Error("Expected daemon hello.");

    client.send({ type: "get_snapshot", requestId: "snapshot-1" });
    const snapshot = await client.next((message) => message.type === "snapshot");
    expect(snapshot).toMatchObject({ type: "snapshot", requestId: "snapshot-1", revision: 0 });

    client.send({
      type: "subscribe",
      requestId: "subscribe-1",
      epoch: hello.epoch,
      sinceRevision: 0,
    });
    await expect(client.next((message) => message.type === "subscribed")).resolves.toMatchObject({
      type: "subscribed",
      reset: false,
    });
    client.send({ type: "state_changed" });
    await expect(client.next((message) => message.type === "state_changed")).resolves.toMatchObject(
      { type: "state_changed", revision: 1 },
    );
  });

  it("does not ping-pong peer-cache changes between mutually observing daemons", async () => {
    const firstSocketPath = tempSocketPath();
    const secondSocketPath = tempSocketPath();
    let publishFirstPeerChange: () => void = () => undefined;
    let publishSecondPeerChange: () => void = () => undefined;
    daemon = runDaemon(firstSocketPath, {
      peerObserverFactory: (onChanged) => {
        publishFirstPeerChange = onChanged;
        return { reconcile: () => undefined, close: () => undefined };
      },
    });
    const second = runDaemon(secondSocketPath, {
      peerObserverFactory: (onChanged) => {
        publishSecondPeerChange = onChanged;
        return { reconcile: () => undefined, close: () => undefined };
      },
    });
    extraDaemons.push(second);
    const firstLocal = await connectClient(firstSocketPath);
    const firstRemoteWatch = await connectClient(firstSocketPath);
    const secondLocal = await connectClient(secondSocketPath);
    const secondRemoteWatch = await connectClient(secondSocketPath);
    firstLocal.send({ type: "subscribe", requestId: "first-local" });
    firstRemoteWatch.send({
      type: "subscribe",
      requestId: "first-remote",
      authoritativeOnly: true,
    });
    secondLocal.send({ type: "subscribe", requestId: "second-local" });
    secondRemoteWatch.send({
      type: "subscribe",
      requestId: "second-remote",
      authoritativeOnly: true,
    });
    await Promise.all([
      firstLocal.next((message) => message.type === "subscribed"),
      firstRemoteWatch.next((message) => message.type === "subscribed"),
      secondLocal.next((message) => message.type === "subscribed"),
      secondRemoteWatch.next((message) => message.type === "subscribed"),
    ]);

    firstLocal.send({ type: "state_changed" });
    await firstLocal.next((message) => message.type === "state_changed");
    await expect(
      firstRemoteWatch.next((message) => message.type === "state_changed"),
    ).resolves.toMatchObject({ revision: 1 });

    publishSecondPeerChange();
    await expect(
      secondLocal.next((message) => message.type === "state_changed"),
    ).resolves.toMatchObject({ revision: 1 });
    secondLocal.send({ type: "state_changed" });
    await secondLocal.next((message) => message.type === "state_changed");
    await expect(
      secondRemoteWatch.next((message) => message.type === "state_changed"),
    ).resolves.toMatchObject({ revision: 2 });

    publishFirstPeerChange();
    await expect(
      firstLocal.next((message) => message.type === "state_changed"),
    ).resolves.toMatchObject({ revision: 2 });
    firstLocal.send({ type: "state_changed" });
    await firstLocal.next((message) => message.type === "state_changed");
    await expect(
      firstRemoteWatch.next((message) => message.type === "state_changed"),
    ).resolves.toMatchObject({ revision: 3 });
  });

  it("rejects incompatible daemon protocol versions", async () => {
    const socketPath = tempSocketPath();
    daemon = runDaemon(socketPath);
    const client = await connectClient(socketPath);
    client.send({ type: "hello", requestId: "old", protocolVersion: 1 });
    await expect(client.next((message) => message.type === "error")).resolves.toMatchObject({
      type: "error",
      requestId: "old",
    });
  });

  it("keeps observation-only attach to an existing session available during an intent", async () => {
    const state = useTemporaryState();
    registerTask(state, "leased", "runtime-leased");
    const socketPath = tempSocketPath();
    daemon = runDaemon(socketPath, {
      executeIntent: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return 0;
      },
    });
    const existing = await connectClient(socketPath);
    existing.send({
      type: "attach",
      sessionId: "runtime-leased",
      taskName: "leased",
      command: process.execPath,
      args: ["-e", ECHO_SCRIPT],
      cols: 80,
      rows: 24,
    });
    await existing.next((message) => message.type === "output");
    const operation = await connectClient(socketPath);
    operation.send({
      type: "run_intent",
      intentId: "intent-1",
      task: "leased",
      intent: { kind: "review" },
    });
    const viewer = await connectClient(socketPath);
    viewer.send({
      type: "attach",
      sessionId: "runtime-leased",
      command: process.execPath,
      args: ["-e", ECHO_SCRIPT],
      cols: 80,
      rows: 24,
    });
    await expect(
      viewer.next((message) => message.type === "output" || message.type === "replay"),
    ).resolves.toMatchObject({ dataBase64: expect.any(String) });
    await expect(
      operation.next((message) => message.type === "intent_exited"),
    ).resolves.toMatchObject({ type: "intent_exited", intentId: "intent-1", code: 0 });
  });

  it("keeps active intent bookkeeping internal to the daemon", async () => {
    const state = useTemporaryState();
    registerTask(state, "recorded", "runtime-recorded");
    const socketPath = tempSocketPath();
    daemon = runDaemon(socketPath, {
      executeIntent: async (_message, output) => {
        output.stdout("started\n");
        await new Promise((resolve) => setTimeout(resolve, 250));
        return 0;
      },
    });
    const client = await connectClient(socketPath);
    client.send({
      type: "run_intent",
      intentId: "recorded-review",
      task: "recorded",
      intent: { kind: "review" },
    });
    await client.next((message) => message.type === "intent_output");
    const statePath = join(state, "projects", "project-id", "tasks", "task-id", "state.json");
    expect(JSON.parse(readFileSync(statePath, "utf8"))).not.toHaveProperty("operation");
    client.send({ type: "list" });
    await expect(client.next((message) => message.type === "sessions")).resolves.toMatchObject({
      intents: [{ task: "recorded" }],
    });
    client.send({ type: "get_snapshot", requestId: "active-intent" });
    const projection = await client.next(
      (message) => message.type === "snapshot" && message.requestId === "active-intent",
    );
    expect(projection).not.toMatchObject({ snapshot: { tasks: [{ state: { operation: {} } }] } });

    await client.next((message) => message.type === "intent_exited");
    expect(JSON.parse(readFileSync(statePath, "utf8"))).not.toHaveProperty("operation");
  });

  it("persists an intent exception as the task failure fact", async () => {
    const state = useTemporaryState();
    registerTask(state, "broken", "runtime-broken");
    const socketPath = tempSocketPath();
    daemon = runDaemon(socketPath, {
      executeIntent: async () => {
        throw new Error("candidate capture exploded");
      },
    });
    const client = await connectClient(socketPath);
    client.send({
      type: "run_intent",
      intentId: "broken-review",
      task: "broken",
      intent: { kind: "review" },
    });
    await expect(
      client.next(
        (message) => message.type === "intent_exited" && message.intentId === "broken-review",
      ),
    ).resolves.toMatchObject({ code: 1 });
    const project = listProjects()[0]!;
    const task = listTasks(project)[0]!;
    expect(readTaskState(project, task).failure).toBe("candidate capture exploded");
  });

  it("executes a typed task intent directly through the command implementation", async () => {
    const state = useTemporaryState();
    registerTask(state, "direct", "runtime-direct");
    const bin = mkdtempSync(join(tmpdir(), "boxers-daemon-direct-bin-"));
    cleanupDirs.push(bin);
    const executable = join(bin, "sbx");
    writeFileSync(
      executable,
      '#!/bin/sh\nif [ "$1" = ls ]; then printf \'{"sandboxes":[]}\\n\'; exit 0; fi\nexit 91\n',
    );
    chmodSync(executable, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    try {
      const socketPath = tempSocketPath();
      daemon = runDaemon(socketPath);
      const client = await connectClient(socketPath);
      client.send({
        type: "run_intent",
        intentId: "direct-discard",
        task: "direct",
        intent: { kind: "discard", force: true },
      });
      await expect(
        client.next(
          (message) => message.type === "intent_output" && message.intentId === "direct-discard",
        ),
      ).resolves.toMatchObject({ type: "intent_output", stream: "stdout" });
      await expect(
        client.next(
          (message) => message.type === "intent_exited" && message.intentId === "direct-discard",
        ),
      ).resolves.toMatchObject({ code: 0 });
      expect(listTasks(listProjects()[0]!)).toEqual([]);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("rejects a second intent while the same task is busy", async () => {
    useTemporaryState();
    const marker = join(cleanupDirs.at(-1) as string, "intent-order");
    const socketPath = tempSocketPath();
    daemon = runDaemon(socketPath, {
      executeIntent: async (message) => {
        await new Promise((resolve) => setTimeout(resolve, message.intentId === "first" ? 75 : 0));
        writeFileSync(marker, `${message.intentId}\n`, { flag: "a" });
        return 0;
      },
    });
    const client = await connectClient(socketPath);
    client.send({
      type: "run_intent",
      intentId: "first",
      task: "ordered",
      intent: { kind: "review" },
    });
    client.send({
      type: "run_intent",
      intentId: "second",
      task: "ordered",
      intent: { kind: "check" },
    });
    await expect(
      client.next((message) => message.type === "error" && message.intentId === "second"),
    ).resolves.toMatchObject({ message: expect.stringContaining("operation in progress") });
    await client.next(
      (message) => message.type === "intent_exited" && message.intentId === "first",
    );
    expect(readFileSync(marker, "utf8")).toBe("first\n");
  });

  it("does not block agent input while checks run", async () => {
    const state = useTemporaryState();
    registerTask(state, "guarded", "runtime-guarded");
    const socketPath = tempSocketPath();
    daemon = runDaemon(socketPath, {
      executeIntent: async (_message, output) => {
        output.stdout("started\n");
        await new Promise((resolve) => setTimeout(resolve, 800));
        return 0;
      },
    });
    const viewer = await connectClient(socketPath);
    viewer.send({
      type: "attach",
      sessionId: "runtime-guarded",
      command: process.execPath,
      args: ["-e", `${ECHO_SCRIPT}setTimeout(() => console.log('late-output'), 50);`],
      cols: 80,
      rows: 24,
    });
    await viewer.next((message) => message.type === "output" || message.type === "replay");

    const operation = await connectClient(socketPath);
    operation.send({
      type: "run_intent",
      intentId: "guard",
      task: "guarded",
      intent: { kind: "check" },
    });
    await operation.next((message) => message.type === "intent_output");
    await viewer.next(
      (message) =>
        message.type === "output" &&
        Buffer.from(message.dataBase64, "base64").toString().includes("late-output"),
    );
    viewer.send({
      type: "input",
      sessionId: "runtime-guarded",
      dataBase64: Buffer.from("allowed\n").toString("base64"),
    });
    const output = await viewer.next(
      (message) =>
        message.type === "output" &&
        Buffer.from(message.dataBase64, "base64").toString().includes("echo:"),
    );
    expect(
      Buffer.from((output as { dataBase64: string }).dataBase64, "base64").toString(),
    ).toContain("allowed");
    await operation.next((message) => message.type === "intent_exited");
  });

  it("keeps an intent alive after its requesting client disconnects", async () => {
    useTemporaryState();
    const marker = join(cleanupDirs.at(-1) as string, "intent-finished");
    const socketPath = tempSocketPath();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    daemon = runDaemon(socketPath, {
      executeIntent: async () => {
        markStarted?.();
        await new Promise((resolve) => setTimeout(resolve, 75));
        writeFileSync(marker, "done");
        return 0;
      },
    });
    const client = await connectClient(socketPath);
    client.send({
      type: "run_intent",
      intentId: "durable-intent",
      task: "durable",
      intent: { kind: "review" },
    });
    await started;
    client.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(existsSync(marker)).toBe(true);
  });

  it("streams output to an attached viewer and replays it to a later one", async () => {
    const socketPath = tempSocketPath();
    daemon = runDaemon(socketPath);
    const first = await connectClient(socketPath);
    first.send({
      type: "attach",
      sessionId: "task-a",
      command: process.execPath,
      args: ["-e", ECHO_SCRIPT],
      cols: 80,
      rows: 24,
    });
    const output = await first.next((m) => m.type === "output" || m.type === "replay");
    expect(output.type === "output" || output.type === "replay").toBe(true);
    expect((output as { dataBase64: string }).dataBase64).toBeTruthy();

    const second = await connectClient(socketPath);
    second.send({
      type: "attach",
      sessionId: "task-a",
      command: "should-not-be-used",
      args: [],
      cols: 80,
      rows: 24,
    });
    const replay = await second.next((m) => m.type === "replay");
    expect(
      Buffer.from((replay as { dataBase64: string }).dataBase64, "base64").toString(),
    ).toContain("ready");
  });

  it("disconnects a backpressured viewer without pausing PTY production", async () => {
    const socketPath = tempSocketPath();
    const marker = join(cleanupDirs.at(-1) as string, "producer-finished");
    daemon = runDaemon(socketPath);
    const slow = connect(socketPath);
    sockets.push(slow);
    await new Promise<void>((resolve, reject) => {
      slow.once("connect", resolve);
      slow.once("error", reject);
    });
    slow.write(
      encodeMessage({
        type: "attach",
        sessionId: "backpressured",
        command: process.execPath,
        args: [
          "-e",
          `const fs=require('node:fs');const chunk=Buffer.alloc(65536,120);for(let i=0;i<256;i++)fs.writeSync(1,chunk);fs.writeFileSync(${JSON.stringify(marker)},'done')`,
        ],
        cols: 80,
        rows: 24,
      }),
    );
    slow.pause();
    for (let attempt = 0; attempt < 100 && !existsSync(marker); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(existsSync(marker)).toBe(true);

    const control = await connectClient(socketPath);
    control.send({
      type: "hello",
      requestId: "during-backpressure",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
    });
    await expect(control.next((message) => message.type === "hello")).resolves.toMatchObject({
      requestId: "during-backpressure",
    });

    slow.destroy();
  });

  it("only forwards input from the most recently attached viewer", async () => {
    const socketPath = tempSocketPath();
    daemon = runDaemon(socketPath);
    const first = await connectClient(socketPath);
    first.send({
      type: "attach",
      sessionId: "task-b",
      command: process.execPath,
      args: ["-e", ECHO_SCRIPT],
      cols: 80,
      rows: 24,
    });
    await first.next((m) => m.type === "replay" || m.type === "output");

    const second = await connectClient(socketPath);
    second.send({
      type: "attach",
      sessionId: "task-b",
      command: "unused",
      args: [],
      cols: 80,
      rows: 24,
    });
    await second.next((m) => m.type === "replay");

    first.send({
      type: "input",
      sessionId: "task-b",
      dataBase64: Buffer.from("from-first\n").toString("base64"),
    });
    second.send({
      type: "input",
      sessionId: "task-b",
      dataBase64: Buffer.from("from-second\n").toString("base64"),
    });

    const echoed = await second.next(
      (m) =>
        m.type === "output" && Buffer.from(m.dataBase64, "base64").toString().includes("echo:"),
    );
    const text = Buffer.from((echoed as { dataBase64: string }).dataBase64, "base64").toString();
    expect(text).toContain("from-second");
    expect(text).not.toContain("from-first");
  });

  it("returns input ownership and terminal size when the newest viewer disconnects", async () => {
    const socketPath = tempSocketPath();
    daemon = runDaemon(socketPath);
    const first = await connectClient(socketPath);
    first.send({
      type: "attach",
      sessionId: "writer-replacement",
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write('ready\\n');process.stdout.on('resize',()=>process.stdout.write(`size:${process.stdout.columns}x${process.stdout.rows}\\n`));process.stdin.on('data',d=>process.stdout.write('echo:'+d));",
      ],
      cols: 100,
      rows: 40,
    });
    await first.next((m) => m.type === "output" || m.type === "replay");

    const second = await connectClient(socketPath);
    second.send({
      type: "attach",
      sessionId: "writer-replacement",
      command: "unused",
      args: [],
      cols: 30,
      rows: 10,
    });
    const attached = await second.next((m) => m.type === "replay");
    if (
      !Buffer.from((attached as { dataBase64: string }).dataBase64, "base64")
        .toString()
        .includes("size:30x10")
    )
      await second.next(
        (m) =>
          m.type === "output" &&
          Buffer.from(m.dataBase64, "base64").toString().includes("size:30x10"),
      );
    second.socket.destroy();

    const restored = await first.next(
      (m) =>
        m.type === "output" &&
        Buffer.from(m.dataBase64, "base64").toString().includes("size:100x40"),
    );
    expect(
      Buffer.from((restored as { dataBase64: string }).dataBase64, "base64").toString(),
    ).toContain("size:100x40");
    first.send({
      type: "input",
      sessionId: "writer-replacement",
      dataBase64: Buffer.from("from-first-again\\n").toString("base64"),
    });
    const echoed = await first.next(
      (m) =>
        m.type === "output" &&
        Buffer.from(m.dataBase64, "base64").toString().includes("from-first-again"),
    );
    expect(
      Buffer.from((echoed as { dataBase64: string }).dataBase64, "base64").toString(),
    ).toContain("from-first-again");
  });

  it("keeps a reattached viewer connected while a large replay drains", async () => {
    const socketPath = tempSocketPath();
    daemon = runDaemon(socketPath);
    const first = await connectClient(socketPath);
    first.send({
      type: "attach",
      sessionId: "large-replay",
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write('x'.repeat(150000));process.stdin.on('data',d=>process.stdout.write('echo:'+d));",
      ],
      cols: 80,
      rows: 24,
    });
    await first.next((m) => m.type === "output");
    first.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 25));

    const second = await connectClient(socketPath);
    second.send({
      type: "attach",
      sessionId: "large-replay",
      command: "unused",
      args: [],
      cols: 80,
      rows: 24,
    });
    const replay = await second.next((m) => m.type === "replay");
    expect(
      Buffer.from((replay as { dataBase64: string }).dataBase64, "base64").byteLength,
    ).toBeGreaterThan(100_000);
    second.send({
      type: "input",
      sessionId: "large-replay",
      dataBase64: Buffer.from("still-attached\\n").toString("base64"),
    });
    const echoed = await second.next(
      (m) =>
        m.type === "output" &&
        Buffer.from(m.dataBase64, "base64").toString().includes("still-attached"),
    );
    expect(
      Buffer.from((echoed as { dataBase64: string }).dataBase64, "base64").toString(),
    ).toContain("still-attached");
  });

  it("does not persist raw user input or infer activity from it", async () => {
    const state = useTemporaryState();
    registerTask(state, "input-only", "runtime-input-only");
    const socketPath = tempSocketPath();
    daemon = runDaemon(socketPath);
    const client = await connectClient(socketPath);
    client.send({
      type: "attach",
      sessionId: "runtime-input-only",
      command: process.execPath,
      args: ["-e", "process.stdout.write('ready\\n'); process.stdin.resume();"],
      cols: 80,
      rows: 24,
    });
    await client.next((message) => message.type === "output" || message.type === "replay");

    // Give the PTY echo time to settle before isolating the input assertion.
    await new Promise((resolve) => setTimeout(resolve, 550));
    const project = listProjects()[0]!;
    const task = listTasks(project)[0]!;
    const before = readTaskState(project, task);

    client.send({
      type: "input",
      sessionId: "runtime-input-only",
      dataBase64: Buffer.from("typed but not submitted").toString("base64"),
    });
    // Input persistence is deliberately trailing-debounced so a typing burst
    // performs no registry I/O on the terminal hot path.
    await new Promise((resolve) => setTimeout(resolve, 175));

    const after = readTaskState(project, task);
    expect(after.revision).toBe(before.revision);
    expect(after.agentTurnState).toBe("not_started");
    expect(JSON.stringify(after)).not.toContain("typed but not submitted");
    expect(readTaskState(project, task).agentTurnState).toBe("not_started");
  });

  it("keeps the session running after a viewer disconnects, and replays what it missed", async () => {
    const socketPath = tempSocketPath();
    daemon = runDaemon(socketPath);
    const first = await connectClient(socketPath);
    first.send({
      type: "attach",
      sessionId: "task-c",
      command: process.execPath,
      args: ["-e", ECHO_SCRIPT],
      cols: 80,
      rows: 24,
    });
    await first.next((m) => m.type === "replay" || m.type === "output");
    first.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const status = await connectClient(socketPath);
    status.send({ type: "list" });
    const sessions = await status.next((m) => m.type === "sessions");
    expect(sessions).toMatchObject({ sessions: [{ sessionId: "task-c", state: "running" }] });

    const second = await connectClient(socketPath);
    second.send({
      type: "attach",
      sessionId: "task-c",
      command: "unused",
      args: [],
      cols: 80,
      rows: 24,
    });
    const replay = await second.next((m) => m.type === "replay");
    expect(
      Buffer.from((replay as { dataBase64: string }).dataBase64, "base64").toString(),
    ).toContain("ready");
  });

  it("stops the underlying process on an explicit stop request", async () => {
    const socketPath = tempSocketPath();
    daemon = runDaemon(socketPath);
    const client = await connectClient(socketPath);
    client.send({
      type: "attach",
      sessionId: "task-d",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cols: 80,
      rows: 24,
    });
    client.send({ type: "stop", sessionId: "task-d", requestId: "stop-task-d" });
    await client.next(
      (message) => message.type === "session_stopped" && message.requestId === "stop-task-d",
    );

    const status = await connectClient(socketPath);
    status.send({ type: "list" });
    const sessions = await status.next((m) => m.type === "sessions");
    expect(sessions).toMatchObject({ sessions: [] });
  });
});
