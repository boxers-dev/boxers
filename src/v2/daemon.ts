import { createServer, type Server, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as pty from "@lydell/node-pty";
import type { IPty } from "@lydell/node-pty";
import {
  atomicWriteText,
  atomicWriteJson,
  readJson,
  daemonHealthPath,
  daemonLockPath,
  daemonPidPath,
  daemonSocketPath,
  taskIntentLeasePath,
} from "./paths.ts";
import {
  DAEMON_PROTOCOL_VERSION,
  encodeMessage,
  LineDecoder,
  parseClientMessage,
  type ClientMessage,
  type ServerMessage,
} from "./daemon-protocol.ts";
import { readVersion } from "../core/version.ts";
import type { OutputSink } from "../core/output.ts";
import { captureStateProjection } from "./projection.ts";
import { listProjects, listTasks } from "./registry.ts";
import { startPeerObservers, type PeerObserverHandle } from "./peer-cache.ts";
import { ensureTaskState, readTaskState, recordAgentExited, updateTaskState } from "./state.ts";
import {
  findTaskRuntime,
  isRuntimeRunning,
  runtimeInventoryAsync,
  taskRuntimeId,
} from "./runtime/task.ts";
import type { RuntimeInfo } from "./runtime/types.ts";
import { gossipFleetMembership } from "./fleet-connect.ts";
import { fleetReleaseNeedsDaemonHandoff, reconcileFleetRelease } from "./fleet-release.ts";
import { activeReleaseBuildId } from "./release.ts";
import { taskIntentLeaseActive } from "./leases.ts";
import { recoverTaskMutationBarrier, taskMutationBarrierActiveAsync } from "./mutation.ts";
import {
  executeIntentDirect,
  executeIntentInWorker,
  ingestLifecycleInWorker,
  settlementInWorker,
} from "./daemon-worker.ts";
import { processIsBoxersDaemon } from "./daemon-identity.ts";
import { PtyControlParser } from "./pty-control.ts";
import {
  SettlementCoordinator,
  type SettlementRunContext,
  type SettlementRunSnapshot,
} from "./settlement.ts";
import { debugValue, writeDaemonDebug } from "./daemon-debug.ts";
import type { RecordedTaskOperation, TaskOperationKind } from "./types.ts";

const REPLAY_BUFFER_BYTES = 200_000;
const MAX_VIEWER_BUFFER_BYTES = 1_000_000;
interface TaskIntentLease {
  version: 1;
  task: string;
  daemonPid: number;
  childPid?: number;
  operations: RecordedTaskOperation[];
  updatedAt: string;
}
const SETTLEMENT_ACTIVITY: Record<SettlementRunSnapshot["phase"], string> = {
  queued: "Queued post-turn processing",
  refreshing: "Checking for updated Git targets",
  reconciling: "Reconciling with the updated Git target",
  capturing: "Capturing the sandbox candidate",
  checking: "Running checks",
  generating: "Generating commit metadata",
  ready: "Finished post-turn processing",
  needs_input: "Post-turn processing needs input",
  cancelled: "Cancelled post-turn processing",
  failed: "Post-turn processing failed",
};

interface ViewerState {
  cols: number;
  rows: number;
}

interface Session {
  id: string;
  proc: IPty;
  buffer: string[];
  bufferedBytes: number;
  viewers: Map<Socket, ViewerState>;
  activeWriter: Socket | undefined;
  taskName: string | undefined;
  pendingInput: string[];
  inputFlushPending: boolean;
  inputFlushTimer: ReturnType<typeof setTimeout> | undefined;
  state: "running" | "exited";
  controlParser: PtyControlParser | undefined;
}

export interface DaemonHandle {
  server: Server;
  close: () => Promise<void>;
}

export interface DaemonOptions {
  debug?: (message: string) => void;
  executeIntent?: (
    message: ClientMessage & { type: "run_intent" },
    output: OutputSink,
  ) => Promise<number>;
  ingestLifecycle?: (
    taskName: string,
    throughSequence?: number,
  ) => Promise<{ sequence: number; kind: "user_prompt" | "turn_finished" }[]>;
  executeSettlement?: (
    taskName: string,
    triggerSequence: number,
    runId: string,
    signal: AbortSignal,
    onProgress: (
      phase: "refreshing" | "reconciling" | "capturing" | "checking" | "generating",
    ) => void,
    onIdentity: (targetOid: string, candidateTreeOid: string) => void,
  ) => Promise<
    | {
        targetOid?: string;
        candidateTreeOid?: string;
        deferred?: boolean;
        needsInput?: string;
      }
    | undefined
  >;
  onSettlementTransition?: (snapshot: Readonly<SettlementRunSnapshot>) => void;
  startupInventory?: () => Promise<RuntimeInfo[]>;
  onUpdateHandoff?: () => void;
}

function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) result[key] = value;
  return result;
}

function appendToReplayBuffer(session: Session, chunk: string): void {
  session.buffer.push(chunk);
  session.bufferedBytes += Buffer.byteLength(chunk, "utf8");
  while (session.bufferedBytes > REPLAY_BUFFER_BYTES && session.buffer.length > 1) {
    const dropped = session.buffer.shift();
    if (dropped) session.bufferedBytes -= Buffer.byteLength(dropped, "utf8");
  }
}

function send(socket: Socket, message: ServerMessage): boolean {
  return !socket.destroyed && socket.write(encodeMessage(message));
}

function applyViewerBackpressure(session: Session, viewer: Socket): void {
  // `socket.write()` returning false only means that Node queued the bytes and
  // wants the producer to wait for `drain`; it is not a delivery failure. Keep
  // a normally draining viewer attached, including one receiving the bounded
  // replay buffer, and discard it only if its own queue grows substantially
  // beyond a complete replay.
  if (!viewer.destroyed && viewer.writableLength <= MAX_VIEWER_BUFFER_BYTES) return;
  // A viewer is only a disposable projection of the durable PTY. Disconnect a
  // lagging projection and let it recover from the bounded replay buffer on
  // reattach; never let one abandoned SSH connection pause the agent or the
  // other viewers.
  session.viewers.delete(viewer);
  if (session.activeWriter === viewer) restorePreviousWriter(session);
  viewer.destroy();
}

function restorePreviousWriter(session: Session): void {
  const previous = [...session.viewers.entries()].at(-1);
  session.activeWriter = previous?.[0];
  if (previous) session.proc.resize(previous[1].cols, previous[1].rows);
}

function startSession(
  sessions: Map<string, Session>,
  request: (ClientMessage & { type: "attach" }) | (ClientMessage & { type: "start_session" }),
  taskName: string | undefined,
  onEvent: (
    sessionId: string,
    event: "output" | "exited" | { type: "lifecycle"; sequence: number },
  ) => void,
): Session {
  const proc = pty.spawn(request.command, request.args, {
    name: "xterm-256color",
    cols: request.cols,
    rows: request.rows,
    cwd: process.cwd(),
    env: cleanEnv(process.env),
  });
  const session: Session = {
    id: request.sessionId,
    proc,
    buffer: [],
    bufferedBytes: 0,
    viewers: new Map(),
    activeWriter: undefined,
    taskName,
    pendingInput: [],
    inputFlushPending: false,
    inputFlushTimer: undefined,
    state: "running",
    controlParser: request.bridgeToken ? new PtyControlParser(request.bridgeToken) : undefined,
  };
  sessions.set(request.sessionId, session);
  proc.onData((chunk) => {
    const current = sessions.get(request.sessionId);
    if (!current) return;
    if (current.controlParser) {
      const parsed = current.controlParser.push(chunk);
      chunk = parsed.output;
      for (const frame of parsed.frames)
        onEvent(request.sessionId, { type: "lifecycle", sequence: frame.sequence });
    }
    if (!chunk) return;
    appendToReplayBuffer(current, chunk);
    const message: ServerMessage = {
      type: "output",
      sessionId: request.sessionId,
      dataBase64: Buffer.from(chunk, "utf8").toString("base64"),
    };
    for (const viewer of current.viewers.keys())
      if (!send(viewer, message)) applyViewerBackpressure(current, viewer);
    onEvent(request.sessionId, "output");
  });
  proc.onExit(({ exitCode }) => {
    const current = sessions.get(request.sessionId);
    if (!current) return;
    current.state = "exited";
    for (const viewer of current.viewers.keys())
      send(viewer, { type: "exited", sessionId: request.sessionId, code: exitCode });
    onEvent(request.sessionId, "exited");
  });
  return session;
}

/** Starts the daemon's socket server. Callers own the process lifetime (see `daemonMain`). */
export function runDaemon(
  socketPath: string = daemonSocketPath(),
  options: DaemonOptions = {},
): DaemonHandle {
  const sessions = new Map<string, Session>();
  const subscribers = new Set<Socket>();
  const epoch = randomUUID();
  let revision = 0;
  let closing = false;
  const busyTaskNames = new Set<string>();
  const intentTails = new Map<string, Promise<void>>();
  const lifecycleTails = new Map<string, Promise<void>>();
  const settlementDebugPhases = new Map<string, SettlementRunSnapshot["phase"]>();
  let peerObservers: PeerObserverHandle | undefined;
  let updateHandoffRequested = false;
  const debug =
    options.debug ?? (socketPath === daemonSocketPath() ? writeDaemonDebug : () => undefined);

  debug(`Starting daemon event loop (pid ${process.pid}).`);

  const publishChange = (): void => {
    revision++;
    for (const subscriber of subscribers)
      send(subscriber, { type: "state_changed", epoch, revision });
  };

  const persistSettlement = (snapshot: Readonly<SettlementRunSnapshot>): void => {
    if (settlementDebugPhases.get(snapshot.runId) !== snapshot.phase) {
      debug(
        `${SETTLEMENT_ACTIVITY[snapshot.phase]} on sandbox ${debugValue(snapshot.taskKey)}${snapshot.failure ? `: ${debugValue(snapshot.failure)}.` : "."}`,
      );
      settlementDebugPhases.set(snapshot.runId, snapshot.phase);
    }
    if (["ready", "needs_input", "cancelled", "failed"].includes(snapshot.phase))
      settlementDebugPhases.delete(snapshot.runId);
    options.onSettlementTransition?.(snapshot);
    for (const project of listProjects()) {
      const task = listTasks(project).find(
        (candidate) => candidate.name.toLowerCase() === snapshot.taskKey,
      );
      if (!task) continue;
      const { taskKey: _taskKey, ...settlement } = snapshot;
      updateTaskState(project, task, { settlement }, "daemon");
      publishChange();
      return;
    }
  };
  const settlements = new SettlementCoordinator({ onTransition: persistSettlement });

  const settlementWork =
    (taskName: string, sequence: number) => async (context: SettlementRunContext) => {
      const result = await (options.executeSettlement ?? settlementInWorker)(
        taskName,
        sequence,
        context.runId,
        context.signal,
        (phase) => context.transition(phase),
        (targetOid, candidateTreeOid) => context.identify(targetOid, candidateTreeOid),
      );
      if (result?.targetOid && result.candidateTreeOid)
        context.identify(result.targetOid, result.candidateTreeOid);
      if (result?.deferred) context.defer();
      if (result?.needsInput) context.needsInput(result.needsInput);
    };

  const startSettlement = (taskName: string, sequence: number, resume = false): void => {
    if (closing) return;
    const launch = settlementWork(taskName, sequence);
    if (resume) settlements.resume(taskName, sequence, launch);
    else settlements.start(taskName, sequence, launch);
  };

  const restartSettlement = (taskName: string, sequence: number): void => {
    if (closing) return;
    settlements.restart(taskName, sequence, settlementWork(taskName, sequence));
  };

  const acceptLifecycle = (
    taskName: string,
    events: { sequence: number; kind: "user_prompt" | "turn_finished" }[],
  ): void => {
    for (const lifecycle of events) {
      if (lifecycle.kind === "user_prompt") {
        debug(`Agent started generating on sandbox ${debugValue(taskName)}.`);
        settlements.cancel(taskName);
      } else {
        debug(`Agent finished generating on sandbox ${debugValue(taskName)}.`);
        startSettlement(taskName, lifecycle.sequence);
      }
    }
  };

  const ingestLifecycle = (
    taskName: string,
    throughSequence?: number,
    reason = "the daemon is reconciling task state",
  ): Promise<void> => {
    const key = taskName.toLowerCase();
    debug(
      `Polling lifecycle events for sandbox ${debugValue(taskName)} because ${reason}${throughSequence === undefined ? "." : ` (through sequence ${throughSequence}).`}`,
    );
    const previous = lifecycleTails.get(key) ?? Promise.resolve();
    const running = previous
      .catch(() => undefined)
      .then(() => (options.ingestLifecycle ?? ingestLifecycleInWorker)(taskName, throughSequence))
      .then((events) => {
        if (events.length)
          debug(
            `Received ${events.length} lifecycle event${events.length === 1 ? "" : "s"} for sandbox ${debugValue(taskName)}: ${events.map((event) => `${event.kind}#${event.sequence}`).join(", ")}.`,
          );
        else debug(`No new lifecycle events for sandbox ${debugValue(taskName)}.`);
        acceptLifecycle(taskName, events);
        publishChange();
      })
      .catch((error) => {
        debug(
          `Lifecycle polling failed for sandbox ${debugValue(taskName)}: ${debugValue(error instanceof Error ? error.message : String(error))}.`,
        );
        for (const project of listProjects()) {
          const task = listTasks(project).find(
            (candidate) => candidate.name.toLowerCase() === taskName.toLowerCase(),
          );
          if (task)
            updateTaskState(
              project,
              task,
              { lifecycleDiagnostic: error instanceof Error ? error.message : String(error) },
              "daemon",
            );
        }
        publishChange();
      })
      .finally(() => {
        if (lifecycleTails.get(key) === running) lifecycleTails.delete(key);
      });
    lifecycleTails.set(key, running);
    return running;
  };

  for (const project of listProjects())
    for (const task of listTasks(project)) {
      ensureTaskState(project, task);
      taskIntentLeaseActive(task.name);
      recoverTaskMutationBarrier(task);
    }

  const onSessionEvent = (
    sessionId: string,
    event: "output" | "exited" | { type: "lifecycle"; sequence: number },
  ): void => {
    if (typeof event === "object") {
      const taskName = sessions.get(sessionId)?.taskName;
      if (!taskName) return;
      ingestLifecycle(taskName, event.sequence, "the provider signaled a lifecycle change");
      return;
    }
    if (event === "exited") {
      const taskName = sessions.get(sessionId)?.taskName;
      debug(`Agent session exited on sandbox ${debugValue(taskName ?? sessionId)}.`);
      settlements.cancel(taskName ?? sessionId);
      if (taskName)
        for (const project of listProjects()) {
          const task = listTasks(project).find(
            (candidate) => candidate.name.toLowerCase() === taskName.toLowerCase(),
          );
          if (task) {
            recordAgentExited(project, task);
            publishChange();
            break;
          }
        }
    }
  };

  const taskNameForSession = (sessionId: string): string | undefined => {
    for (const project of listProjects()) {
      const task = listTasks(project).find(
        (candidate) => taskRuntimeId(candidate) === sessionId || candidate.id === sessionId,
      );
      if (task) return task.name;
    }
    return undefined;
  };

  const flushSessionInput = async (session: Session): Promise<void> => {
    session.inputFlushTimer = undefined;
    if (session.inputFlushPending) return;
    session.inputFlushPending = true;
    const task = session.taskName
      ? listProjects()
          .flatMap((project) => listTasks(project))
          .find((candidate) => candidate.name.toLowerCase() === session.taskName?.toLowerCase())
      : undefined;
    const blocked = task ? await taskMutationBarrierActiveAsync(task) : false;
    session.inputFlushPending = false;
    if (blocked) {
      const timer = setTimeout(() => void flushSessionInput(session), 25);
      timer.unref();
      session.inputFlushTimer = timer;
      return;
    }
    const input = session.pendingInput.splice(0).join("");
    if (input && session.state === "running") session.proc.write(input);
  };

  const writeSessionInput = (session: Session, input: string): void => {
    if (!session.taskName) {
      session.proc.write(input);
      return;
    }
    session.pendingInput.push(input);
    if (!session.inputFlushTimer && !session.inputFlushPending) void flushSessionInput(session);
  };

  const runIntent = async (
    socket: Socket,
    message: ClientMessage & { type: "run_intent" },
    onWorkerSpawn: (pid: number) => void,
  ): Promise<void> => {
    const forward = (stream: "stdout" | "stderr", chunk: string): void => {
      send(socket, {
        type: "intent_output",
        intentId: message.intentId,
        stream,
        dataBase64: Buffer.from(chunk, "utf8").toString("base64"),
      });
    };
    const output: OutputSink = {
      stdout: (chunk) => forward("stdout", chunk),
      stderr: (chunk) => forward("stderr", chunk),
    };
    let code = 1;
    debug(
      `Running ${debugValue(message.intent.kind)} command on sandbox ${debugValue(message.task)}.`,
    );
    try {
      code = options.executeIntent
        ? await options.executeIntent(message, output)
        : socketPath === daemonSocketPath()
          ? await executeIntentInWorker(
              message.task,
              message.intent,
              output,
              undefined,
              onWorkerSpawn,
            )
          : await executeIntentDirect(message.task, message.intent, output);
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error);
      for (const project of listProjects()) {
        const task = listTasks(project).find(
          (candidate) => candidate.name.toLowerCase() === message.task.toLowerCase(),
        );
        if (!task) continue;
        updateTaskState(project, task, { failure }, "command");
        break;
      }
      forward("stderr", `${failure}\n`);
    }
    if (["refresh", "sync", "review", "check"].includes(message.intent.kind))
      for (const project of listProjects()) {
        const task = listTasks(project).find(
          (candidate) => candidate.name.toLowerCase() === message.task.toLowerCase(),
        );
        if (!task) continue;
        const state = readTaskState(project, task);
        const completedPassage =
          code === 0 ||
          (message.intent.kind === "check" && state.check?.status === "failed" && !state.failure);
        if (
          completedPassage &&
          state.agentTurnState === "awaiting_input" &&
          state.conversationHighWaterSequence > 0
        )
          restartSettlement(task.name, state.conversationHighWaterSequence);
        break;
      }
    send(socket, { type: "intent_exited", intentId: message.intentId, code });
    debug(
      `Finished ${debugValue(message.intent.kind)} command on sandbox ${debugValue(message.task)} with status ${code}.`,
    );
    publishChange();
  };

  const enqueueIntent = (socket: Socket, message: ClientMessage & { type: "run_intent" }): void => {
    const taskKey = message.task.toLowerCase();
    debug(
      `Received ${debugValue(message.intent.kind)} command for sandbox ${debugValue(message.task)}.`,
    );
    if (
      taskIntentLeaseActive(taskKey) &&
      !busyTaskNames.has(taskKey) &&
      !intentTails.has(taskKey)
    ) {
      send(socket, {
        type: "error",
        intentId: message.intentId,
        message: `Task ${message.task} has an intent owned by another daemon process.`,
      });
      return;
    }
    const intentOperation: TaskOperationKind | undefined = (() => {
      switch (message.intent.kind) {
        case "refresh":
          return "refreshing_target";
        case "sync":
          return "reconciling";
        case "review":
          return "reviewing";
        case "check":
          return "running_checks";
        case "promote":
          return "promoting";
        case "discard":
          return "discarding";
        case "setup":
          return "setup";
        case "preview":
          return message.intent.action === "start" || message.intent.action === "restart"
            ? "starting_preview"
            : undefined;
      }
    })();
    const leasePath = taskIntentLeasePath(taskKey);
    const readLease = (): TaskIntentLease => {
      if (existsSync(leasePath)) {
        try {
          const current = readJson<TaskIntentLease>(leasePath);
          if (current.daemonPid === process.pid && Array.isArray(current.operations)) return current;
        } catch {
          // The current daemon replaces its own malformed lease below.
        }
      }
      return {
        version: 1,
        task: message.task,
        daemonPid: process.pid,
        operations: [],
        updatedAt: new Date().toISOString(),
      };
    };
    const writeLease = (update: (lease: TaskIntentLease) => TaskIntentLease): void =>
      atomicWriteJson(leasePath, update(readLease()));
    if (intentOperation)
      writeLease((lease) => ({
        ...lease,
        operations: [
          ...lease.operations,
          { kind: intentOperation, state: "queued", intentId: message.intentId },
        ],
        updatedAt: new Date().toISOString(),
      }));
    else if (!existsSync(leasePath)) atomicWriteJson(leasePath, readLease());
    const previous = intentTails.get(taskKey) ?? Promise.resolve();
    const running = previous
      .catch(() => undefined)
      .then(async () => {
        await settlements.cancelAndWait(taskKey);
        busyTaskNames.add(taskKey);
        writeLease((lease) => ({
          ...lease,
          operations: lease.operations.map((operation) =>
            operation.intentId === message.intentId
              ? { ...operation, state: "running", startedAt: new Date().toISOString() }
              : operation,
          ),
          updatedAt: new Date().toISOString(),
        }));
        try {
          await runIntent(socket, message, (childPid) => {
            writeLease((lease) => ({
              ...lease,
              childPid,
              updatedAt: new Date().toISOString(),
            }));
          });
        } finally {
          busyTaskNames.delete(taskKey);
          const lease = readLease();
          const operations = lease.operations.filter(
            (operation) => operation.intentId !== message.intentId,
          );
          if (operations.length)
            atomicWriteJson(leasePath, {
              ...lease,
              operations,
              childPid: undefined,
              updatedAt: new Date().toISOString(),
            });
          else
            try {
              unlinkSync(leasePath);
            } catch {
              // Discard may already have removed task-owned state.
            }
        }
      })
      .catch((error) => {
        send(socket, {
          type: "error",
          intentId: message.intentId,
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (intentTails.get(taskKey) === running) intentTails.delete(taskKey);
      });
    intentTails.set(taskKey, running);
  };

  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch {
      // A live daemon may already own this socket; listen() below fails loudly if so.
    }
  }

  const server = createServer((socket) => {
    const decoder = new LineDecoder();
    socket.setEncoding("utf8");
    let ownedSessionId: string | undefined;

    const leaveSession = (): void => {
      if (!ownedSessionId) return;
      const session = sessions.get(ownedSessionId);
      if (!session) return;
      session.viewers.delete(socket);
      if (session.activeWriter === socket) restorePreviousWriter(session);
    };

    const handle = (message: ClientMessage): void => {
      switch (message.type) {
        case "start_session": {
          debug(`Received start-session command for sandbox ${debugValue(message.taskName)}.`);
          void (async () => {
            let session = sessions.get(message.sessionId);
            if (!session || session.state === "exited") {
              session = startSession(sessions, message, message.taskName, onSessionEvent);
              debug(`Started agent session on sandbox ${debugValue(message.taskName)}.`);
            }
            send(socket, {
              type: "session_started",
              requestId: message.requestId,
              sessionId: message.sessionId,
            });
            if (options.ingestLifecycle || socketPath === daemonSocketPath())
              ingestLifecycle(message.taskName, undefined, "an agent session started");
          })();
          return;
        }
        case "list": {
          send(socket, {
            type: "sessions",
            pid: process.pid,
            sessions: [...sessions.entries()].map(([sessionId, session]) => ({
              sessionId,
              state: session.state,
              viewers: session.viewers.size,
            })),
            intents: [...intentTails.keys()].map((task) => ({ task })),
            backgroundWork:
              intentTails.size + lifecycleTails.size + (settlements.hasActiveRuns() ? 1 : 0),
          });
          return;
        }
        case "hello": {
          if (message.protocolVersion !== DAEMON_PROTOCOL_VERSION) {
            send(socket, {
              type: "error",
              requestId: message.requestId,
              message: `Unsupported daemon protocol version ${message.protocolVersion}; expected ${DAEMON_PROTOCOL_VERSION}.`,
            });
            return;
          }
          send(socket, {
            type: "hello",
            requestId: message.requestId,
            protocolVersion: DAEMON_PROTOCOL_VERSION,
            boxersVersion: readVersion(),
            epoch,
            revision,
          });
          return;
        }
        case "get_snapshot": {
          send(socket, {
            type: "snapshot",
            requestId: message.requestId,
            epoch,
            revision,
            snapshot: captureStateProjection(),
          });
          return;
        }
        case "subscribe": {
          subscribers.add(socket);
          send(socket, {
            type: "subscribed",
            requestId: message.requestId,
            epoch,
            revision,
            reset: message.epoch !== epoch || (message.sinceRevision ?? revision) !== revision,
          });
          return;
        }
        case "state_changed": {
          debug("Received state-change notification; reconciling peer observers.");
          peerObservers?.reconcile();
          publishChange();
          return;
        }
        case "setup_completed": {
          const taskName = message.taskName;
          debug(`Setup finished on sandbox ${debugValue(taskName)}.`);
          for (const project of listProjects()) {
            const task = listTasks(project).find(
              (candidate) => candidate.name.toLowerCase() === taskName.toLowerCase(),
            );
            if (!task) continue;
            const state = readTaskState(project, task);
            if (
              state.agentTurnState === "awaiting_input" &&
              state.conversationHighWaterSequence > 0
            )
              startSettlement(task.name, state.conversationHighWaterSequence, true);
            break;
          }
          publishChange();
          return;
        }
        case "run_intent": {
          if (!message.task || !message.intent?.kind) {
            send(socket, {
              type: "error",
              intentId: message.intentId,
              message: "Invalid daemon task intent.",
            });
            return;
          }
          enqueueIntent(socket, message);
          return;
        }
        case "attach": {
          ownedSessionId = message.sessionId;
          void (async () => {
            const taskName = message.taskName ?? taskNameForSession(message.sessionId);
            debug(
              `Received attach command for sandbox ${debugValue(taskName ?? message.sessionId)}.`,
            );
            let session = sessions.get(message.sessionId);
            if (!session || session.state === "exited") {
              session = startSession(sessions, message, taskName, onSessionEvent);
              debug(
                `Started agent session on sandbox ${debugValue(taskName ?? message.sessionId)}.`,
              );
            } else {
              session.taskName = taskName;
              if (message.bridgeToken)
                session.controlParser = new PtyControlParser(message.bridgeToken);
              session.proc.resize(message.cols, message.rows);
            }
            session.viewers.set(socket, { cols: message.cols, rows: message.rows });
            session.activeWriter = socket;
            if (taskName && (options.ingestLifecycle || socketPath === daemonSocketPath()))
              ingestLifecycle(taskName, undefined, "a viewer attached");
            const replay = session.buffer.join("");
            if (
              replay &&
              !send(socket, {
                type: "replay",
                sessionId: message.sessionId,
                dataBase64: Buffer.from(replay, "utf8").toString("base64"),
              })
            )
              applyViewerBackpressure(session, socket);
          })();
          return;
        }
        case "input": {
          const session = sessions.get(message.sessionId);
          if (!session || session.activeWriter !== socket) return;
          if (session.taskName) settlements.cancel(session.taskName);
          writeSessionInput(session, Buffer.from(message.dataBase64, "base64").toString("utf8"));
          return;
        }
        case "resize": {
          const session = sessions.get(message.sessionId);
          if (!session || session.activeWriter !== socket) return;
          session.viewers.set(socket, { cols: message.cols, rows: message.rows });
          session.proc.resize(message.cols, message.rows);
          return;
        }
        case "detach": {
          debug(`Detached viewer from session ${debugValue(message.sessionId)}.`);
          leaveSession();
          return;
        }
        case "stop": {
          const session = sessions.get(message.sessionId);
          if (!session) return;
          debug(
            `Stopping agent session on sandbox ${debugValue(session.taskName ?? message.sessionId)}.`,
          );
          session.proc.kill();
          sessions.delete(message.sessionId);
          return;
        }
      }
    };

    socket.on("data", (chunk: string) => {
      for (const line of decoder.push(chunk)) {
        const message = parseClientMessage(line);
        if (message) handle(message);
      }
    });
    socket.on("close", () => {
      subscribers.delete(socket);
      leaveSession();
    });
    socket.on("error", () => {
      subscribers.delete(socket);
      leaveSession();
    });
  });

  let fleetGossip: ReturnType<typeof setTimeout> | undefined;
  let fleetGossipClosed = false;
  const scheduleFleetGossip = (delay: number, failedAttempts = 0): void => {
    if (socketPath !== daemonSocketPath() || fleetGossipClosed) return;
    debug(
      `Scheduled fleet synchronization in ${delay}ms because ${failedAttempts ? `${failedAttempts} previous attempt${failedAttempts === 1 ? "" : "s"} failed` : "the fleet cache needs a periodic refresh"}.`,
    );
    fleetGossip = setTimeout(() => {
      debug("Polling fleet peers because the scheduled synchronization is due.");
      void gossipFleetMembership()
        .then(async (summary) => {
          debug(
            `Fleet synchronization contacted ${summary.attempted} peer${summary.attempted === 1 ? "" : "s"}; ${summary.failures.length} failed.`,
          );
          const release = await reconcileFleetRelease();
          if (release.status === "updated") debug("Installed the fleet's desired Boxers release.");
          if (release.detail)
            debug(
              `Fleet release reconciliation is ${release.status}: ${debugValue(release.detail)}.`,
            );
          const sessionsSafe = [...sessions.values()].every((session) => {
            if (session.state === "exited") return true;
            if (!session.taskName) return false;
            for (const project of listProjects()) {
              const task = listTasks(project).find(
                (candidate) => candidate.name.toLowerCase() === session.taskName?.toLowerCase(),
              );
              if (task) return readTaskState(project, task).agentTurnState === "awaiting_input";
            }
            return false;
          });
          if (
            !updateHandoffRequested &&
            fleetReleaseNeedsDaemonHandoff() &&
            sessionsSafe &&
            !busyTaskNames.size &&
            !intentTails.size &&
            !lifecycleTails.size &&
            !settlements.hasActiveRuns()
          ) {
            updateHandoffRequested = true;
            debug(
              "The desired Boxers release is installed and daemon work is at a safe handoff boundary.",
            );
            if (options.onUpdateHandoff) options.onUpdateHandoff();
            else if (socketPath === daemonSocketPath())
              setTimeout(() => {
                // systemd uses Restart=on-failure so normal `daemon stop`
                // remains stopped while an update handoff is restarted.
                process.exitCode = 75;
                process.kill(process.pid, "SIGTERM");
              }, 0);
          }
          const nextFailures = summary.failures.length ? failedAttempts + 1 : 0;
          const nextDelay = summary.failures.length
            ? Math.min(5 * 60_000, 15_000 * 2 ** Math.min(nextFailures, 4))
            : 60_000;
          scheduleFleetGossip(nextDelay, nextFailures);
        })
        .catch((error) => {
          debug(
            `Fleet synchronization failed: ${debugValue(error instanceof Error ? error.message : String(error))}.`,
          );
          const nextFailures = failedAttempts + 1;
          scheduleFleetGossip(
            Math.min(5 * 60_000, 15_000 * 2 ** Math.min(nextFailures, 4)),
            nextFailures,
          );
        });
    }, delay);
    fleetGossip.unref();
  };
  scheduleFleetGossip(5_000);
  peerObservers =
    socketPath === daemonSocketPath() ? startPeerObservers(publishChange, debug) : undefined;
  const startupInventory = options.startupInventory ?? runtimeInventoryAsync;
  const startupRecovery =
    socketPath === daemonSocketPath() || options.startupInventory
      ? startupInventory()
          .then(async (inventory) => {
            debug(
              `Checked ${inventory.length} sandbox runtime${inventory.length === 1 ? "" : "s"} during startup recovery.`,
            );
            for (const project of listProjects())
              for (const task of listTasks(project)) {
                if (!isRuntimeRunning(findTaskRuntime(inventory, task))) continue;
                await ingestLifecycle(task.name, undefined, "startup found the sandbox running");
                const state = readTaskState(project, task);
                const recoverable =
                  !state.settlement ||
                  [
                    "queued",
                    "refreshing",
                    "reconciling",
                    "capturing",
                    "checking",
                    "generating",
                  ].includes(state.settlement.phase);
                if (
                  recoverable &&
                  state.agentTurnState === "awaiting_input" &&
                  state.conversationHighWaterSequence > 0
                )
                  startSettlement(task.name, state.conversationHighWaterSequence);
              }
          })
          .catch((error) =>
            debug(
              `Startup sandbox recovery failed: ${debugValue(error instanceof Error ? error.message : String(error))}.`,
            ),
          )
      : Promise.resolve();

  // Listen only after synchronous startup initialization has succeeded. If an
  // initializer rejects persisted state, no live server handle is left behind.
  server.listen(socketPath);
  server.once("listening", () => {
    if (process.platform !== "win32") chmodSync(socketPath, 0o600);
    debug(`Listening for commands on ${debugValue(socketPath)}.`);
  });

  const close = (): Promise<void> => {
    debug("Stopping daemon event loop.");
    closing = true;
    fleetGossipClosed = true;
    if (fleetGossip) clearTimeout(fleetGossip);
    peerObservers?.close();
    for (const session of sessions.values()) {
      if (session.inputFlushTimer) clearTimeout(session.inputFlushTimer);
      session.proc.kill();
    }
    sessions.clear();
    return startupRecovery
      .then(() =>
        Promise.all([settlements.close(), ...intentTails.values(), ...lifecycleTails.values()]),
      )
      .then(() => new Promise((resolve) => server.close(() => resolve())));
  };

  return { server, close };
}

/** Foreground daemon entrypoint; returns false when another process owns it. */
export function daemonMain(): boolean {
  const lockPath = daemonLockPath();
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const claim = (): boolean => {
    try {
      writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      return true;
    } catch {
      try {
        const owner = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
        process.kill(owner, 0);
        if (processIsBoxersDaemon(owner)) return false;
        throw Object.assign(new Error("Stale daemon lock owner"), { code: "ESRCH" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
        try {
          unlinkSync(lockPath);
          writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
          return true;
        } catch {
          return false;
        }
      }
    }
  };
  if (!claim()) return false;
  let close: () => Promise<void>;
  try {
    ({ close } = runDaemon());
  } catch (error) {
    try {
      if (Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10) === process.pid)
        unlinkSync(lockPath);
    } catch {
      // A later startup can recover the PID lock if cleanup is interrupted.
    }
    throw error;
  }
  atomicWriteText(daemonPidPath(), `${process.pid}\n`);
  atomicWriteJson(daemonHealthPath(), {
    version: 1,
    pid: process.pid,
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    boxersVersion: readVersion(),
    ...(activeReleaseBuildId() ? { boxersBuildId: activeReleaseBuildId() } : {}),
    startedAt: new Date().toISOString(),
  });
  const shutdown = (): void => {
    void close().then(() => {
      try {
        unlinkSync(lockPath);
      } catch {
        // Another startup safely handles a stale lock if shutdown is interrupted.
      }
      process.exit(process.exitCode ?? 0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  return true;
}
