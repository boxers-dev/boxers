import { basename } from "node:path";
import { existsSync } from "node:fs";
import { taskReconciliationPath, taskDeliveryPath } from "./paths.ts";
import { readVersion } from "../core/version.ts";
import { listProjects, listTasks, localMachineIdentity, readProjectTarget } from "./registry.ts";
import { readTaskState } from "./state.ts";
import type {
  ProjectManifest,
  RemoteSnapshot,
  TaskManifest,
  TaskProjectionPhase,
  TaskState,
  TaskSnapshot,
  TaskView,
  RecordedTaskOperation,
  ProjectTargetObservation,
} from "./types.ts";
import { readHostStatus } from "./host-status.ts";
import { fleetReleaseIsAcknowledged, readFleetUpdateState } from "./fleet-update.ts";
import { deriveTaskView } from "./task-view.ts";

function projectionPhase(snapshot: TaskSnapshot, state: TaskState): TaskProjectionPhase {
  if (state.agentTurnState === "working") return "working";
  if (state.failure) return "failed";
  if (state.agentTurnState === "awaiting_input") {
    if (state.check?.status === "failed") return "check_failed";
    if (state.baseOid && state.candidateTreeOid && state.check?.status === "passed") return "ready";
    return "awaiting_input";
  }
  return snapshot.phase;
}

export function projectTaskView(
  project: ProjectManifest,
  task: TaskManifest,
  recordedState = readTaskState(project, task),
  options: {
    ignoreOperationKind?: string;
    operations?: readonly RecordedTaskOperation[];
    target?: ProjectTargetObservation;
    workspaceChanges?: boolean;
  } = {},
): TaskView {
  const state =
    options.workspaceChanges === undefined
      ? recordedState
      : {
          ...recordedState,
          hasUnmergedChanges: {
            ...recordedState.hasUnmergedChanges,
            value: options.workspaceChanges,
          },
        };
  const setupConfigured = state.setupConfigured ?? Boolean(state.setup);
  const checksConfigured = state.checksConfigured ?? Boolean(state.check);
  const checkConfigHash = state.checkConfigHash;
  const target = options.target ?? readProjectTarget(project);
  const operations = options.operations?.filter(
    (operation) => operation.kind !== options.ignoreOperationKind,
  );
  return deriveTaskView({
    name: task.name,
    state,
    setupConfigured,
    checksConfigured,
    target: target ?? { ...project.integration, attemptedAt: "" },
    ...(operations ? { operations } : {}),
    reconciliationUncertain: existsSync(taskReconciliationPath(project.id, task.id)),
    deliveryPending: existsSync(taskDeliveryPath(project.id, task.id)),
    ...(checkConfigHash ? { checkConfigHash } : {}),
    ...(task.lastSnapshot?.preview ? { preview: task.lastSnapshot.preview } : {}),
    ...(task.lastSnapshot?.runtimeState ? { runtimeState: task.lastSnapshot.runtimeState } : {}),
  });
}

/** Materialize the host projection from durable state without subprocesses. */
export function captureStateProjection(
  operationsByTask: ReadonlyMap<string, readonly RecordedTaskOperation[]> = new Map(),
): RemoteSnapshot {
  const projects = listProjects();
  const hostStatus = readHostStatus();
  const update = readFleetUpdateState();
  const localId = localMachineIdentity().id;
  const localUpdate = update.acknowledgements.find(
    (acknowledgement) => acknowledgement.body.hostId === localId,
  );
  const servedAt = new Date().toISOString();
  let observedAt = servedAt;
  const tasks = projects.flatMap((project) =>
    listTasks(project).map((task) => {
      const snapshot = task.lastSnapshot ?? { phase: "idle" as const, agent: task.agent };
      const state = readTaskState(project, task);
      const view = projectTaskView(project, task, state, {
        operations: operationsByTask.get(task.name.toLowerCase()) ?? [],
      });
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
              localUpdate?.body.status === "failed"
                ? ("failed" as const)
                : fleetReleaseIsAcknowledged(localId, update)
                  ? ("current" as const)
                  : ("pending" as const),
            ...(localUpdate?.body.detail ? { detail: localUpdate.body.detail } : {}),
          },
        }
      : {}),
    projects: projects.map((project) => ({
      id: project.id,
      name: basename(project.root),
      ...(project.source ? { source: project.source } : {}),
      base: project.integration.base,
      remote: project.integration.remote,
    })),
    tasks,
  };
}
