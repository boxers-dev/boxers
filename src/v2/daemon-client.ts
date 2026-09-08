import { boxersLaunch } from "../core/launcher.ts";
import { parseTaskIntent as parseDaemonIntent } from "../core/task-intent.ts";
export { parseTaskIntent as parseDaemonIntent } from "../core/task-intent.ts";
import { daemonReleaseMatches } from "./daemon-identity.ts";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { dirname } from "node:path";
import { resetTerminalInputModes } from "../core/ansi.ts";
import { readVersion } from "../core/version.ts";
import { boxersHome, daemonLogPath, daemonSocketPath } from "./paths.ts";
import {
  DAEMON_PROTOCOL_VERSION,
  encodeMessage,
  LineDecoder,
  parseServerMessage,
  type ClientMessage,
  type TaskIntent,
} from "./daemon-protocol.ts";
import type { RemoteSnapshot } from "./types.ts";
import { activeReleaseBuildId, activeManagedExecutable } from "./release.ts";

const CONNECT_RETRY_DELAY_MS = 150;
const CONNECT_RETRY_ATTEMPTS = 40; // ~6s of retrying while a fresh daemon boots.
// Ctrl-C is the familiar way to leave an interactive command. Treat it as a
// viewer detach at this boundary so it cannot merely interrupt the provider
// and leave the user in its runtime shell.
const DETACH_KEY = 0x03;

interface PausableSource {
  pause(): unknown;
  resume(): unknown;
}

interface DrainOutput {
  write(chunk: Buffer): boolean;
  once(event: "drain", listener: () => void): unknown;
  off(event: "drain", listener: () => void): unknown;
}

interface TerminalInput {
  isTTY?: boolean;
  setRawMode(mode: boolean): unknown;
  pause(): unknown;
}

/** Release terminal input so the short-lived attaching CLI can exit. */
export function releaseTerminalInput(input: TerminalInput, wasRaw: boolean | undefined): void {
  if (input.isTTY) input.setRawMode(Boolean(wasRaw));
  input.pause();
}

/** Decode-side flow control between the daemon socket and the real terminal. */
export class TerminalOutputPump {
  readonly #source: PausableSource;
  readonly #output: DrainOutput;
  readonly #pending: Buffer[] = [];
  #blocked = false;
  #closed = false;

  constructor(source: PausableSource, output: DrainOutput) {
    this.#source = source;
    this.#output = output;
  }

  write(output: Buffer): void {
    if (this.#closed) return;
    if (this.#blocked) {
      this.#pending.push(output);
      return;
    }
    if (!this.#output.write(output)) {
      this.#blocked = true;
      this.#source.pause();
      this.#output.once("drain", this.#flush);
    }
  }

  close(): void {
    this.#closed = true;
    this.#pending.length = 0;
    this.#output.off("drain", this.#flush);
  }

  readonly #flush = (): void => {
    if (this.#closed) return;
    this.#blocked = false;
    while (this.#pending.length) {
      const output = this.#pending.shift();
      if (output && !this.#output.write(output)) {
        this.#blocked = true;
        this.#output.once("drain", this.#flush);
        return;
      }
    }
    this.#source.resume();
  };
}

export function detachKeyIndex(chunk: Buffer): number {
  return chunk.indexOf(DETACH_KEY);
}

function tryConnect(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `tsx`-run sources can't be handed to a plain `node` child; match how "dev" launches. */
export function daemonSpawnCommand(
  entry = process.argv[1] ?? "",
  managedExecutable = activeManagedExecutable() ?? process.env["BOXERS_EXECUTABLE"],
): { command: string; args: string[] } {
  if (managedExecutable) return boxersLaunch(managedExecutable, ["__daemon-run"]);
  if (entry.endsWith(".ts")) return { command: "npx", args: ["tsx", entry, "__daemon-run"] };
  return boxersLaunch(entry, ["__daemon-run"]);
}

const DAEMON_ERROR_LOG_BYTES = 8 * 1024;

export function daemonStartupError(
  logPath: string,
  launchFailure?: string,
  attemptLogOffset?: number,
): Error {
  let recent = "";
  try {
    const contents = readFileSync(logPath);
    const offset = Math.max(
      0,
      attemptLogOffset ?? contents.length - DAEMON_ERROR_LOG_BYTES,
      contents.length - DAEMON_ERROR_LOG_BYTES,
    );
    recent = contents.subarray(offset).toString();
  } catch {
    // The launch failure below is still more useful than masking it with a log read error.
  }
  const detail = [
    launchFailure,
    recent.trim() ? `Recent daemon output:\n${recent.trimEnd()}` : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");
  return new Error(
    `Could not start the boxers daemon (see ${logPath}).${detail ? `\n${detail}` : ""}`,
  );
}

async function ensureDaemonRunning(socketPath: string): Promise<Socket> {
  try {
    return await tryConnect(socketPath);
  } catch {
    // No daemon listening yet; spawn one below.
  }
  const logPath = daemonLogPath();
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
  const logFd = openSync(logPath, "a");
  const attemptLogOffset = fstatSync(logFd).size;
  let launchFailure: string | undefined;
  try {
    const { command, args } = daemonSpawnCommand();
    const child = spawn(command, args, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, BOXERS_HOME: boxersHome() },
    });
    child.once("error", (error) => {
      launchFailure = `Daemon launch failed: ${error.message}`;
    });
    child.once("exit", (code, signal) => {
      launchFailure = `Daemon launch exited ${signal ? `after ${signal}` : `with status ${code ?? 1}`}.`;
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }
  for (let attempt = 0; attempt < CONNECT_RETRY_ATTEMPTS; attempt++) {
    await wait(CONNECT_RETRY_DELAY_MS);
    try {
      return await tryConnect(socketPath);
    } catch {
      continue;
    }
  }
  const startupFailure = daemonStartupError(logPath, launchFailure, attemptLogOffset);
  if (!launchFailure && startupFailure.message.endsWith(`(see ${logPath}).`))
    throw new Error(
      `${startupFailure.message}\nThe daemon launcher remained alive without opening its socket. A previous daemon may be stuck during shutdown; inspect \`boxers daemon status\` and use \`boxers daemon stop --force\` only if interrupting daemon-owned work is acceptable.`,
    );
  throw startupFailure;
}

/** Ensure the durable session and lifecycle-event daemon is available. */
export function assertDaemonVersion(daemonVersion: string): void {
  const cliVersion = readVersion();
  if (daemonVersion !== cliVersion)
    throw new Error(
      `Boxers daemon ${daemonVersion} does not match CLI ${cliVersion}. Finish active agent sessions and intents, run \`boxers daemon stop\`, then retry so the updated daemon can start.`,
    );
}

export async function ensureDaemonReady(allowVersionMismatch = false): Promise<void> {
  const socket = await readyDaemonSocket(allowVersionMismatch);
  socket.destroy();
}

function helloOnSocket(socket: Socket): Promise<{
  protocolVersion: number;
  boxersVersion: string;
  boxersBuildId?: string | undefined;
  epoch: string;
  revision: number;
}> {
  const requestId = randomUUID();
  const decoder = new LineDecoder();
  socket.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const finish = (
      result:
        | {
            protocolVersion: number;
            boxersVersion: string;
            boxersBuildId?: string | undefined;
            epoch: string;
            revision: number;
          }
        | Error,
    ): void => {
      cleanup();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            "The running Boxers daemon did not answer protocol negotiation. It may predate this CLI. Run `boxers daemon status`; if it is unresponsive and interrupting daemon-owned work is acceptable, run `boxers daemon stop --force` and retry.",
          ),
        ),
      5_000,
    );
    const onData = (chunk: string): void => {
      for (const line of decoder.push(chunk)) {
        const message = parseServerMessage(line);
        if (message?.type === "hello" && message.requestId === requestId) finish(message);
        else if (message?.type === "error" && message.requestId === requestId)
          finish(new Error(message.message));
      }
    };
    const onError = (error: Error): void => finish(error);
    const onClose = (): void =>
      finish(new Error("The Boxers daemon closed the connection during protocol negotiation."));
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.write(
      encodeMessage({ type: "hello", requestId, protocolVersion: DAEMON_PROTOCOL_VERSION }),
    );
  });
}

async function readyDaemonSocket(allowVersionMismatch = false): Promise<Socket> {
  const socket = await ensureDaemonRunning(daemonSocketPath());
  try {
    const hello = await helloOnSocket(socket);
    if (!allowVersionMismatch) {
      assertDaemonVersion(hello.boxersVersion);
      if (!daemonReleaseMatches(hello, { version: readVersion(), buildId: activeReleaseBuildId() }))
        throw new Error(
          "The Boxers daemon build or protocol does not match this CLI. Run `boxers update` to align the active build and daemon.",
        );
    }
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

export async function daemonSnapshot(): Promise<{
  epoch: string;
  revision: number;
  snapshot: RemoteSnapshot;
}> {
  const socket = await readyDaemonSocket();
  const requestId = randomUUID();
  const decoder = new LineDecoder();
  socket.setEncoding("utf8");
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out reading the Boxers daemon snapshot."));
    }, 5_000);
    socket.on("data", (chunk: string) => {
      for (const line of decoder.push(chunk)) {
        const message = parseServerMessage(line);
        if (message?.type === "snapshot" && message.requestId === requestId) {
          clearTimeout(timer);
          socket.destroy();
          resolve({
            epoch: message.epoch,
            revision: message.revision,
            snapshot: message.snapshot as RemoteSnapshot,
          });
        } else if (message?.type === "error" && message.requestId === requestId) {
          clearTimeout(timer);
          socket.destroy();
          reject(new Error(message.message));
        }
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.write(encodeMessage({ type: "get_snapshot", requestId }));
  });
}

/** Best-effort observation only: no startup, negotiation, or exclusive intent. */
export function runningDaemonSnapshot(
  timeoutMs = 500,
  prepareTask?: string,
): Promise<RemoteSnapshot | undefined> {
  return new Promise((resolve) => {
    const socket = connect(daemonSocketPath());
    const requestId = randomUUID();
    const decoder = new LineDecoder();
    let finished = false;
    const finish = (snapshot?: RemoteSnapshot): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(snapshot);
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      if (prepareTask) socket.write(encodeMessage({ type: "prepare_task", taskName: prepareTask }));
      socket.write(encodeMessage({ type: "get_snapshot", requestId }));
    });
    socket.on("data", (chunk: string) => {
      for (const line of decoder.push(chunk)) {
        const message = parseServerMessage(line);
        if (message?.type === "snapshot" && message.requestId === requestId)
          finish(message.snapshot as RemoteSnapshot);
      }
    });
    socket.once("error", () => finish());
    socket.once("close", () => finish());
  });
}

export async function daemonHello(): Promise<{
  protocolVersion: number;
  boxersVersion: string;
  boxersBuildId?: string | undefined;
  epoch: string;
  revision: number;
}> {
  const socket = await ensureDaemonRunning(daemonSocketPath());
  try {
    return await helloOnSocket(socket);
  } finally {
    socket.destroy();
  }
}

/** Notify a running daemon without starting one. Durable state is already on disk. */
export function notifyDaemonStateChanged(): void {
  const socket = connect(daemonSocketPath());
  socket.once("connect", () => {
    socket.end(encodeMessage({ type: "state_changed" }));
  });
  socket.once("error", () => socket.destroy());
}

/** Notify a running daemon of a published target; never starts the daemon. */
export function notifyDaemonTargetChanged(projectId: string): void {
  const socket = connect(daemonSocketPath());
  socket.once("connect", () => {
    socket.end(encodeMessage({ type: "target_changed", projectId }));
  });
  socket.once("error", () => socket.destroy());
}

/** Wake the daemon once after setup reaches a terminal state. */
export function notifyDaemonSetupCompleted(taskName: string): void {
  const socket = connect(daemonSocketPath());
  socket.once("connect", () => {
    socket.end(encodeMessage({ type: "setup_completed", taskName }));
  });
  socket.once("error", () => socket.destroy());
}

/** Dispose a daemon-owned provider PTY so the next attach launches it again. */
export async function stopDaemonSession(sessionId: string): Promise<void> {
  const socket = await readyDaemonSocket();
  const requestId = randomUUID();
  const decoder = new LineDecoder();
  socket.setEncoding("utf8");
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error("Timed out restarting the daemon-owned agent session.")),
      5_000,
    );
    socket.on("data", (text: string) => {
      for (const line of decoder.push(text)) {
        const message = parseServerMessage(line);
        if (message?.type === "session_stopped" && message.requestId === requestId) finish();
        else if (message?.type === "error" && message.requestId === requestId)
          finish(new Error(message.message));
      }
    });
    socket.once("error", finish);
    socket.write(encodeMessage({ type: "stop", requestId, sessionId }));
  });
}

export async function subscribeDaemonChanges(
  onReady: (cursor: { epoch: string; revision: number }) => void,
  onChanged: (cursor: { epoch: string; revision: number }) => void,
  options: { authoritativeOnly?: boolean } = {},
): Promise<() => void> {
  const socket = await readyDaemonSocket();
  const requestId = randomUUID();
  const decoder = new LineDecoder();
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    for (const line of decoder.push(chunk)) {
      const message = parseServerMessage(line);
      if (message?.type === "subscribed" && message.requestId === requestId)
        onReady({ epoch: message.epoch, revision: message.revision });
      else if (message?.type === "state_changed")
        onChanged({ epoch: message.epoch, revision: message.revision });
    }
  });
  socket.write(
    encodeMessage({
      type: "subscribe",
      requestId,
      ...(options.authoritativeOnly ? { authoritativeOnly: true } : {}),
    }),
  );
  return () => socket.destroy();
}

export async function runTypedDaemonIntent(task: string, intent: TaskIntent): Promise<number> {
  const socket = await readyDaemonSocket();
  const intentId = randomUUID();
  const decoder = new LineDecoder();
  socket.setEncoding("utf8");
  return await new Promise<number>((resolve) => {
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(code);
    };
    socket.on("data", (chunk: string) => {
      for (const line of decoder.push(chunk)) {
        const message = parseServerMessage(line);
        if (message?.type === "intent_output" && message.intentId === intentId) {
          const output = Buffer.from(message.dataBase64, "base64");
          if (message.stream === "stdout") process.stdout.write(output);
          else process.stderr.write(output);
        } else if (message?.type === "intent_exited" && message.intentId === intentId)
          finish(message.code);
        else if (
          message?.type === "error" &&
          (message.intentId === undefined || message.intentId === intentId)
        ) {
          process.stderr.write(`${message.message}\n`);
          finish(1);
        }
      }
    });
    socket.on("error", (error) => {
      process.stderr.write(`${error.message}\n`);
      finish(1);
    });
    socket.on("close", () => finish(1));
    socket.write(encodeMessage({ type: "run_intent", intentId, task, intent }));
  });
}

export async function runDaemonIntent(args: string[]): Promise<number> {
  const { task, intent } = parseDaemonIntent(args);
  return runTypedDaemonIntent(task, intent);
}

/**
 * Attaches the current terminal to a durable, daemon-held session. The pty
 * lives in the daemon, not in this process, so losing this connection (SSH
 * drop, closed terminal) never touches the underlying `command`/`args`
 * process — only re-running attach loses the live view, not the work.
 */
export async function attachInteractive(
  sessionId: string,
  command: string,
  args: string[],
  lifecycle?: { taskName: string; bridgeToken: string; startsTurn?: boolean },
): Promise<number> {
  const socket = await readyDaemonSocket();
  const decoder = new LineDecoder();
  socket.setEncoding("utf8");
  const send = (message: ClientMessage): boolean => socket.write(encodeMessage(message));

  send({
    type: "attach",
    sessionId,
    command,
    args,
    cols: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
    ...(lifecycle ? lifecycle : {}),
  });

  const wasRaw = process.stdin.isRaw;
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();

  const onResize = (): void => {
    send({
      type: "resize",
      sessionId,
      cols: process.stdout.columns ?? 80,
      rows: process.stdout.rows ?? 24,
    });
  };
  process.stdout.on("resize", onResize);

  return await new Promise<number>((resolve) => {
    let settled = false;
    let inputBackpressured = false;
    const outputPump = new TerminalOutputPump(socket, process.stdout);

    const onInputDrain = (): void => {
      inputBackpressured = false;
      if (!settled) process.stdin.resume();
    };

    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      process.stdout.off("resize", onResize);
      outputPump.close();
      process.stdin.off("data", onStdinData);
      socket.off("drain", onInputDrain);
      // `resume()` keeps stdin referenced even after its data listener is
      // removed. Always pause it so a deliberate detach can let this
      // short-lived CLI process exit and return control to the shell. A fresh
      // Node TTY reports `isPaused() === false` even before it is consumed, so
      // its initial pause state cannot be used to decide whether to release it.
      releaseTerminalInput(process.stdin, wasRaw);
      resetTerminalInputModes();
      socket.destroy();
      resolve(code);
    };

    function onStdinData(chunk: Buffer): void {
      const detachIndex = detachKeyIndex(chunk);
      if (detachIndex < 0) {
        if (
          !send({ type: "input", sessionId, dataBase64: chunk.toString("base64") }) &&
          !inputBackpressured
        ) {
          inputBackpressured = true;
          process.stdin.pause();
          socket.once("drain", onInputDrain);
        }
        return;
      }
      if (detachIndex > 0)
        send({
          type: "input",
          sessionId,
          dataBase64: chunk.subarray(0, detachIndex).toString("base64"),
        });
      finish(0);
    }
    process.stdin.on("data", onStdinData);

    socket.on("data", (text: string) => {
      for (const line of decoder.push(text)) {
        const message = parseServerMessage(line);
        if (message?.type === "error") {
          process.stderr.write(`${message.message}\n`);
          finish(1);
          continue;
        }
        if (!message || !["replay", "output", "exited"].includes(message.type)) continue;
        if (message.type !== "replay" && message.type !== "output" && message.type !== "exited")
          continue;
        if (message.sessionId !== sessionId) continue;
        if (message.type === "replay" || message.type === "output")
          outputPump.write(Buffer.from(message.dataBase64, "base64"));
        else if (message.type === "exited") finish(message.code ?? 0);
      }
    });
    socket.on("close", () => finish(0));
    socket.on("error", () => finish(0));
  });
}

/** Start a daemon-owned durable PTY without attaching a viewer. */
export async function startViewerlessSession(
  sessionId: string,
  taskName: string,
  bridgeToken: string,
  command: string,
  args: string[],
  startsTurn = false,
): Promise<void> {
  const socket = await readyDaemonSocket();
  const requestId = randomUUID();
  const decoder = new LineDecoder();
  socket.setEncoding("utf8");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out starting the daemon-owned agent session."));
    }, 5_000);
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.on("data", (text: string) => {
      for (const line of decoder.push(text)) {
        const message = parseServerMessage(line);
        if (message?.type === "session_started" && message.requestId === requestId) finish();
        else if (message?.type === "error" && message.requestId === requestId)
          finish(new Error(message.message));
      }
    });
    socket.once("error", (error) => finish(error));
    socket.write(
      encodeMessage({
        type: "start_session",
        requestId,
        sessionId,
        taskName,
        bridgeToken,
        startsTurn,
        command,
        args,
        cols: 80,
        rows: 24,
      }),
    );
  });
}
