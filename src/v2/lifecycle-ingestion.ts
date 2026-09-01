import { posix } from "node:path";
import {
  MAX_CONVERSATION_CONTEXT_BYTES,
  normalizeRecordedLifecycleEnvelope,
  type ConversationEventRecord,
} from "./conversation.ts";
import { runtimeForTask } from "./runtime/registry.ts";
import { readTaskState, recordLifecycleDiagnostic, recordLifecycleEvent } from "./state.ts";
import type { ProjectManifest, TaskManifest } from "./types.ts";

export const MAX_LIFECYCLE_EVENTS_PER_DRAIN = 256;

function taskGitDir(task: TaskManifest): string {
  const runtime = runtimeForTask(task);
  const result = runtime.execute(task, [
    "git",
    "-C",
    runtime.workspacePath(task),
    "rev-parse",
    "--absolute-git-dir",
  ]);
  if (result.status !== 0)
    throw new Error(
      `Could not locate lifecycle event storage: ${(result.stderr || result.stdout).trim()}`,
    );
  const gitDir = result.stdout.trim();
  if (!gitDir.startsWith("/")) throw new Error("Lifecycle event storage path is not absolute.");
  return gitDir;
}

export function recordedLifecycleHighWater(task: TaskManifest): number {
  const runtime = runtimeForTask(task);
  const sequencePath = posix.join(taskGitDir(task), "boxers", "conversation", "sequence");
  const result = runtime.execute(task, ["cat", sequencePath]);
  if (result.status !== 0) return 0;
  const sequence = Number(result.stdout.trim());
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : 0;
}

/** Bounded, event-triggered drain. This is never called from a polling loop. */
export function drainTaskLifecycleEvents(
  project: ProjectManifest,
  task: TaskManifest,
  requestedThroughSequence = recordedLifecycleHighWater(task),
): ConversationEventRecord[] {
  const runtime = runtimeForTask(task);
  const gitDir = taskGitDir(task);
  const state = readTaskState(project, task);
  const through = Math.min(
    requestedThroughSequence,
    state.lifecycleDrainSequence + MAX_LIFECYCLE_EVENTS_PER_DRAIN,
  );
  const accepted: ConversationEventRecord[] = [];
  for (let sequence = state.lifecycleDrainSequence + 1; sequence <= through; sequence++) {
    const path = posix.join(gitDir, "boxers", "conversation", "events", `${sequence}.json`);
    const result = runtime.execute(task, ["cat", path]);
    if (result.status !== 0) {
      recordLifecycleDiagnostic(project, task, sequence, `Lifecycle event ${sequence} is missing.`);
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(result.stdout);
    } catch {
      recordLifecycleDiagnostic(
        project,
        task,
        sequence,
        `Lifecycle event ${sequence} is malformed.`,
      );
      continue;
    }
    const record = normalizeRecordedLifecycleEnvelope(raw);
    if (!record || record.sequence !== sequence || record.event.provider !== task.agent) {
      recordLifecycleDiagnostic(project, task, sequence, `Lifecycle event ${sequence} is invalid.`);
      continue;
    }
    if (recordLifecycleEvent(project, task, record)) accepted.push(record);
  }
  return accepted;
}

export function readConversationRecords(
  task: TaskManifest,
  throughSequence: number,
  afterSequence = 0,
  maximumBytes = MAX_CONVERSATION_CONTEXT_BYTES,
): ConversationEventRecord[] {
  const runtime = runtimeForTask(task);
  const gitDir = taskGitDir(task);
  const records: ConversationEventRecord[] = [];
  let bytes = 0;
  for (let sequence = throughSequence; sequence > afterSequence; sequence--) {
    const path = posix.join(gitDir, "boxers", "conversation", "events", `${sequence}.json`);
    const result = runtime.execute(task, ["cat", path]);
    if (result.status !== 0) continue;
    try {
      const record = normalizeRecordedLifecycleEnvelope(JSON.parse(result.stdout));
      if (record?.sequence === sequence && record.event.provider === task.agent) {
        records.unshift(record);
        bytes += Buffer.byteLength(JSON.stringify(record.event), "utf8");
        // Retain one overflow record so conversationWindow reports truncation.
        if (records.length > 1 && bytes > maximumBytes) break;
      }
    } catch {
      // The ingestion diagnostic owns malformed-event reporting.
    }
  }
  return records;
}
