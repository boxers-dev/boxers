import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { humanTimestamp } from "../core/time.ts";
import { writeStderr, writeStdout } from "../core/output.ts";
import {
  authenticateAgent,
  authenticateCodexSubscription,
  authenticateClaudeSubscription,
  confirmAuthentication,
  hasGlobalCredential,
  isInteractive,
  isSshSession,
  providerForAgent,
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
import { atomicWriteText, projectDir, taskDir, taskRepairLogPath } from "./paths.ts";
import { command, commandWithInput, requireSuccess } from "./process.ts";
import {
  assertTaskNameAvailable,
  createTaskManifest,
  findProject,
  initProject,
  listProjects,
  listRegisteredTasks,
  listTasks,
  markTaskSessionStarted,
  refreshSeed,
  repositoryRoot,
  requireProject,
  requireRegisteredTask,
  rotateTaskLifecycleBridgeToken,
  updateTask,
  updateTaskSessionSettings,
} from "./registry.ts";
import {
  advanceTaskWorkspace,
  assertTaskAgentCredential,
  createTaskEnvironment,
  destroyTaskEnvironment,
  findTaskRuntime,
  isRuntimeRunning,
  openTaskShell,
  prepareTaskCheckWorkspace,
  publishTaskPorts,
  reconcileTaskWorkspace,
  runtimeInventory,
  runTaskShellStreamingAt,
  startTaskPreview,
  stopTaskPreview,
  taskConflictPaths,
  taskRuntimeHandle,
  taskRuntimeId,
  taskPreviewLogs,
  taskPublishedUrls,
  taskWorkspacePatch,
  taskWorkspaceTreeAt,
  type TaskGitStatusObservation,
} from "./runtime/task.ts";
import { drainTaskLifecycleEvents, readConversationRecords } from "./lifecycle-ingestion.ts";
import { buildConversationGenerationEnvelope } from "./conversation.ts";
import {
  ensureDaemonReady,
  generateCommitMessage,
  runAgentSessionDetached,
  runAgentSessionInteractive,
  runRepairAgent,
} from "./session.ts";
import { withTaskMutationBarrier } from "./mutation.ts";
import { readSetupStatus, startBackgroundSetup, waitForSetup } from "./setup.ts";
import { formatMachineViews } from "./machines.ts";
import {
  readTaskState,
  recordCandidateCommitMessage,
  recordTaskSnapshot,
  updateTaskState,
  taskNeedsAttention,
} from "./state.ts";
import { captureStateProjection } from "./projection.ts";
import { defaultRuntime } from "./runtime/registry.ts";
import type { RuntimeDiagnostic } from "./runtime/types.ts";
import { readCachedPeerViews } from "./peer-cache-store.ts";
import { collectHostStatus, daemonStatusChecks } from "./host-status.ts";
import type { DaemonServiceStatus } from "./service.ts";
import type { TaskIntent } from "./daemon-protocol.ts";
import {
  beginSettlementPublicationGuard,
  endSettlementPublicationGuard,
  identifySettlementPublication,
} from "./settlement-publication.ts";
import type {
  Agent,
  CheckDefinition,
  CheckResult,
  IntegrationMode,
  ProjectConfig,
  ProjectManifest,
  SetupStatus,
  TaskManifest,
  TaskSnapshot,
} from "./types.ts";
import { note } from "../core/ui.ts";
import { copyToClipboard } from "../core/clipboard.ts";
import { readKey } from "../core/prompt.ts";
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
): DoctorResult["checks"] {
  return daemonStatusChecks(service, cliVersion).map((check) => ({
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
    ok: status.health === "healthy" && (!agent || status.authentication[agent] === "configured"),
    warnings,
    checks,
  };
}

export interface ProjectStatusResult {
  project: { name: string; root: string; integration: IntegrationMode; base: string };
  checks: { name: string; ok: boolean; detail: string }[];
}

export function projectStatus(json: boolean): number {
  const project = requireProject();
  const checks: ProjectStatusResult["checks"] = [];
  if (project.integration.mode === "local") {
    const branch = command("git", ["-C", project.root, "branch", "--show-current"]);
    const status = command("git", ["-C", project.root, "status", "--porcelain=v1"]);
    const current = branch.stdout.trim();
    checks.push({
      name: "local target",
      ok:
        branch.status === 0 &&
        current === project.integration.base &&
        status.status === 0 &&
        !status.stdout.trim(),
      detail: `branch ${branch.status === 0 ? current || "detached" : (branch.stderr || "unavailable").trim()}; worktree ${status.status === 0 ? (status.stdout.trim() ? "dirty" : "clean") : (status.stderr || "unavailable").trim()}`,
    });
  } else {
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
      integration: project.integration.mode,
      base: project.integration.base,
    },
    checks,
  };
  if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else {
    process.stdout.write(
      `${result.project.name} (${result.project.integration}:${result.project.base})\n`,
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
  integration?: IntegrationMode;
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

function defaultRemote(root: string, base: string): string | undefined {
  const upstream = command("git", ["-C", root, "config", `branch.${base}.remote`]);
  if (upstream.status === 0 && upstream.stdout.trim() && upstream.stdout.trim() !== ".")
    return upstream.stdout.trim();
  const remotes = command("git", ["-C", root, "remote"]);
  if (remotes.status !== 0) return undefined;
  const names = remotes.stdout.split("\n").filter(Boolean);
  return names.includes("origin") ? "origin" : names[0];
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
    integration: integration.mode,
    base: integration.base,
    ...(integration.mode === "remote" ? { remote: integration.remote } : {}),
    cwd: root,
    configText,
  });
  note(
    `Registered ${basename(root)} from .boxers/config.yml (${integration.mode}:${integration.base}).`,
  );
  return project;
}

export async function initialize(options: InitializeOptions = {}): Promise<number> {
  const root = repositoryRoot();
  const registered = findProject(root);
  let integration = options.integration ?? registered?.integration.mode ?? "local";
  let base = options.base ?? registered?.integration.base ?? currentBranch(root);
  let remote =
    options.remote ??
    (registered?.integration.mode === "remote" ? registered.integration.remote : undefined);
  const configPath = join(root, ".boxers", "config.yml");
  const configExists = existsSync(configPath);
  if (configExists) writeStdout("Found existing .boxers/config.yml; re-running configuration.\n");
  let config: ProjectConfig = configExists
    ? parseProjectConfig(readFileSync(configPath, "utf8"))
    : emptyProjectConfig();
  if (config.integration) {
    integration = options.integration ?? config.integration.mode;
    base = options.base ?? config.integration.base;
    remote =
      options.remote ??
      (config.integration.mode === "remote" ? config.integration.remote : undefined);
  }
  if (integration === "local" && !options.remote) remote = undefined;
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
      if (!options.integration) {
        const answer = (await question(`Integration [${integration}] (local or remote): `))
          .trim()
          .toLowerCase();
        if (answer) {
          if (answer !== "local" && answer !== "remote")
            throw new Error("Integration must be local or remote.");
          integration = answer;
        }
      }
      if (!options.base) base = (await question(`Base branch [${base}]: `)).trim() || base;
      if (integration === "remote" && !options.remote) {
        const detected = defaultRemote(root, base);
        const fallback = remote ?? detected;
        remote = (await question(`Remote [${fallback ?? "none"}]: `)).trim() || fallback;
      }
      if (integration === "local" && !options.remote) remote = undefined;
      if (integration === "local" && remote)
        throw new Error("--remote applies only to remote integration.");
      if (integration === "remote" && !remote)
        throw new Error("Remote integration requires --remote <name-or-url>.");

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
    if (integration === "remote") remote ??= defaultRemote(root, base);
    if (integration === "local" && remote)
      throw new Error("--remote applies only to remote integration.");
    if (integration === "remote" && !remote)
      throw new Error("Remote integration requires --remote <name-or-url>.");
    showDetectedFeatures(detected);
    if (options.preview === undefined && !config.preview && detected.preview)
      config.preview = detected.preview;
  }

  const reachableRemote = integration === "remote" ? remote : defaultRemote(root, base);
  if (reachableRemote) verifyRemoteReachable(root, reachableRemote);
  else
    writeStdout(
      "No Git remote is configured. Local integration can continue, but this checkout cannot be cloned or promoted through a remote until one is added.\n",
    );

  config = {
    ...config,
    version: 3,
    integration:
      integration === "local"
        ? { mode: "local", base }
        : { mode: "remote", base, remote: remote as string },
  };

  const configChanged = !configExists || originalConfig !== JSON.stringify(config);
  if (configChanged) atomicWriteText(configPath, renderConfig(config), 0o644);

  const project = initProject({
    integration,
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
): Promise<CheckResult> {
  const started = Date.now();
  const logPath = nativeCheckLog(task, definition.name);
  writeFileSync(logPath, "", { mode: 0o600 });
  note(`Running ${definition.name}: ${definition.run}`);
  const stream = (chunk: string) => {
    appendFileSync(logPath, chunk);
    writeStderr(chunk);
  };
  const result = await runTaskShellStreamingAt(task, directory, definition.run, {
    timeout: definition.timeoutMs,
    onStdout: stream,
    onStderr: stream,
  });
  if (result.timedOut) {
    const timeout = `Timed out after ${humanDuration(definition.timeoutMs)}.\n`;
    appendFileSync(logPath, timeout);
    writeStderr(timeout);
  }
  const check: CheckResult = {
    name: definition.name,
    command: definition.run,
    status: result.timedOut ? "timed_out" : result.status === 0 ? "passed" : "failed",
    exitCode: result.status,
    durationMs: Date.now() - started,
    logPath,
  };
  note(
    `${definition.name} ${check.status === "passed" ? "passed" : "failed"} in ${humanDuration(check.durationMs)}.`,
  );
  return check;
}

async function prepareIsolatedCheckSetup(
  task: TaskManifest,
  candidateTreeOid: string,
  directory: string,
  run: string | undefined,
): Promise<SetupStatus | undefined> {
  if (!run) return undefined;
  const marker = join(taskDir(task.projectId, task.id), "check-worktree-setup.json");
  const key = JSON.stringify({ candidateTreeOid, run });
  if (existsSync(marker) && readFileSync(marker, "utf8") === key) return undefined;
  const logPath = join(taskDir(task.projectId, task.id), "check-worktree-setup.log");
  writeFileSync(logPath, "", { mode: 0o600 });
  const startedAt = new Date().toISOString();
  const stream = (chunk: string) => {
    appendFileSync(logPath, chunk);
    writeStderr(chunk);
  };
  const result = await runTaskShellStreamingAt(task, directory, run, {
    timeout: 900_000,
    onStdout: stream,
    onStderr: stream,
  });
  const status: SetupStatus = {
    state: result.timedOut ? "timed_out" : result.status === 0 ? "passed" : "failed",
    command: run,
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: result.status,
    logPath,
  };
  if (status.state === "passed") writeFileSync(marker, key, { mode: 0o600 });
  return status;
}

async function nativeSnapshot(task: TaskManifest, running: boolean): Promise<TaskSnapshot> {
  const snapshot = task.lastSnapshot ?? { phase: "idle", agent: task.agent };
  if (running) return snapshot;
  return snapshot.phase === "reviewed" ? snapshot : { ...snapshot, phase: "stopped" };
}

function ensureAgentWorkspaceStable(project: ProjectManifest, task: TaskManifest): void {
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

function recordAdvancedTargetPending(
  project: ProjectManifest,
  task: TaskManifest,
  targetOid: string,
): void {
  if (!task.lastSnapshot?.targetOid || task.lastSnapshot.targetOid === targetOid) return;
  recordTaskSnapshot(
    project,
    task,
    { ...task.lastSnapshot, targetOid },
    { source: "git", workspaceRelation: "reconcile_pending" },
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

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function reclaimAbortedCreation(name: string): void {
  const registered = listRegisteredTasks().find(
    ({ task }) => task.name.toLowerCase() === name.toLowerCase(),
  );
  if (
    !registered ||
    registered.task.lastSnapshot?.phase !== "creating" ||
    registered.task.creationPid === undefined ||
    processIsAlive(registered.task.creationPid)
  )
    return;
  const sandbox = findTaskRuntime(runtimeInventory(), registered.task);
  if (sandbox) return;
  rmSync(taskDir(registered.project.id, registered.task.id), { recursive: true, force: true });
  note(`Recovered task name ${name} from interrupted runtime provisioning.`);
}

export async function newTask(name: string, options: NewTaskOptions): Promise<number> {
  reclaimAbortedCreation(name);
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
  const globallyAuthenticated = hasGlobalCredential(agent);
  let bootstrapCodexSubscription = false;
  let bootstrapClaudeSubscription = false;
  if (!globallyAuthenticated) {
    if (!isInteractive())
      throw new Error(
        `No global ${providerForAgent(agent)} credential is configured. ${remediationFor(agent)}`,
      );
    if (!(await confirmAuthentication(agent)))
      throw new Error(
        `Authentication is required to create a ${agent} task. ${remediationFor(agent)}`,
      );
    if (agent === "codex") {
      if (isSshSession()) bootstrapCodexSubscription = true;
      else authenticateAgent("codex", { mode: "oauth" });
    } else bootstrapClaudeSubscription = true;
  }
  const template = resolveTemplate(agent, options.template);
  let task = createTaskManifest(project, name, agent, template, model, effort, fast);
  let previewUrls: string[] = [];
  let previewFailure: string | undefined;
  try {
    createTaskEnvironment(task, project.seedPath);
    if (bootstrapCodexSubscription) authenticateCodexSubscription(task);
    if (bootstrapClaudeSubscription) authenticateClaudeSubscription(task);
    if (!bootstrapCodexSubscription && !bootstrapClaudeSubscription)
      assertTaskAgentCredential(task);
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
        startTaskPreview(task, configuredPreview.run);
        task = updateTask(project, task, {
          ...(task.lastSnapshot as TaskSnapshot),
          preview: { state: "running", urls: previewUrls },
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
): Promise<number> {
  const project = projectByReference(projectReference);
  process.chdir(project.root);
  return newTask(name, options);
}

export async function cloneAndInitializeProject(
  source: string,
  base: string,
  destination: string,
): Promise<number> {
  if (!isAbsolute(destination)) throw new Error("Remote clone destination must be absolute.");
  if (existsSync(destination)) throw new Error(`Clone destination already exists: ${destination}`);
  requireSuccess(
    command("git", ["clone", "--branch", base, "--", source, destination], { stdio: "inherit" }),
    `Could not clone ${source}`,
  );
  process.chdir(destination);
  return initialize({ yes: true });
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
      view.connection === "error" || view.snapshot?.tasks.some((task) => task.phase === "failed"),
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
    setup: readSetupStatus(task),
  };
  updateTask(project, task, withSetup, undefined, "daemon");
  return withSetup;
}

async function refreshTaskStatus(name: string, json: boolean): Promise<number> {
  let { project, task } = requireRegisteredTask(name);
  await waitForSetup(task);
  ({ project, task } = requireRegisteredTask(name));
  drainTaskLifecycleEvents(project, task);
  if (readTaskState(project, task).agentTurnState !== "working")
    await refreshSettledCandidate(name);
  return status(name, json, false);
}

export async function status(name: string, json: boolean, refresh = false): Promise<number> {
  if (refresh) return refreshTaskStatus(name, json);
  const { project, task } = requireRegisteredTask(name);
  const state = readTaskState(project, task);
  if (json) writeStdout(`${JSON.stringify({ task: projectedTaskRecord(task), state })}\n`);
  else {
    const unmerged =
      state.hasUnmergedChanges.value === "unknown"
        ? "unknown"
        : state.hasUnmergedChanges.value
          ? "yes"
          : "no";
    writeStdout(
      `${name}: ${state.agentTurnState}\nNeeds attention: ${taskNeedsAttention(state) ? "yes" : "no"} (event ${humanTimestamp(state.lastLifecycleEventAt ?? state.updatedAt)})\nUnmerged changes: ${unmerged} (observed ${humanTimestamp(state.hasUnmergedChanges.observedAt)})${unmerged === "no" && state.lastDelivery ? `; as of that observation, last commit on ${project.integration.base}: ${JSON.stringify(state.lastDelivery.value.subject)}, no other changes by this task` : ""}\n${state.settlement ? `Settlement: ${state.settlement.phase}${state.settlement.failure ? ` (${state.settlement.failure})` : ""}\n` : ""}${state.lifecycleDiagnostic ? `Lifecycle capture: ${state.lifecycleDiagnostic}\n` : ""}${state.setup ? `Setup: ${state.setup.state}\n` : ""}${state.check ? `Checks: ${state.check.status}\n` : ""}${state.failure ? `Failure: ${state.failure}\n` : ""}`,
    );
  }
  return state.failure || state.settlement?.phase === "failed" ? 1 : 0;
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
  let { project, task } = requireRegisteredTask(name);
  await waitForSetup(task);
  ({ project, task } = requireRegisteredTask(name));
  drainTaskLifecycleEvents(project, task);
  ensureAgentWorkspaceStable(project, task);
  const before = task.lastSnapshot?.targetOid;
  const snapshot = await refreshSettledCandidate(name);
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
  if (
    !force &&
    delivered &&
    recordedState.hasUnmergedChanges.value === false &&
    recordedState.hasUnmergedChanges.source === "git" &&
    recordedState.agentTurnState !== "working"
  ) {
    const info = findTaskRuntime(runtimeInventory(), task);
    writeStdout(
      `Unmerged changes: no; last commit on ${delivered.ref}: ${JSON.stringify(delivered.subject)}, no other changes by this task\n`,
    );
    if (info) destroyTaskEnvironment(task);
    rmSync(taskDir(project.id, task.id), { recursive: true, force: true });
    writeStdout(`Discarded task ${name}.\n`);
    return 0;
  }
  if (!force) await waitForSetup(task);
  if (!force) ({ project, task } = requireRegisteredTask(name));
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
): string {
  const patch = taskWorkspacePatch(task, targetOid);
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
  return withTaskMutationBarrier(task, () =>
    materializeNativeCandidateUnsafe(project, task, targetOid),
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

function reconciliationRepairPrompt(
  base: string,
  oldTargetOid: string,
  targetOid: string,
  conflicts: readonly string[],
): string {
  return `Boxers has transplanted this task from ${oldTargetOid} onto ${targetOid} (${base}) and the Git index now contains merge conflicts in:
${conflicts.map((path) => `- ${path}`).join("\n")}

Resolve this existing reconciliation only. Inspect the base, ours, and theirs stages and preserve the intended task change while incorporating the new target. Stage every resolved path so that git diff --name-only --diff-filter=U is empty.

Do not commit, rebase, reset, abort the merge, install dependencies, run the project test suite, or modify unrelated work. If the correct resolution is genuinely ambiguous, leave that conflict unresolved and explain why in your final response.`;
}

function attemptAutomaticReconciliationRepair(
  project: ProjectManifest,
  task: TaskManifest,
  previous: TaskSnapshot,
  oldTargetOid: string,
  targetOid: string,
  conflicts: string[],
): { status: "clean" | "conflicted"; conflicts: string[] } {
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
      reconciliationRepairPrompt(project.integration.base, oldTargetOid, targetOid, conflicts),
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

  const remaining = taskConflictPaths(repairing);
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
  const updated = updateTask(project, task, snapshot, true);
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
  return {
    ...result,
    fromTargetOid: oldTargetOid,
    targetOid,
    snapshot,
  };
}

function reconcileNativeTask(
  project: ProjectManifest,
  task: TaskManifest,
  previous: TaskSnapshot,
  oldTargetOid: string,
  targetOid: string,
): NativeTaskReconciliation {
  return withTaskMutationBarrier(task, () =>
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
    !snapshot.candidateTreeOid
  )
    return undefined;
  if (
    state.hasUnmergedChanges.value !== true ||
    state.baseOid !== targetOid ||
    state.candidateTreeOid !== snapshot.candidateTreeOid
  )
    return undefined;
  return { snapshot, targetOid, candidateTreeOid: snapshot.candidateTreeOid };
}

interface PreparedCandidate {
  snapshot: TaskSnapshot;
  targetOid: string;
  candidateTreeOid?: string;
}

function prepareCandidate(
  project: ProjectManifest,
  task: TaskManifest,
  initial: TaskSnapshot,
  targetOid: string,
): PreparedCandidate | { conflictStatus: 1 } {
  let previous = initial;
  const conflicts = taskConflictPaths(task);
  if (conflicts.length) {
    recordUnresolvedNativeConflicts(project, task, previous, conflicts);
    writeStderr(
      `Task ${task.name} still has unresolved reconciliation conflicts:\n${conflicts.map((path) => `  ${path}`).join("\n")}\nRun \`boxers ${task.name} attach\` to resolve and stage them, then try again.\n`,
    );
    return { conflictStatus: 1 };
  }
  if (previous.targetOid && previous.targetOid !== targetOid) {
    note("The target advanced; reconciling the task.");
    const result = reconcileNativeTask(project, task, previous, previous.targetOid, targetOid);
    if (result.status === "conflicted")
      return { conflictStatus: reportNativeReconciliationConflict(project, task, result) };
    previous = result.snapshot;
    writeStdout(
      `Target advanced from ${result.fromTargetOid} to ${targetOid}; reconciled automatically.\n`,
    );
  }
  const candidateTreeOid = materializeNativeCandidate(project, task, targetOid);
  const targetTree = requireSuccess(
    command("git", ["-C", project.seedPath, "rev-parse", `${targetOid}^{tree}`]),
    "Could not resolve target tree",
  );
  const changed = candidateTreeOid !== targetTree;
  if (candidateTreeOid !== (previous.candidateTreeOid ?? targetTree))
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
  updateTask(project, task, snapshot, changed);
  return { snapshot, targetOid, ...(changed ? { candidateTreeOid } : {}) };
}

/**
 * The shared strong capture passage for an event-confirmed stable workspace.
 * It refreshes and reconciles the canonical target and captures one exact
 * candidate for automatic settlement and explicit intents alike.
 */
export async function refreshSettledCandidate(
  name: string,
  onPhase?: (phase: "refreshing" | "reconciling" | "capturing") => void,
): Promise<TaskSnapshot> {
  let { project, task } = requireRegisteredTask(name);
  const setup = readSetupStatus(task);
  const previous = task.lastSnapshot ?? { phase: "idle" as const, agent: task.agent };
  updateTask(project, task, { ...previous, setup, runtimeState: "running" }, undefined, "daemon");
  if (readTaskState(project, task).agentTurnState === "working" || setup?.state === "running")
    return previous;

  onPhase?.("refreshing");
  const targetOid = refreshSeed(project);
  recordAdvancedTargetPending(project, task, targetOid);
  if (previous.targetOid && previous.targetOid !== targetOid) {
    onPhase?.("reconciling");
    const conflicts = taskConflictPaths(task);
    if (conflicts.length)
      return recordUnresolvedNativeConflicts(project, task, previous, conflicts);
    targetConfig(project, targetOid);
    const reconciliation = reconcileNativeTask(
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

  onPhase?.("capturing");
  const prepared = prepareCandidate(project, task, task.lastSnapshot ?? previous, targetOid);
  if ("conflictStatus" in prepared) return requireRegisteredTask(name).task.lastSnapshot!;
  return prepared.snapshot;
}

export interface AutomaticSettlementResult {
  targetOid?: string;
  candidateTreeOid?: string;
  deferred?: boolean;
  needsInput?: string;
}

/** One automatic post-turn passage: capture, check, and conversation metadata. */
export async function runAutomaticSettlement(
  name: string,
  triggerSequence: number,
  runId: string,
  onPhase?: (phase: "refreshing" | "reconciling" | "capturing" | "checking" | "generating") => void,
  onIdentity?: (targetOid: string, candidateTreeOid: string) => void,
): Promise<AutomaticSettlementResult> {
  const initial = requireRegisteredTask(name);
  beginSettlementPublicationGuard({
    taskId: initial.task.id,
    runId,
    triggerSequence,
  });
  try {
    const state = readTaskState(initial.project, initial.task);
    if (
      state.agentTurnState !== "awaiting_input" ||
      state.conversationHighWaterSequence !== triggerSequence
    )
      return {};
    if (readSetupStatus(initial.task)?.state === "running") return { deferred: true };
    const captured = await refreshSettledCandidate(name, onPhase);
    const afterCapture = requireRegisteredTask(name);
    const current = readTaskState(afterCapture.project, afterCapture.task);
    if (
      current.agentTurnState !== "awaiting_input" ||
      current.conversationHighWaterSequence !== triggerSequence
    )
      return {};
    if (captured.failure) return { needsInput: captured.failure };
    if (captured.candidateTreeOid) {
      if (!captured.targetOid) return {};
      identifySettlementPublication(captured.targetOid, captured.candidateTreeOid);
      onIdentity?.(captured.targetOid, captured.candidateTreeOid);
      onPhase?.("checking");
      await refreshAutomaticCheck(name);
      onPhase?.("generating");
      if (!refreshAutomaticCommitMessage(name))
        throw new Error("Commit metadata generation failed for the current candidate.");
    }
    const final = readTaskState(afterCapture.project, requireRegisteredTask(name).task);
    return {
      ...(final.baseOid ? { targetOid: final.baseOid } : {}),
      ...(final.candidateTreeOid ? { candidateTreeOid: final.candidateTreeOid } : {}),
    };
  } finally {
    endSettlementPublicationGuard();
  }
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
  if (
    snapshot.check?.targetOid === snapshot.targetOid &&
    snapshot.check.candidateTreeOid === snapshot.candidateTreeOid &&
    snapshot.check.configHash === configHash
  )
    return snapshot;
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
  const candidateDiff = command("git", [
    "-C",
    project.seedPath,
    "diff",
    "--binary",
    "--full-index",
    "--no-ext-diff",
    prepared.targetOid,
    prepared.candidateTreeOid,
  ]);
  requireSuccess(candidateDiff, "Could not read the exact candidate patch for checks");
  // A Git patch is byte-sensitive: requireSuccess intentionally trims display
  // output, so pass the original stdout through to `git apply`.
  const candidatePatch = candidateDiff.stdout;
  const checkWorkspace = prepareTaskCheckWorkspace(
    task,
    project.integration.base,
    prepared.targetOid,
    prepared.candidateTreeOid,
    candidatePatch,
  );
  if (checkWorkspace.candidateTreeOid !== prepared.candidateTreeOid)
    throw new Error(
      `Candidate changed while preparing checks: captured ${prepared.candidateTreeOid}, isolated ${checkWorkspace.candidateTreeOid}.`,
    );
  const setup = await prepareIsolatedCheckSetup(
    task,
    prepared.candidateTreeOid,
    checkWorkspace.path,
    config.check?.setup ?? config.setup?.run,
  );
  const definitions = config.check?.commands ?? [];
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
  if (setup && setup.state !== "passed") {
    results.push({
      name: "setup",
      command: setup.command,
      status: setup.state === "timed_out" ? "timed_out" : "failed",
      ...(setup.exitCode === undefined ? {} : { exitCode: setup.exitCode }),
      durationMs:
        setup.finishedAt === undefined
          ? 0
          : Math.max(0, Date.parse(setup.finishedAt) - Date.parse(setup.startedAt)),
      logPath: setup.logPath,
    });
  }
  for (const definition of setup && setup.state !== "passed" ? [] : definitions) {
    results.push(await runNativeCheck(task, definition, checkWorkspace.path));
  }
  const finalTree = taskWorkspaceTreeAt(task, checkWorkspace.path);
  if (finalTree !== candidateTreeOid)
    throw new Error(
      "A configured check modified the workspace. Check commands must be read-only; move formatting or fixes into the agent workflow.",
    );
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
      results,
    },
  };
  updateTask(project, current, snapshot);
  return snapshot;
}

function executeChecks(
  project: ProjectManifest,
  task: TaskManifest,
  prepared: PreparedCandidate,
  config: ProjectConfig,
  configHash: string,
): Promise<TaskSnapshot> {
  return executeChecksUnsafe(project, task, prepared, config, configHash);
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
  let { project, task } = requireRegisteredTask(name);
  await waitForSetup(task);
  ({ project, task } = requireRegisteredTask(name));
  note(`Reviewing ${name} against ${project.integration.base}.`);
  drainTaskLifecycleEvents(project, task);
  ensureAgentWorkspaceStable(project, task);
  try {
    const snapshot = await refreshSettledCandidate(name);
    ({ project, task } = requireRegisteredTask(name));
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
  let { project, task } = requireRegisteredTask(name);
  await waitForSetup(task);
  ({ project, task } = requireRegisteredTask(name));
  drainTaskLifecycleEvents(project, task);
  ensureAgentWorkspaceStable(project, task);
  note(`Checking ${name} against ${project.integration.base}.`);
  const captured = await refreshSettledCandidate(name);
  ({ project, task } = requireRegisteredTask(name));
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

function acquireLock(project: ProjectManifest): { fd: number; path: string } {
  const path = join(projectDir(project.id), "promote.lock");
  mkdirSync(projectDir(project.id), { recursive: true });
  try {
    return { fd: openSync(path, "wx", 0o600), path };
  } catch {
    throw new Error("Another Boxers promotion is currently updating this project.");
  }
}

function releaseLock(lock: { fd: number; path: string }): void {
  closeSync(lock.fd);
  unlinkSync(lock.path);
}

function remoteDeliveryBranch(project: ProjectManifest, task: TaskManifest): string {
  const projectName = basename(project.root).replace(/[^a-zA-Z0-9._-]+/g, "-") || "project";
  return `agent/${projectName}/${task.name}`;
}

async function reportRemoteDelivery(branch: string, base: string): Promise<void> {
  writeStdout(`Pushed ${branch}. Open a pull request to merge it into ${base}.\n`);
  if (!process.stdin.isTTY) return;
  const key = await readKey(
    `Press c to copy ${branch} to your clipboard, any other key to continue: `,
  );
  if (key.toLowerCase() !== "c") return;
  if (copyToClipboard(branch)) writeStdout(`Copied ${branch} to your clipboard.\n`);
  else note(`Could not reach a clipboard tool; copy it manually: ${branch}`);
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
  let { project, task } = requireRegisteredTask(name);
  await waitForSetup(task);
  ({ project, task } = requireRegisteredTask(name));
  drainTaskLifecycleEvents(project, task);
  ensureAgentWorkspaceStable(project, task);
  let lock: { fd: number; path: string } | undefined;
  try {
    const targetOid = refreshSeed(project);
    recordAdvancedTargetPending(project, task, targetOid);
    const target = targetConfig(project, targetOid);
    const config = parseProjectConfig(target.text);
    const checkConfig = config.check;
    let prepared: PreparedCandidate | { conflictStatus: 1 } | undefined = recordedPreparedCandidate(
      project,
      task,
      targetOid,
    );
    if (!prepared) {
      note(`Preparing ${name} for promotion against ${project.integration.base}.`);
      const captured = await refreshSettledCandidate(name);
      ({ project, task } = requireRegisteredTask(name));
      prepared =
        captured.question || captured.failure
          ? { conflictStatus: 1 }
          : {
              snapshot: captured,
              targetOid: captured.targetOid ?? targetOid,
              ...(captured.candidateTreeOid ? { candidateTreeOid: captured.candidateTreeOid } : {}),
            };
    }
    if ("conflictStatus" in prepared) return prepared.conflictStatus;
    if (!prepared.candidateTreeOid) {
      writeStdout(`Task ${name} has no changes to promote.\n`);
      return 0;
    }
    let snapshot = prepared.snapshot;
    const checkConfigured = Boolean(config.check?.commands.length);
    const configHash = checkConfig ? checkConfigHash(checkConfig) : undefined;
    const reusablePass =
      snapshot.check?.status === "passed" &&
      snapshot.check.targetOid === targetOid &&
      snapshot.check.candidateTreeOid === prepared.candidateTreeOid &&
      snapshot.check.configHash === configHash;
    if (checkConfigured && skipChecks)
      writeStderr("Skipping configured checks by explicit request.\n");
    else if (checkConfigured && reusablePass)
      writeStdout("All checks have successfully completed.\n");
    else if (checkConfigured) {
      note("No current passing check result; running checks before promotion.");
      snapshot = await executeChecks(project, task, prepared, config, configHash as string);
      printCheckResults(snapshot);
      if (snapshot.check?.status !== "passed") {
        writeStderr(
          `Promotion stopped because checks failed. See ${join(taskDir(task.projectId, task.id), "checks")}.\n`,
        );
        return 1;
      }
    }
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
    if (project.integration.mode === "local") {
      const branch = requireSuccess(
        command("git", ["-C", project.root, "branch", "--show-current"]),
        "Could not inspect local branch",
      );
      const status = requireSuccess(
        command("git", ["-C", project.root, "status", "--porcelain=v1"]),
        "Could not inspect local worktree",
      );
      const head = requireSuccess(
        command("git", ["-C", project.root, "rev-parse", "HEAD^{commit}"]),
        "Could not inspect local HEAD",
      );
      if (branch !== project.integration.base || status || head !== targetOid)
        throw new Error(
          `Local integration refused: expected clean ${project.integration.base} at ${targetOid}.`,
        );
    }
    let remoteDelivery:
      | { remote: string; branch: string; parentOid: string; replaceOid?: string }
      | undefined;
    if (project.integration.mode === "remote") {
      const remoteResult = command("git", [
        "-C",
        project.root,
        "remote",
        "get-url",
        project.integration.remote,
      ]);
      const remote =
        remoteResult.status === 0 ? remoteResult.stdout.trim() : project.integration.remote;
      const branch = remoteDeliveryBranch(project, task);
      const published = requireSuccess(
        command("git", ["ls-remote", "--heads", remote, `refs/heads/${branch}`]),
        `Could not inspect remote delivery branch ${branch}`,
      );
      let parentOid = published.split(/\s+/)[0] || targetOid;
      let replaceOid: string | undefined;
      if (parentOid !== targetOid) {
        requireSuccess(
          command("git", [
            "-C",
            project.seedPath,
            "fetch",
            "--no-tags",
            remote,
            `refs/heads/${branch}:refs/boxers/delivery`,
          ]),
          `Could not fetch remote delivery branch ${branch}`,
        );
        const targetIsAncestor =
          command("git", [
            "-C",
            project.seedPath,
            "merge-base",
            "--is-ancestor",
            targetOid,
            parentOid,
          ]).status === 0;
        if (!targetIsAncestor) {
          const deliveryIsMerged =
            command("git", [
              "-C",
              project.seedPath,
              "merge-base",
              "--is-ancestor",
              parentOid,
              targetOid,
            ]).status === 0;
          const cherry = command("git", ["-C", project.seedPath, "cherry", targetOid, parentOid]);
          const deliveryIsPatchEquivalent =
            cherry.status === 0 &&
            cherry.stdout
              .split("\n")
              .filter(Boolean)
              .every((line) => line.startsWith("- "));
          if (!deliveryIsMerged && !deliveryIsPatchEquivalent)
            throw new Error(
              `Remote delivery branch ${branch} still contains changes not present on ${project.integration.base}; merge or rename it before trying again.`,
            );
          replaceOid = parentOid;
          parentOid = targetOid;
        }
      }
      remoteDelivery = { remote, branch, parentOid, ...(replaceOid ? { replaceOid } : {}) };
    }
    const created = command(
      "git",
      [
        "-C",
        project.seedPath,
        "commit-tree",
        prepared.candidateTreeOid,
        "-p",
        remoteDelivery?.parentOid ?? targetOid,
        "-m",
        commitMessage,
      ],
      { env: identity },
    );
    const finalCommit = requireSuccess(created, "Could not create final delivery commit");
    if (project.integration.mode === "local") {
      requireSuccess(
        command("git", ["-C", project.root, "fetch", "-q", project.seedPath, finalCommit]),
        "Could not import delivery commit into local repository",
      );
      requireSuccess(
        command("git", ["-C", project.root, "merge", "--ff-only", finalCommit]),
        "Could not fast-forward local target",
      );
    } else {
      const delivery = remoteDelivery as NonNullable<typeof remoteDelivery>;
      const { remote, branch: deliveryBranch } = delivery;
      const pushed = command("git", [
        "-C",
        project.seedPath,
        "push",
        remote,
        ...(delivery.replaceOid
          ? [`--force-with-lease=refs/heads/${deliveryBranch}:${delivery.replaceOid}`]
          : []),
        `${finalCommit}:refs/heads/${deliveryBranch}`,
      ]);
      if (pushed.status !== 0) {
        refreshSeed(project);
        throw new Error(
          `Remote branch push was rejected; update or remove ${deliveryBranch}, then try again. ${(pushed.stderr || pushed.stdout).trim()}`,
        );
      }
      requireSuccess(
        command("git", [
          "-C",
          project.seedPath,
          "update-ref",
          `refs/heads/${deliveryBranch}`,
          finalCommit,
        ]),
        `Could not publish local delivery ref ${deliveryBranch}`,
      );
      await reportRemoteDelivery(deliveryBranch, project.integration.base);
    }
    const mergedTarget = refreshSeed(project);
    if (project.integration.mode === "local" && mergedTarget !== finalCommit)
      throw new Error(`Integrated target resolved to ${mergedTarget}, expected ${finalCommit}.`);
    try {
      const preservedWorkspaceChanges = advanceTaskWorkspace(
        task,
        remoteDelivery?.branch ?? project.integration.base,
        finalCommit,
      );
      const advanced = updateTask(
        project,
        task,
        {
          ...snapshot,
          phase: preservedWorkspaceChanges ? "stopped" : "idle",
          // advanceTaskWorkspace verified and installed finalCommit. In remote
          // mode the base branch is advanced separately, so mergedTarget may be
          // unrelated or may not contain this delivery commit yet.
          targetOid: finalCommit,
          candidateTreeOid: undefined,
          check: undefined,
        },
        preservedWorkspaceChanges || project.integration.mode === "remote",
      );
      recordTaskSnapshot(project, advanced, advanced.lastSnapshot as TaskSnapshot, {
        source: "git",
        workspaceRelation:
          preservedWorkspaceChanges || project.integration.mode === "remote"
            ? "not_on_base"
            : "on_base",
        lastDelivery: {
          ref: remoteDelivery?.branch ?? project.integration.base,
          oid: finalCommit,
          subject: commitSubject,
        },
      });
      updateTaskState(
        project,
        advanced,
        {
          promotionConversationCheckpoint: readTaskState(project, advanced)
            .conversationHighWaterSequence,
        },
        "git",
      );
      if (preservedWorkspaceChanges)
        note("Preserved workspace changes created after the promoted candidate was captured.");
    } catch (error) {
      throw new Error(
        `${project.integration.mode === "local" ? "Promoted" : "Published"} ${name} as ${finalCommit}, but advancing the originating task failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    writeStdout(
      project.integration.mode === "local"
        ? `Promoted ${name} as ${finalCommit}.\n`
        : `Published ${name} as ${finalCommit}.\n`,
    );
    return 0;
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
    const result = taskPreviewLogs(task);
    writeStdout(result.stdout);
    return result.status;
  }
  if (action === "stop" || action === "restart") stopTaskPreview(task);
  let preview: NonNullable<TaskSnapshot["preview"]> = { state: "stopped" };
  if (action === "start" || action === "restart") {
    const setup = await waitForSetup(task);
    ({ project, task } = requireRegisteredTask(name));
    if (setup && setup.state !== "passed")
      throw new Error(`Preview cannot start because setup ${setup.state}.`);
    const target = refreshSeed(project);
    const configuredPreview = parseProjectPreview(targetConfig(project, target).text);
    if (!configuredPreview) throw new Error("No preview is configured on the canonical target.");
    startTaskPreview(task, configuredPreview.run);
    let urls = task.lastSnapshot?.preview?.urls ?? taskPublishedUrls(task);
    try {
      if (!urls.length) urls = publishTaskPorts(task, configuredPreview.ports);
    } catch (error) {
      stopTaskPreview(task);
      throw error;
    }
    preview = { state: "running", urls };
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
    case "refresh":
      return status(name, intent.json, true);
    case "sync":
      return sync(name);
    case "review":
      return review(name, intent.color ?? false);
    case "check":
      return check(name);
    case "promote":
      return promote(name, intent.message, intent.skipChecks);
    case "preview":
      return preview(name, intent.action ?? "show");
    case "discard":
      return discard(name, intent.force);
  }
}
