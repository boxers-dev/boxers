import { basename } from "node:path";
import { readVersion } from "../core/version.ts";
import { listProjects, listTasks, localMachineIdentity } from "./registry.ts";
import { readTaskState, updateTaskState } from "./state.ts";
import type {
  ProjectManifest,
  RemoteSnapshot,
  TaskManifest,
  TaskProjectionPhase,
  TaskState,
  TaskSnapshot,
  TaskView,
} from "./types.ts";
import { readHostStatus } from "./host-status.ts";
import { fleetReleaseIsAcknowledged, readFleetUpdateState } from "./fleet-update.ts";
import { readDaemonHandoffState } from "./daemon-handoff.ts";
import { deriveTaskView } from "./task-view.ts";
import { readTaskIntentOperations } from "./leases.ts";

function projectionPhase(snapshot: TaskSnapshot, state: TaskState): TaskProjectionPhase {
  if (state.agentTurnState === "working") return "working";
  const settlement = state.settlement;
  if (settlement) {
    if (settlement.phase === "queued") return "settling";
    if (
      ["refreshing", "reconciling", "capturing", "checking", "generating"].includes(
        settlement.phase,
      )
    )
      return settlement.phase as TaskProjectionPhase;
    if (settlement.phase === "failed") return "settlement_failed";
    if (settlement.phase === "needs_input") return "awaiting_input";
    if (settlement.phase === "ready")
      return state.check?.status === "failed" ? "check_failed" : "ready";
    if (settlement.phase === "cancelled") return "cancelled";
  }
  if (state.failure) return "failed";
  if (state.agentTurnState === "awaiting_input") return "awaiting_input";
  return snapshot.phase;
}

export function projectTaskView(
  project: ProjectManifest,
  task: TaskManifest,
  recordedState = readTaskState(project, task),
  options: { ignoreOperationKind?: string } = {},
): TaskView {
  let state = recordedState;
  const setupConfigured = state.setupConfigured ?? Boolean(state.setup);
  const checksConfigured = state.checksConfigured ?? Boolean(state.check || state.checkProgress);
  const checkConfigHash = state.checkConfigHash;
  const recordedOperations = readTaskIntentOperations(task.name.toLowerCase());
  const recordedOperation = recordedOperations.find((operation) => operation.state === "running");
  if (
    state.checkProgress &&
    recordedOperation?.kind !== "running_checks" &&
    state.settlement?.phase !== "checking"
  )
    state = updateTaskState(
      project,
      task,
      {
        checkProgress: null,
        failure: "The recorded check worker is no longer active.",
      },
      "daemon",
    );
  let ignoredRunningOperation = false;
  const operations = recordedOperations.filter((operation) => {
    if (
      !ignoredRunningOperation &&
      operation.kind === options.ignoreOperationKind &&
      operation.state === "running"
    ) {
      ignoredRunningOperation = true;
      return false;
    }
    return true;
  });
  return deriveTaskView({
    name: task.name,
    state,
    setupConfigured,
    checksConfigured,
    ...(checkConfigHash ? { checkConfigHash } : {}),
    ...(task.lastSnapshot?.preview ? { preview: task.lastSnapshot.preview } : {}),
    ...(task.lastSnapshot?.runtimeState ? { runtimeState: task.lastSnapshot.runtimeState } : {}),
    ...(operations.length ? { operations } : {}),
  });
}

/** Materialize the host projection from durable state without subprocesses. */
export function captureStateProjection(): RemoteSnapshot {
  const projects = listProjects();
  const hostStatus = readHostStatus();
  const update = readFleetUpdateState();
  const localId = localMachineIdentity().id;
  const localUpdate = update.acknowledgements.find(
    (acknowledgement) => acknowledgement.body.hostId === localId,
  );
  const handoff = readDaemonHandoffState();
  const servedAt = new Date().toISOString();
  let observedAt = servedAt;
  const tasks = projects.flatMap((project) =>
    listTasks(project).map((task) => {
      const snapshot = task.lastSnapshot ?? { phase: "idle" as const, agent: task.agent };
      const state = readTaskState(project, task);
      const view = projectTaskView(project, task, state);
      if (state.updatedAt < observedAt) observedAt = state.updatedAt;
      return {
        id: task.id,
        projectId: project.id,
        project: basename(project.root),
        name: task.name,
        agent: task.agent,
        runtime: task.runtime,
        view,
        runtimeState: snapshot.runtimeState ?? "unknown",
        stateObservedAt: state.updatedAt,
        activityObservedAt: state.lastLifecycleEventAt ?? state.updatedAt,
        workspaceObservedAt: state.hasUnmergedChanges.observedAt,
        internal: {
          state,
          phase: projectionPhase(snapshot, state),
          ...(snapshot.runtimeState ? { runtimeState: snapshot.runtimeState } : {}),
        },
      };
    }),
  );
  return {
    protocolVersion: 3,
    machine: { ...localMachineIdentity(), boxersVersion: readVersion() },
    observedAt,
    servedAt,
    ...(hostStatus ? { hostStatus } : {}),
    ...(update.desired
      ? {
          boxersUpdate: {
            desiredBuildId: update.desired.body.release.buildId,
            desiredVersion: update.desired.body.release.packageVersion,
            status:
              localUpdate?.body.status === "failed" ||
              (handoff?.desiredBuildId === update.desired.body.release.buildId &&
                handoff.status === "failed")
                ? ("failed" as const)
                : fleetReleaseIsAcknowledged(localId, update) &&
                    !(
                      handoff?.desiredBuildId === update.desired.body.release.buildId &&
                      ["waiting", "restarting"].includes(handoff.status)
                    )
                  ? ("current" as const)
                  : ("pending" as const),
            ...(handoff?.desiredBuildId === update.desired.body.release.buildId
              ? {
                  activation: handoff.status,
                  ...(handoff.blockers.length ? { blockers: handoff.blockers } : {}),
                  ...(handoff.lastError
                    ? { detail: handoff.lastError }
                    : handoff.blockers.length
                      ? { detail: handoff.blockers.map((blocker) => blocker.detail).join("; ") }
                      : localUpdate?.body.detail
                        ? { detail: localUpdate.body.detail }
                        : {}),
                }
              : localUpdate?.body.detail
                ? { detail: localUpdate.body.detail }
                : {}),
          },
        }
      : {}),
    projects: projects.map((project) => ({
      id: project.id,
      name: basename(project.root),
      ...(project.source ? { source: project.source } : {}),
      base: project.integration.base,
      integration: project.integration.mode,
    })),
    tasks,
  };
}
