import type { TaskState } from "./types.ts";

export type RestartBlockerKind =
  | "working"
  | "unknown_activity"
  | "active_intent"
  | "background_work"
  | "uncommitted_input"
  | "lifecycle_failure"
  | "superseded";

export interface RestartBlocker {
  kind: RestartBlockerKind;
  task?: string;
  detail: string;
}

export type RestartBoundary =
  | { safe: true; reason: "not_started" | "turn_finished" | "exited" }
  | { safe: false; blocker: RestartBlocker };

/** Classify one fully drained provider session at the daemon shutdown boundary. */
export function restartBoundary(
  taskName: string,
  state: TaskState,
  session: { state: "running" | "exited"; uncommittedInput: boolean },
): RestartBoundary {
  if (session.state === "exited") return { safe: true, reason: "exited" };
  if (session.uncommittedInput)
    return {
      safe: false,
      blocker: {
        kind: "uncommitted_input",
        task: taskName,
        detail: `Task ${taskName} has terminal input not confirmed by a provider lifecycle event.`,
      },
    };
  if (
    state.agentTurnState === "not_started" &&
    state.conversationHighWaterSequence === 0 &&
    state.lifecycleDrainSequence === 0
  )
    return { safe: true, reason: "not_started" };
  if (
    state.agentTurnState === "awaiting_input" &&
    state.lastLifecycleEventKind === "turn_finished" &&
    state.conversationHighWaterSequence > 0 &&
    state.conversationHighWaterSequence === state.lifecycleDrainSequence
  )
    return { safe: true, reason: "turn_finished" };
  if (state.agentTurnState === "working")
    return {
      safe: false,
      blocker: {
        kind: "working",
        task: taskName,
        detail: `Task ${taskName}'s provider turn is still working.`,
      },
    };
  return {
    safe: false,
    blocker: {
      kind: state.lifecycleDiagnostic ? "lifecycle_failure" : "unknown_activity",
      task: taskName,
      detail: state.lifecycleDiagnostic
        ? `Task ${taskName}'s lifecycle state could not be proven safe: ${state.lifecycleDiagnostic}`
        : `Task ${taskName}'s lifecycle state ${state.agentTurnState} is not a proven restart boundary.`,
    },
  };
}
