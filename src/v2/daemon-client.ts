import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { dirname } from "node:path";
import { colorEnabled, resetTerminalInputModes } from "../core/ansi.ts";
import { readVersion } from "../core/version.ts";
import { daemonLogPath, daemonSocketPath } from "./paths.ts";
import {
  DAEMON_PROTOCOL_VERSION,
  encodeMessage,
  LineDecoder,
  parseServerMessage,
  type ClientMessage,
  type TaskIntent,
} from "./daemon-protocol.ts";
import type { RemoteSnapshot } from "./types.ts";
import { activeManagedExecutable } from "./release.ts";

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
  managedExecutable = process.env["BOXERS_EXECUTABLE"] ?? activeManagedExecutable(),
): { command: string; args: string[] } {
  // Fleet bootstrap records the authoritative launcher explicitly. Preserve
  // that boundary instead of assuming it is JavaScript for this Node runtime.
  if (managedExecutable)
    return { command: managedExecutable, args: ["__daemon-run"] };
  if (entry.endsWith(".ts")) return { command: "npx", args: ["tsx", entry, "__daemon-run"] };
  return { command: process.execPath, args: [entry, "__daemon-run"] };
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
    const child = spawn(command, args, { detached: true, stdio: ["ignore", logFd, logFd] });
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
        | { protocolVersion: number; boxersVersion: string; epoch: string; revision: number }
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
    if (!allowVersionMismatch) assertDaemonVersion(hello.boxersVersion);
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

export async function daemonHello(): Promise<{
  protocolVersion: number;
  boxersVersion: string;
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

/** Wake the daemon once after setup reaches a terminal state. */
export function notifyDaemonSetupCompleted(taskName: string): void {
  const socket = connect(daemonSocketPath());
  socket.once("connect", () => {
    socket.end(encodeMessage({ type: "setup_completed", taskName }));
  });
  socket.once("error", () => socket.destroy());
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

export function parseDaemonIntent(args: string[]): { task: string; intent: TaskIntent } {
  const task = args[0];
  const command = args[1];
  if (!task || !command) throw new Error("A daemon intent requires a task and command.");
  const rest = args.slice(2);
  switch (command) {
    case "status":
      if (rest.some((argument) => argument !== "--refresh" && argument !== "--json"))
        throw new Error("status --refresh accepts only --json.");
      return { task, intent: { kind: "refresh", json: rest.includes("--json") } };
    case "sync":
    case "check":
    case "setup":
      if (rest.length) throw new Error(`${command} does not accept arguments.`);
      return { task, intent: { kind: command } };
    case "review":
      if (rest.length) throw new Error(`${command} does not accept arguments.`);
      return { task, intent: { kind: command, color: colorEnabled() } };
    case "promote": {
      let message: string | undefined;
      let skipChecks = false;
      for (let index = 0; index < rest.length; index++) {
        const argument = rest[index];
        if (argument === "--skip-checks") skipChecks = true;
        else if (argument === "--message") {
          message = rest[++index];
          if (!message) throw new Error("--message requires a value.");
        } else if (argument?.startsWith("--message=")) message = argument.slice(10);
        else throw new Error(`Unexpected argument for promote: ${argument}`);
      }
      return {
        task,
        intent: {
          kind: "promote",
          ...(message ? { message } : {}),
          skipChecks,
        },
      };
    }
    case "preview": {
      const action = rest[0] ?? "show";
      if (
        action !== "show" &&
        action !== "start" &&
        action !== "stop" &&
        action !== "restart" &&
        action !== "logs"
      )
        throw new Error(`Invalid preview action ${action}.`);
      return { task, intent: { kind: "preview", action } };
    }
    case "discard":
      if (rest.some((argument) => argument !== "--force") || rest.length > 1)
        throw new Error("discard accepts only --force.");
      return { task, intent: { kind: "discard", force: rest.includes("--force") } };
    default:
      throw new Error(`Unsupported daemon intent ${command}.`);
  }
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
  lifecycle?: { taskName: string; bridgeToken: string },
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
        command,
        args,
        cols: 80,
        rows: 24,
      }),
    );
  });
}
