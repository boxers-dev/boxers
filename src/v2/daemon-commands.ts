import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { connect } from "node:net";
import { daemonMain } from "./daemon.ts";
import { ensureDaemonReady } from "./daemon-client.ts";
import { encodeMessage, LineDecoder, parseServerMessage } from "./daemon-protocol.ts";
import { daemonLogPath, daemonPidPath, daemonSocketPath } from "./paths.ts";
import { listRegisteredTasks } from "./registry.ts";
import { taskRuntimeId } from "./runtime/task.ts";
import { readTaskState } from "./state.ts";
import type { AgentTurnState } from "./types.ts";
import { daemonProcessCommandLine, isBoxersDaemonCommand } from "./daemon-identity.ts";

export { isBoxersDaemonCommand } from "./daemon-identity.ts";

function readDaemonPid(): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(daemonPidPath(), "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Foreground daemon entrypoint for service managers or explicit debugging. */
export async function runDaemonForeground(announce = false): Promise<number> {
  const started = daemonMain();
  if (started) {
    if (announce)
      process.stdout.write(
        `Boxers daemon running in foreground (pid ${process.pid}).\nSocket: ${daemonSocketPath()}\nPress Ctrl-C to stop.\n`,
      );
    return 0;
  }
  const pid = readDaemonPid();
  if (pid === undefined || !processIsAlive(pid))
    throw new Error("Another process owns the daemon lock, but no running daemon could be found.");
  if (announce) {
    const logPath = daemonLogPath();
    process.stdout.write(
      `Attached to the boxers daemon (pid ${pid}).\nTailing ${logPath}; press Ctrl-C to detach.\n`,
    );
    return tailDaemonLog(logPath, pid);
  }
  // A service can be installed while a lazily spawned daemon still owns
  // durable PTYs. Keep the service process alive until that daemon exits, then
  // fail so Restart=on-failure starts a supervised replacement.
  await waitForProcessExit(pid);
  return 1;
}

const LOG_TAIL_LINES = 20;
const LOG_POLL_INTERVAL_MS = 250;

export function waitForProcessExit(
  pid: number,
  alive: (pid: number) => boolean = processIsAlive,
  intervalMs = LOG_POLL_INTERVAL_MS,
): Promise<void> {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (alive(pid)) return;
      clearInterval(timer);
      resolve();
    }, intervalMs);
  });
}

function recentLogOffset(path: string, lines: number): number {
  const size = statSync(path).size;
  if (size === 0) return 0;
  const fd = openSync(path, "r");
  try {
    const blockSize = 16 * 1024;
    let position = size;
    let newlines = 0;
    let skipTrailingNewline = true;
    while (position > 0) {
      const length = Math.min(blockSize, position);
      position -= length;
      const block = Buffer.allocUnsafe(length);
      readSync(fd, block, 0, length, position);
      for (let index = length - 1; index >= 0; index--) {
        if (block[index] !== 0x0a) continue;
        if (skipTrailingNewline && position + index === size - 1) {
          skipTrailingNewline = false;
          continue;
        }
        skipTrailingNewline = false;
        newlines++;
        if (newlines === lines) return position + index + 1;
      }
      skipTrailingNewline = false;
    }
    return 0;
  } finally {
    closeSync(fd);
  }
}

/** Print recent daemon log context and follow appended bytes until that daemon exits. */
export function tailDaemonLog(
  path = daemonLogPath(),
  pid = readDaemonPid(),
  alive: (pid: number) => boolean = processIsAlive,
): Promise<number> {
  let offset = existsSync(path) ? recentLogOffset(path, LOG_TAIL_LINES) : 0;
  let identity: string | undefined;

  const copyAppendedBytes = (): void => {
    if (!existsSync(path)) return;
    const stat = statSync(path);
    const nextIdentity = `${stat.dev}:${stat.ino}`;
    if ((identity !== undefined && identity !== nextIdentity) || stat.size < offset) offset = 0;
    identity = nextIdentity;
    if (stat.size === offset) return;
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.allocUnsafe(16 * 1024);
      while (offset < stat.size) {
        const bytesRead = readSync(
          fd,
          buffer,
          0,
          Math.min(buffer.length, stat.size - offset),
          offset,
        );
        if (bytesRead === 0) break;
        process.stdout.write(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
    } finally {
      closeSync(fd);
    }
  };

  copyAppendedBytes();
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      copyAppendedBytes();
      if (pid !== undefined && !alive(pid)) {
        clearInterval(timer);
        process.stdout.write(`The boxers daemon (pid ${pid}) stopped.\n`);
        resolve(0);
      }
    }, LOG_POLL_INTERVAL_MS);
  });
}

/** Start the daemon in the background and wait until it answers the current protocol. */
export async function daemonStart(
  ensureReady: (allowVersionMismatch?: boolean) => Promise<void> = ensureDaemonReady,
): Promise<number> {
  const existingPid = readDaemonPid();
  const alreadyRunning = existingPid !== undefined && processIsAlive(existingPid);
  await ensureReady();
  const pid = readDaemonPid();
  process.stdout.write(
    alreadyRunning
      ? `The boxers daemon is already running${pid === undefined ? "." : ` (pid ${pid}).`}\n`
      : `Started the boxers daemon${pid === undefined ? "." : ` (pid ${pid}).`}\n`,
  );
  return 0;
}

async function stopDaemonProcess(
  pid: number,
  force: boolean,
  inspectProcess?: (pid: number) => string | undefined,
): Promise<number> {
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      process.stdout.write("The boxers daemon is not running.\n");
      return 0;
    }
    throw error;
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!processIsAlive(pid)) {
      process.stdout.write(`${force ? "Force-stopped" : "Stopped"} the boxers daemon.\n`);
      return 0;
    }
    await wait(200);
  }
  if (!force) throw new Error(`The boxers daemon (pid ${pid}) did not stop within 4s.`);
  const commandLine = inspectProcess?.(pid);
  if (!commandLine || !isBoxersDaemonCommand(commandLine))
    throw new Error(
      `Refusing to send SIGKILL to PID ${pid}: its process identity changed after SIGTERM.`,
    );
  process.kill(pid, "SIGKILL");
  for (let attempt = 0; attempt < 10; attempt++) {
    if (!processIsAlive(pid)) {
      process.stdout.write(`Killed the unresponsive boxers daemon (pid ${pid}).\n`);
      return 0;
    }
    await wait(100);
  }
  throw new Error(`The boxers daemon (pid ${pid}) remained alive after SIGKILL.`);
}

export async function daemonStop(
  force = false,
  inspectProcess: (pid: number) => string | undefined = daemonProcessCommandLine,
): Promise<number> {
  const pid = readDaemonPid();
  if (pid === undefined || !processIsAlive(pid)) {
    process.stdout.write("The boxers daemon is not running.\n");
    return 0;
  }
  if (force) {
    const commandLine = inspectProcess(pid);
    if (!commandLine || !isBoxersDaemonCommand(commandLine))
      throw new Error(
        `Refusing to force-stop PID ${pid}: the process from ${daemonPidPath()} could not be verified as an Boxers daemon.`,
      );
    process.stderr.write(
      `Force-stopping Boxers daemon PID ${pid} without checking live sessions or intents; daemon-owned work may be interrupted.\n`,
    );
    return stopDaemonProcess(pid, true, inspectProcess);
  }
  let status: SessionsQuery;
  try {
    status = await querySessions();
  } catch (error) {
    throw new Error(
      `Could not verify that the daemon is safe to stop: ${error instanceof Error ? error.message : String(error)} If interrupting daemon-owned work is acceptable, run \`boxers daemon stop --force\`.`,
    );
  }
  if (status.pid !== pid)
    throw new Error(
      `Refusing to stop daemon PID ${pid}: the active daemon socket belongs to PID ${status.pid}.`,
    );
  const runningSessions = status.sessions.filter((session) => session.state === "running");
  const blockingSessions = runningSessions.flatMap((session) => {
    const boundary = sessionRestartBoundary(session.sessionId);
    return boundary.safe ? [] : [{ session, boundary }];
  });
  if (blockingSessions.length || status.intents.length) {
    const details = blockingSessions
      .map(({ session, boundary }) =>
        boundary.taskName
          ? `${session.sessionId} (${boundary.taskName}: ${boundary.turnState})`
          : `${session.sessionId} (task activity unknown)`,
      )
      .join(", ");
    throw new Error(
      `The daemon still owns ${blockingSessions.length} agent session(s) that are working or not confirmed to be awaiting input${details ? `: ${details}` : ""}, and ${status.intents.length} intent(s). Finish them before restarting the daemon; stopping now would interrupt durable task work.`,
    );
  }
  return stopDaemonProcess(pid, false);
}

/** Safely stop the current daemon, then start and readiness-check its replacement. */
export async function daemonRestart(
  force = false,
  stop: (force: boolean) => Promise<number> = daemonStop,
  start: () => Promise<number> = daemonStart,
): Promise<number> {
  await stop(force);
  return start();
}

interface SessionsQuery {
  pid: number;
  sessions: { sessionId: string; state: string; viewers: number }[];
  intents: { task: string }[];
}

interface SessionRestartBoundary {
  safe: boolean;
  taskName?: string;
  turnState?: AgentTurnState;
}

/** Only a provider-confirmed completed turn is safe to interrupt during normal restart. */
function sessionRestartBoundary(sessionId: string): SessionRestartBoundary {
  try {
    const registered = listRegisteredTasks().find(
      ({ task }) => taskRuntimeId(task) === sessionId || task.id === sessionId,
    );
    if (!registered) return { safe: false };
    const turnState = readTaskState(registered.project, registered.task).agentTurnState;
    return {
      safe: turnState === "awaiting_input",
      taskName: registered.task.name,
      turnState,
    };
  } catch {
    return { safe: false };
  }
}

function querySessions(): Promise<SessionsQuery> {
  return new Promise((resolve, reject) => {
    const socket = connect(daemonSocketPath());
    const decoder = new LineDecoder();
    let settled = false;
    const finish = (result: SessionsQuery | Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      finish(new Error("Timed out reading daemon activity."));
    }, 5_000);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(encodeMessage({ type: "list" })));
    socket.once("error", (error) => finish(error));
    socket.once("close", () => finish(new Error("The daemon closed the activity connection.")));
    socket.on("data", (chunk: string) => {
      for (const line of decoder.push(chunk)) {
        const message = parseServerMessage(line);
        if (message?.type === "sessions") {
          clearTimeout(timer);
          socket.destroy();
          if (
            !Number.isInteger(message.pid) ||
            message.pid <= 0 ||
            !Array.isArray(message.sessions) ||
            !message.sessions.every(
              (session) =>
                session &&
                typeof session.sessionId === "string" &&
                typeof session.state === "string" &&
                typeof session.viewers === "number",
            ) ||
            !Array.isArray(message.intents) ||
            !message.intents.every((intent) => intent && typeof intent.task === "string")
          ) {
            finish(new Error("The daemon returned an invalid activity response."));
            return;
          }
          finish(message);
          return;
        }
      }
    });
  });
}

export async function daemonStatus(json: boolean): Promise<number> {
  let status: SessionsQuery;
  try {
    status = await querySessions();
  } catch (error) {
    const pid = readDaemonPid();
    if (pid !== undefined && processIsAlive(pid)) {
      const detail = error instanceof Error ? error.message : String(error);
      if (json)
        process.stdout.write(
          `${JSON.stringify({ running: true, responsive: false, pid, error: detail })}\n`,
        );
      else
        process.stdout.write(
          `The boxers daemon process (pid ${pid}) is running but not responding. Use \`boxers daemon stop --force\` only if interrupting daemon-owned work is acceptable.\n`,
        );
      return 1;
    }
    if (json)
      process.stdout.write(
        `${JSON.stringify({ running: false, responsive: false, sessions: [], intents: [] })}\n`,
      );
    else process.stdout.write("The boxers daemon is not running.\n");
    return 0;
  }
  if (json) {
    process.stdout.write(`${JSON.stringify({ running: true, responsive: true, ...status })}\n`);
    return 0;
  }
  process.stdout.write(
    `The boxers daemon is running with ${status.sessions.length} session(s) and ${status.intents.length} intent(s).\n`,
  );
  for (const session of status.sessions)
    process.stdout.write(
      `  ${session.sessionId}\t${session.state}\t${session.viewers} viewer(s)\n`,
    );
  for (const intent of status.intents)
    process.stdout.write(`  ${intent.task}\tintent in progress\n`);
  return 0;
}
