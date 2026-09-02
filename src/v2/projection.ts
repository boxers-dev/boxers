import { basename } from "node:path";
import { readVersion } from "../core/version.ts";
import { listProjects, listTasks, localMachineIdentity } from "./registry.ts";
import { readTaskState, taskNeedsAttention } from "./state.ts";
import type { RemoteSnapshot, TaskProjectionPhase, TaskState, TaskSnapshot } from "./types.ts";
import { readHostStatus } from "./host-status.ts";
import { fleetReleaseIsAcknowledged, readFleetUpdateState } from "./fleet-update.ts";

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
      if (state.updatedAt < observedAt) observedAt = state.updatedAt;
      return {
        id: task.id,
        projectId: project.id,
        project: basename(project.root),
        name: task.name,
        agent: task.agent,
        runtime: task.runtime,
        phase: projectionPhase(snapshot, state),
        activity: state.agentTurnState,
        needsAttention: taskNeedsAttention(state),
        ...(state.hasUnmergedChanges.value === "unknown"
          ? {}
          : { hasUnmergedChanges: state.hasUnmergedChanges.value }),
        runtimeState: snapshot.runtimeState ?? "unknown",
        stateObservedAt: state.updatedAt,
        activityObservedAt: state.lastLifecycleEventAt ?? state.updatedAt,
        workspaceObservedAt: state.hasUnmergedChanges.observedAt,
        state,
        ...(snapshot.preview ? { preview: snapshot.preview } : {}),
        ...(state.lastDelivery ? { lastDelivery: state.lastDelivery.value } : {}),
        ...(state.summary ? { summary: state.summary } : {}),
      };
    }),
  );
  return {
    protocolVersion: 2,
    machine: { ...localMachineIdentity(), boxersVersion: readVersion() },
    observedAt,
    servedAt,
    ...(hostStatus ? { hostStatus } : {}),
    ...(update.desired
      ? {
          boxersUpdate: {
            desiredBuildId: update.desired.body.release.buildId,
            desiredVersion: update.desired.body.release.packageVersion,
            status: fleetReleaseIsAcknowledged(localId, update)
              ? ("current" as const)
              : localUpdate?.body.status === "failed"
                ? ("failed" as const)
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
