import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { hostname } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { DEFAULT_PROJECT_CONFIG, readProjectConfig } from "./config.ts";
import {
  atomicWriteJson,
  machineIdentityLockPath,
  machineIdentityPath,
  projectDir,
  projectsDir,
  readJson,
  taskDir,
  taskManifestLockPath,
} from "./paths.ts";
import { withPidFileLock } from "./lock.ts";
import { command, requireSuccess } from "./process.ts";
import { recordTaskSnapshot } from "./state.ts";
import { notifyDaemonStateChanged } from "./daemon-client.ts";
import { defaultRuntime, runtimeHandleForTask } from "./runtime/registry.ts";
import type {
  Agent,
  IntegrationMode,
  ObservationSource,
  ProjectManifest,
  TaskManifest,
  TaskSnapshot,
  MachineIdentity,
} from "./types.ts";

export function localMachineIdentity(): MachineIdentity {
  const path = machineIdentityPath();
  if (existsSync(path)) {
    const identity = readJson<MachineIdentity>(path);
    if (
      identity.version !== 1 ||
      typeof identity.id !== "string" ||
      typeof identity.name !== "string" ||
      typeof identity.createdAt !== "string"
    )
      throw new Error(`Invalid machine identity at ${path}.`);
    return identity;
  }
  return withPidFileLock(machineIdentityLockPath(), () => {
    if (existsSync(path)) return readJson<MachineIdentity>(path);
    const identity: MachineIdentity = {
      version: 1,
      id: randomUUID(),
      name: hostname(),
      createdAt: new Date().toISOString(),
    };
    atomicWriteJson(path, identity);
    return identity;
  });
}

export function repositoryRoot(cwd = process.cwd()): string {
  return requireSuccess(
    command("git", ["-C", cwd, "rev-parse", "--show-toplevel"]),
    "Not inside a Git repository",
  );
}

export function listProjects(): ProjectManifest[] {
  if (!existsSync(projectsDir())) return [];
  const projects: ProjectManifest[] = [];
  for (const id of readdirSync(projectsDir())) {
    const path = join(projectsDir(), id, "project.json");
    if (!existsSync(path)) continue;
    try {
      projects.push(readJson<ProjectManifest>(path));
    } catch {
      // A partial/corrupt manifest is not a registered project.
    }
  }
  return projects;
}

export function findProject(cwd = process.cwd()): ProjectManifest | undefined {
  const root = realpathSync(repositoryRoot(cwd));
  return listProjects().find((project) => {
    try {
      return realpathSync(project.root) === root;
    } catch {
      return false;
    }
  });
}

export function requireProject(cwd = process.cwd()): ProjectManifest {
  const project = findProject(cwd);
  if (!project)
    throw new Error('This repository is not initialized. Run "boxers project init ..." first.');
  return project;
}

function sourceFor(project: ProjectManifest): string {
  if (project.integration.mode === "local") return project.root;
  const configured = command("git", [
    "-C",
    project.root,
    "remote",
    "get-url",
    project.integration.remote,
  ]);
  return configured.status === 0 ? configured.stdout.trim() : project.integration.remote;
}

function remoteUrl(project: ProjectManifest): string | undefined {
  const preferred = project.integration.mode === "remote" ? project.integration.remote : "origin";
  const configured = command("git", ["-C", project.root, "remote", "get-url", preferred]);
  return configured.status === 0 && configured.stdout.trim() ? configured.stdout.trim() : undefined;
}

/** Credential-free identity used only to discover equivalent checkouts. */
export function canonicalizeProjectSource(source: string): string {
  if (source.includes("://")) {
    try {
      const url = new URL(source);
      if (url.protocol === "file:") return url.pathname.replace(/\.git$/, "");
      return `${url.hostname.toLowerCase()}${url.pathname.replace(/\.git$/, "")}`;
    } catch {
      return source.replace(/\.git$/, "");
    }
  }
  const scp = /^(?:[^@/:]+@)?([^/:]+):(.+)$/.exec(source);
  if (scp) return `${scp[1]!.toLowerCase()}/${scp[2]!.replace(/\.git$/, "")}`;
  return source.replace(/\.git$/, "");
}

/** Credential-free identity used only to discover equivalent checkouts. */
export function canonicalProjectSource(project: ProjectManifest): string | undefined {
  if (project.source) return project.source;
  const source = remoteUrl(project);
  return source ? canonicalizeProjectSource(source) : undefined;
}

/** Clone URL stays host-side and may use the user's normal Git authentication. */
export function projectCloneSource(project: ProjectManifest): string {
  const source = remoteUrl(project);
  if (!source)
    throw new Error(`Project ${basename(project.root)} has no Git remote that can be cloned.`);
  return source;
}

export function refreshSeed(project: ProjectManifest): string {
  mkdirSync(project.seedPath, { recursive: true, mode: 0o700 });
  if (!existsSync(join(project.seedPath, ".git"))) {
    requireSuccess(
      command("git", ["-C", project.seedPath, "init", "-q"]),
      "Could not initialize sanitized seed",
    );
  }
  const source = sourceFor(project);
  const base = project.integration.base;
  requireSuccess(
    command("git", [
      "-C",
      project.seedPath,
      "fetch",
      "--no-tags",
      "--force",
      source,
      `refs/heads/${base}:refs/boxers/target`,
    ]),
    `Could not refresh ${source} ${base}`,
  );
  const oid = requireSuccess(
    command("git", ["-C", project.seedPath, "rev-parse", "refs/boxers/target^{commit}"]),
    "Target is not a commit",
  );
  requireSuccess(
    command("git", ["-C", project.seedPath, "checkout", "-q", "-B", base, oid]),
    "Could not check out sanitized target",
  );
  requireSuccess(
    command("git", ["-C", project.seedPath, "reset", "--hard", "-q", oid]),
    "Could not reset sanitized seed",
  );
  // Fetch metadata can contain the source URL. It is not needed by clone mode.
  command("git", ["-C", project.seedPath, "remote", "remove", "origin"]);
  command("git", ["-C", project.seedPath, "config", "--unset-all", "credential.helper"]);
  command("git", ["-C", project.seedPath, "config", "--unset-all", "core.hooksPath"]);
  rmSync(join(project.seedPath, ".git", "FETCH_HEAD"), { force: true });
  return oid;
}

export interface InitProjectOptions {
  integration: IntegrationMode;
  base: string;
  remote?: string;
  cwd?: string;
  configText?: string;
}

export function initProject(options: InitProjectOptions): ProjectManifest {
  const root = realpathSync(repositoryRoot(options.cwd));
  const existing = findProject(root);
  if (!options.base.trim()) throw new Error("--base requires a branch name.");
  if (options.integration === "remote" && !options.remote?.trim())
    throw new Error("Remote integration requires --remote <name-or-url>.");
  const configPath = join(root, ".boxers", "config.yml");
  if (!existsSync(configPath)) {
    mkdirSync(join(root, ".boxers"), { recursive: true });
    writeFileSync(configPath, options.configText ?? DEFAULT_PROJECT_CONFIG, { flag: "wx" });
  }
  const config = readProjectConfig(configPath);
  if (
    config.integration &&
    (config.integration.mode !== options.integration ||
      config.integration.base !== options.base ||
      (config.integration.mode === "remote" && config.integration.remote !== options.remote))
  )
    throw new Error(
      ".boxers/config.yml integration settings do not match the requested project registration.",
    );
  if (existing) {
    mkdirSync(join(projectDir(existing.id), "tasks"), { recursive: true, mode: 0o700 });
    let updated: ProjectManifest = {
      ...existing,
      integration:
        options.integration === "local"
          ? { mode: "local", base: options.base }
          : { mode: "remote", base: options.base, remote: options.remote as string },
    };
    refreshSeed(updated);
    delete updated.source;
    const source = canonicalProjectSource(updated);
    if (source) updated = { ...updated, source };
    atomicWriteJson(join(projectDir(existing.id), "project.json"), updated);
    return updated;
  }
  const id = randomUUID();
  const dir = projectDir(id);
  let project: ProjectManifest = {
    version: 1,
    id,
    root,
    seedPath: join(dir, "seed"),
    integration:
      options.integration === "local"
        ? { mode: "local", base: options.base }
        : { mode: "remote", base: options.base, remote: options.remote as string },
    createdAt: new Date().toISOString(),
  };
  mkdirSync(join(dir, "tasks"), { recursive: true, mode: 0o700 });
  refreshSeed(project);
  const source = canonicalProjectSource(project);
  if (source) project = { ...project, source };
  atomicWriteJson(join(dir, "project.json"), project);
  return project;
}

const TASK_MANIFEST_KEYS = [
  "version",
  "id",
  "projectId",
  "name",
  "runtime",
  "agent",
  "template",
  "model",
  "effort",
  "fast",
  "creationPid",
  "sessionMode",
  "sessionStartedAt",
  "lifecycleBridgeToken",
  "createdAt",
  "lastSnapshot",
] as const;

const TASK_SNAPSHOT_KEYS = [
  "phase",
  "summary",
  "report",
  "question",
  "failure",
  "agent",
  "targetOid",
  "candidateTreeOid",
  "check",
  "preview",
  "setup",
  "runtimeState",
] as const;

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

function validTaskSnapshot(value: unknown): value is TaskSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  const phases = [
    "creating",
    "active",
    "working",
    "reconciling",
    "setting_up",
    "checking",
    "needs_input",
    "reviewed",
    "idle",
    "failed",
    "stopped",
  ];
  if (
    !hasOnlyKeys(snapshot, TASK_SNAPSHOT_KEYS) ||
    !phases.includes(String(snapshot.phase)) ||
    (snapshot.agent !== "codex" && snapshot.agent !== "claude")
  )
    return false;
  for (const field of [
    "summary",
    "report",
    "question",
    "failure",
    "targetOid",
    "candidateTreeOid",
    "runtimeState",
  ])
    if (snapshot[field] !== undefined && typeof snapshot[field] !== "string") return false;
  return [snapshot.check, snapshot.preview, snapshot.setup].every(
    (field) => field === undefined || (field !== null && typeof field === "object"),
  );
}

export function listTasks(project: ProjectManifest): TaskManifest[] {
  const dir = join(projectDir(project.id), "tasks");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((id) => {
    const path = join(dir, id, "task.json");
    if (!existsSync(path)) return [];
    const task = readJson<unknown>(path);
    if (!task || typeof task !== "object") throw new Error(`Invalid task manifest at ${path}.`);
    const record = task as Record<string, unknown>;
    if (record.version !== 3 || record.sessionMode !== "native")
      throw new Error(
        `Unsupported task manifest at ${path}. This release supports native task runtimes only.`,
      );
    if (
      typeof record.id !== "string" ||
      !hasOnlyKeys(record, TASK_MANIFEST_KEYS) ||
      typeof record.projectId !== "string" ||
      typeof record.name !== "string" ||
      !record.runtime ||
      typeof record.runtime !== "object" ||
      typeof (record.runtime as Record<string, unknown>).kind !== "string" ||
      typeof (record.runtime as Record<string, unknown>).id !== "string" ||
      !hasOnlyKeys(record.runtime as Record<string, unknown>, ["kind", "id"]) ||
      (record.agent !== "codex" && record.agent !== "claude") ||
      (record.template !== undefined && typeof record.template !== "string") ||
      (record.model !== undefined && typeof record.model !== "string") ||
      (record.effort !== undefined && typeof record.effort !== "string") ||
      (record.fast !== undefined && typeof record.fast !== "boolean") ||
      (record.creationPid !== undefined && typeof record.creationPid !== "number") ||
      (record.sessionStartedAt !== undefined && typeof record.sessionStartedAt !== "string") ||
      typeof record.lifecycleBridgeToken !== "string" ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(record.lifecycleBridgeToken) ||
      (record.lastSnapshot !== undefined && !validTaskSnapshot(record.lastSnapshot)) ||
      typeof record.createdAt !== "string"
    )
      throw new Error(`Invalid task manifest at ${path}.`);
    return [task as TaskManifest];
  });
}

export function findTask(project: ProjectManifest, name: string): TaskManifest | undefined {
  return listTasks(project).find((task) => task.name === name);
}

export function requireTask(project: ProjectManifest, name: string): TaskManifest {
  const task = findTask(project, name);
  if (!task) throw new Error(`Unknown task "${name}" in project ${basename(project.root)}.`);
  return task;
}

export interface RegisteredTask {
  project: ProjectManifest;
  task: TaskManifest;
}

export function listRegisteredTasks(): RegisteredTask[] {
  return listProjects().flatMap((project) => listTasks(project).map((task) => ({ project, task })));
}

export function requireRegisteredTask(name: string): RegisteredTask {
  const normalized = name.toLowerCase();
  const matches = listRegisteredTasks().filter(
    ({ task }) => task.name.toLowerCase() === normalized,
  );
  if (!matches.length) throw new Error(`Unknown task "${name}".`);
  if (matches.length > 1)
    throw new Error(
      `Task name "${name}" is not globally unique in the existing registry. Rename or remove the duplicate tasks before using global task commands.`,
    );
  return matches[0] as RegisteredTask;
}

export function assertTaskNameAvailable(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name))
    throw new Error("Task names may contain letters, numbers, dots, underscores, and hyphens.");
  if (
    [
      "help",
      "version",
      "doctor",
      "auth",
      "init",
      "list",
      "ls",
      "connect",
      "hosts",
      "disconnect",
      "update",
      "service",
      "daemon",
      "debug",
      "project",
      "remote",
    ].includes(name.toLowerCase())
  )
    throw new Error(`Task name "${name}" is reserved by a global command.`);
  const existing = listRegisteredTasks().find(
    ({ task }) => task.name.toLowerCase() === name.toLowerCase(),
  );
  if (existing)
    throw new Error(
      `Task "${name}" already exists in project ${basename(existing.project.root)}; task names must be unique on this machine.`,
    );
}

function runtimeIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9.+-]+/g, "-");
}

function runtimeIdFor(
  project: ProjectManifest,
  taskName: string,
  taskId: string,
  runtimeKind: string,
): string {
  const projectName = runtimeIdPart(basename(project.root)) || `project-${project.id.slice(0, 8)}`;
  const base = `boxers-${projectName}-${runtimeIdPart(taskName)}`;
  const used = new Set(
    listProjects().flatMap((registered) =>
      listTasks(registered)
        .map(runtimeHandleForTask)
        .filter((handle) => handle.kind === runtimeKind)
        .map((handle) => handle.id),
    ),
  );
  return used.has(base) ? `${base}-${taskId.slice(0, 8)}` : base;
}

export function createTaskManifest(
  project: ProjectManifest,
  name: string,
  agent: Agent,
  template?: string,
  model?: string,
  effort?: string,
  fast?: boolean,
): TaskManifest {
  mkdirSync(projectsDir(), { recursive: true, mode: 0o700 });
  const lockPath = join(projectsDir(), `.create-${name.toLowerCase()}.lock`);
  let lock: number;
  try {
    lock = openSync(lockPath, "wx", 0o600);
  } catch {
    throw new Error(`Task "${name}" is already being created.`);
  }
  try {
    assertTaskNameAvailable(name);
    const id = randomUUID();
    const runtimeKind = defaultRuntime().kind;
    const runtimeId = runtimeIdFor(project, name, id, runtimeKind);
    const task: TaskManifest = {
      version: 3,
      id,
      projectId: project.id,
      name,
      runtime: { kind: runtimeKind, id: runtimeId },
      agent,
      ...(template ? { template } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(fast ? { fast } : {}),
      creationPid: process.pid,
      sessionMode: "native",
      lifecycleBridgeToken: randomBytes(32).toString("base64url"),
      createdAt: new Date().toISOString(),
      lastSnapshot: { phase: "creating", agent },
    };
    atomicWriteJson(join(taskDir(project.id, id), "task.json"), task);
    recordTaskSnapshot(project, task, task.lastSnapshot as TaskSnapshot, {
      source: "command",
      workspaceRelation: "on_base",
    });
    notifyDaemonStateChanged();
    return task;
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}

export function updateTask(
  project: ProjectManifest,
  task: TaskManifest,
  snapshot: TaskSnapshot,
  hasUnmergedChanges?: boolean,
  source: ObservationSource = "command",
): TaskManifest {
  const manifestPath = join(taskDir(project.id, task.id), "task.json");
  const transaction = withPidFileLock(taskManifestLockPath(project.id, task.id), () => {
    const current = readJson<TaskManifest>(manifestPath);
    if (current.id !== task.id || current.projectId !== project.id)
      throw new Error(`Task manifest identity changed at ${manifestPath}.`);
    const mergedSnapshot = mergeTaskSnapshot(
      current.lastSnapshot ?? { phase: "idle", agent: current.agent },
      task.lastSnapshot,
      snapshot,
      source,
    );
    const updated: TaskManifest = {
      ...current,
      runtime: task.runtime,
      lastSnapshot: mergedSnapshot,
    };
    if (mergedSnapshot.phase !== "creating") delete updated.creationPid;
    const manifestChanged = !isDeepStrictEqual(updated, current);
    if (manifestChanged) atomicWriteJson(manifestPath, updated);
    const liveObservation = source === "daemon";
    if (manifestChanged || liveObservation || hasUnmergedChanges !== undefined)
      recordTaskSnapshot(project, updated, mergedSnapshot, {
        source,
        publishSnapshot: true,
        ...(hasUnmergedChanges !== undefined
          ? {
              workspaceRelation: hasUnmergedChanges ? "not_on_base" : "on_base",
            }
          : {}),
      });
    return {
      task: manifestChanged || !isDeepStrictEqual(current, task) ? updated : task,
      manifestChanged,
    };
  });
  if (transaction.manifestChanged) notifyDaemonStateChanged();
  return transaction.task;
}

const SOURCE_SNAPSHOT_FIELDS: Partial<Record<ObservationSource, (keyof TaskSnapshot)[]>> = {
  worker: ["setup", "preview"],
  daemon: ["phase", "runtimeState", "setup", "preview", "question", "failure"],
};

const FORCED_OBSERVATION_FIELDS: Partial<
  Record<ObservationSource, ReadonlySet<keyof TaskSnapshot>>
> = {
  worker: new Set(["setup"]),
  daemon: new Set(["phase", "runtimeState"]),
};

const COMMAND_SNAPSHOT_FIELDS = new Set<keyof TaskSnapshot>([
  "phase",
  "candidateTreeOid",
  "check",
  "preview",
  "summary",
  "report",
  "question",
  "failure",
]);

const OBSERVABLE_PHASES = new Set<TaskSnapshot["phase"]>([
  "creating",
  "active",
  "working",
  "needs_input",
  "idle",
  "stopped",
]);

/** Merge a writer's intended dimensions over the latest manifest read under lock. */
function mergeTaskSnapshot(
  current: TaskSnapshot,
  writerBase: TaskSnapshot | undefined,
  requested: TaskSnapshot,
  source: ObservationSource,
): TaskSnapshot {
  const base = writerBase ?? { phase: "idle", agent: requested.agent };
  const restrictedFields = SOURCE_SNAPSHOT_FIELDS[source];
  const forcedFields = FORCED_OBSERVATION_FIELDS[source];
  const candidates = restrictedFields ?? [
    ...new Set([...Object.keys(base), ...Object.keys(requested)]),
  ];
  const merged = { ...current };
  const mutable = merged as unknown as Record<string, unknown>;
  for (const field of candidates) {
    if (
      !forcedFields?.has(field as keyof TaskSnapshot) &&
      !(source === "command" && COMMAND_SNAPSHOT_FIELDS.has(field as keyof TaskSnapshot)) &&
      isDeepStrictEqual(base[field as keyof TaskSnapshot], requested[field as keyof TaskSnapshot])
    )
      continue;
    if (field === "phase" && restrictedFields && !OBSERVABLE_PHASES.has(current.phase)) continue;
    const value = requested[field as keyof TaskSnapshot];
    if (value === undefined) delete mutable[field];
    else mutable[field] = value;
  }
  return merged;
}

export function markTaskSessionStarted(project: ProjectManifest, task: TaskManifest): TaskManifest {
  const path = join(taskDir(project.id, task.id), "task.json");
  const result = withPidFileLock(taskManifestLockPath(project.id, task.id), () => {
    const current = readJson<TaskManifest>(path);
    if (current.sessionStartedAt) return { task: current, changed: false };
    const updated: TaskManifest = { ...current, sessionStartedAt: new Date().toISOString() };
    atomicWriteJson(path, updated);
    return { task: updated, changed: true };
  });
  if (result.changed) notifyDaemonStateChanged();
  return result.task;
}

export function updateTaskSessionSettings(
  project: ProjectManifest,
  task: TaskManifest,
  settings: { model?: string; effort?: string; fast?: boolean },
): TaskManifest {
  const path = join(taskDir(project.id, task.id), "task.json");
  const result = withPidFileLock(taskManifestLockPath(project.id, task.id), () => {
    const current = readJson<TaskManifest>(path);
    const updated: TaskManifest = { ...current, ...settings };
    if (isDeepStrictEqual(updated, current)) return { task: current, changed: false };
    atomicWriteJson(path, updated);
    return { task: updated, changed: true };
  });
  if (result.changed) notifyDaemonStateChanged();
  return result.task;
}

/** Rotate the collision token for one newly prepared durable PTY session. */
export function rotateTaskLifecycleBridgeToken(
  project: ProjectManifest,
  task: TaskManifest,
): TaskManifest {
  const path = join(taskDir(project.id, task.id), "task.json");
  const updated = withPidFileLock(taskManifestLockPath(project.id, task.id), () => {
    const current = readJson<TaskManifest>(path);
    if (current.id !== task.id || current.projectId !== project.id)
      throw new Error(`Task manifest identity changed at ${path}.`);
    const next: TaskManifest = {
      ...current,
      lifecycleBridgeToken: randomBytes(32).toString("base64url"),
    };
    atomicWriteJson(path, next);
    return next;
  });
  notifyDaemonStateChanged();
  return updated;
}

export function resolvePath(path: string): string {
  return resolve(path);
}
