import { existsSync } from "node:fs";
import { atomicWriteJson, readJson, taskStatePath } from "./paths.ts";
import { withPidFileLock } from "./lock.ts";
import type {
  Observation,
  ObservationSource,
  CandidateCommitMessage,
  CheckRun,
  DeliveryRecord,
  ProjectManifest,
  SetupStatus,
  TaskManifest,
  TaskSnapshot,
  TaskState,
  WorkspaceRelation,
} from "./types.ts";
import type { ConversationEventRecord } from "./conversation.ts";

function observation<T>(
  value: T,
  observedAt: string,
  source: ObservationSource,
  conversationSequence?: number,
): Observation<T> {
  return {
    value,
    observedAt,
    source,
    ...(conversationSequence === undefined ? {} : { conversationSequence }),
  };
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function initialTaskState(
  _project: ProjectManifest,
  task: TaskManifest,
  now = new Date().toISOString(),
): TaskState {
  return {
    version: 3,
    taskId: task.id,
    revision: 1,
    updatedAt: now,
    agentTurnState: "not_started",
    conversationHighWaterSequence: 0,
    lifecycleDrainSequence: 0,
    promotionConversationCheckpoint: 0,
    hasUnmergedChanges: observation("unknown", now, "initial"),
  };
}

function validObservation<T>(
  value: unknown,
  valid: (candidate: unknown) => candidate is T,
): value is Observation<T> {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    hasOnlyKeys(record, ["value", "observedAt", "source", "conversationSequence"]) &&
    valid(record["value"]) &&
    typeof record["observedAt"] === "string" &&
    Number.isFinite(Date.parse(record["observedAt"])) &&
    ["command", "daemon", "worker", "git", "initial"].includes(String(record["source"])) &&
    (record["conversationSequence"] === undefined ||
      (Number.isSafeInteger(record["conversationSequence"]) &&
        Number(record["conversationSequence"]) >= 0))
  );
}

function validSetup(value: unknown): value is SetupStatus {
  if (!value || typeof value !== "object") return false;
  const setup = value as Record<string, unknown>;
  return (
    hasOnlyKeys(setup, [
      "state",
      "command",
      "startedAt",
      "finishedAt",
      "exitCode",
      "logPath",
      "jobId",
      "configHash",
      "observedAt",
      "source",
      "attempt",
      "maxAttempts",
    ]) &&
    ["running", "passed", "failed", "timed_out", "interrupted", "stale"].includes(
      String(setup.state),
    ) &&
    typeof setup.command === "string" &&
    typeof setup.startedAt === "string" &&
    typeof setup.logPath === "string" &&
    typeof setup.jobId === "string" &&
    typeof setup.configHash === "string" &&
    (setup.observedAt === undefined || typeof setup.observedAt === "string") &&
    (setup.source === undefined ||
      ["command", "daemon", "worker", "git", "initial"].includes(String(setup.source))) &&
    (setup.finishedAt === undefined || typeof setup.finishedAt === "string") &&
    (setup.exitCode === undefined || typeof setup.exitCode === "number") &&
    (setup.attempt === undefined ||
      (Number.isSafeInteger(setup.attempt) && Number(setup.attempt) > 0)) &&
    (setup.maxAttempts === undefined ||
      (Number.isSafeInteger(setup.maxAttempts) && Number(setup.maxAttempts) > 0))
  );
}

function validCheck(value: unknown): value is CheckRun {
  if (!value || typeof value !== "object") return false;
  const check = value as Record<string, unknown>;
  return (
    hasOnlyKeys(check, [
      "status",
      "targetOid",
      "candidateTreeOid",
      "configHash",
      "observedAt",
      "source",
      "results",
    ]) &&
    (check.status === "passed" || check.status === "failed") &&
    typeof check.targetOid === "string" &&
    typeof check.candidateTreeOid === "string" &&
    typeof check.configHash === "string" &&
    (check.observedAt === undefined || typeof check.observedAt === "string") &&
    (check.source === undefined ||
      ["command", "daemon", "worker", "git", "initial"].includes(String(check.source))) &&
    Array.isArray(check.results) &&
    check.results.every((result) => {
      if (!result || typeof result !== "object") return false;
      const item = result as Record<string, unknown>;
      return (
        hasOnlyKeys(item, ["name", "command", "status", "exitCode", "durationMs", "logPath"]) &&
        typeof item.name === "string" &&
        typeof item.command === "string" &&
        ["passed", "failed", "timed_out"].includes(String(item.status)) &&
        typeof item.durationMs === "number" &&
        (item.exitCode === undefined || typeof item.exitCode === "number") &&
        (item.logPath === undefined || typeof item.logPath === "string")
      );
    })
  );
}

function validCandidateCommitMessage(value: unknown): value is CandidateCommitMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return (
    hasOnlyKeys(message, [
      "targetOid",
      "candidateTreeOid",
      "conversationHighWaterSequence",
      "lifecycleDrainSequence",
      "subject",
      "note",
    ]) &&
    typeof message.targetOid === "string" &&
    typeof message.candidateTreeOid === "string" &&
    Number.isSafeInteger(message.conversationHighWaterSequence) &&
    Number(message.conversationHighWaterSequence) >= 0 &&
    typeof message.subject === "string" &&
    message.subject.length > 0 &&
    message.subject.length <= 72 &&
    ![...message.subject].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    }) &&
    (message.note === undefined ||
      (typeof message.note === "string" &&
        message.note.length > 0 &&
        message.note.length <= 8_000 &&
        ![...message.note].some((character) => {
          const code = character.codePointAt(0) ?? 0;
          return (code < 32 && code !== 9 && code !== 10) || code === 127;
        })))
  );
}

export function isTaskState(value: unknown, taskId: string): value is TaskState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<TaskState>;
  const record = value as Record<string, unknown>;
  return (
    hasOnlyKeys(record, [
      "version",
      "taskId",
      "revision",
      "updatedAt",
      "agentTurnState",
      "conversationHighWaterSequence",
      "lifecycleDrainSequence",
      "promotionConversationCheckpoint",
      "providerSessionId",
      "providerTurnId",
      "lastLifecycleEventKind",
      "lastLifecycleEventAt",
      "lifecycleDiagnostic",
      "hasUnmergedChanges",
      "baseOid",
      "candidateTreeOid",
      "lastDelivery",
      "setup",
      "check",
      "checksConfigured",
      "checkConfigHash",
      "setupConfigured",
      "commitMessage",
      "summary",
      "failure",
    ]) &&
    state.version === 3 &&
    state.taskId === taskId &&
    Number.isInteger(state.revision) &&
    (state.revision ?? 0) > 0 &&
    typeof state.updatedAt === "string" &&
    Number.isFinite(Date.parse(state.updatedAt)) &&
    ["not_started", "working", "awaiting_input", "exited", "unknown"].includes(
      String(state.agentTurnState),
    ) &&
    Number.isSafeInteger(state.conversationHighWaterSequence) &&
    Number(state.conversationHighWaterSequence) >= 0 &&
    Number.isSafeInteger(state.lifecycleDrainSequence) &&
    Number(state.lifecycleDrainSequence) >= Number(state.conversationHighWaterSequence) &&
    Number.isSafeInteger(state.promotionConversationCheckpoint) &&
    Number(state.promotionConversationCheckpoint) >= 0 &&
    Number(state.promotionConversationCheckpoint) <= Number(state.conversationHighWaterSequence) &&
    [
      state.providerSessionId,
      state.providerTurnId,
      state.lastLifecycleEventAt,
      state.lifecycleDiagnostic,
    ].every((candidate) => candidate === undefined || typeof candidate === "string") &&
    (state.lastLifecycleEventKind === undefined ||
      state.lastLifecycleEventKind === "user_prompt" ||
      state.lastLifecycleEventKind === "turn_finished") &&
    validObservation(
      state.hasUnmergedChanges,
      (candidate): candidate is boolean | "unknown" =>
        typeof candidate === "boolean" || candidate === "unknown",
    ) &&
    (state.setup === undefined || validSetup(state.setup)) &&
    (state.check === undefined || validCheck(state.check)) &&
    (state.checksConfigured === undefined || typeof state.checksConfigured === "boolean") &&
    (state.checkConfigHash === undefined || typeof state.checkConfigHash === "string") &&
    (state.setupConfigured === undefined || typeof state.setupConfigured === "boolean") &&
    (state.commitMessage === undefined || validCandidateCommitMessage(state.commitMessage)) &&
    (state.lastDelivery === undefined ||
      validObservation(state.lastDelivery, (candidate): candidate is DeliveryRecord => {
        if (!candidate || typeof candidate !== "object") return false;
        const delivery = candidate as Record<string, unknown>;
        return (
          hasOnlyKeys(delivery, [
            "ref",
            "oid",
            "subject",
            "deliveredAt",
            "conversationSequence",
            "checks",
          ]) &&
          typeof delivery.ref === "string" &&
          typeof delivery.oid === "string" &&
          typeof delivery.subject === "string" &&
          (delivery.deliveredAt === undefined || typeof delivery.deliveredAt === "string") &&
          (delivery.conversationSequence === undefined ||
            Number.isSafeInteger(delivery.conversationSequence)) &&
          (delivery.checks === undefined ||
            ["passed", "skipped", "not_configured"].includes(String(delivery.checks)))
        );
      })) &&
    [state.baseOid, state.candidateTreeOid, state.summary, state.failure].every(
      (candidate) => candidate === undefined || typeof candidate === "string",
    )
  );
}

function withTaskStateLock<T>(path: string, action: () => T): T {
  return withPidFileLock(`${path}.lock`, action);
}

export function readTaskState(project: ProjectManifest, task: TaskManifest): TaskState {
  const path = taskStatePath(project.id, task.id);
  if (!existsSync(path)) return initialTaskState(project, task);
  const state = readJson<unknown>(path);
  if (!isTaskState(state, task.id))
    throw new Error(`Unsupported task state at ${path}; discard and recreate the task.`);
  return state;
}

/** Create only the current schema. Older state is deliberately unsupported. */
export function ensureTaskState(project: ProjectManifest, task: TaskManifest): TaskState {
  const path = taskStatePath(project.id, task.id);
  return withTaskStateLock(path, () => {
    if (existsSync(path)) return readTaskState(project, task);
    const state = initialTaskState(project, task);
    atomicWriteJson(path, state);
    return state;
  });
}

export interface TaskStateUpdate {
  hasUnmergedChanges?: boolean | "unknown";
  baseOid?: string | null;
  candidateTreeOid?: string | null;
  setup?: TaskSnapshot["setup"] | null;
  check?: TaskSnapshot["check"] | null;
  checksConfigured?: boolean;
  checkConfigHash?: string | null;
  setupConfigured?: boolean;
  summary?: string | null;
  failure?: string | null;
  lastDelivery?: DeliveryRecord | { ref: string; oid: string; subject: string };
  lifecycleDiagnostic?: string | null;
  promotionConversationCheckpoint?: number;
}

export function updateTaskState(
  project: ProjectManifest,
  task: TaskManifest,
  update: TaskStateUpdate,
  source: ObservationSource = "daemon",
  observedAt = new Date().toISOString(),
): TaskState {
  const path = taskStatePath(project.id, task.id);
  return withTaskStateLock(path, () => {
    const previous = existsSync(path)
      ? readTaskState(project, task)
      : initialTaskState(project, task);
    const state: TaskState = {
      ...previous,
      revision: previous.revision + 1,
      updatedAt: observedAt,
      ...(update.hasUnmergedChanges === undefined
        ? {}
        : {
            hasUnmergedChanges: observation(
              update.hasUnmergedChanges,
              observedAt,
              source,
              source === "git" ? previous.conversationHighWaterSequence : undefined,
            ),
          }),
      ...(update.lastDelivery
        ? {
            lastDelivery: observation(
              "deliveredAt" in update.lastDelivery
                ? update.lastDelivery
                : {
                    ...update.lastDelivery,
                    deliveredAt: observedAt,
                    conversationSequence: previous.conversationHighWaterSequence,
                    checks: "not_configured" as const,
                  },
              observedAt,
              source,
            ),
          }
        : {}),
    };
    for (const [field, value] of [
      ["baseOid", update.baseOid],
      ["candidateTreeOid", update.candidateTreeOid],
      ["setup", update.setup],
      ["check", update.check],
      ["checksConfigured", update.checksConfigured],
      ["checkConfigHash", update.checkConfigHash],
      ["setupConfigured", update.setupConfigured],
      ["summary", update.summary],
      ["failure", update.failure],
      ["lifecycleDiagnostic", update.lifecycleDiagnostic],
      ["promotionConversationCheckpoint", update.promotionConversationCheckpoint],
    ] as const) {
      if (value === undefined) continue;
      if (value === null) delete (state as unknown as Record<string, unknown>)[field];
      else (state as unknown as Record<string, unknown>)[field] = value;
    }
    if (
      state.commitMessage &&
      (state.commitMessage.targetOid !== state.baseOid ||
        state.commitMessage.candidateTreeOid !== state.candidateTreeOid)
    )
      delete state.commitMessage;
    atomicWriteJson(path, state);
    return state;
  });
}

/** Publish a generated commit message only while its exact candidate is still current. */
export function recordCandidateCommitMessage(
  project: ProjectManifest,
  task: TaskManifest,
  message: CandidateCommitMessage,
  observedAt = new Date().toISOString(),
): boolean {
  const path = taskStatePath(project.id, task.id);
  return withTaskStateLock(path, () => {
    const previous = existsSync(path)
      ? readTaskState(project, task)
      : initialTaskState(project, task);
    if (
      previous.baseOid !== message.targetOid ||
      previous.candidateTreeOid !== message.candidateTreeOid ||
      previous.conversationHighWaterSequence !== message.conversationHighWaterSequence
    )
      return false;
    atomicWriteJson(path, {
      ...previous,
      revision: previous.revision + 1,
      updatedAt: observedAt,
      commitMessage: message,
    } satisfies TaskState);
    return true;
  });
}

/** Record the daemon-owned durable provider process reaching a terminal state. */
export function recordAgentExited(
  project: ProjectManifest,
  task: TaskManifest,
  observedAt = new Date().toISOString(),
): TaskState {
  const path = taskStatePath(project.id, task.id);
  return withTaskStateLock(path, () => {
    const previous = existsSync(path)
      ? readTaskState(project, task)
      : initialTaskState(project, task);
    if (previous.agentTurnState === "exited") return previous;
    const state = {
      ...previous,
      revision: previous.revision + 1,
      updatedAt: observedAt,
      agentTurnState: "exited" as const,
    };
    atomicWriteJson(path, state);
    return state;
  });
}

/** Atomically accept one strictly newer normalized lifecycle event. */
export function recordLifecycleEvent(
  project: ProjectManifest,
  task: TaskManifest,
  record: ConversationEventRecord,
): boolean {
  const path = taskStatePath(project.id, task.id);
  return withTaskStateLock(path, () => {
    const previous = existsSync(path)
      ? readTaskState(project, task)
      : initialTaskState(project, task);
    if (record.sequence <= previous.lifecycleDrainSequence) return false;
    const event = record.event;
    const duplicate =
      previous.providerSessionId === event.providerSessionId &&
      previous.providerTurnId === event.providerTurnId &&
      previous.lastLifecycleEventKind === event.kind;
    if (duplicate) {
      atomicWriteJson(path, {
        ...previous,
        revision: previous.revision + 1,
        updatedAt: event.recordedAt,
        lifecycleDrainSequence: record.sequence,
      } satisfies TaskState);
      return false;
    }
    const next: TaskState = {
      ...previous,
      revision: previous.revision + 1,
      updatedAt: event.recordedAt,
      agentTurnState: event.kind === "user_prompt" ? "working" : "awaiting_input",
      conversationHighWaterSequence: record.sequence,
      lifecycleDrainSequence: record.sequence,
      providerSessionId: event.providerSessionId,
      ...(event.providerTurnId ? { providerTurnId: event.providerTurnId } : {}),
      lastLifecycleEventKind: event.kind,
      lastLifecycleEventAt: event.recordedAt,
    };
    if (!event.providerTurnId) delete next.providerTurnId;
    atomicWriteJson(path, next);
    return true;
  });
}

export function recordLifecycleDiagnostic(
  project: ProjectManifest,
  task: TaskManifest,
  sequence: number,
  diagnostic: string,
): void {
  const path = taskStatePath(project.id, task.id);
  withTaskStateLock(path, () => {
    const previous = existsSync(path)
      ? readTaskState(project, task)
      : initialTaskState(project, task);
    if (sequence <= previous.lifecycleDrainSequence) return;
    atomicWriteJson(path, {
      ...previous,
      revision: previous.revision + 1,
      updatedAt: new Date().toISOString(),
      lifecycleDrainSequence: sequence,
      lifecycleDiagnostic: diagnostic,
    } satisfies TaskState);
  });
}

/** Publish the five user-facing facts derived from one coherent snapshot. */
export function recordTaskSnapshot(
  project: ProjectManifest,
  task: TaskManifest,
  snapshot: TaskSnapshot,
  options: {
    source?: ObservationSource;
    workspaceRelation?: WorkspaceRelation;
    observedAt?: string;
    publishSnapshot?: boolean;
    lastDelivery?: DeliveryRecord | { ref: string; oid: string; subject: string };
  } = {},
): TaskState {
  const relation = options.workspaceRelation;
  const publish = options.publishSnapshot === true;
  return updateTaskState(
    project,
    task,
    {
      ...(relation === undefined
        ? {}
        : {
            hasUnmergedChanges:
              relation === "on_base"
                ? false
                : relation === "not_on_base" || relation === "conflicted"
                  ? true
                  : "unknown",
          }),
      ...(snapshot.targetOid ? { baseOid: snapshot.targetOid } : {}),
      ...(snapshot.candidateTreeOid
        ? { candidateTreeOid: snapshot.candidateTreeOid }
        : publish
          ? { candidateTreeOid: null }
          : {}),
      ...(publish ? { setup: snapshot.setup ?? null, check: snapshot.check ?? null } : {}),
      ...(publish ? { summary: snapshot.summary ?? null, failure: snapshot.failure ?? null } : {}),
      ...(options.lastDelivery ? { lastDelivery: options.lastDelivery } : {}),
    },
    options.source ?? (relation === undefined ? "command" : "git"),
    options.observedAt,
  );
}

export function recordWorkspaceRelation(
  project: ProjectManifest,
  task: TaskManifest,
  relation: WorkspaceRelation,
  source: ObservationSource = "git",
): TaskState {
  return recordTaskSnapshot(
    project,
    task,
    task.lastSnapshot ?? { phase: "idle", agent: task.agent },
    { source, workspaceRelation: relation },
  );
}
