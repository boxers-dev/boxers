import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { command, requireSuccess, type CommandResult } from "./process.ts";
import type { Agent, HerdrTask, ProjectConfig } from "./types.ts";
import {
  pluginStateDir,
  readPluginState,
  updateTask,
  withStateLock,
  writePluginState,
} from "./state.ts";

const MINIMUM_SBX_VERSION = [0, 37, 0] as const;

export interface SandboxInfo {
  name: string;
  status: string;
  agent?: string;
  ports?: unknown;
}

export function parseSandboxList(value: unknown): SandboxInfo[] {
  const raw = Array.isArray(value)
    ? value
    : value &&
        typeof value === "object" &&
        Array.isArray((value as Record<string, unknown>).sandboxes)
      ? ((value as Record<string, unknown>).sandboxes as unknown[])
      : [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const name = row.name ?? row.Name;
    const status = row.status ?? row.Status ?? row.state ?? row.State;
    if (typeof name !== "string" || typeof status !== "string") return [];
    const agent = row.agent ?? row.Agent;
    return [
      {
        name,
        status,
        ...(typeof agent === "string" ? { agent } : {}),
        ...((row.ports ?? row.Ports) !== undefined ? { ports: row.ports ?? row.Ports } : {}),
      },
    ];
  });
}

export function strictSandboxEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result = { ...env };
  // Docker Sandboxes forwards this socket by default. Never offer publication
  // authority to a Boxers sandbox, including during create, start, and attach.
  delete result.SSH_AUTH_SOCK;
  for (const key of Object.keys(result)) if (key.startsWith("HERDR_")) delete result[key];
  return result;
}

export function runSbx(args: readonly string[], inherit = false): CommandResult {
  return command("sbx", args, {
    env: strictSandboxEnvironment(),
    ...(inherit ? { stdio: "inherit" as const } : {}),
  });
}

export function assertSbxAvailable(): void {
  const result = runSbx(["--version"]);
  const match = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:\s|$)/m.exec(`${result.stdout}\n${result.stderr}`);
  if (result.status !== 0 || !match) throw new Error("Docker Sandboxes (`sbx`) is required.");
  const actual = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let index = 0; index < 3; index++) {
    if (actual[index]! > MINIMUM_SBX_VERSION[index]!) return;
    if (actual[index]! < MINIMUM_SBX_VERSION[index]!)
      throw new Error("Boxers requires Docker Sandboxes 0.37.0 or newer.");
  }
}

export function sandboxName(projectId: string, occupied: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 64; attempt++) {
    const name = `boxers-${projectId.slice(0, 8)}-${randomBytes(5).toString("hex")}`;
    if (!occupied.has(name)) return name;
  }
  throw new Error("Could not allocate a unique Docker Sandbox name.");
}

export function listPluginSandboxes(): SandboxInfo[] {
  const output = requireSuccess(runSbx(["ls", "--json"]), "Could not list Docker Sandboxes");
  try {
    return parseSandboxList(JSON.parse(output));
  } catch {
    throw new Error("sbx ls returned invalid JSON.");
  }
}

export function createPluginSandbox(
  projectId: string,
  mirrorPath: string,
  agent: Agent,
  config: ProjectConfig,
): string {
  assertSbxAvailable();
  const occupied = new Set(listPluginSandboxes().map((sandbox) => sandbox.name));
  const name = sandboxName(projectId, occupied);
  requireSuccess(
    runSbx(
      [
        "create",
        "--clone",
        "--name",
        name,
        ...(config.sandbox?.template ? ["--template", config.sandbox.template] : []),
        agent,
        mirrorPath,
      ],
      true,
    ),
    `Could not create Docker Sandbox ${name}`,
  );
  return name;
}

function herdr(args: readonly string[], inherit = false): CommandResult {
  const binary = process.env.HERDR_BIN_PATH ?? "herdr";
  return command(binary, args, inherit ? { stdio: "inherit" } : {});
}

export function openAgentPane(task: HerdrTask): void {
  const args = [
    "plugin",
    "pane",
    "open",
    "--plugin",
    process.env.HERDR_PLUGIN_ID ?? "boxers.sandboxes",
    "--entrypoint",
    `agent-${task.agent}`,
    "--placement",
    "tab",
    "--cwd",
    task.projectRoot,
    "--env",
    `BOXERS_TASK_ID=${task.id}`,
    "--env",
    `BOXERS_SANDBOX_ID=${task.sandboxId}`,
    "--env",
    `HERDR_AGENT=${task.agent}`,
    ...(task.workspaceId ? ["--workspace", task.workspaceId] : []),
    "--focus",
  ];
  requireSuccess(herdr(args), `Could not open a Herdr pane for ${task.sandboxId}`);
}

export function attachPane(agent: Agent): number {
  const stateDir = pluginStateDir();
  const taskId = process.env.BOXERS_TASK_ID;
  const sandboxId = process.env.BOXERS_SANDBOX_ID;
  if (!taskId || !sandboxId) throw new Error("The Boxers pane is missing its task mapping.");
  const paneId = process.env.HERDR_PANE_ID;
  if (paneId) {
    updateTask(stateDir, taskId, (task) => ({
      ...task,
      paneId,
      sessionStartedAt: task.sessionStartedAt ?? new Date().toISOString(),
    }));
    requireSuccess(
      herdr([
        "pane",
        "report-metadata",
        paneId,
        "--source",
        "boxers",
        "--agent",
        agent,
        "--display-agent",
        `${agent === "codex" ? "Codex" : "Claude"} (sandboxed)`,
      ]),
      "Could not report the sandboxed agent label to Herdr",
    );
  }
  const task = readPluginState(stateDir).tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`Unknown Boxers task ${taskId}.`);
  const providerArgs = [
    ...(task.agentModel ? ["--model", task.agentModel] : []),
    ...(agent === "codex" && task.agentEffort
      ? ["--config", `model_reasoning_effort=${JSON.stringify(task.agentEffort)}`]
      : []),
  ];
  const result = spawnSync(
    "sbx",
    ["run", "--name", sandboxId, ...(providerArgs.length ? ["--", ...providerArgs] : [])],
    {
      env: strictSandboxEnvironment(),
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function reconcilePluginPanes(): void {
  const stateDir = pluginStateDir();
  const state = readPluginState(stateDir);
  const sandboxes = new Map(listPluginSandboxes().map((sandbox) => [sandbox.name, sandbox]));
  withStateLock(stateDir, () => {
    const current = readPluginState(stateDir);
    current.tasks = current.tasks.map((task) => {
      const status = sandboxes.get(task.sandboxId)?.status.toLowerCase();
      const runtimeState = !status
        ? "missing"
        : status.includes("running")
          ? "running"
          : status.includes("stop")
            ? "stopped"
            : "unknown";
      return { ...task, runtimeState };
    });
    writePluginState(current, stateDir);
  });
  for (const task of state.tasks) {
    const status = sandboxes.get(task.sandboxId)?.status.toLowerCase();
    if (!status?.includes("running")) continue;
    if (task.paneId && herdr(["agent", "get", task.paneId]).status === 0) continue;
    try {
      openAgentPane(task);
    } catch (error) {
      process.stderr.write(
        `Could not reopen ${task.sandboxId}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
}
