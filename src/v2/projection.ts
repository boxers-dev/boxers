import { basename } from "node:path";
import { readVersion } from "../core/version.ts";
import { listProjects, listTasks, localMachineIdentity } from "./registry.ts";
import { readTaskState } from "./state.ts";
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
  _options: { ignoreOperationKind?: string } = {},
): TaskView {
  const state = recordedState;
  const setupConfigured = state.setupConfigured ?? Boolean(state.setup);
  const checksConfigured = state.checksConfigured ?? Boolean(state.check);
  const checkConfigHash = state.checkConfigHash;
  return deriveTaskView({
    name: task.name,
    state,
    setupConfigured,
    checksConfigured,
    ...(checkConfigHash ? { checkConfigHash } : {}),
    ...(task.lastSnapshot?.preview ? { preview: task.lastSnapshot.preview } : {}),
    ...(task.lastSnapshot?.runtimeState ? { runtimeState: task.lastSnapshot.runtimeState } : {}),
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
      integration: project.integration.mode,
    })),
    tasks,
  };
}
