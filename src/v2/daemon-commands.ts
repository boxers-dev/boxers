import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { connect } from "node:net";
import { daemonMain } from "./daemon.ts";
import { ensureDaemonReady } from "./daemon-client.ts";
import {
  DAEMON_PROTOCOL_VERSION,
  encodeMessage,
  LineDecoder,
  parseServerMessage,
  type ShutdownReason,
  type ShutdownBlocker,
} from "./daemon-protocol.ts";
import { daemonLockPath, daemonLogPath, daemonPidPath, daemonSocketPath } from "./paths.ts";
import { daemonProcessCommandLine, isBoxersDaemonCommand } from "./daemon-identity.ts";
import { activeManagedBuildId } from "./release.ts";
import { daemonServiceStatus, type DaemonServiceStatus } from "./service.ts";

export { isBoxersDaemonCommand } from "./daemon-identity.ts";

function readPidFile(path: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function readDaemonPid(): number | undefined {
  return readPidFile(daemonPidPath());
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
  reason: ShutdownReason = "stop",
): Promise<number> {
  if (force) {
    const candidates = [readPidFile(daemonLockPath()), readDaemonPid()];
    const liveCandidates = candidates.filter(
      (pid, index): pid is number =>
        pid !== undefined && processIsAlive(pid) && candidates.indexOf(pid) === index,
    );
    const pid = liveCandidates.find((candidate) => {
      const commandLine = inspectProcess(candidate);
      return commandLine !== undefined && isBoxersDaemonCommand(commandLine);
    });
    if (pid === undefined) {
      if (liveCandidates.length)
        throw new Error(
          `Refusing to force-stop PID ${liveCandidates.join(", ")}: the process recorded by Boxers could not be verified as a Boxers daemon.`,
        );
      process.stdout.write("The boxers daemon is not running.\n");
      return 0;
    }
    process.stderr.write(
      `Force-stopping Boxers daemon PID ${pid} without checking live sessions or intents; daemon-owned work may be interrupted.\n`,
    );
    return stopDaemonProcess(pid, true, inspectProcess);
  }
  let result: PreparedShutdownResult;
  try {
    result = await requestPreparedShutdown(reason);
  } catch (error) {
    const recordedPids = [readPidFile(daemonLockPath()), readDaemonPid()].filter(
      (pid): pid is number => pid !== undefined && processIsAlive(pid),
    );
    if (!recordedPids.length) {
      process.stdout.write("The boxers daemon is not running.\n");
      return 0;
    }
    throw new Error(
      `Could not verify that the daemon is safe to stop: ${error instanceof Error ? error.message : String(error)} If interrupting daemon-owned work is acceptable, run \`boxers daemon stop --force\`.`,
    );
  }
  if (result.status === "blocked")
    throw new Error(
      `The daemon is not ready to stop:\n${result.blockers.map((blocker) => `  ${blocker.detail}`).join("\n")}`,
    );
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!processIsAlive(result.pid)) {
      process.stdout.write("Stopped the boxers daemon.\n");
      return 0;
    }
    await wait(200);
  }
  throw new Error(`The boxers daemon (pid ${result.pid}) did not stop within 4s.`);
}

/** Safely stop the current daemon, then start and readiness-check its replacement. */
export async function daemonRestart(
  force = false,
  stop: (force: boolean) => Promise<number> = (requestedForce) =>
    daemonStop(requestedForce, daemonProcessCommandLine, "restart"),
  start: () => Promise<number> = daemonStart,
): Promise<number> {
  await stop(force);
  return start();
}

/** Bounded replacement after activating a new managed executable. */
export async function runDaemonReplacement(
  expectedBuildId: string,
  activatedBuildId: () => string | undefined = activeManagedBuildId,
  dependencies: {
    status?: () => DaemonServiceStatus;
    stop?: () => Promise<number>;
    start?: () => Promise<number>;
  } = {},
): Promise<number> {
  if (!/^[a-f0-9]{64}$/.test(expectedBuildId))
    throw new Error("Invalid Boxers replacement build ID.");
  if (activatedBuildId() !== expectedBuildId) return 0;
  const status = dependencies.status ?? daemonServiceStatus;
  const stop = dependencies.stop ?? (() => daemonStop(true));
  const start = dependencies.start ?? daemonStart;

  const running = status();
  if (
    running.active &&
    running.boxersBuildId === expectedBuildId &&
    running.protocolVersion === DAEMON_PROTOCOL_VERSION
  )
    return 0;

  // An update explicitly replaces daemon-owned PTYs and recomputable host
  // orchestration. Do not ask the daemon being superseded to approve that
  // policy: an older protocol or build may reject the request using obsolete
  // blocker rules. The force path still verifies the recorded PID belongs to
  // Boxers, sends SIGTERM first, and uses SIGKILL only after the bounded grace
  // period expires.
  if (running.active) await stop();
  if (activatedBuildId() !== expectedBuildId) return 0;
  await start();
  if (activatedBuildId() !== expectedBuildId) return 0;
  const replacement = status();
  if (
    !replacement.active ||
    replacement.boxersBuildId !== expectedBuildId ||
    replacement.protocolVersion !== DAEMON_PROTOCOL_VERSION
  )
    throw new Error(
      `The replacement daemon did not start the activated Boxers build ${expectedBuildId.slice(0, 8)} (protocol ${DAEMON_PROTOCOL_VERSION}).`,
    );
  return 0;
}

interface SessionsQuery {
  pid: number;
  sessions: { sessionId: string; state: string; viewers: number }[];
  intents: { task: string }[];
  backgroundWork?: number;
}

export type PreparedShutdownResult =
  | { status: "started"; pid: number }
  | { status: "blocked"; blockers: ShutdownBlocker[] };

/** Ask the daemon to freeze admission, drain lifecycle state, classify work, and shut itself down. */
export function requestPreparedShutdown(
  reason: ShutdownReason,
  expectedBuildId?: string,
): Promise<PreparedShutdownResult> {
  return new Promise((resolve, reject) => {
    const socket = connect(daemonSocketPath());
    const requestId = `${process.pid}-${Date.now()}`;
    const decoder = new LineDecoder();
    let settled = false;
    const finish = (result: PreparedShutdownResult | Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const timer = setTimeout(
      () => finish(new Error("Timed out waiting for the daemon to prepare shutdown.")),
      15_000,
    );
    socket.setEncoding("utf8");
    socket.once("connect", () =>
      socket.write(
        encodeMessage({
          type: "prepare_shutdown",
          requestId,
          reason,
          ...(expectedBuildId ? { expectedBuildId } : {}),
        }),
      ),
    );
    socket.once("error", (error) => finish(error));
    socket.once("close", () => {
      if (!settled) finish(new Error("The daemon closed the shutdown preparation connection."));
    });
    socket.on("data", (chunk: string) => {
      for (const line of decoder.push(chunk)) {
        const message = parseServerMessage(line);
        if (!message || !("requestId" in message) || message.requestId !== requestId) continue;
        if (message.type === "shutdown_started") finish({ status: "started", pid: message.pid });
        else if (message.type === "shutdown_blocked")
          finish({ status: "blocked", blockers: message.blockers });
        else if (message.type === "error") finish(new Error(message.message));
      }
    });
  });
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
            !message.intents.every((intent) => intent && typeof intent.task === "string") ||
            (message.backgroundWork !== undefined &&
              (!Number.isSafeInteger(message.backgroundWork) || message.backgroundWork < 0))
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
