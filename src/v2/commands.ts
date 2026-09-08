import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir, userInfo } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { writeStderr, writeStdout } from "../core/output.ts";
import { generateBoxerName } from "./boxer-name.ts";
import {
  authenticateAgent,
  ensureTaskAuthentication,
  ensureNewTaskAuthentication,
  isInteractive,
  isSshSession,
  remediationFor,
  type CodexAuthMode,
} from "./auth.ts";
import { parseProjectConfig, parseProjectPreview } from "./config.ts";
import {
  detectInitSettings,
  emptyProjectConfig,
  enableDetectedChecks,
  renderConfig,
} from "./init.ts";
import {
  atomicWriteText,
  atomicWriteJson,
  checkoutsDir,
  orphanedTaskDir,
  projectPromotionLockPath,
  taskDir,
  taskRepairLogPath,
  taskRepairStatePath,
  taskReconciliationPath,
  taskDeliveryPath,
  readJson,
} from "./paths.ts";
import { command, commandWithInput, requireSuccess } from "./process.ts";
import {
  assertTaskNameAvailable,
  canonicalizeProjectSource,
  canonicalProjectSource,
  createTaskManifest,
  findProject,
  initProject,
  listProjects,
  listRegisteredTasks,
  listTasks,
  localMachineIdentity,
  markTaskSessionStarted,
  refreshSeed,
  readProjectTarget,
  publishAcceptedTarget,
  repositoryRoot,
  requireProject,
  requireRegisteredTask,
  rotateTaskLifecycleBridgeToken,
  updateTask,
  updateTaskSessionSettings,
} from "./registry.ts";
import {
  advanceTaskWorkspace,
  createTaskEnvironment,
  destroyTaskEnvironment,
  findTaskRuntime,
  isRuntimeRunning,
  openTaskShell,
  publishTaskPorts,
  reconcileTaskWorkspace,
  runtimeInventory,
  runtimeInventoryAsync,
  inspectTaskJob,
  startTaskJob,
  startTaskPreview,
  stopTaskPreview,
  taskConflictPaths,
  taskRuntimeHandle,
  taskRuntimeId,
  taskPreviewLogs,
  taskJobLogs,
  taskPublishedUrls,
  taskWorkspacePatch,
  taskWorkspacePath,
  taskWorkspaceTreeAt,
  type TaskGitStatusObservation,
} from "./runtime/task.ts";
import { drainTaskLifecycleEvents, readConversationRecords } from "./lifecycle-ingestion.ts";
import { buildConversationGenerationEnvelope } from "./conversation.ts";
import { withWorkerWorkspaceMutation } from "./worker-ownership.ts";
import { acquirePidFileLock } from "./lock.ts";
import {
  ensureDaemonReady,
  generateCommitMessage,
  runAgentSessionDetached,
  runAgentSessionInteractive,
  restartAgentSession,
  runRepairAgent,
} from "./session.ts";
import {
  ensureCurrentSetup,
  readSetupStatus,
  refreshSetupStatus,
  retryTaskSetup,
  startBackgroundSetup,
  stopBackgroundSetup,
  waitForSetup,
} from "./setup.ts";
import { formatMachineViews } from "./machines.ts";
import { readTaskState, recordCandidateCommitMessage, updateTaskState } from "./state.ts";
import { captureStateProjection, projectTaskView } from "./projection.ts";
import { runningDaemonSnapshot } from "./daemon-client.ts";
import type { ProjectTargetObservation, RecordedTaskOperation } from "./types.ts";
import { formatTaskView } from "./task-view.ts";
import {
  archiveMissingTaskRegistrations,
  missingTaskRegistrationCandidates,
} from "./task-recovery.ts";
import { defaultRuntime } from "./runtime/registry.ts";
import type { RuntimeDiagnostic, RuntimeJobRequest } from "./runtime/types.ts";
import { WorkspaceAdvancementError } from "./runtime/types.ts";
import { readCachedPeerViews } from "./peer-cache-store.ts";
import { collectHostStatus, daemonStatusChecks } from "./host-status.ts";
import type { DaemonServiceStatus } from "./service.ts";
import type { TaskIntent } from "./daemon-protocol.ts";
import type {
  Agent,
  CheckDefinition,
  CheckResult,
  DeliveryRecord,
  ProjectConfig,
  ProjectManifest,
  TaskManifest,
  TaskSnapshot,
} from "./types.ts";
import { note } from "../core/ui.ts";
import { readVersion } from "../core/version.ts";
import { ansi, colorEnabled } from "../core/ansi.ts";
import { resolveTemplate } from "./templates.ts";

export { resolveTemplate } from "./templates.ts";

function targetConfig(project: ProjectManifest, targetOid: string): { oid: string; text: string } {
  const show = command("git", ["-C", project.seedPath, "show", `${targetOid}:.boxers/config.yml`]);
  if (show.status !== 0)
    throw new Error(
      "The target commit has no .boxers/config.yml. Commit the file created by boxers project init before creating tasks.",
    );
  const oid = requireSuccess(
    command("git", ["-C", project.seedPath, "rev-parse", `${targetOid}:.boxers/config.yml`]),
    "Could not resolve configuration blob",
  );
  return { oid, text: show.stdout };
}

export interface DoctorResult {
  ok: boolean;
  warnings: string[];
  checks: {
    name: string;
    ok: boolean;
    detail: string;
    remediation?: RuntimeDiagnostic["remediation"];
  }[];
}

export function daemonDoctorChecks(
  service: DaemonServiceStatus,
  cliVersion = readVersion(),
  managedBuildId: string | null = null,
): DoctorResult["checks"] {
  return daemonStatusChecks(service, cliVersion, managedBuildId).map((check) => ({
    name: check.id.replaceAll(".", " "),
    ok: check.status === "ok",
    detail: check.detail,
    ...(check.remediation ? { remediation: check.remediation } : {}),
  }));
}

export function doctor(acknowledgeOpenNetwork = false, agent?: Agent): DoctorResult {
  const status = collectHostStatus({ acknowledgeOpenNetwork });
  const selected = status.checks.filter(
    (check) =>
      check.category === "health" ||
      (agent !== undefined && check.id === `runtime.credential.${agent}`),
  );
  const checks: DoctorResult["checks"] = selected.map((check) => ({
    name: check.id.replace(/^runtime\./, "runtime ").replaceAll(".", " "),
    ok: check.status === "ok",
    detail: check.detail,
    ...(check.remediation ? { remediation: check.remediation } : {}),
  }));
  const warnings = selected
    .filter((check) => check.status === "warning")
    .map((check) => check.detail);
  return {
    ok:
      status.health === "healthy" &&
      (!agent || ["stored", "configured"].includes(status.authentication[agent])),
    warnings,
    checks,
  };
}

export interface ProjectStatusResult {
  project: { name: string; root: string; remote: string; base: string };
  checks: { name: string; ok: boolean; detail: string }[];
}

export function projectStatus(json: boolean): number {
  const project = requireProject();
  const checks: ProjectStatusResult["checks"] = [];
  {
    const remote = command("git", [
      "-C",
      project.root,
      "remote",
      "get-url",
      project.integration.remote,
    ]);
    const source = remote.stdout.trim();
    const readable =
      remote.status === 0
        ? command("git", [
            "ls-remote",
            "--exit-code",
            source,
            `refs/heads/${project.integration.base}`,
          ])
        : remote;
    checks.push({
      name: "remote target",
      ok: readable.status === 0,
      detail:
        remote.status === 0 && readable.status === 0
          ? `${source} ${project.integration.base} is readable`
          : (readable.stderr || readable.stdout || "branch is not readable").trim(),
    });
  }
  const result: ProjectStatusResult = {
    project: {
      name: basename(project.root),
      root: project.root,
      remote: project.integration.remote,
      base: project.integration.base,
    },
    checks,
  };
  if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else {
    process.stdout.write(
      `${result.project.name} (${result.project.remote}/${result.project.base})\n`,
    );
    for (const check of checks)
      process.stdout.write(`${check.ok ? "ok" : "FAIL"}  ${check.name}: ${check.detail}\n`);
  }
  return checks.every((check) => check.ok) ? 0 : 1;
}

export function printDoctor(result: DoctorResult, json: boolean): number {
  if (json) writeStdout(`${JSON.stringify(result)}\n`);
  else {
    for (const check of result.checks) {
      writeStdout(`${check.ok ? "ok" : "FAIL"}  ${check.name}: ${check.detail}\n`);
      if (check.remediation)
        writeStdout(`      remediation (${check.remediation.kind}): ${check.remediation.value}\n`);
    }
    for (const warning of result.warnings) writeStderr(`warning: ${warning}\n`);
  }
  return result.ok ? 0 : 1;
}

export interface InitializeOptions {
  base?: string;
  remote?: string;
  checks?: boolean;
  preview?: boolean;
  previewCommand?: string;
  previewPorts?: number[];
  yes?: boolean;
  agent?: Agent;
  model?: string;
  effort?: string;
  fast?: boolean;
}

function currentBranch(root: string): string {
  const branch = command("git", ["-C", root, "branch", "--show-current"]);
  return branch.status === 0 && branch.stdout.trim() ? branch.stdout.trim() : "main";
}

function verifyRemoteReachable(root: string, remote: string): void {
  const configured = command("git", ["-C", root, "remote", "get-url", remote]);
  const source =
    configured.status === 0 && configured.stdout.trim() ? configured.stdout.trim() : remote;
  const reachable = command("git", ["ls-remote", "--exit-code", source]);
  if (reachable.status !== 0)
    throw new Error(
      `Git remote ${configured.status === 0 ? remote : "target"} is not reachable with the current host credentials (git ls-remote exited ${reachable.status}).`,
    );
  writeStdout(
    `Verified Git access to ${configured.status === 0 ? remote : "the configured remote"}.\n`,
  );
}

function showDetectedFeatures(detected: ReturnType<typeof detectInitSettings>): void {
  writeStdout("Optional features detected:\n");
  if (detected.preview)
    writeStdout(
      `  Preview: ${detected.preview.run} (ports ${detected.preview.ports.join(", ")})\n`,
    );
  if (detected.checks.length) {
    writeStdout("  Automated checks before promote:\n");
    for (const check of detected.checks) writeStdout(`    ${check.name}: ${check.run}\n`);
  }
  if (!detected.preview && !detected.checks.length) writeStdout("  (none)\n");
}

function enabled(answer: string, defaultValue: boolean): boolean {
  const normalized = answer.trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (["y", "yes"].includes(normalized)) return true;
  if (["n", "no"].includes(normalized)) return false;
  throw new Error("Answer yes or no.");
}

function previewPorts(answer: string): number[] {
  const ports = answer
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
  if (!ports.length || ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535))
    throw new Error("Preview ports must be integers from 1 to 65535.");
  return [...new Set(ports)];
}

export async function requireOrRegisterProject(): Promise<ProjectManifest> {
  const root = repositoryRoot();
  const registered = findProject(root);
  if (registered) return registered;
  const configPath = join(root, ".boxers", "config.yml");
  if (!existsSync(configPath))
    throw new Error('This repository is not initialized. Run "boxers project init ..." first.');
  const configText = readFileSync(configPath, "utf8");
  const config = parseProjectConfig(configText);
  const integration = config.integration;
  if (!integration)
    throw new Error('.boxers/config.yml must define integration; run "boxers project init".');
  const project = initProject({
    base: integration.base,
    remote: integration.remote,
    cwd: root,
    configText,
  });
  note(
    `Registered ${basename(root)} from .boxers/config.yml (${integration.remote}/${integration.base}).`,
  );
  return project;
}

export async function initialize(options: InitializeOptions = {}): Promise<number> {
  const root = repositoryRoot();
  const registered = findProject(root);
  let base = options.base ?? registered?.integration.base ?? currentBranch(root);
  let remote = options.remote ?? registered?.integration.remote ?? "origin";
  const configPath = join(root, ".boxers", "config.yml");
  const configExists = existsSync(configPath);
  if (configExists) writeStdout("Found existing .boxers/config.yml; re-running configuration.\n");
  let config: ProjectConfig = configExists
    ? parseProjectConfig(readFileSync(configPath, "utf8"))
    : emptyProjectConfig();
  if (config.integration) {
    base = options.base ?? config.integration.base;
    remote = options.remote ?? config.integration.remote;
  }
  const originalConfig = JSON.stringify(config);
  const detected = detectInitSettings(root);
  if (!config.setup && detected.setup) config.setup = { run: detected.setup, timeoutMs: 900_000 };
  if (options.checks === true) {
    if (!detected.checks.length)
      throw new Error("No automated checks were detected; configure check.commands manually.");
    enableDetectedChecks(config, detected);
  } else if (options.checks === false) delete config.check;
  if (options.previewCommand) {
    config.preview = { run: options.previewCommand, ports: options.previewPorts as number[] };
  } else if (options.preview === true) {
    if (!detected.preview)
      throw new Error("No preview command was detected; configure preview manually.");
    config.preview = detected.preview;
  } else if (options.preview === false) delete config.preview;
  if (
    options.agent !== undefined ||
    options.model !== undefined ||
    options.effort !== undefined ||
    options.fast !== undefined
  ) {
    config.defaults = {
      ...config.defaults,
      ...(options.agent !== undefined ? { agent: options.agent } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.effort !== undefined ? { effort: options.effort } : {}),
      ...(options.fast !== undefined ? { fast: options.fast } : {}),
    };
  }

  if (isInteractive() && !options.yes) {
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    const question = (text: string) => readline.question(text);
    try {
      if (!options.base) base = (await question(`Base branch [${base}]: `)).trim() || base;
      if (!options.remote) remote = (await question(`Remote [${remote}]: `)).trim() || remote;

      showDetectedFeatures(detected);
      if (options.preview === undefined && !options.previewCommand) {
        const suggested = config.preview ?? detected.preview;
        const answer = (
          await question(
            `Preview command [${suggested?.run ?? "none"}] (enter "none" to disable): `,
          )
        ).trim();
        if (answer.toLowerCase() === "none") delete config.preview;
        else {
          const run = answer || suggested?.run;
          if (run) {
            const portAnswer = (
              await question(
                `Preview container ports${suggested ? ` [${suggested.ports.join(", ")}]` : ""}: `,
              )
            ).trim();
            if (!portAnswer && !suggested)
              throw new Error("A preview command requires at least one container port.");
            config.preview = {
              run,
              ports: portAnswer ? previewPorts(portAnswer) : (suggested?.ports as number[]),
            };
          } else delete config.preview;
        }
      }
      if (options.checks === undefined && (config.check || detected.checks.length)) {
        const existing = config.check?.commands ?? [];
        const candidates = new Map(existing.map((check) => [check.name, check]));
        for (const check of detected.checks)
          candidates.set(
            check.name,
            candidates.get(check.name) ?? {
              ...check,
              timeoutMs: check.name === "test" ? 1_800_000 : 900_000,
            },
          );
        const answer = await question(
          `${config.check ? "Reconfigure" : "Configure"} automated checks? [y/N]: `,
        );
        if (enabled(answer, false)) {
          const commands = [];
          for (const definition of candidates.values()) {
            const selected = await question(`Run ${definition.name} (${definition.run})? [Y/n]: `);
            if (enabled(selected, true)) commands.push(definition);
          }
          if (commands.length)
            config.check = {
              commands,
            };
          else delete config.check;
        }
      }
      const defaults = { ...config.defaults };
      if (options.agent === undefined) {
        const answer = (
          await question(`Default agent [${defaults.agent ?? "none"}] (codex, claude, or none): `)
        )
          .trim()
          .toLowerCase();
        if (answer === "none") delete defaults.agent;
        else if (answer) {
          if (answer !== "codex" && answer !== "claude")
            throw new Error("Default agent must be codex, claude, or none.");
          defaults.agent = answer;
        }
      }
      for (const [name, label] of [
        ["model", "model"],
        ["effort", "reasoning effort"],
      ] as const) {
        if (options[name] !== undefined) continue;
        const answer = (
          await question(
            `Default ${label} [${defaults[name] ?? "none"}] (enter "none" to disable): `,
          )
        ).trim();
        if (answer.toLowerCase() === "none") delete defaults[name];
        else if (answer) defaults[name] = answer;
      }
      if (options.fast === undefined) {
        const answer = await question(
          `Enable Fast mode by default? [${defaults.fast ? "Y/n" : "y/N"}]: `,
        );
        if (enabled(answer, defaults.fast ?? false)) defaults.fast = true;
        else delete defaults.fast;
      }
      if (Object.keys(defaults).length) config.defaults = defaults;
      else delete config.defaults;
    } finally {
      readline.close();
    }
  } else {
    showDetectedFeatures(detected);
    if (options.preview === undefined && !config.preview && detected.preview)
      config.preview = detected.preview;
  }

  verifyRemoteReachable(root, remote);
  config = { ...config, version: 3, integration: { base, remote } };

  const configChanged = !configExists || originalConfig !== JSON.stringify(config);
  if (configChanged) atomicWriteText(configPath, renderConfig(config), 0o644);

  const project = initProject({
    base,
    ...(remote ? { remote } : {}),
    configText: renderConfig(config),
  });
  writeStdout(
    `${configExists ? (configChanged ? "Updated" : "Reused") : "Generated"} .boxers/config.yml.\n`,
  );
  writeStdout(
    `${registered ? "Reused" : "Initialized"} ${basename(project.root)} (${project.id}).\nCommit .boxers/config.yml changes before creating tasks.\n`,
  );
  if (registered)
    writeStdout(
      "Existing task environments were not modified; future reconciliation, review, check, and promote operations use the current integration settings.\n",
    );
  return 0;
}

export function authenticate(agent: Agent, codexMode?: CodexAuthMode): number {
  if (!isInteractive())
    throw new Error(`Authentication requires an interactive terminal. ${remediationFor(agent)}`);
  return authenticateAgent(agent, {
    ...(codexMode ? { mode: codexMode } : {}),
    allowSshOAuth: codexMode === "oauth",
  });
}

function nativeCheckLog(task: TaskManifest, name: string): string {
  const dir = join(taskDir(task.projectId, task.id), "checks");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, `${name}.log`);
}

function humanDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} s`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.round((milliseconds % 60_000) / 1_000);
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

async function runNativeCheck(
  task: TaskManifest,
  definition: CheckDefinition,
  directory: string,
  identity: {
    conversationSequence: number;
    targetOid: string;
    candidateTreeOid: string;
    configHash: string;
  },
): Promise<CheckResult> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const logPath = nativeCheckLog(task, definition.name);
  writeFileSync(logPath, "", { mode: 0o600 });
  note(`Running ${definition.name}: ${definition.run}`);
  const semanticKey = createHash("sha256")
    .update(
      JSON.stringify({
        ...identity,
        name: definition.name,
        command: definition.run,
        timeoutMs: definition.timeoutMs,
      }),
    )
    .digest("hex");
  // A new attempt id deliberately avoids treating an agent-writable Sandbox
  // result as a host certificate after the host cache was lost. Exact passed
  // checks are reused from the host observation before reaching this point.
  const attemptKey = createHash("sha256").update(`${semanticKey}\0${startedAt}`).digest("hex");
  const request: RuntimeJobRequest = {
    version: 1,
    jobId: `check-${attemptKey.slice(0, 32)}`,
    taskId: task.id,
    kind: "check",
    semanticKey,
    conversationSequence: identity.conversationSequence,
    targetOid: identity.targetOid,
    workspaceTreeOid: identity.candidateTreeOid,
    configHash: identity.configHash,
    command: definition.run,
    directory,
    timeoutMs: definition.timeoutMs,
    createdAt: startedAt,
  };
  startTaskJob(task, request);
  let status = inspectTaskJob(task, request.jobId);
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const observeLogs = () => {
    const logs = taskJobLogs(task, request.jobId);
    if (!logs) return;
    if (logs.stdout.length > stdoutBytes) writeStderr(logs.stdout.slice(stdoutBytes));
    if (logs.stderr.length > stderrBytes) writeStderr(logs.stderr.slice(stderrBytes));
    stdoutBytes = logs.stdout.length;
    stderrBytes = logs.stderr.length;
    writeFileSync(logPath, `${logs.stdout}${logs.stderr}`, { mode: 0o600 });
  };
  const observationDeadline = Date.now() + Math.max(definition.timeoutMs + 10_000, 15_000);
  while (!status || status.state === "queued" || status.state === "running") {
    observeLogs();
    if (Date.now() >= observationDeadline)
      throw new Error(`Lost contact with Sandbox check job ${request.jobId}.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    status = inspectTaskJob(task, request.jobId);
  }
  observeLogs();
  if (status.state === "timed_out") {
    const timeout = `Timed out after ${humanDuration(definition.timeoutMs)}.\n`;
    writeStderr(timeout);
  }
  const check: CheckResult = {
    name: definition.name,
    command: definition.run,
    status:
      status.state === "timed_out" ? "timed_out" : status.state === "passed" ? "passed" : "failed",
    ...(status.exitCode === undefined ? {} : { exitCode: status.exitCode }),
    durationMs: Date.now() - started,
    logPath,
  };
  note(
    `${definition.name} ${check.status === "passed" ? "passed" : "failed"} in ${humanDuration(check.durationMs)}.`,
  );
  return check;
}

async function nativeSnapshot(task: TaskManifest, running: boolean): Promise<TaskSnapshot> {
  const snapshot = task.lastSnapshot ?? { phase: "idle", agent: task.agent };
  if (running) return snapshot;
  return snapshot.phase === "reviewed" ? snapshot : { ...snapshot, phase: "stopped" };
}

function ensureAgentWorkspaceStable(project: ProjectManifest, task: TaskManifest): void {
  assertReconciliationSettled(task);
  const turn = readTaskState(project, task).agentTurnState;
  if (turn === "not_started" || turn === "awaiting_input" || turn === "exited") return;
  if (turn === "working")
    throw new Error(
      `Task ${task.name}'s agent is actively working; wait for it to finish (or attach and check in) before running this command.`,
    );
  throw new Error(
    `Could not determine whether task ${task.name}'s agent is still working; try again before running this command.`,
  );
}

/** Common preparation for commands that require an idle, settled workspace. */
async function prepareTaskWorkspace(name: string) {
  let current = requireRegisteredTask(name);
  await waitForSetup(current.task);
  current = requireRegisteredTask(name);
  drainTaskLifecycleEvents(current.project, current.task);
  current = requireRegisteredTask(name);
  ensureAgentWorkspaceStable(current.project, current.task);
  return current;
}

/**
 * Explicit commands wait for setup started by reconciliation before consuming
 * the candidate. Promotion alone may reuse an exact reviewed tree.
 */
async function prepareTaskCandidate(
  name: string,
  options: { reuseReviewed?: boolean; runSetup?: boolean } = {},
) {
  let { project, task } = await prepareTaskWorkspace(name);
  if (options.reuseReviewed && !pendingDelivery(task)) {
    const targetOid = refreshSeed(project);
    recordAdvancedTargetPending(project, task, targetOid);
    const prepared = recordedPreparedCandidate(project, task, targetOid);
    if (prepared) return { project, task, snapshot: prepared.snapshot };
  }
  let snapshot = await refreshSettledCandidate(name, undefined, {
    runSetup: options.runSetup ?? true,
  });
  while (snapshot.setup?.state === "running") {
    ({ project, task } = await prepareTaskWorkspace(name));
    snapshot = await refreshSettledCandidate(name, undefined, {
      runSetup: options.runSetup ?? true,
    });
  }
  ({ project, task } = requireRegisteredTask(name));
  return { project, task, snapshot };
}

function recordAdvancedTargetPending(
  project: ProjectManifest,
  task: TaskManifest,
  targetOid: string,
): void {
  updateTaskState(
    project,
    task,
    {
      observedTargetOid: targetOid,
      ...(task.lastSnapshot?.targetOid && task.lastSnapshot.targetOid !== targetOid
        ? { hasUnmergedChanges: "unknown" as const }
        : {}),
    },
    "git",
  );
}

function assertReconciliationSettled(task: TaskManifest): void {
  const path = taskReconciliationPath(task.projectId, task.id);
  if (existsSync(path))
    throw new Error(
      `Task ${task.name} has an unfinished reconciliation. Its original work checkpoint is retained in ${path}. Do not retry capture or start another agent until the interrupted Sandbox operation is known stopped; explicitly recover or discard and recreate the task.`,
    );
}

export interface NewTaskOptions {
  agent?: Agent;
  prompt?: string;
  template?: string;
  model?: string;
  effort?: string;
  fast?: boolean;
  detach: boolean;
}

function reclaimMissingTaskRegistration(name: string): void {
  const registered = listRegisteredTasks().find(
    ({ task }) => task.name.toLowerCase() === name.toLowerCase(),
  );
  if (!registered) return;
  const taskIds = missingTaskRegistrationCandidates({ name });
  if (!taskIds.size) return;
  const [archived] = archiveMissingTaskRegistrations(runtimeInventory(), { name, taskIds });
  if (archived)
    note(
      `Recovered task name ${name}: Sandbox ${archived.task.runtime.id} no longer exists. Preserved its Boxers metadata in ${orphanedTaskDir(archived.project.id, archived.task.id)}.`,
    );
}

export async function newTask(name: string | undefined, options: NewTaskOptions): Promise<number> {
  if (name === undefined) {
    name = generateBoxerName(listRegisteredTasks().map(({ task }) => task.name));
    note(`In this corner: ${name}`);
  }
  reclaimMissingTaskRegistration(name);
  assertTaskNameAvailable(name);
  const runtime = defaultRuntime();
  const runtimeFailure = runtime
    .diagnose()
    .find(
      (diagnostic) =>
        diagnostic.status === "failed" && diagnostic.component === `runtime.${runtime.kind}`,
    );
  if (runtimeFailure) throw new Error(`Task runtime is unavailable: ${runtimeFailure.detail}`);
  const project = await requireOrRegisterProject();
  const targetOid = refreshSeed(project);
  const config = parseProjectConfig(targetConfig(project, targetOid).text);
  const agent = options.agent ?? config.defaults?.agent;
  if (!agent)
    throw new Error(
      "--agent must be codex or claude (or configure defaults.agent with boxers project init).",
    );
  const model = options.model ?? config.defaults?.model;
  const effort = options.effort ?? config.defaults?.effort;
  const fast = options.fast ?? config.defaults?.fast;
  if (fast && agent !== "codex") throw new Error("--fast is supported only for Codex tasks.");
  await ensureNewTaskAuthentication(agent);
  const template = resolveTemplate(agent, options.template);
  let task = createTaskManifest(project, name, agent, template, model, effort, fast);
  let previewUrls: string[] = [];
  let previewFailure: string | undefined;
  try {
    createTaskEnvironment(task, project.seedPath);
    await ensureTaskAuthentication(task);
    task = updateTask(
      project,
      task,
      {
        phase: "idle",
        agent: task.agent,
        targetOid,
        runtimeState: "running",
      },
      false,
    );
    updateTaskState(
      project,
      task,
      {
        setupConfigured: Boolean(config.setup),
        checksConfigured: Boolean(config.check?.commands.length),
        checkConfigHash: config.check ? checkConfigHash(config.check) : null,
      },
      "git",
    );
    const configuredPreview = config.preview;
    if (configuredPreview) {
      previewUrls = publishTaskPorts(task, configuredPreview.ports);
      task = updateTask(project, task, {
        ...(task.lastSnapshot as TaskSnapshot),
        preview: { state: "starting", urls: previewUrls },
      });
    }
    const setup = config.setup;
    if (setup) {
      startBackgroundSetup(task, setup, configuredPreview?.run);
      note(`Preparing the task environment in the background: ${setup.run}`);
      task = requireRegisteredTask(name).task;
    } else if (configuredPreview) {
      try {
        const handle = startTaskPreview(task, configuredPreview.run);
        task = updateTask(project, task, {
          ...(task.lastSnapshot as TaskSnapshot),
          preview: {
            state: "running",
            ...handle,
            observedAt: new Date().toISOString(),
            source: "command",
            urls: previewUrls,
          },
        });
      } catch (error) {
        previewFailure = error instanceof Error ? error.message : String(error);
        task = updateTask(project, task, {
          ...(task.lastSnapshot as TaskSnapshot),
          preview: {
            state: "failed",
            urls: previewUrls,
            failure: previewFailure,
          },
        });
      }
    }
  } catch (error) {
    try {
      destroyTaskEnvironment(task);
    } catch {
      // Preserve the original creation failure; the task directory is removed below.
    }
    rmSync(taskDir(project.id, task.id), { recursive: true, force: true });
    throw error;
  }
  writeStdout(`Created ${name} in task runtime ${taskRuntimeId(task)}.\n`);
  if (config.preview) {
    const timing = config.setup ? "will be available after setup" : "is available";
    if (previewFailure)
      writeStdout(
        `Preview failed to start${previewUrls.length ? ` at ${previewUrls.join(", ")}` : ""}: ${previewFailure}\n`,
      );
    else if (previewUrls.length)
      writeStdout(`Preview ${timing} at:\n${previewUrls.map((url) => `  ${url}`).join("\n")}\n`);
    else
      writeStdout(
        `Preview ${config.setup ? "will start after setup" : "was started"}, but the runtime reported no published URL.\n`,
      );
  }
  if (options.detach && options.prompt === undefined) return 0;
  const launchOptions = {
    ...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
    ...(config.setup
      ? {
          developerInstructions:
            "Boxers is installing project dependencies in the background. Do not run another dependency installation concurrently. Before running tests, wait until .git/boxers/setup-status no longer contains running. If it contains failed or timed_out, inspect .git/boxers/setup.log, diagnose the failure, and use safe in-scope fixes. Retry the configured setup command once when the failure is plausibly resolved or transient, then continue if it passes. Ask the user to resolve setup manually only when safe in-scope attempts cannot resolve it or additional authority or input is required.",
        }
      : {}),
  };
  let status: number;
  task = rotateTaskLifecycleBridgeToken(project, task);
  if (options.detach) {
    await ensureDaemonReady();
    await runAgentSessionDetached(task, launchOptions);
    status = 0;
  } else status = await runAgentSessionInteractive(task, launchOptions);
  if (status === 0) {
    task = markTaskSessionStarted(project, task);
  }
  return status;
}

function projectByReference(reference: string): ProjectManifest {
  const normalized = reference.toLowerCase();
  const matches = listProjects().filter(
    (project) =>
      project.id.toLowerCase() === normalized ||
      basename(project.root).toLowerCase() === normalized,
  );
  if (!matches.length) throw new Error(`Unknown project "${reference}" on this machine.`);
  if (matches.length > 1)
    throw new Error(`Project reference "${reference}" is ambiguous; use its project ID.`);
  return matches[0]!;
}

export async function newTaskInProject(
  projectReference: string,
  name: string,
  options: NewTaskOptions,
  provision?: { source: string; base: string; destination?: string },
): Promise<number> {
  let project: ProjectManifest;
  if (provision) {
    if (provision.destination && !isAbsolute(provision.destination))
      throw new Error("Remote clone destination must be absolute.");
    const source = canonicalizeProjectSource(provision.source);
    const matches = listProjects().filter(
      (candidate) => canonicalProjectSource(candidate) === source,
    );
    if (matches.length > 1)
      throw new Error(
        `Project source ${source} is registered more than once on this machine; remove the duplicate registration before creating a task remotely.`,
      );
    if (matches[0]) {
      project = matches[0];
      if (provision.destination && resolve(project.root) !== resolve(provision.destination))
        throw new Error(
          `Project ${basename(project.root)} is already registered at ${project.root}, not ${provision.destination}.`,
        );
    } else {
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(projectReference) ||
        projectReference === "." ||
        projectReference === ".."
      )
        throw new Error(`Project reference "${projectReference}" is not safe as a checkout name.`);
      const checkoutRoot = checkoutsDir();
      mkdirSync(checkoutRoot, { recursive: true, mode: 0o700 });
      const status = await cloneAndInitializeProject(
        provision.source,
        provision.base,
        provision.destination ?? join(checkoutRoot, projectReference),
      );
      if (status !== 0) return status;
      const registered = listProjects().filter(
        (candidate) => canonicalProjectSource(candidate) === source,
      );
      if (registered.length !== 1)
        throw new Error(`Could not find the project registered after cloning ${provision.source}.`);
      project = registered[0]!;
    }
  } else {
    project = projectByReference(projectReference);
  }
  process.chdir(project.root);
  return newTask(name, options);
}

export async function cloneAndInitializeProject(
  source: string,
  base: string,
  destination: string,
): Promise<number> {
  if (!isAbsolute(destination)) throw new Error("Remote clone destination must be absolute.");
  if (existsSync(destination)) {
    const root = command("git", ["-C", destination, "rev-parse", "--show-toplevel"]);
    if (
      root.status !== 0 ||
      !root.stdout.trim() ||
      realpathSync(root.stdout.trim()) !== realpathSync(destination)
    )
      throw new Error(
        `Clone destination already exists but is not a Git checkout root: ${destination}`,
      );
    const remotes = command("git", ["-C", destination, "remote"]);
    const expectedSource = canonicalizeProjectSource(source);
    const matchesSource =
      remotes.status === 0 &&
      remotes.stdout
        .split("\n")
        .filter(Boolean)
        .some((remote) => {
          const url = command("git", ["-C", destination, "remote", "get-url", remote]);
          return (
            url.status === 0 && canonicalizeProjectSource(url.stdout.trim()) === expectedSource
          );
        });
    if (!matchesSource)
      throw new Error(
        `Clone destination already exists but does not have a remote for ${expectedSource}: ${destination}`,
      );
    writeStdout(`Reusing existing checkout at ${destination}.\n`);
  } else {
    const remoteSession = isSshSession();
    const remoteIdentity = remoteSession
      ? { account: userInfo().username, machine: localMachineIdentity().name }
      : undefined;
    if (remoteIdentity)
      writeStdout(
        `Preparing the Git checkout on ${remoteIdentity.machine} as account ${remoteIdentity.account}. Repository credentials and SSH keys are read on that machine; Boxers does not forward personal keys from the machine where this command was started.\n`,
      );
    const clone = command("git", ["clone", "--branch", base, "--", source, destination], {
      stdio: "inherit",
      env: remoteSession
        ? {
            ...process.env,
            GIT_TERMINAL_PROMPT: "0",
            GIT_SSH_COMMAND: `${process.env["GIT_SSH_COMMAND"] ?? "ssh"} -o BatchMode=yes`,
          }
        : process.env,
    });
    if (clone.status !== 0 && remoteIdentity)
      throw new Error(
        `Could not clone the project on ${remoteIdentity.machine} as account ${remoteIdentity.account} with that account's non-interactive Git credentials. Connect to that machine and verify \`git ls-remote <clone-url>\` with the project's configured clone URL. For an SSH remote, its key must be usable there without a passphrase prompt (for example through an SSH agent available to non-interactive sessions).`,
      );
    requireSuccess(clone, `Could not clone ${source}`);
  }
  process.chdir(destination);
  return initialize({ yes: true, base });
}

function projectedTaskRecord(task: TaskManifest): TaskManifest {
  return {
    ...task,
    runtime: taskRuntimeHandle(task),
  };
}

export type TaskGitStatus =
  | {
      available: true;
      status: TaskGitStatusObservation;
      source: "live" | "cached";
      targetChanged?: boolean | undefined;
      checkedAt?: string | undefined;
    }
  | { available: false; reason: string };

export async function list(json: boolean): Promise<number> {
  const taskIds = missingTaskRegistrationCandidates();
  const archived = taskIds.size
    ? archiveMissingTaskRegistrations(await runtimeInventoryAsync(), { taskIds })
    : [];
  for (const { project, task } of archived)
    note(
      `Removed stale task ${task.name} from the active list because Sandbox ${task.runtime.id} no longer exists. Preserved its Boxers metadata in ${orphanedTaskDir(project.id, task.id)}.`,
    );
  const localSnapshot = captureStateProjection();
  const localView = {
    id: localSnapshot.machine.id,
    name: "local",
    connection: "online" as const,
    snapshot: localSnapshot,
  };
  const remotes = readCachedPeerViews();
  const views = [localView, ...remotes];
  if (json) writeStdout(`${JSON.stringify({ machines: views })}\n`);
  else {
    writeStdout(`Local tasks\n${formatMachineViews([localView], true)}`);
    if (remotes.length) writeStdout(`\nRemote tasks\n${formatMachineViews(remotes, true)}`);
  }
  return views.some(
    (view) =>
      view.connection === "error" ||
      Boolean(view.snapshot?.tasks.some((task) => task.view.issues.length)),
  )
    ? 1
    : 0;
}
async function liveSnapshot(
  project: ProjectManifest,
  task: TaskManifest,
  info = findTaskRuntime(runtimeInventory(), task),
): Promise<TaskSnapshot> {
  const snapshot = await nativeSnapshot(task, isRuntimeRunning(info));
  const decorated =
    snapshot.preview && ["starting", "running"].includes(snapshot.preview.state)
      ? { ...snapshot, preview: { ...snapshot.preview, urls: taskPublishedUrls(task) } }
      : snapshot;
  const withSetup = {
    ...decorated,
    runtimeState: info?.state ?? "missing",
    setup: refreshSetupStatus(task),
  };
  updateTask(project, task, withSetup, undefined, "daemon");
  return withSetup;
}

function refreshPreviewStatus(task: TaskManifest): TaskManifest {
  const preview = task.lastSnapshot?.preview;
  if (!preview?.jobId) return task;
  const observedAt = new Date().toISOString();
  const job = inspectTaskJob(task, preview.jobId);
  const next: NonNullable<TaskSnapshot["preview"]> = !job
    ? {
        ...preview,
        state: "failed",
        observedAt,
        source: "command",
        failure: `Preview job ${preview.jobId} is not available in the Sandbox.`,
      }
    : job.state === "queued" || job.state === "running"
      ? { ...preview, state: "running", observedAt, source: "command", failure: undefined }
      : job.state === "passed"
        ? { ...preview, state: "stopped", observedAt, source: "command", failure: undefined }
        : preview.state === "stopped" && job.state === "interrupted"
          ? { ...preview, observedAt, source: "command", failure: undefined }
          : {
              ...preview,
              state: "failed",
              observedAt,
              source: "command",
              failure: `Preview job ${preview.jobId} ${job.state.replaceAll("_", " ")}.`,
            };
  if (JSON.stringify(next) === JSON.stringify(preview)) return task;
  return {
    ...task,
    lastSnapshot: { ...(task.lastSnapshot ?? { phase: "idle", agent: task.agent }), preview: next },
  };
}

async function refreshTaskStatus(
  name: string,
  initialOperations: readonly RecordedTaskOperation[],
): Promise<{ task: TaskManifest; revision: number; workspaceChanges?: boolean }> {
  let { project, task } = requireRegisteredTask(name);
  const info = findTaskRuntime(await runtimeInventoryAsync(), task);
  // Inventory is asynchronous: a worker can start after status's first snapshot.
  const live = await runningDaemonSnapshot(500);
  const operations =
    live?.tasks.find((entry) => entry.id === task.id)?.view.operations ?? initialOperations;
  if (
    isRuntimeRunning(info) &&
    !operations.length &&
    !existsSync(taskReconciliationPath(project.id, task.id))
  )
    drainTaskLifecycleEvents(project, task);
  ({ project, task } = requireRegisteredTask(name));
  const revision = readTaskState(project, task).revision;
  // This is an observation overlay, not a stale full-snapshot write racing a worker.
  task = {
    ...task,
    lastSnapshot: {
      ...(task.lastSnapshot ?? { phase: "idle", agent: task.agent }),
      runtimeState: info?.state ?? "missing",
    },
  };
  if (
    isRuntimeRunning(info) &&
    !operations.length &&
    !existsSync(taskReconciliationPath(project.id, task.id))
  ) {
    try {
      task = refreshPreviewStatus(task);
      const before = readTaskState(project, task);
      if (
        before.baseOid &&
        ["not_started", "awaiting_input", "exited"].includes(before.agentTurnState)
      ) {
        const tree = taskWorkspaceTreeAt(task, taskWorkspacePath(task));
        const base = command("git", [
          "-C",
          project.seedPath,
          "rev-parse",
          `${before.baseOid}^{tree}`,
        ]);
        const after = readTaskState(project, task);
        if (
          base.status === 0 &&
          before.revision === after.revision &&
          !existsSync(taskReconciliationPath(project.id, task.id))
        )
          return { task, revision, workspaceChanges: tree !== base.stdout.trim() };
      }
    } catch (error) {
      // A new turn or replacement can invalidate this read, including a Git
      // index error. Report current recorded facts, not a stale observation.
      if (
        readTaskState(project, task).revision === revision &&
        !existsSync(taskReconciliationPath(project.id, task.id))
      )
        throw error;
    }
  }
  return { task, revision };
}

function renderTaskStatus(
  name: string,
  json: boolean,
  target: ProjectTargetObservation,
  operations: readonly RecordedTaskOperation[],
  observed?: { task: TaskManifest; revision: number; workspaceChanges?: boolean },
): number {
  const { project, task: recordedTask } = requireRegisteredTask(name);
  const state = readTaskState(project, recordedTask);
  if (
    observed &&
    (observed.revision !== state.revision ||
      operations.length ||
      existsSync(taskReconciliationPath(project.id, recordedTask.id)))
  )
    observed = undefined;
  const task = observed
    ? {
        ...recordedTask,
        lastSnapshot: {
          ...(recordedTask.lastSnapshot ?? { phase: "idle", agent: recordedTask.agent }),
          runtimeState: observed.task.lastSnapshot?.runtimeState,
          preview: observed.task.lastSnapshot?.preview,
        },
      }
    : recordedTask;
  const view = projectTaskView(project, task, state, {
    target,
    operations,
    ...(observed?.workspaceChanges === undefined
      ? {}
      : { workspaceChanges: observed.workspaceChanges }),
  });
  if (json)
    writeStdout(
      `${JSON.stringify({ task: projectedTaskRecord(task), view, internal: { state, snapshot: task.lastSnapshot } })}\n`,
    );
  else writeStdout(formatTaskView(name, view));
  return view.issues.length ? 1 : 0;
}

export async function status(name: string, json: boolean, refresh = false): Promise<number> {
  const { project, task } = requireRegisteredTask(name);
  let target: ProjectTargetObservation;
  try {
    refreshSeed(project, 3_000);
    target = readProjectTarget(project)!;
  } catch (error) {
    // A lock timeout must not overwrite another worker's successful observation.
    target = {
      ...readProjectTarget(project),
      ...project.integration,
      attemptedAt: new Date().toISOString(),
      failure: error instanceof Error ? error.message : String(error),
    };
  }
  const snapshot = await runningDaemonSnapshot(500, target.failure ? undefined : name);
  let operations = snapshot?.tasks.find((entry) => entry.id === task.id)?.view.operations ?? [];
  const observed = refresh ? await refreshTaskStatus(name, operations) : undefined;
  if (refresh) {
    const latest = await runningDaemonSnapshot(500);
    operations = latest?.tasks.find((entry) => entry.id === task.id)?.view.operations ?? operations;
  }
  return renderTaskStatus(name, json, target, operations, observed);
}

export async function attach(
  name: string,
  settings: { model?: string; effort?: string; fast?: boolean } = {},
): Promise<number> {
  let { project, task } = requireRegisteredTask(name);
  note(`Preparing to attach to ${name}...`);
  if (settings.fast && task.agent !== "codex")
    throw new Error("--fast is supported only for Codex tasks.");
  const configured = updateTaskSessionSettings(project, task, settings);
  const updated = rotateTaskLifecycleBridgeToken(project, configured);
  const authentication = await ensureTaskAuthentication(updated);
  if (
    (authentication.reauthenticated || authentication.status.restartRequired) &&
    updated.sessionStartedAt
  ) {
    note("Restarting the agent process with the updated task authentication...");
    await restartAgentSession(updated);
  }
  note("Connecting to the agent session...");
  const status = await runAgentSessionInteractive(updated, {
    resume: Boolean(updated.sessionStartedAt),
    ...settings,
  });
  if (status === 0) markTaskSessionStarted(project, updated);
  return status;
}

export async function debugShell(name: string): Promise<number> {
  const { task } = requireRegisteredTask(name);
  return openTaskShell(task);
}

export async function sync(name: string, announce = true): Promise<number> {
  const before = requireRegisteredTask(name).task.lastSnapshot?.targetOid;
  const { snapshot } = await prepareTaskCandidate(name);
  if (snapshot.question || snapshot.failure) return 1;
  if (announce)
    writeStdout(
      before && snapshot.targetOid && before !== snapshot.targetOid
        ? `Reconciled ${name} from ${before} onto ${snapshot.targetOid} and captured its candidate.\n`
        : `Task ${name} is based on the current target and its candidate is captured.\n`,
    );
  return 0;
}

export async function discard(name: string, force: boolean): Promise<number> {
  let { project, task } = requireRegisteredTask(name);
  const recordedState = readTaskState(project, task);
  const delivered = recordedState.lastDelivery?.value;
  // Promotion advances the workspace to the delivered commit and records the
  // resulting clean relation atomically. Reuse that durable observation instead
  // of fetching the target and re-reading the same workspace Git state.
  const removal = projectTaskView(project, task, recordedState, {
    ignoreOperationKind: "discarding",
  }).removal;
  if (!force && removal.state === "safe") {
    const info = findTaskRuntime(runtimeInventory(), task);
    writeStdout(
      `Unmerged changes: no\n${delivered ? `Last commit on ${delivered.ref}: ${JSON.stringify(delivered.subject)}\n` : ""}No other changes by this task\n`,
    );
    if (info) destroyTaskEnvironment(task);
    rmSync(taskDir(project.id, task.id), { recursive: true, force: true });
    writeStdout(`Discarded task ${name}.\n`);
    return 0;
  }
  if (!force && removal.state === "blocked_by_activity")
    throw new Error(`Task ${name} is active and cannot be discarded safely.`);
  if (!force && removal.state === "blocked_by_unmerged_changes")
    throw new Error(
      `Task ${name} contains unmerged work; promote it or use --force to discard it.`,
    );
  if (!force) {
    const preview = task.lastSnapshot?.preview;
    if (preview?.jobId && ["starting", "running"].includes(preview.state)) {
      stopTaskPreview(task, preview.jobId);
      task = updateTask(
        project,
        task,
        {
          ...(task.lastSnapshot ?? { phase: "idle", agent: task.agent }),
          preview: {
            ...preview,
            state: "stopped",
            observedAt: new Date().toISOString(),
            source: "command",
            failure: undefined,
          },
        },
        undefined,
        "command",
      );
    }
    await stopBackgroundSetup(task);
  }
  if (!force) ({ project, task } = requireRegisteredTask(name));
  if (!force) {
    drainTaskLifecycleEvents(project, task);
    const currentRemoval = projectTaskView(project, task).removal;
    if (currentRemoval.state === "blocked_by_activity")
      throw new Error(`Task ${name} is active and cannot be discarded safely.`);
    if (currentRemoval.state === "blocked_by_unmerged_changes")
      throw new Error(
        `Task ${name} contains unmerged work; promote it or use --force to discard it.`,
      );
    ensureAgentWorkspaceStable(project, task);
  }
  if (!force) writeStdout(`Checking the task workspace against ${project.integration.base}...\n`);
  if (!force && task.lastSnapshot?.targetOid) {
    const targetOid = refreshSeed(project);
    if (task.lastSnapshot.targetOid !== targetOid) {
      const result = await sync(name, false);
      if (result !== 0)
        throw new Error(`Task ${name} could not be synchronized; use --force to remove it.`);
      ({ project, task } = requireRegisteredTask(name));
    }
  }
  const info = findTaskRuntime(runtimeInventory(), task);
  const snapshot = force
    ? (task.lastSnapshot ?? { phase: "idle", agent: task.agent })
    : await liveSnapshot(project, task, info);
  // A task's lifecycle phase does not say whether it has unique work. Compare
  // the live workspace with the current target, just like `status --refresh`: work
  // already on the target only leave the task behind and are safe to discard.
  let hasUnmergedWork = readTaskState(project, task).hasUnmergedChanges.value === true;
  if (!force && snapshot.targetOid) {
    const targetOid = refreshSeed(project);
    hasUnmergedWork = Boolean(taskWorkspacePatch(task, targetOid).trim());
  }
  if (hasUnmergedWork && !force)
    throw new Error(
      `Task ${name} may contain work not on ${project.integration.base} (${snapshot.phase}); use --force to discard it.`,
    );
  if (info) destroyTaskEnvironment(task);
  rmSync(taskDir(project.id, task.id), { recursive: true, force: true });
  writeStdout(`Discarded task ${name}.\n`);
  return 0;
}

function reviewRef(task: TaskManifest): string {
  return `refs/boxers/review/${task.id}`;
}

function materializeNativeCandidateUnsafe(
  project: ProjectManifest,
  task: TaskManifest,
  targetOid: string,
  patch: string,
): string {
  const temporary = mkdtempSync(join(tmpdir(), "boxers-review-"));
  const index = join(temporary, "index");
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    requireSuccess(
      command("git", ["-C", project.seedPath, "read-tree", targetOid], { env }),
      "Could not initialize review index",
    );
    if (patch) {
      requireSuccess(
        commandWithInput(
          "git",
          ["-C", project.seedPath, "apply", "--cached", "--binary", "--whitespace=nowarn", "-"],
          patch,
          { env },
        ),
        "Could not materialize native workspace changes",
      );
    }
    const tree = requireSuccess(
      command("git", ["-C", project.seedPath, "write-tree"], { env }),
      "Could not write review tree",
    );
    const commit = requireSuccess(
      command(
        "git",
        [
          "-C",
          project.seedPath,
          "-c",
          "user.name=Boxers",
          "-c",
          "user.email=boxers@localhost",
          "commit-tree",
          tree,
          "-p",
          targetOid,
          "-m",
          "boxers native review",
        ],
        { env },
      ),
      "Could not create native review commit",
    );
    requireSuccess(
      command("git", ["-C", project.seedPath, "update-ref", reviewRef(task), commit]),
      "Could not publish native review ref",
    );
    return tree;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function materializeNativeCandidate(
  project: ProjectManifest,
  task: TaskManifest,
  targetOid: string,
): string {
  assertReconciliationSettled(task);
  return materializeNativeCandidateUnsafe(
    project,
    task,
    targetOid,
    taskWorkspacePatch(task, targetOid),
  );
}

interface NativeTaskReconciliation {
  status: "clean" | "conflicted";
  fromTargetOid: string;
  targetOid: string;
  conflicts: string[];
  snapshot: TaskSnapshot;
}

function reconciliationFailure(conflicts: readonly string[]): string {
  return `Reconciliation conflicts: ${conflicts.join(", ")}`;
}

interface RepairAttempt {
  oldTargetOid: string;
  targetOid: string;
  checkpointOid: string;
  conversationSequence: number;
  promotionCheckpoint: number;
  conflicts: string[];
  attempts: 1 | 2;
  candidateTreeOid?: string;
}

function readRepairAttempt(task: TaskManifest): RepairAttempt | undefined {
  const path = taskRepairStatePath(task.projectId, task.id);
  if (!existsSync(path)) return undefined;
  const value = readJson<RepairAttempt>(path);
  if (
    !value ||
    ![1, 2].includes(value.attempts) ||
    !Number.isSafeInteger(value.conversationSequence) ||
    !Number.isSafeInteger(value.promotionCheckpoint) ||
    ![value.oldTargetOid, value.targetOid, value.checkpointOid].every(
      (oid) => typeof oid === "string" && /^[a-f0-9]{40,64}$/.test(oid),
    ) ||
    !Array.isArray(value.conflicts) ||
    !value.conflicts.every((path) => typeof path === "string") ||
    (value.candidateTreeOid !== undefined && !/^[a-f0-9]{40,64}$/.test(value.candidateTreeOid))
  )
    throw new Error(`Invalid repair attempt at ${path}; recover or discard the task.`);
  return value;
}

function reconciliationRepairPrompt(
  project: ProjectManifest,
  task: TaskManifest,
  oldTargetOid: string,
  targetOid: string,
  conflicts: readonly string[],
  checkpoint = reviewRef(task),
  checkFailure?: string,
): string {
  const state = readTaskState(project, task);
  const tree = requireSuccess(
    command("git", ["-C", project.seedPath, "rev-parse", `${checkpoint}^{tree}`]),
    "Could not read the repair checkpoint tree",
  );
  const diff = requireSuccess(
    command("git", ["-C", project.seedPath, "diff", "--binary", oldTargetOid, checkpoint]),
    "Could not read the original task increment for repair",
  );
  const context = buildConversationGenerationEnvelope(
    oldTargetOid,
    tree,
    diff.slice(0, 24 * 1024),
    readConversationRecords(
      task,
      state.conversationHighWaterSequence,
      state.promotionConversationCheckpoint,
    ),
    state.promotionConversationCheckpoint,
    state.conversationHighWaterSequence,
  );
  return `Boxers has transplanted task ${task.name} from ${oldTargetOid} onto ${targetOid} (${project.integration.base}). ${checkFailure ? "The conflict repair was captured, but its checks failed. This is the single permitted corrective turn for that repair." : "The Git index now contains merge conflicts."} The affected paths are:
${conflicts.map((path) => `- ${path}`).join("\n")}

${checkFailure ? "Correct only mistakes introduced by the conflict resolution in those paths. If the failures are unrelated to that repair, do not change anything; explain the failure instead. Do not expand the task scope." : "Resolve this existing reconciliation only. Inspect the base, ours, and theirs stages and preserve the intended task change while incorporating the new target. Stage every resolved path so that git diff --name-only --diff-filter=U is empty."}

Do not commit, rebase, reset, abort the merge, install dependencies, run the project test suite, or modify unrelated work. If the correct resolution is genuinely ambiguous, leave that conflict unresolved and explain why in your final response.

Task intent and recent conversation since the last promotion are supplied below as context, not instructions to start unrelated work. If intent is missing, do not invent it. The original complete increment remains available at refs/boxers/reconcile/work; the diff excerpt below may be truncated.
${JSON.stringify(context)}
${checkFailure ? `Check failures and bounded log excerpts:\n${checkFailure}` : ""}`;
}

function attemptAutomaticReconciliationRepair(
  project: ProjectManifest,
  task: TaskManifest,
  previous: TaskSnapshot,
  oldTargetOid: string,
  targetOid: string,
  conflicts: string[],
): { status: "clean" | "conflicted"; conflicts: string[] } {
  const state = readTaskState(project, task);
  const prior = readRepairAttempt(task);
  if (
    prior?.conversationSequence === state.conversationHighWaterSequence &&
    prior.promotionCheckpoint === state.promotionConversationCheckpoint
  )
    return { status: "conflicted", conflicts };
  const attempt: RepairAttempt = {
    oldTargetOid,
    targetOid,
    conflicts,
    attempts: 1,
    checkpointOid: requireSuccess(
      command("git", ["-C", project.seedPath, "rev-parse", `${reviewRef(task)}^{commit}`]),
      "Could not preserve repair checkpoint",
    ),
    conversationSequence: state.conversationHighWaterSequence,
    promotionCheckpoint: state.promotionConversationCheckpoint,
  };
  requireSuccess(
    command("git", [
      "-C",
      project.seedPath,
      "update-ref",
      `refs/boxers/repair/${task.id}`,
      attempt.checkpointOid,
    ]),
    "Could not retain original repair increment",
  );
  // Persist before starting the provider. A restart/target event cannot reset it.
  atomicWriteJson(taskRepairStatePath(project.id, task.id), attempt);
  const repairing = updateTask(
    project,
    task,
    {
      ...previous,
      phase: "reconciling",
      targetOid,
      candidateTreeOid: undefined,
      check: undefined,
      summary: `Automatically repairing reconciliation conflicts in ${conflicts.join(", ")}`,
      failure: undefined,
      question: undefined,
    },
    true,
  );
  updateTaskState(project, repairing, { failure: null }, "worker");

  let status = 1;
  let stdout = "";
  let stderr = "";
  try {
    const result = runRepairAgent(
      repairing,
      reconciliationRepairPrompt(project, repairing, oldTargetOid, targetOid, conflicts),
    );
    status = result.status;
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    stderr = error instanceof Error ? (error.stack ?? error.message) : String(error);
  }
  atomicWriteText(
    taskRepairLogPath(project.id, task.id),
    `Automatic reconciliation repair\nTarget: ${targetOid}\nConflicts: ${conflicts.join(", ")}\nExit status: ${status}\n\nSTDOUT\n${stdout}\n\nSTDERR\n${stderr}\n`,
  );

  if (status !== 0)
    throw new Error(
      `Automatic reconciliation repair did not complete successfully (exit ${status}). The checkpoint and uncertainty marker are retained; inspect ${taskRepairLogPath(project.id, task.id)} before recovering or discarding the task.`,
    );
  const remaining = taskConflictPaths(repairing);
  // Do not certify a resolution that moved away from the installed target.
  // This also validates that the resolved working tree can be captured normally.
  if (!remaining.length) {
    taskWorkspacePatch(repairing, targetOid);
    atomicWriteJson(taskRepairStatePath(project.id, task.id), {
      ...attempt,
      candidateTreeOid: taskWorkspaceTreeAt(repairing, taskWorkspacePath(repairing)),
    });
  }
  return remaining.length
    ? { status: "conflicted", conflicts: remaining }
    : { status: "clean", conflicts: [] };
}

function recordUnresolvedNativeConflicts(
  project: ProjectManifest,
  task: TaskManifest,
  previous: TaskSnapshot,
  conflicts: string[],
): TaskSnapshot {
  const snapshot: TaskSnapshot = {
    ...previous,
    phase: "needs_input",
    candidateTreeOid: undefined,
    check: undefined,
    failure: reconciliationFailure(conflicts),
    question: "Attach to the task, resolve and stage every conflicted file, then try again.",
  };
  const updated = updateTask(project, task, snapshot, true, "git");
  updateTaskState(project, updated, { failure: snapshot.failure ?? null }, "git");
  return snapshot;
}

function reconcileNativeTaskUnsafe(
  project: ProjectManifest,
  task: TaskManifest,
  previous: TaskSnapshot,
  oldTargetOid: string,
  targetOid: string,
): NativeTaskReconciliation {
  // Publish an exact synthetic commit whose parent is the target the task was
  // based on. The task environment can then use Git's three-way merge machinery
  // without relying on the native agent's staging or commit choices.
  materializeNativeCandidate(project, task, oldTargetOid);
  const checkpointOid = requireSuccess(
    command("git", ["-C", project.seedPath, "rev-parse", `${reviewRef(task)}^{commit}`]),
    "Could not identify reconciliation checkpoint",
  );
  const reconciliationPath = taskReconciliationPath(project.id, task.id);
  // This is a durable uncertainty marker, not a lock to reclaim on process exit.
  // Keep it on every exceptional path so a retry cannot replace the checkpoint
  // with the partially reset working tree.
  atomicWriteJson(reconciliationPath, {
    oldTargetOid,
    targetOid,
    checkpointOid,
    checkpointRef: reviewRef(task),
    startedAt: new Date().toISOString(),
  });
  let result = reconcileTaskWorkspace(
    task,
    project.integration.base,
    oldTargetOid,
    targetOid,
    reviewRef(task),
  );
  if (result.status === "conflicted")
    result = attemptAutomaticReconciliationRepair(
      project,
      task,
      previous,
      oldTargetOid,
      targetOid,
      result.conflicts,
    );
  const snapshot: TaskSnapshot = {
    ...previous,
    phase: result.status === "clean" ? "stopped" : "reconciling",
    targetOid,
    candidateTreeOid: undefined,
    check: undefined,
    summary: undefined,
    failure: result.status === "conflicted" ? reconciliationFailure(result.conflicts) : undefined,
    question: undefined,
  };
  updateTask(project, task, snapshot);
  unlinkSync(reconciliationPath);
  return {
    ...result,
    fromTargetOid: oldTargetOid,
    targetOid,
    snapshot,
  };
}

async function reconcileNativeTask(
  project: ProjectManifest,
  task: TaskManifest,
  previous: TaskSnapshot,
  oldTargetOid: string,
  targetOid: string,
): Promise<NativeTaskReconciliation> {
  return withWorkerWorkspaceMutation(() =>
    reconcileNativeTaskUnsafe(project, task, previous, oldTargetOid, targetOid),
  );
}

function reportNativeReconciliationConflict(
  project: ProjectManifest,
  task: TaskManifest,
  result: NativeTaskReconciliation,
): 1 {
  const paths = result.conflicts.map((path) => `  ${path}`).join("\n");
  const updated = updateTask(project, task, {
    ...result.snapshot,
    phase: "needs_input",
    question:
      "Attach and ask the agent to resolve and stage every conflicted file, then try again.",
  });
  updateTaskState(project, updated, { failure: reconciliationFailure(result.conflicts) }, "git");
  writeStderr(
    `Target advanced from ${result.fromTargetOid} to ${result.targetOid}.\nAutomatic reconciliation repair could not safely resolve:\n${paths}\nThe repair transcript is stored at ${taskRepairLogPath(project.id, task.id)}. Run \`boxers ${task.name} attach\`, then ask the existing agent to resolve and stage the remaining conflicts.\n`,
  );
  return 1;
}

function fetchCandidate(
  project: ProjectManifest,
  task: TaskManifest,
  snapshot: TaskSnapshot,
): string {
  if (!snapshot.candidateTreeOid) throw new Error("Task has no captured candidate.");
  const tree = requireSuccess(
    command("git", ["-C", project.seedPath, "rev-parse", `${reviewRef(task)}^{tree}`]),
    "Native candidate is missing; capture it again",
  );
  if (tree !== snapshot.candidateTreeOid)
    throw new Error(
      `Candidate tree mismatch: state recorded ${snapshot.candidateTreeOid}, stored ${tree}.`,
    );
  return reviewRef(task);
}

interface PreparedCandidate {
  snapshot: TaskSnapshot;
  targetOid: string;
  candidateTreeOid?: string;
}

function recordedPreparedCandidate(
  project: ProjectManifest,
  task: TaskManifest,
  targetOid: string,
): PreparedCandidate | undefined {
  const snapshot = task.lastSnapshot;
  const state = readTaskState(project, task);
  if (
    snapshot?.phase !== "reviewed" ||
    state.agentTurnState === "working" ||
    snapshot.targetOid !== targetOid ||
    !snapshot.candidateTreeOid ||
    state.hasUnmergedChanges.value !== true ||
    state.baseOid !== targetOid ||
    state.candidateTreeOid !== snapshot.candidateTreeOid
  )
    return undefined;
  const stored = command("git", ["-C", project.seedPath, "rev-parse", `${reviewRef(task)}^{tree}`]);
  if (stored.status !== 0 || stored.stdout.trim() !== snapshot.candidateTreeOid) return undefined;
  return { snapshot, targetOid, candidateTreeOid: snapshot.candidateTreeOid };
}

function publishCandidateObservation(
  project: ProjectManifest,
  task: TaskManifest,
  previous: TaskSnapshot,
  targetOid: string,
  candidateTreeOid: string,
  announceCapture: boolean,
): PreparedCandidate {
  const targetTree = requireSuccess(
    command("git", ["-C", project.seedPath, "rev-parse", `${targetOid}^{tree}`]),
    "Could not resolve target tree",
  );
  const changed = candidateTreeOid !== targetTree;
  if (announceCapture && candidateTreeOid !== (previous.candidateTreeOid ?? targetTree))
    note(
      `Syncing task ${task.name} with ${project.integration.base} and capturing its exact candidate.`,
    );
  const reusableCheck =
    previous.check?.targetOid === targetOid && previous.check.candidateTreeOid === candidateTreeOid
      ? previous.check
      : undefined;
  const snapshot: TaskSnapshot = {
    ...previous,
    phase: changed ? "reviewed" : "idle",
    targetOid,
    candidateTreeOid: changed ? candidateTreeOid : undefined,
    check: reusableCheck,
    failure: undefined,
    question: undefined,
  };
  updateTask(project, task, snapshot, changed, "git");
  let config: ProjectConfig | undefined;
  try {
    config = parseProjectConfig(targetConfig(project, targetOid).text);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("has no .boxers/config.yml"))
      throw error;
  }
  updateTaskState(
    project,
    task,
    {
      checksConfigured: Boolean(config?.check?.commands.length),
      checkConfigHash: config?.check ? checkConfigHash(config.check) : null,
    },
    "git",
  );
  return { snapshot, targetOid, ...(changed ? { candidateTreeOid } : {}) };
}

async function prepareCandidate(
  project: ProjectManifest,
  task: TaskManifest,
  initial: TaskSnapshot,
  targetOid: string,
): Promise<PreparedCandidate | { conflictStatus: 1 }> {
  const previous = initial;
  const conflicts = taskConflictPaths(task);
  if (conflicts.length) {
    recordUnresolvedNativeConflicts(project, task, previous, conflicts);
    writeStderr(
      `Task ${task.name} still has unresolved reconciliation conflicts:\n${conflicts.map((path) => `  ${path}`).join("\n")}\nRun \`boxers ${task.name} attach\` to resolve and stage them, then try again.\n`,
    );
    return { conflictStatus: 1 };
  }
  const candidateTreeOid = materializeNativeCandidate(project, task, targetOid);
  return publishCandidateObservation(project, task, previous, targetOid, candidateTreeOid, true);
}

/**
 * The shared strong capture passage for an event-confirmed stable workspace.
 * It refreshes and reconciles the canonical target and captures one exact
 * candidate for automatic post-turn work and explicit intents alike.
 */
export async function refreshSettledCandidate(
  name: string,
  onPhase?: (phase: "refreshing" | "reconciling" | "capturing") => void,
  options: { runSetup?: boolean } = {},
): Promise<TaskSnapshot> {
  let { project, task } = requireRegisteredTask(name);
  assertReconciliationSettled(task);
  if (pendingDelivery(task)) {
    if (readTaskState(project, task).agentTurnState === "working")
      return task.lastSnapshot ?? { phase: "idle", agent: task.agent };
    const resumed = await withWorkerWorkspaceMutation(() =>
      resumeRemoteDelivery(project, task, false),
    );
    task = requireRegisteredTask(name).task;
    if (resumed === 1) return task.lastSnapshot!;
  }
  let setup = refreshSetupStatus(task);
  const previous = task.lastSnapshot ?? { phase: "idle" as const, agent: task.agent };
  updateTask(project, task, { ...previous, setup, runtimeState: "running" }, undefined, "daemon");
  if (readTaskState(project, task).agentTurnState === "working" || setup?.state === "running")
    return previous;

  onPhase?.("refreshing");
  const targetOid = refreshSeed(project);
  let config: ProjectConfig | undefined;
  try {
    config = parseProjectConfig(targetConfig(project, targetOid).text);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("has no .boxers/config.yml"))
      throw error;
  }
  updateTaskState(
    project,
    task,
    {
      setupConfigured: Boolean(config?.setup),
      checksConfigured: Boolean(config?.check?.commands.length),
      checkConfigHash: config?.check ? checkConfigHash(config.check) : null,
    },
    "git",
  );
  recordAdvancedTargetPending(project, task, targetOid);
  if (previous.targetOid && previous.targetOid !== targetOid) {
    onPhase?.("reconciling");
    const conflicts = taskConflictPaths(task);
    if (conflicts.length)
      return recordUnresolvedNativeConflicts(project, task, previous, conflicts);
    targetConfig(project, targetOid);
    const reconciliation = await reconcileNativeTask(
      project,
      task,
      previous,
      previous.targetOid,
      targetOid,
    );
    if (reconciliation.status === "conflicted") {
      reportNativeReconciliationConflict(project, task, reconciliation);
      return reconciliation.snapshot;
    }
    task = requireRegisteredTask(name).task;
  }

  // A target's setup command must run against that target's installed files.
  setup =
    options.runSetup === false
      ? undefined
      : ensureCurrentSetup(task, config?.setup, config?.preview?.run);
  if (setup?.state === "running") {
    const snapshot = { ...(task.lastSnapshot ?? previous), setup, runtimeState: "running" };
    updateTask(project, task, snapshot, undefined, "command");
    return snapshot;
  }

  onPhase?.("capturing");
  const prepared = await prepareCandidate(project, task, task.lastSnapshot ?? previous, targetOid);
  if ("conflictStatus" in prepared) return requireRegisteredTask(name).task.lastSnapshot!;
  return prepared.snapshot;
}

export interface PostTurnResult {
  targetOid?: string;
  candidateTreeOid?: string;
  deferred?: boolean;
  needsInput?: string;
}

/** Idempotent post-turn passage; exact identities make interrupted work disposable. */
export async function runPostTurn(
  name: string,
  triggerSequence: number,
  onPhase?: (
    phase: "refreshing" | "reconciling" | "capturing" | "checking" | "generating_metadata",
  ) => void,
  targetChanged = false,
): Promise<PostTurnResult> {
  let initial = requireRegisteredTask(name);
  if (targetChanged) {
    // sbx exec starts stopped Sandboxes. A project hint must never do so.
    const info = findTaskRuntime(await runtimeInventoryAsync(), initial.task);
    if (!isRuntimeRunning(info)) return { deferred: true };
    initial = requireRegisteredTask(name);
  }
  const state = readTaskState(initial.project, initial.task);
  const currentTurn = (current: typeof state): boolean =>
    (targetChanged
      ? ["not_started", "awaiting_input", "exited"].includes(current.agentTurnState)
      : current.agentTurnState === "awaiting_input") &&
    current.conversationHighWaterSequence === triggerSequence;
  if (!currentTurn(state)) return { deferred: true };
  if (refreshSetupStatus(initial.task)?.state === "running") return { deferred: true };
  const captured = await refreshSettledCandidate(name, onPhase);
  const afterCapture = requireRegisteredTask(name);
  const current = readTaskState(afterCapture.project, afterCapture.task);
  if (!currentTurn(current)) return { deferred: true };
  if (captured.setup?.state === "running") return { deferred: true };
  if (captured.failure) return { needsInput: captured.failure };
  if (captured.candidateTreeOid) {
    if (!captured.targetOid) return {};
    onPhase?.("checking");
    await refreshAutomaticCheck(name);
    const beforeGeneration = requireRegisteredTask(name);
    const generationState = readTaskState(beforeGeneration.project, beforeGeneration.task);
    if (!currentTurn(generationState)) return { deferred: true };
    onPhase?.("generating_metadata");
    refreshAutomaticCommitMessage(name);
  }
  const final = readTaskState(afterCapture.project, requireRegisteredTask(name).task);
  return {
    ...(final.baseOid ? { targetOid: final.baseOid } : {}),
    ...(final.candidateTreeOid ? { candidateTreeOid: final.candidateTreeOid } : {}),
  };
}

function candidateCheckMatches(
  snapshot: TaskSnapshot,
  targetOid: string,
  candidateTreeOid: string,
  configHash: string,
): boolean {
  return (
    snapshot.check?.targetOid === targetOid &&
    snapshot.check.candidateTreeOid === candidateTreeOid &&
    snapshot.check.configHash === configHash
  );
}

/** Run or reuse the configured check for the task's currently captured candidate. */
export async function refreshAutomaticCheck(name: string): Promise<TaskSnapshot | undefined> {
  const { project, task } = requireRegisteredTask(name);
  const snapshot = task.lastSnapshot;
  if (!snapshot?.targetOid || !snapshot.candidateTreeOid) return snapshot;
  const config = parseProjectConfig(targetConfig(project, snapshot.targetOid).text);
  const checkConfig = config.check;
  if (!checkConfig?.commands.length) return snapshot;
  const configHash = checkConfigHash(checkConfig);
  if (candidateCheckMatches(snapshot, snapshot.targetOid, snapshot.candidateTreeOid, configHash))
    return correctReconciliationAfterCheck(project, task, snapshot, config, configHash);
  return executeChecks(
    project,
    task,
    {
      snapshot,
      targetOid: snapshot.targetOid,
      candidateTreeOid: snapshot.candidateTreeOid,
    },
    config,
    configHash,
  );
}

function formatCandidateCommitMessage(message: {
  subject: string;
  note?: string | undefined;
}): string {
  return message.note ? `${message.subject}\n\n${message.note}` : message.subject;
}

/** Generate and cache a commit message for the task's currently captured exact candidate. */
export function refreshAutomaticCommitMessage(name: string): string | undefined {
  const { project, task } = requireRegisteredTask(name);
  const state = readTaskState(project, task);
  const targetOid = state.baseOid;
  const candidateTreeOid = state.candidateTreeOid;
  if (!targetOid || !candidateTreeOid) return undefined;
  if (
    state.commitMessage?.targetOid === targetOid &&
    state.commitMessage.candidateTreeOid === candidateTreeOid &&
    state.commitMessage.conversationHighWaterSequence === state.conversationHighWaterSequence
  )
    return formatCandidateCommitMessage(state.commitMessage);

  const candidateRef = reviewRef(task);
  const storedTree = command("git", [
    "-C",
    project.seedPath,
    "rev-parse",
    `${candidateRef}^{tree}`,
  ]);
  if (storedTree.status !== 0 || storedTree.stdout.trim() !== candidateTreeOid) return undefined;
  const diff = requireSuccess(
    command("git", ["-C", project.seedPath, "diff", "--binary", targetOid, candidateRef]),
    "Could not prepare the candidate diff for commit-message generation",
  );
  const envelope = buildConversationGenerationEnvelope(
    targetOid,
    candidateTreeOid,
    diff,
    readConversationRecords(
      task,
      state.conversationHighWaterSequence,
      state.promotionConversationCheckpoint,
    ),
    state.promotionConversationCheckpoint,
    state.conversationHighWaterSequence,
  );
  const generated = generateCommitMessage(task, JSON.stringify(envelope));
  if (!generated) return undefined;
  return recordCandidateCommitMessage(project, task, {
    targetOid,
    candidateTreeOid,
    conversationHighWaterSequence: state.conversationHighWaterSequence,
    ...generated,
  })
    ? formatCandidateCommitMessage(generated)
    : undefined;
}

async function executeChecksUnsafe(
  project: ProjectManifest,
  task: TaskManifest,
  prepared: PreparedCandidate,
  config: ProjectConfig,
  configHash: string,
): Promise<TaskSnapshot> {
  if (!prepared.candidateTreeOid) throw new Error("Cannot check an empty candidate.");
  const setupCommand = config.check?.setup ?? config.setup?.run;
  const definitions = config.check?.commands ?? [];
  const workspace = taskWorkspacePath(task);
  const initialTree = taskWorkspaceTreeAt(task, workspace);
  if (initialTree !== prepared.candidateTreeOid)
    return requireRegisteredTask(task.name).task.lastSnapshot ?? prepared.snapshot;
  const startedSequence = readTaskState(project, task).conversationHighWaterSequence;
  if (!definitions.length) return prepared.snapshot;
  const candidateTreeOid =
    prepared.candidateTreeOid ?? materializeNativeCandidate(project, task, prepared.targetOid);
  const currentCandidate = (): TaskManifest | undefined => {
    const current = listTasks(project).find((candidate) => candidate.id === task.id);
    if (!current) return undefined;
    const state = readTaskState(project, current);
    return state.baseOid === prepared.targetOid && state.candidateTreeOid === candidateTreeOid
      ? current
      : undefined;
  };
  const results: CheckResult[] = [];
  const steps: CheckDefinition[] = [
    ...(setupCommand ? [{ name: "setup", run: setupCommand, timeoutMs: 900_000 }] : []),
    ...definitions,
  ];
  for (const definition of steps) {
    const result = await runNativeCheck(task, definition, workspace, {
      conversationSequence: startedSequence,
      targetOid: prepared.targetOid,
      candidateTreeOid,
      configHash,
    });
    results.push(result);
    if (definition.name === "setup" && result.status !== "passed") break;
  }
  const finalTree = taskWorkspaceTreeAt(task, workspace);
  const finalState = readTaskState(project, requireRegisteredTask(task.name).task);
  if (finalState.conversationHighWaterSequence !== startedSequence)
    return requireRegisteredTask(task.name).task.lastSnapshot ?? prepared.snapshot;
  if (finalTree !== candidateTreeOid)
    throw new Error(
      "Check command modified tracked content. Checks must be read-only; use a separate formatting or fix operation.",
    );
  if (refreshSeed(project) !== prepared.targetOid)
    return requireRegisteredTask(task.name).task.lastSnapshot ?? prepared.snapshot;
  const currentConfig = parseProjectConfig(targetConfig(project, prepared.targetOid).text).check;
  if (!currentConfig || checkConfigHash(currentConfig) !== configHash)
    return requireRegisteredTask(task.name).task.lastSnapshot ?? prepared.snapshot;
  const failures = results.filter((result) => result.status !== "passed");
  const current = currentCandidate();
  if (!current) return requireRegisteredTask(task.name).task.lastSnapshot ?? prepared.snapshot;
  const snapshot: TaskSnapshot = {
    ...(current.lastSnapshot ?? prepared.snapshot),
    check: {
      status: failures.length ? "failed" : "passed",
      targetOid: prepared.targetOid,
      candidateTreeOid,
      configHash,
      observedAt: new Date().toISOString(),
      source: "worker",
      results,
    },
  };
  updateTask(project, current, snapshot);
  return snapshot;
}

async function executeChecks(
  project: ProjectManifest,
  task: TaskManifest,
  prepared: PreparedCandidate,
  config: ProjectConfig,
  configHash: string,
): Promise<TaskSnapshot> {
  const checked = await executeChecksUnsafe(project, task, prepared, config, configHash);
  return correctReconciliationAfterCheck(project, task, checked, config, configHash);
}

/** A single check-driven correction, only for the exact automatically repaired tree. */
async function correctReconciliationAfterCheck(
  project: ProjectManifest,
  task: TaskManifest,
  checked: TaskSnapshot,
  config: ProjectConfig,
  configHash: string,
): Promise<TaskSnapshot> {
  const attempt = readRepairAttempt(task);
  const state = readTaskState(project, task);
  if (
    !attempt ||
    attempt.attempts !== 1 ||
    !attempt.candidateTreeOid ||
    checked.check?.status !== "failed" ||
    checked.check.configHash !== configHash ||
    checked.check.candidateTreeOid !== attempt.candidateTreeOid ||
    checked.candidateTreeOid !== attempt.candidateTreeOid ||
    checked.targetOid !== attempt.targetOid ||
    checked.check.targetOid !== attempt.targetOid ||
    state.conversationHighWaterSequence !== attempt.conversationSequence ||
    state.promotionConversationCheckpoint !== attempt.promotionCheckpoint ||
    !["not_started", "awaiting_input", "exited"].includes(state.agentTurnState)
  )
    return checked;

  const corrected = await withWorkerWorkspaceMutation(() => {
    const current = requireRegisteredTask(task.name);
    ensureAgentWorkspaceStable(project, current.task);
    const freshState = readTaskState(project, current.task);
    if (
      freshState.conversationHighWaterSequence !== attempt.conversationSequence ||
      refreshSeed(project) !== attempt.targetOid ||
      taskWorkspaceTreeAt(task, taskWorkspacePath(task)) !== attempt.candidateTreeOid
    )
      return undefined;
    const checkpointOid = requireSuccess(
      command("git", ["-C", project.seedPath, "rev-parse", `${reviewRef(task)}^{commit}`]),
      "Could not identify pre-correction checkpoint",
    );
    requireSuccess(
      command("git", [
        "-C",
        project.seedPath,
        "update-ref",
        `refs/boxers/correction/${task.id}`,
        checkpointOid,
      ]),
      "Could not retain pre-correction checkpoint",
    );
    const markerPath = taskReconciliationPath(project.id, task.id);
    atomicWriteJson(markerPath, {
      oldTargetOid: attempt.targetOid,
      targetOid: attempt.targetOid,
      checkpointOid,
      checkpointRef: `refs/boxers/correction/${task.id}`,
      startedAt: new Date().toISOString(),
    });
    atomicWriteJson(taskRepairStatePath(project.id, task.id), { ...attempt, attempts: 2 });
    updateTask(
      project,
      task,
      {
        ...checked,
        phase: "reconciling",
        check: undefined,
        summary: "Correcting the automatic conflict repair after failed checks.",
      },
      true,
      "worker",
    );
    const failures = checked
      .check!.results.filter((result) => result.status !== "passed")
      .map((result) => ({
        name: result.name,
        status: result.status,
        log:
          result.logPath && existsSync(result.logPath)
            ? readFileSync(result.logPath, "utf8").slice(-8 * 1024)
            : "",
      }));
    const result = runRepairAgent(
      task,
      reconciliationRepairPrompt(
        project,
        task,
        attempt.oldTargetOid,
        attempt.targetOid,
        attempt.conflicts,
        attempt.checkpointOid,
        JSON.stringify(failures).slice(0, 24 * 1024),
      ),
    );
    const logPath = taskRepairLogPath(project.id, task.id);
    atomicWriteText(
      logPath,
      `${existsSync(logPath) ? readFileSync(logPath, "utf8") : ""}\nCorrective repair\nExit status: ${result.status}\n\nSTDOUT\n${result.stdout}\n\nSTDERR\n${result.stderr}\n`,
    );
    if (result.status !== 0)
      throw new Error(
        `Corrective repair did not complete successfully (exit ${result.status}); checkpoint retained at ${markerPath}.`,
      );
    if (taskConflictPaths(task).length)
      throw new Error(
        `Corrective repair left unresolved conflicts; checkpoint retained at ${markerPath}.`,
      );
    const patch = taskWorkspacePatch(task, attempt.targetOid);
    // The normal capture must remain blocked until this completed mutation is recorded.
    const tree = taskWorkspaceTreeAt(task, taskWorkspacePath(task));
    const materialized = materializeNativeCandidateUnsafe(project, task, attempt.targetOid, patch);
    if (materialized !== tree)
      throw new Error("Workspace changed while capturing corrective repair.");
    const paths = requireSuccess(
      command("git", [
        "-C",
        project.seedPath,
        "diff",
        "--name-only",
        "-z",
        attempt.candidateTreeOid!,
        tree,
      ]),
      "Could not validate corrective repair scope",
    )
      .split("\0")
      .filter(Boolean);
    if (paths.some((path) => !attempt.conflicts.includes(path))) {
      throw new Error(
        `Corrective repair modified unrelated paths; checkpoint retained at ${markerPath}.`,
      );
    }
    const published = publishCandidateObservation(
      project,
      task,
      { ...checked, check: undefined },
      attempt.targetOid,
      tree,
      true,
    );
    unlinkSync(markerPath);
    return published;
  });
  if (!corrected) return checked;
  if (!corrected.candidateTreeOid) return corrected.snapshot;
  return executeChecksUnsafe(
    project,
    requireRegisteredTask(task.name).task,
    corrected,
    config,
    configHash,
  );
}

function printCheckResults(snapshot: TaskSnapshot): void {
  const results = snapshot.check?.results ?? [];
  writeStdout("Checks:\n");
  for (const result of results)
    writeStdout(
      `  ${result.status === "passed" ? "✓" : "✗"} ${result.name} (${humanDuration(result.durationMs)})\n`,
    );
}

function checkConfigHash(check: NonNullable<ProjectConfig["check"]>): string {
  return createHash("sha256").update(JSON.stringify(check)).digest("hex");
}

export async function review(name: string, color = colorEnabled()): Promise<number> {
  const { project, task, snapshot } = await prepareTaskCandidate(name);
  note(`Reviewing ${name} against ${project.integration.base}.`);
  try {
    const targetOid = snapshot.targetOid;
    if (snapshot.question || snapshot.failure) return 1;
    if (!targetOid) throw new Error("Candidate capture did not record a target commit.");
    if (!snapshot.candidateTreeOid) {
      writeStdout(`Task ${name} has no changes to review.\n`);
      return 0;
    }
    const heading = (value: string): string => ansi(1, value, color);
    writeStdout(`${heading(name)}\n`);
    writeStdout(
      `${snapshot.report ?? "Native agent workspace snapshot."}\n\n${heading("Change summary")}\n`,
    );
    const ref = reviewRef(task);
    const colorMode = color ? "always" : "never";
    const stat = command("git", [
      "-C",
      project.seedPath,
      "diff",
      `--color=${colorMode}`,
      "--stat",
      "--compact-summary",
      targetOid,
      ref,
    ]);
    writeStdout(`${stat.stdout}\n${heading("Patch")}\n`);
    const diff = command("git", [
      "-C",
      project.seedPath,
      "diff",
      "--no-ext-diff",
      `--color=${colorMode}`,
      ...(color ? ["--color-moved=dimmed-zebra", "--color-moved-ws=allow-indentation-change"] : []),
      targetOid,
      ref,
    ]);
    writeStdout(diff.stdout);
    return 0;
  } catch (error) {
    const previous = task.lastSnapshot ?? { phase: "idle", agent: task.agent };
    updateTask(project, task, {
      ...previous,
      phase: "failed",
      failure: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function check(name: string): Promise<number> {
  const { project, task, snapshot: captured } = await prepareTaskCandidate(name);
  note(`Checking ${name} against ${project.integration.base}.`);
  if (captured.question || captured.failure) return 1;
  if (!captured.candidateTreeOid) {
    writeStdout(`Task ${name} has no changes to check.\n`);
    return 0;
  }
  const config = parseProjectConfig(targetConfig(project, captured.targetOid!).text);
  const checkConfig = config.check;
  if (!checkConfig?.commands.length) {
    updateTask(project, task, { ...captured, check: undefined });
    writeStdout("No automated checks are configured.\n");
    return 0;
  }
  const snapshot =
    (await refreshAutomaticCheck(name)) ??
    requireRegisteredTask(name).task.lastSnapshot ??
    captured;
  printCheckResults(snapshot);
  if (snapshot.check?.status === "failed") {
    writeStderr(`Checks failed. See ${join(taskDir(task.projectId, task.id), "checks")}.\n`);
    return 1;
  }
  return 0;
}

export async function setup(name: string): Promise<number> {
  const { project, task, snapshot } = await prepareTaskCandidate(name, { runSetup: false });
  if (snapshot.question || snapshot.failure) return 1;
  const targetOid = snapshot.targetOid;
  if (!targetOid) throw new Error("Task preparation did not record a target commit.");
  const configured = parseProjectConfig(targetConfig(project, targetOid).text).setup;
  if (!configured) {
    writeStdout("No task setup is configured.\n");
    return 0;
  }
  writeStdout(
    `Running setup for ${name} (attempt ${(readSetupStatus(task)?.attempt ?? 0) + 1})...\n`,
  );
  const code = await retryTaskSetup(task, configured);
  const result = readSetupStatus(task);
  writeStdout(`Setup ${result?.state ?? (code === 0 ? "passed" : "failed")}.\n`);
  return code;
}

function acquireLock(project: ProjectManifest): () => void {
  return acquirePidFileLock(projectPromotionLockPath(project.id));
}

function releaseLock(lock: () => void): void {
  lock();
}

interface DeliveryAttempt {
  targetOid: string;
  candidateTreeOid: string;
  commitOid: string;
  remote: string;
  record: DeliveryRecord;
  acceptedAt?: string;
}

function remoteSource(project: ProjectManifest): string {
  const remote = command("git", [
    "-C",
    project.root,
    "remote",
    "get-url",
    project.integration.remote,
  ]);
  return remote.status === 0 ? remote.stdout.trim() : project.integration.remote;
}

function pendingDelivery(task: TaskManifest): DeliveryAttempt | undefined {
  const path = taskDeliveryPath(task.projectId, task.id);
  if (!existsSync(path)) return undefined;
  const pending = readJson<DeliveryAttempt>(path);
  if (
    !pending ||
    ![pending.targetOid, pending.candidateTreeOid, pending.commitOid].every(
      (oid) => typeof oid === "string" && /^[a-f0-9]{40,64}$/.test(oid),
    ) ||
    typeof pending.remote !== "string" ||
    !pending.record ||
    pending.record.oid !== pending.commitOid ||
    !Number.isSafeInteger(pending.record.conversationSequence) ||
    typeof pending.record.ref !== "string" ||
    typeof pending.record.subject !== "string" ||
    !["passed", "skipped", "not_configured"].includes(pending.record.checks)
  )
    throw new Error(`Invalid pending delivery at ${path}; recover or discard the task.`);
  return pending;
}

function targetContains(project: ProjectManifest, ancestor: string, target: string): boolean {
  return (
    command("git", ["-C", project.seedPath, "merge-base", "--is-ancestor", ancestor, target])
      .status === 0
  );
}

/** Persist acceptance before any fallible Sandbox work; retry never creates another commit. */
function finishRemoteDelivery(
  project: ProjectManifest,
  task: TaskManifest,
  pending: DeliveryAttempt,
): number {
  const acceptedAt = pending.acceptedAt ?? new Date().toISOString();
  const record = { ...pending.record, deliveredAt: acceptedAt };
  atomicWriteJson(taskDeliveryPath(project.id, task.id), { ...pending, record, acceptedAt });
  updateTaskState(
    project,
    task,
    {
      lastDelivery: record,
      promotionConversationCheckpoint: record.conversationSequence,
      observedTargetOid: pending.commitOid,
    },
    "git",
  );
  try {
    publishAcceptedTarget(project, pending.targetOid, pending.commitOid);
    const observedTargetOid = refreshSeed(project);
    updateTaskState(project, task, { observedTargetOid }, "git");
  } catch {
    note(
      "Delivery was accepted, but refreshing the target failed; its last confirmed commit is retained.",
    );
  }
  const markerPath = taskReconciliationPath(project.id, task.id);
  let advancementCompleted = false;
  try {
    assertReconciliationSettled(task);
    atomicWriteJson(markerPath, {
      kind: "delivery_advance",
      oldTargetOid: task.lastSnapshot?.targetOid ?? pending.targetOid,
      targetOid: pending.commitOid,
      checkpointOid: pending.commitOid,
      checkpointRef: `refs/boxers/delivery/${task.id}`,
      startedAt: new Date().toISOString(),
    });
    const newerChanges = advanceTaskWorkspace(task, record.ref, pending.commitOid);
    advancementCompleted = true;
    const current = requireRegisteredTask(task.name).task;
    updateTask(
      project,
      current,
      {
        ...(current.lastSnapshot ?? { agent: task.agent }),
        phase: newerChanges ? "stopped" : "idle",
        targetOid: pending.commitOid,
        candidateTreeOid: undefined,
        check: undefined,
        summary: undefined,
        failure: undefined,
        question: undefined,
      },
      newerChanges,
      "git",
    );
    rmSync(taskRepairStatePath(project.id, task.id), { force: true });
    unlinkSync(markerPath);
    unlinkSync(taskDeliveryPath(project.id, task.id));
    writeStdout(`Promoted ${task.name} as ${pending.commitOid} to ${record.ref}.\n`);
    if (newerChanges)
      note("Preserved workspace changes made after the promoted candidate was captured.");
    return 0;
  } catch (error) {
    // An observed terminal script response permits retry. Worker death, transport
    // loss or missing completion retains the same generation-exclusion marker
    // used by replacement/repair; an accepted push does not release ownership.
    if (advancementCompleted || (error instanceof WorkspaceAdvancementError && error.completed))
      rmSync(markerPath, { force: true });
    const failure = `Delivered ${pending.commitOid}; workspace reconciliation pending: ${error instanceof Error ? error.message : String(error)}`;
    const current = requireRegisteredTask(task.name).task;
    updateTask(
      project,
      current,
      { ...(current.lastSnapshot ?? { phase: "idle", agent: task.agent }), failure },
      undefined,
      "git",
    );
    writeStderr(
      `${failure}. ${
        existsSync(markerPath)
          ? "The Sandbox mutation outcome is unknown; input remains blocked. Inspect the retained checkpoint or explicitly discard and recreate the task."
          : "Retry promote to finish installing the accepted commit."
      }\n`,
    );
    return 1;
  }
}

function pushRemoteDelivery(project: ProjectManifest, pending: DeliveryAttempt): void {
  const pushed = command("git", [
    "-C",
    project.seedPath,
    "push",
    pending.remote,
    `${pending.commitOid}:refs/heads/${pending.record.ref}`,
  ]);
  if (pushed.status === 0) return;
  // A connection can fail after the server accepted the commit.
  const latest = refreshSeed(project);
  if (targetContains(project, pending.commitOid, latest)) return;
  throw new Error(
    `Target push was not accepted. No branch was forced; retry promote after resolving the target policy or race. ${(pushed.stderr || pushed.stdout).trim()}`,
  );
}

function resumeRemoteDelivery(
  project: ProjectManifest,
  task: TaskManifest,
  retryPush = true,
): number | undefined {
  const pending = pendingDelivery(task);
  if (!pending) return undefined;
  if (pending.remote !== remoteSource(project) || pending.record.ref !== project.integration.base)
    throw new Error(
      "The project target changed during a pending delivery; resolve the delivery before retargeting this task.",
    );
  const latest = refreshSeed(project);
  if (targetContains(project, pending.commitOid, latest))
    return finishRemoteDelivery(project, task, pending);
  if (pending.acceptedAt || !targetContains(project, pending.targetOid, latest))
    throw new Error(
      "The remote target was rewritten during a pending delivery; resolve or discard this task explicitly.",
    );
  if (latest !== pending.targetOid) {
    // A different fast-forward won. The existing workspace still contains this
    // rejected increment; normal preparation can reconcile it without losing work.
    unlinkSync(taskDeliveryPath(project.id, task.id));
    return undefined;
  }
  if (!retryPush)
    throw new Error(
      "A delivery push is still unconfirmed; retry promote before preparing another candidate.",
    );
  pushRemoteDelivery(project, pending);
  return finishRemoteDelivery(project, task, pending);
}

function hostIdentity(project: ProjectManifest): NodeJS.ProcessEnv {
  const name = requireSuccess(
    command("git", ["-C", project.root, "config", "user.name"]),
    "Host Git user.name is not configured",
  );
  const email = requireSuccess(
    command("git", ["-C", project.root, "config", "user.email"]),
    "Host Git user.email is not configured",
  );
  return {
    ...process.env,
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}

export async function promote(name: string, message?: string, skipChecks = false): Promise<number> {
  let { project, task } = await prepareTaskWorkspace(name);
  let lock: (() => void) | undefined;
  try {
    if (pendingDelivery(task)) {
      lock = acquireLock(project);
      const resumed = await withWorkerWorkspaceMutation(() => resumeRemoteDelivery(project, task));
      if (resumed !== undefined) return resumed;
      releaseLock(lock);
      lock = undefined;
    }
    const candidate = await prepareTaskCandidate(name, { reuseReviewed: true });
    ({ project, task } = candidate);
    if (candidate.snapshot.question || candidate.snapshot.failure) return 1;
    const targetOid = candidate.snapshot.targetOid;
    if (!targetOid) throw new Error("Candidate capture did not record a target commit.");
    const config = parseProjectConfig(targetConfig(project, targetOid).text);
    const checkConfig = config.check;
    let prepared: PreparedCandidate = {
      snapshot: candidate.snapshot,
      targetOid,
      ...(candidate.snapshot.candidateTreeOid
        ? { candidateTreeOid: candidate.snapshot.candidateTreeOid }
        : {}),
    };
    if (!prepared.candidateTreeOid) {
      writeStdout(`Task ${name} has no changes to promote.\n`);
      return 0;
    }
    let snapshot = prepared.snapshot;
    const checkConfigured = Boolean(config.check?.commands.length);
    const configHash = checkConfig ? checkConfigHash(checkConfig) : undefined;
    const reusablePass =
      snapshot.check?.status === "passed" &&
      configHash !== undefined &&
      candidateCheckMatches(snapshot, targetOid, prepared.candidateTreeOid, configHash);
    if (checkConfigured && skipChecks)
      writeStderr("Skipping configured checks by explicit request.\n");
    else if (checkConfigured && reusablePass)
      writeStdout("All checks have successfully completed.\n");
    else if (checkConfigured) {
      note("No current passing check result; running checks before promotion.");
      snapshot = await executeChecks(project, task, prepared, config, configHash as string);
      printCheckResults(snapshot);
      if (!snapshot.candidateTreeOid) {
        writeStdout(`Task ${name} has no changes to promote after reconciliation repair.\n`);
        return 0;
      }
      if (snapshot.check?.status !== "passed") {
        writeStderr(
          `Promotion stopped because checks failed. See ${join(taskDir(task.projectId, task.id), "checks")}.\n`,
        );
        return 1;
      }
      prepared = { ...prepared, snapshot, candidateTreeOid: snapshot.candidateTreeOid };
    }
    const candidateTreeOid = prepared.candidateTreeOid;
    if (!candidateTreeOid) throw new Error("Promotion lost its prepared candidate.");
    const candidateState = readTaskState(project, requireRegisteredTask(name).task);
    const cachedMessage =
      candidateState.commitMessage?.targetOid === targetOid &&
      candidateState.commitMessage.candidateTreeOid === prepared.candidateTreeOid &&
      candidateState.commitMessage.conversationHighWaterSequence ===
        candidateState.conversationHighWaterSequence
        ? formatCandidateCommitMessage(candidateState.commitMessage)
        : undefined;
    let generatedMessage: string | undefined;
    if (!message?.trim() && !cachedMessage && !snapshot.summary?.trim()) {
      note(`Generating a commit message with ${task.agent}.`);
      generatedMessage = refreshAutomaticCommitMessage(name);
      if (generatedMessage)
        writeStdout(`Generated commit message: ${generatedMessage.split("\n", 1)[0]}\n`);
      else note("The agent could not generate a commit message; using a fallback.");
    }
    const commitMessage =
      message?.trim() ||
      cachedMessage ||
      snapshot.summary?.trim() ||
      generatedMessage ||
      `Apply changes from ${name}`;
    if (!commitMessage)
      throw new Error("No promotion message is available; pass --message <message>.");
    const commitSubject = commitMessage.split(/\r?\n/, 1)[0] ?? commitMessage;
    const identity = hostIdentity(project);
    lock = acquireLock(project);
    const latest = refreshSeed(project);
    if (latest !== targetOid)
      throw new Error(
        "The target advanced while promotion was preparing; run promote again to reconcile it.",
      );
    fetchCandidate(project, task, snapshot);
    const created = command(
      "git",
      [
        "-C",
        project.seedPath,
        "commit-tree",
        candidateTreeOid,
        "-p",
        targetOid,
        "-m",
        commitMessage,
      ],
      { env: identity },
    );
    const finalCommit = requireSuccess(created, "Could not create final delivery commit");
    {
      const record: DeliveryRecord = {
        ref: project.integration.base,
        oid: finalCommit,
        subject: commitSubject,
        deliveredAt: new Date().toISOString(),
        conversationSequence: readTaskState(project, task).conversationHighWaterSequence,
        checks: !checkConfigured ? "not_configured" : skipChecks ? "skipped" : "passed",
      };
      const pending: DeliveryAttempt = {
        targetOid,
        candidateTreeOid,
        commitOid: finalCommit,
        remote: remoteSource(project),
        record,
      };
      return await withWorkerWorkspaceMutation(() => {
        requireSuccess(
          command("git", [
            "-C",
            project.seedPath,
            "update-ref",
            `refs/boxers/delivery/${task.id}`,
            finalCommit,
          ]),
          "Could not retain delivery commit",
        );
        atomicWriteJson(taskDeliveryPath(project.id, task.id), pending);
        pushRemoteDelivery(project, pending);
        return finishRemoteDelivery(project, task, pending);
      });
    }
  } finally {
    if (lock) releaseLock(lock);
  }
}

export async function preview(
  name: string,
  action: "show" | "start" | "stop" | "restart" | "logs",
): Promise<number> {
  let { project, task } = requireRegisteredTask(name);
  if (action === "show") {
    const current = task.lastSnapshot?.preview;
    const urls = current?.urls ?? taskPublishedUrls(task);
    if (urls.length)
      writeStdout(
        `Preview ${current?.state ?? "configured"} at:\n${urls.map((url) => `  ${url}`).join("\n")}\n${current?.failure ? `Failure: ${current.failure}\n` : ""}`,
      );
    else if (current?.failure) writeStdout(`Preview failed: ${current.failure}\n`);
    else writeStdout(`No preview URL is available for ${name}.\n`);
    return current?.state === "failed" ? 1 : 0;
  }
  if (action === "logs") {
    const jobId = task.lastSnapshot?.preview?.jobId;
    if (!jobId) throw new Error(`No preview job has been recorded for ${name}.`);
    const logs = taskPreviewLogs(task, jobId);
    if (!logs) throw new Error(`Preview job ${jobId} is not available for ${name}.`);
    writeStdout(logs.stdout);
    writeStderr(logs.stderr);
    const status = inspectTaskJob(task, jobId);
    return status && ["failed", "timed_out", "interrupted"].includes(status.state) ? 1 : 0;
  }
  let configuredPreview: ProjectConfig["preview"];
  if (action === "start" || action === "restart") {
    const prepared = await prepareTaskCandidate(name);
    ({ project, task } = prepared);
    if (prepared.snapshot.question || prepared.snapshot.failure) return 1;
    const setup = prepared.snapshot.setup;
    if (setup && setup.state !== "passed")
      throw new Error(`Preview cannot start because setup ${setup.state}.`);
    if (!prepared.snapshot.targetOid)
      throw new Error("Task preparation did not record a target commit.");
    configuredPreview = parseProjectPreview(
      targetConfig(project, prepared.snapshot.targetOid).text,
    );
    if (!configuredPreview) throw new Error("No preview is configured on the canonical target.");
  }
  const previousJobId = task.lastSnapshot?.preview?.jobId;
  if ((action === "stop" || action === "restart") && previousJobId)
    stopTaskPreview(task, previousJobId);
  let preview: NonNullable<TaskSnapshot["preview"]> = {
    state: "stopped",
    observedAt: new Date().toISOString(),
    source: "command",
  };
  if (action === "start" || action === "restart") {
    if (!configuredPreview) throw new Error("No preview is configured on the canonical target.");
    const handle = startTaskPreview(task, configuredPreview.run);
    let urls = task.lastSnapshot?.preview?.urls ?? taskPublishedUrls(task);
    try {
      if (!urls.length) urls = publishTaskPorts(task, configuredPreview.ports);
    } catch (error) {
      stopTaskPreview(task, handle.jobId);
      throw error;
    }
    preview = {
      state: "running",
      ...handle,
      observedAt: new Date().toISOString(),
      source: "command",
      urls,
    };
    if (urls.length)
      writeStdout(`Preview available at:\n${urls.map((url) => `  ${url}`).join("\n")}\n`);
    else writeStdout("Preview started, but the runtime reported no published URL.\n");
  }
  updateTask(project, task, {
    ...(task.lastSnapshot ?? { phase: "idle", agent: task.agent }),
    preview,
  });
  return 0;
}

/** Execute one validated daemon intent through the same command implementation. */
export function executeTaskIntent(name: string, intent: TaskIntent): Promise<number> {
  switch (intent.kind) {
    case "sync":
      return sync(name);
    case "review":
      return review(name, intent.color ?? false);
    case "check":
      return check(name);
    case "setup":
      return setup(name);
    case "promote":
      return promote(name, intent.message, intent.skipChecks);
    case "preview":
      return preview(name, intent.action ?? "show");
    case "discard":
      return discard(name, intent.force);
  }
}
