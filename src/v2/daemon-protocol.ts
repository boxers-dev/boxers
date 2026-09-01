export interface AttachRequest {
  type: "attach";
  sessionId: string;
  command: string;
  args: string[];
  cols: number;
  rows: number;
  taskName?: string;
  bridgeToken?: string;
}
export interface StartSessionRequest {
  type: "start_session";
  requestId: string;
  sessionId: string;
  taskName: string;
  bridgeToken: string;
  command: string;
  args: string[];
  cols: number;
  rows: number;
}
export interface InputMessage {
  type: "input";
  sessionId: string;
  dataBase64: string;
}
export interface ResizeMessage {
  type: "resize";
  sessionId: string;
  cols: number;
  rows: number;
}
export interface DetachMessage {
  type: "detach";
  sessionId: string;
}
export interface StopMessage {
  type: "stop";
  sessionId: string;
}
export interface ListRequest {
  type: "list";
}

export const DAEMON_PROTOCOL_VERSION = 5;

export interface HelloRequest {
  type: "hello";
  requestId: string;
  protocolVersion: number;
}

export interface SnapshotRequest {
  type: "get_snapshot";
  requestId: string;
}

export interface SubscribeRequest {
  type: "subscribe";
  requestId: string;
  epoch?: string;
  sinceRevision?: number;
}

export interface StateChangedRequest {
  type: "state_changed";
}

export interface SetupCompletedRequest {
  type: "setup_completed";
  taskName: string;
}

export type TaskIntent =
  | { kind: "refresh"; json: boolean }
  | { kind: "sync" }
  | { kind: "review"; color?: boolean }
  | { kind: "check" }
  | { kind: "promote"; message?: string; skipChecks: boolean }
  | { kind: "preview"; action?: "show" | "start" | "stop" | "restart" | "logs" }
  | { kind: "discard"; force: boolean };

export interface RunIntentRequest {
  type: "run_intent";
  intentId: string;
  task: string;
  intent: TaskIntent;
}

export type ClientMessage =
  | AttachRequest
  | StartSessionRequest
  | InputMessage
  | ResizeMessage
  | DetachMessage
  | StopMessage
  | ListRequest
  | HelloRequest
  | SnapshotRequest
  | SubscribeRequest
  | StateChangedRequest
  | SetupCompletedRequest
  | RunIntentRequest;

export interface ReplayMessage {
  type: "replay";
  sessionId: string;
  dataBase64: string;
}
export interface OutputMessage {
  type: "output";
  sessionId: string;
  dataBase64: string;
}
export interface ExitedMessage {
  type: "exited";
  sessionId: string;
  code: number | null;
}
export interface SessionStartedMessage {
  type: "session_started";
  requestId: string;
  sessionId: string;
}
export interface SessionInfo {
  sessionId: string;
  state: "running" | "exited";
  viewers: number;
}
export interface SessionsMessage {
  type: "sessions";
  pid: number;
  sessions: SessionInfo[];
  intents: { task: string }[];
}
export interface ErrorMessage {
  type: "error";
  message: string;
  requestId?: string;
  intentId?: string;
}

export interface HelloMessage {
  type: "hello";
  requestId: string;
  protocolVersion: number;
  boxersVersion: string;
  epoch: string;
  revision: number;
}

export interface SnapshotMessage {
  type: "snapshot";
  requestId: string;
  epoch: string;
  revision: number;
  snapshot: unknown;
}

export interface SubscribedMessage {
  type: "subscribed";
  requestId: string;
  epoch: string;
  revision: number;
  reset: boolean;
}

export interface StateChangedMessage {
  type: "state_changed";
  epoch: string;
  revision: number;
}

export interface IntentOutputMessage {
  type: "intent_output";
  intentId: string;
  stream: "stdout" | "stderr";
  dataBase64: string;
}

export interface IntentExitedMessage {
  type: "intent_exited";
  intentId: string;
  code: number;
}

export type ServerMessage =
  | ReplayMessage
  | OutputMessage
  | ExitedMessage
  | SessionStartedMessage
  | SessionsMessage
  | ErrorMessage
  | HelloMessage
  | SnapshotMessage
  | SubscribedMessage
  | StateChangedMessage
  | IntentOutputMessage
  | IntentExitedMessage;

export function encodeMessage(message: ClientMessage | ServerMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/** Buffers partial socket chunks and yields complete newline-delimited JSON lines. */
export class LineDecoder {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      lines.push(this.buffer.slice(0, newline));
      this.buffer = this.buffer.slice(newline + 1);
    }
    return lines;
  }
}

const CLIENT_MESSAGE_TYPES = new Set([
  "attach",
  "start_session",
  "input",
  "resize",
  "detach",
  "stop",
  "list",
  "hello",
  "get_snapshot",
  "subscribe",
  "state_changed",
  "setup_completed",
  "run_intent",
]);
const SERVER_MESSAGE_TYPES = new Set([
  "replay",
  "output",
  "exited",
  "session_started",
  "sessions",
  "error",
  "hello",
  "snapshot",
  "subscribed",
  "state_changed",
  "intent_output",
  "intent_exited",
]);

function parseLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Local-socket protocol between trusted, same-version peers: validate shape, not full schema. */
export function parseClientMessage(line: string): ClientMessage | undefined {
  const value = parseLine(line);
  if (!value || typeof value["type"] !== "string" || !CLIENT_MESSAGE_TYPES.has(value["type"]))
    return undefined;
  if (value["type"] === "run_intent") {
    const intent = value["intent"];
    if (
      typeof value["intentId"] !== "string" ||
      typeof value["task"] !== "string" ||
      !intent ||
      typeof intent !== "object" ||
      !["refresh", "sync", "review", "check", "promote", "preview", "discard"].includes(
        String((intent as Record<string, unknown>)["kind"]),
      )
    )
      return undefined;
    const intentRecord = intent as Record<string, unknown>;
    if (
      intentRecord["kind"] === "review" &&
      intentRecord["color"] !== undefined &&
      typeof intentRecord["color"] !== "boolean"
    )
      return undefined;
  }
  if (value["type"] === "setup_completed" && typeof value["taskName"] !== "string")
    return undefined;
  return value as unknown as ClientMessage;
}

export function parseServerMessage(line: string): ServerMessage | undefined {
  const value = parseLine(line);
  if (!value || typeof value["type"] !== "string" || !SERVER_MESSAGE_TYPES.has(value["type"]))
    return undefined;
  return value as unknown as ServerMessage;
}
