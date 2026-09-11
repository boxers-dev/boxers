import { existsSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson, readJson } from "./files.ts";
import { withPidFileLock } from "./lock.ts";
import type { HerdrInvocationContext, HerdrPluginState, HerdrProject, HerdrTask } from "./types.ts";

const EMPTY_STATE: HerdrPluginState = { version: 1, projects: [], tasks: [] };

export function pluginStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const path = env.HERDR_PLUGIN_STATE_DIR;
  if (!path) throw new Error("HERDR_PLUGIN_STATE_DIR is required for Herdr plugin commands.");
  return path;
}

export function statePath(stateDir = pluginStateDir()): string {
  return join(stateDir, "state.json");
}

export function readPluginState(stateDir = pluginStateDir()): HerdrPluginState {
  const path = statePath(stateDir);
  if (!existsSync(path)) return structuredClone(EMPTY_STATE);
  const state = readJson<HerdrPluginState>(path);
  if (state.version !== 1 || !Array.isArray(state.projects) || !Array.isArray(state.tasks))
    throw new Error(`Invalid Boxers plugin state at ${path}.`);
  return state;
}

export function writePluginState(state: HerdrPluginState, stateDir = pluginStateDir()): void {
  atomicWriteJson(statePath(stateDir), state);
}

export function withStateLock<T>(stateDir: string, work: () => T): T {
  return withPidFileLock(join(stateDir, "state.lock"), work);
}

export function updateTask(
  stateDir: string,
  taskId: string,
  update: (task: HerdrTask) => HerdrTask,
): HerdrTask {
  return withStateLock(stateDir, () => {
    const state = readPluginState(stateDir);
    const index = state.tasks.findIndex((task) => task.id === taskId);
    if (index < 0) throw new Error(`Unknown Boxers task ${taskId}.`);
    const task = update(state.tasks[index]!);
    state.tasks[index] = task;
    writePluginState(state, stateDir);
    return task;
  });
}

export function parseInvocationContext(raw: string | undefined): HerdrInvocationContext {
  if (!raw) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("HERDR_PLUGIN_CONTEXT_JSON is not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("HERDR_PLUGIN_CONTEXT_JSON must be an object.");
  const source = value as Record<string, unknown>;
  const context: HerdrInvocationContext = {};
  for (const key of [
    "workspace_id",
    "workspace_cwd",
    "focused_pane_id",
    "focused_pane_cwd",
  ] as const) {
    if (source[key] !== undefined && typeof source[key] !== "string")
      throw new Error(`HERDR_PLUGIN_CONTEXT_JSON.${key} must be a string.`);
    if (typeof source[key] === "string" && source[key]) context[key] = source[key];
  }
  return context;
}

export function selectedRoot(context: HerdrInvocationContext): string {
  const path = context.focused_pane_cwd ?? context.workspace_cwd;
  if (!path) throw new Error("Select a Herdr workspace or pane inside a Git repository.");
  return path;
}

export function taskForContext(
  state: HerdrPluginState,
  context: HerdrInvocationContext,
): HerdrTask {
  const paneId = context.focused_pane_id;
  const byPane = paneId
    ? state.tasks.find((task) => task.paneId === paneId || task.sourcePaneId === paneId)
    : undefined;
  if (byPane) return byPane;
  const workspaceId = context.workspace_id;
  const candidates = state.tasks
    .filter((task) => (workspaceId ? task.workspaceId === workspaceId : true))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  if (candidates[0]) return candidates[0];
  throw new Error("No sandboxed Boxers agent is associated with this Herdr context.");
}

export function upsertProject(state: HerdrPluginState, project: HerdrProject): void {
  const index = state.projects.findIndex((item) => item.id === project.id);
  if (index < 0) state.projects.push(project);
  else state.projects[index] = project;
}
