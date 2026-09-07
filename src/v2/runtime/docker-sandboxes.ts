import { arch, platform, release } from "node:os";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { MIN_SBX_VERSION, type TaskManifest } from "../types.ts";
import { command, commandWithInput, requireSuccess } from "../process.ts";
import {
  createSandbox,
  cancelSandboxJob,
  advanceNativeWorkspace,
  isRunning,
  listSandboxes,
  listSandboxesAsync,
  nativeConflictPaths,
  nativeGitStatus,
  inspectSandboxJob,
  nativePreviewLogs,
  nativeWorkspaceTreeAt,
  nativeWorkspacePatch,
  publishPorts,
  publishedUrls,
  reconcileNativeWorkspace,
  removeSandbox,
  runSandboxShell,
  runSandboxShellStreaming,
  runSandboxShellStreamingAt,
  runSandboxSetupStreaming,
  sandboxJobLogs,
  sbx,
  sbxAsync,
  shellSandbox,
  startSandboxJob,
  startNativePreview,
  stopNativePreview,
  stopSandbox,
} from "../sandbox.ts";
import type {
  RuntimeCapabilities,
  RuntimeDiagnostic,
  RuntimeDiagnosticOptions,
  RuntimeHandle,
  RuntimeInfo,
  RuntimeJobRequest,
  TaskEnvironmentSpec,
  TaskRuntime,
  RuntimeAuthMode,
  RuntimeAuthenticationStatus,
} from "./types.ts";
import { harnessForAgent } from "../providers/registry.ts";
import {
  CODEX_CHATGPT_CONFIG_ARGS,
  CODEX_TASK_HOME,
  CODEX_TASK_HOME_ENV,
  PREPARE_CODEX_HOME,
} from "./codex-home.ts";

function parseVersion(text: string): number[] | undefined {
  const match = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:\s|$)/m.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function versionAtLeast(version: number[], required: string): boolean {
  const wanted = required.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if ((version[index] ?? 0) > (wanted[index] ?? 0)) return true;
    if ((version[index] ?? 0) < (wanted[index] ?? 0)) return false;
  }
  return true;
}

export function linuxHostSupported(machineArch: string, kvmAvailable: boolean): boolean {
  return (machineArch === "x64" || machineArch === "arm64") && kvmAvailable;
}

function hostDiagnostic(): RuntimeDiagnostic {
  if (platform() === "darwin") {
    const ok = arch() === "arm64" && Number.parseInt(release().split(".")[0] ?? "0", 10) >= 23;
    return {
      component: "runtime.host",
      status: ok ? "ok" : "failed",
      detail: `${platform()} ${arch()} (requires Apple silicon macOS 14+)`,
    };
  }
  if (platform() === "win32") {
    const ok = arch() === "x64" && Number.parseInt(release().split(".")[2] ?? "0", 10) >= 22000;
    return {
      component: "runtime.host",
      status: ok ? "ok" : "failed",
      detail: `${platform()} ${release()} ${arch()} (requires Windows 11 x86-64)`,
    };
  }
  if (platform() === "linux") {
    const kvmAvailable = existsSync("/dev/kvm");
    const supported = linuxHostSupported(arch(), kvmAvailable);
    let detail = `Linux ${release()} ${arch()}, KVM ${kvmAvailable ? "available" : "missing"}`;
    try {
      const os = readFileSync("/etc/os-release", "utf8");
      const id = /^ID=(?:"?)([^"\n]+)(?:"?)$/m.exec(os)?.[1];
      const version = /^VERSION_ID=(?:"?)([^"\n]+)(?:"?)$/m.exec(os)?.[1];
      detail = `${id ?? "linux"} ${version ?? release()}, KVM ${kvmAvailable ? "available" : "missing"}`;
    } catch {
      // The generic capability result remains actionable.
    }
    return { component: "runtime.host", status: supported ? "ok" : "failed", detail };
  }
  return {
    component: "runtime.host",
    status: "failed",
    detail: `${platform()} ${arch()} is unsupported`,
  };
}

function normalizeState(raw: string | undefined): RuntimeInfo["state"] {
  if (!raw) return "missing";
  if (/running|ready|active/i.test(raw)) return "running";
  if (/stopped|exited|suspended/i.test(raw)) return "stopped";
  return "unknown";
}

function runtimeId(task: TaskManifest): string {
  return task.runtime.id;
}

function dockerTask(task: TaskManifest): TaskManifest {
  const id = runtimeId(task);
  return id === task.runtime.id ? task : { ...task, runtime: { ...task.runtime, id } };
}

function configuredServices(output: string): string[] {
  const known = [
    "openai",
    "anthropic",
    "github",
    "gitlab",
    "docker",
    "aws",
    "gcp",
    "azure",
    "npm",
    "pypi",
    "registry",
  ];
  const lower = output.toLowerCase();
  return known.filter((service) =>
    new RegExp(`(^|[^a-z0-9_-])${service}([^a-z0-9_-]|$)`, "m").test(lower),
  );
}

function serviceIsConfigured(output: string, service: string): boolean {
  return new RegExp(`(^|[^a-z0-9_-])${service}([^a-z0-9_-]|$)`, "im").test(output);
}

const CODEX_ACCOUNT_TIMEOUT_MS = 10_000;
const EXTERNAL_AUTH_REJECTED = 11;
const EXTERNAL_AUTH_MISSING = 13;
function prepareCodexHome(runtimeId: string) {
  return command("sbx", [
    "exec",
    runtimeId,
    "node",
    "-e",
    PREPARE_CODEX_HOME,
    "/home/agent/.codex",
    CODEX_TASK_HOME,
  ]);
}

export const EXTERNAL_AUTH_PROBE = `
agent="$1"
if test "$agent" = codex; then
  case "\${SBX_CRED_OPENAI_MODE:-none}" in
    oauth)
      endpoint=https://chatgpt.com/backend-api/codex/responses
      bearer=oai-oat01-proxy-managed
      ;;
    apikey)
      endpoint=https://api.openai.com/v1/responses
      bearer="$OPENAI_API_KEY"
      ;;
    *) exit 13 ;;
  esac
  status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --connect-timeout 3 --max-time 5 \
    --header "Authorization: Bearer $bearer" \
    --header 'Content-Type: application/json' \
    --data '{}' "$endpoint")" || exit 12
else
  status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --connect-timeout 3 --max-time 5 \
    --header "x-api-key: $ANTHROPIC_API_KEY" \
    --header 'anthropic-version: 2023-06-01' \
    --header 'Content-Type: application/json' \
    --data '{}' https://api.anthropic.com/v1/messages)" || exit 12
fi
test "$status" = 401 && exit 11
case "$status" in
  2??|400|422) exit 0 ;;
  *) exit 12 ;;
esac
`;

function externalCredentialStatus(
  runtimeId: string,
  agent: TaskManifest["agent"],
): RuntimeAuthenticationStatus {
  const result = command("sbx", [
    "exec",
    runtimeId,
    "sh",
    "-c",
    EXTERNAL_AUTH_PROBE,
    "boxers-auth-probe",
    agent,
  ]);
  if (result.status === 0)
    return {
      state: "ready",
      detail: `${agent === "codex" ? "OpenAI" : "Anthropic"} proxy credential was accepted`,
    };
  if (result.status === EXTERNAL_AUTH_REJECTED)
    return {
      state: "reauth_required",
      detail: `${agent === "codex" ? "OpenAI" : "Anthropic"} rejected the proxy credential`,
    };
  if (result.status === EXTERNAL_AUTH_MISSING)
    return {
      state: "missing",
      detail: "No Docker-managed OpenAI credential is bound to this task",
    };
  return {
    state: "external_unverified",
    detail: `${agent === "codex" ? "OpenAI" : "Anthropic"} proxy credential is stored; live verification was inconclusive`,
  };
}

/**
 * Ask Codex to read its task-local account without forcing token rotation. The Docker credential
 * proxy is deliberately removed from this probe so its placeholder API key
 * cannot be mistaken for a usable ChatGPT session.
 */
function codexTaskAccountStatus(runtimeId: string): Promise<RuntimeAuthenticationStatus> {
  const prepared = prepareCodexHome(runtimeId);
  if (prepared.status !== 0)
    return Promise.resolve({
      state: "unknown",
      detail: "Could not prepare the task-local Codex home",
    });
  return new Promise((resolve) => {
    const child = spawn(
      "sbx",
      [
        "exec",
        "--interactive",
        runtimeId,
        "env",
        "-u",
        "OPENAI_API_KEY",
        CODEX_TASK_HOME_ENV,
        "codex",
        ...CODEX_CHATGPT_CONFIG_ARGS,
        "app-server",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const initializeId = "boxers-initialize";
    const accountId = "boxers-account";
    let stdout = "";
    let stderr = "";
    let settled = false;
    let initialized = false;
    let timer: ReturnType<typeof setTimeout>;
    child.stdin.on("error", () => {
      // A short-lived or older app-server may close stdin while the probe is
      // being written. Its close/error result below owns the diagnostic.
    });
    const write = (message: unknown): void => {
      if (!settled && child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const finish = (status: RuntimeAuthenticationStatus): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      resolve(status);
    };
    const inspectLine = (line: string): void => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (!message || typeof message !== "object") return;
      const response = message as {
        id?: unknown;
        result?: { account?: unknown };
        error?: { message?: unknown };
      };
      if (response.id === initializeId && !initialized) {
        if (response.error) {
          finish({ state: "unknown", detail: "Codex account probe initialization failed" });
          return;
        }
        initialized = true;
        write({ method: "initialized", params: {} });
        write({ method: "account/read", id: accountId, params: { refreshToken: false } });
        return;
      }
      if (response.id !== accountId) return;
      if (response.error) {
        const detail =
          typeof response.error.message === "string"
            ? response.error.message
            : "Codex could not read the task-local account";
        finish({ state: "unknown", detail });
        return;
      }
      const account = response.result?.account;
      if (account === null || account === undefined) {
        finish({ state: "missing", detail: "no task-local Codex login is stored" });
        return;
      }
      const type =
        account && typeof account === "object" && "type" in account
          ? String((account as { type: unknown }).type)
          : "account";
      finish({
        state: "ready",
        detail: `task-local Codex ${type === "chatgpt" ? "ChatGPT" : type} account is stored`,
        ...(prepared.stdout.trim() === "imported" ? { restartRequired: true } : {}),
      });
    };
    const consume = (): void => {
      for (;;) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) return;
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        inspectLine(line);
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      consume();
    });
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) =>
      finish({
        state: "unknown",
        detail: `could not start the Codex account probe: ${error.message}`,
      }),
    );
    child.on("close", () => {
      if (settled) return;
      if (stdout.trim()) inspectLine(stdout.trim());
      if (!settled)
        finish({
          state: "unknown",
          detail: (stderr || "Codex did not answer the task-local account probe").trim(),
        });
    });
    timer = setTimeout(
      () => finish({ state: "unknown", detail: "Codex account read timed out" }),
      CODEX_ACCOUNT_TIMEOUT_MS,
    );
    write({
      method: "initialize",
      id: initializeId,
      params: { clientInfo: { name: "boxers", title: "Boxers", version: "1" } },
    });
  });
}

export function dockerLoginDiagnostic(output: string): RuntimeDiagnostic {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return {
      component: "runtime.docker-login",
      status: "failed",
      detail: "authentication status was not reported by sbx diagnose",
    };
  }
  const checks = (parsed as { checks?: unknown }).checks;
  const authentication = Array.isArray(checks)
    ? checks.find((check): check is { status: string; message?: string; detail?: string } =>
        Boolean(
          check &&
          typeof check === "object" &&
          "name" in check &&
          typeof check.name === "string" &&
          check.name.toLowerCase() === "authentication" &&
          "status" in check &&
          typeof check.status === "string",
        ),
      )
    : undefined;
  if (!authentication)
    return {
      component: "runtime.docker-login",
      status: "failed",
      detail: "authentication status was not reported by sbx diagnose",
    };

  const status = authentication.status.toLowerCase();
  const detail = [authentication.message, authentication.detail]
    .map((value) => value?.trim())
    .filter(Boolean)
    .join(": ");
  return {
    component: "runtime.docker-login",
    status: status === "pass" ? "ok" : status === "warn" ? "warning" : "failed",
    detail: detail || status,
    ...(status === "fail"
      ? {
          remediation: {
            kind: "command" as const,
            value: "sbx login",
            interactive: true,
          },
        }
      : {}),
  };
}

export class DockerSandboxesRuntime implements TaskRuntime {
  readonly kind = "docker-sandboxes";
  readonly #taskLocalAuthentication = new Set<string>();

  capabilities(): RuntimeCapabilities {
    return {
      durableWorkspace: true,
      durableAgentSession: true,
      cloneIsolation: true,
      publishedPorts: true,
      lifecycleEvents: false,
      suspension: true,
    };
  }

  diagnose(options: RuntimeDiagnosticOptions = {}): RuntimeDiagnostic[] {
    const host = hostDiagnostic();
    const result = command("sbx", ["version"]);
    const version =
      result.status === 0 ? parseVersion(`${result.stdout}\n${result.stderr}`) : undefined;
    const installed = Boolean(version && versionAtLeast(version, MIN_SBX_VERSION));
    const diagnostics: RuntimeDiagnostic[] = [
      host,
      {
        component: "runtime.docker-sandboxes",
        status: installed ? "ok" : "failed",
        detail: version
          ? `version ${version.join(".")}`
          : (result.stderr || "not installed").trim(),
        ...(installed
          ? {}
          : {
              remediation: {
                kind: "url" as const,
                value: "https://docs.docker.com/ai/sandboxes/install/",
              },
            }),
      },
    ];
    if (!installed) return diagnostics;

    const diagnose = command("sbx", ["diagnose", "--output", "json"]);
    diagnostics.push({
      component: "runtime.health",
      status: diagnose.status === 0 ? "ok" : "failed",
      detail:
        diagnose.status === 0 ? "diagnostics passed" : (diagnose.stderr || diagnose.stdout).trim(),
    });
    diagnostics.push(dockerLoginDiagnostic(diagnose.stdout));

    const policy = command("sbx", ["policy", "ls", "--type", "network", "--json"]);
    const policyText = policy.stdout.trim();
    const initialized =
      policy.status === 0 &&
      Boolean(policyText && policyText !== "[]" && policyText !== "null" && policyText !== "{}");
    const open = initialized && /allow-all|"\*\*"|resource[^\n]*\*\*/i.test(policyText);
    diagnostics.push({
      component: "runtime.network-policy",
      status: !initialized ? "failed" : open && !options.acknowledgeOpenNetwork ? "warning" : "ok",
      detail: !initialized ? "uninitialized" : open ? "open" : "initialized",
      ...(!initialized
        ? {
            remediation: {
              kind: "manual" as const,
              value: "Initialize the Docker Sandboxes network policy.",
            },
          }
        : {}),
    });

    const secrets = command("sbx", ["secret", "ls", "--global"]);
    const services = configuredServices(secrets.stdout);
    const agents = options.agent ? [options.agent] : (["codex", "claude"] as const);
    for (const agent of agents) {
      const provider = agent === "codex" ? "openai" : "anthropic";
      const credentialAvailable = services.includes(provider);
      diagnostics.push({
        component: `runtime.credential.${agent}`,
        status: secrets.status !== 0 ? "warning" : credentialAvailable ? "ok" : "failed",
        detail:
          secrets.status !== 0
            ? (
                secrets.stderr ||
                secrets.stdout ||
                `could not inspect ${provider} credentials`
              ).trim()
            : credentialAvailable
              ? `${provider} host credential is stored for new ${agent} tasks (validity is checked only by the provider when a task starts)`
              : `${provider} host credential is not configured for new ${agent} tasks`,
        ...(secrets.status === 0 && !credentialAvailable
          ? {
              remediation: {
                kind: "manual" as const,
                value: `Create or attach to an interactive ${agent} task to sign in there.`,
                interactive: true,
              },
            }
          : {}),
      });
    }
    return diagnostics;
  }

  globalCredentialServices(): string[] {
    const result = command("sbx", ["secret", "ls", "--global"]);
    return configuredServices(
      requireSuccess(result, "Could not inspect global Docker Sandbox credentials"),
    );
  }

  authenticateGlobal(agent: TaskManifest["agent"], mode: RuntimeAuthMode): number {
    const service = agent === "codex" ? "openai" : "anthropic";
    const args = [
      "secret",
      "set",
      service,
      ...(agent === "codex" && mode === "oauth" ? ["--oauth"] : []),
    ];
    return command("sbx", args, { stdio: "inherit" }).status;
  }

  authenticateSubscription(runtimeId: string, agent: TaskManifest["agent"]): void {
    if (agent === "codex")
      requireSuccess(prepareCodexHome(runtimeId), "Could not prepare the task-local Codex home");
    const result =
      agent === "codex"
        ? command(
            "sbx",
            [
              "exec",
              "--interactive",
              "--tty",
              runtimeId,
              "env",
              "-u",
              "OPENAI_API_KEY",
              CODEX_TASK_HOME_ENV,
              "codex",
              ...CODEX_CHATGPT_CONFIG_ARGS,
              "login",
              "--device-auth",
            ],
            { stdio: "inherit" },
          )
        : command(
            "sbx",
            [
              "exec",
              "--interactive",
              "--tty",
              runtimeId,
              "env",
              "-u",
              "ANTHROPIC_API_KEY",
              "claude",
              "auth",
              "login",
              "--claudeai",
            ],
            { stdio: "inherit" },
          );
    if (result.status !== 0)
      throw new Error(
        `${agent === "codex" ? "Codex device" : "Claude subscription"} authentication was not completed.`,
      );
  }

  create(spec: TaskEnvironmentSpec): RuntimeHandle {
    const task = {
      runtime: { kind: this.kind, id: spec.id },
      agent: spec.agent,
      ...(spec.template ? { template: spec.template } : {}),
    } as TaskManifest;
    createSandbox(task, spec.seedPath);
    return { kind: this.kind, id: spec.id };
  }

  inventory(): RuntimeInfo[] {
    return listSandboxes().map((item) => ({
      kind: this.kind,
      id: item.name,
      state: normalizeState(item.status),
      rawState: item.status,
      ...(item.ports !== undefined ? { ports: item.ports } : {}),
    }));
  }

  async inventoryAsync(): Promise<RuntimeInfo[]> {
    return (await listSandboxesAsync()).map((item) => ({
      kind: this.kind,
      id: item.name,
      state: normalizeState(item.status),
      rawState: item.status,
      ...(item.ports !== undefined ? { ports: item.ports } : {}),
    }));
  }

  ensureAvailable(task: TaskManifest): void {
    const id = runtimeId(task);
    const info = listSandboxes().find((item) => item.name === id);
    if (isRunning(info)) return;
    const result = sbx(["exec", id, "true"]);
    if (result.status !== 0)
      throw new Error(
        `Could not start task runtime ${task.name}: ${(result.stderr || result.stdout).trim()}`,
      );
  }

  execute(task: TaskManifest, args: readonly string[]) {
    return sbx(["exec", runtimeId(task), ...args]);
  }

  executeAsync(task: TaskManifest, args: readonly string[]) {
    return sbxAsync(["exec", runtimeId(task), ...args]);
  }

  executeWithInput(task: TaskManifest, args: readonly string[], input: string) {
    return commandWithInput("sbx", ["exec", runtimeId(task), ...args], input);
  }

  executeStreaming(task: TaskManifest, script: string, options = {}) {
    return runSandboxShellStreaming(dockerTask(task), script, options);
  }

  executeStreamingAt(task: TaskManifest, directory: string, script: string, options = {}) {
    return runSandboxShellStreamingAt(dockerTask(task), directory, script, options);
  }

  runSetup(task: TaskManifest, setupCommand: string, options = {}) {
    return runSandboxSetupStreaming(dockerTask(task), setupCommand, options);
  }

  startJob(task: TaskManifest, request: RuntimeJobRequest): void {
    startSandboxJob(dockerTask(task), request);
  }

  inspectJob(task: TaskManifest, jobId: string) {
    return inspectSandboxJob(dockerTask(task), jobId);
  }

  jobLogs(task: TaskManifest, jobId: string) {
    return sandboxJobLogs(dockerTask(task), jobId);
  }

  cancelJob(task: TaskManifest, jobId: string): boolean {
    return cancelSandboxJob(dockerTask(task), jobId);
  }

  publishPorts(task: TaskManifest, ports: readonly number[]): string[] {
    return publishPorts(dockerTask(task), ports);
  }

  publishedUrls(task: TaskManifest): string[] {
    return publishedUrls(dockerTask(task));
  }

  workspacePatch(task: TaskManifest, targetOid: string): string {
    return nativeWorkspacePatch(dockerTask(task), targetOid);
  }

  gitStatus(task: TaskManifest, base: string, targetOid: string) {
    return nativeGitStatus(dockerTask(task), base, targetOid);
  }

  workspaceTreeAt(task: TaskManifest, directory: string) {
    return nativeWorkspaceTreeAt(dockerTask(task), directory);
  }

  conflictPaths(task: TaskManifest): string[] {
    return nativeConflictPaths(dockerTask(task));
  }

  reconcileWorkspace(
    task: TaskManifest,
    base: string,
    oldTargetOid: string,
    targetOid: string,
    candidateRef: string,
  ) {
    return reconcileNativeWorkspace(dockerTask(task), base, oldTargetOid, targetOid, candidateRef);
  }

  advanceWorkspace(task: TaskManifest, base: string, integratedCommit: string): boolean {
    return advanceNativeWorkspace(dockerTask(task), base, integratedCommit);
  }

  runShell(task: TaskManifest, script: string) {
    return runSandboxShell(dockerTask(task), script);
  }

  startPreview(task: TaskManifest, run: string) {
    return startNativePreview(dockerTask(task), run);
  }

  stopPreview(task: TaskManifest, jobId: string): boolean {
    return stopNativePreview(dockerTask(task), jobId);
  }

  previewLogs(task: TaskManifest, jobId: string) {
    return nativePreviewLogs(dockerTask(task), jobId);
  }

  openShell(task: TaskManifest): number {
    return shellSandbox(dockerTask(task));
  }

  suspend(task: TaskManifest): void {
    stopSandbox(dockerTask(task));
  }

  async agentAuthenticationStatus(task: TaskManifest): Promise<RuntimeAuthenticationStatus> {
    const authentication = harnessForAgent(task.agent).authentication;
    const id = runtimeId(task);
    // Docker owns host OAuth storage, refresh, and the sandbox's provider route.
    // New tasks must reuse that login before considering task-local device auth.
    if (task.agent === "codex") {
      const proxy = externalCredentialStatus(id, "codex");
      if (proxy.state !== "missing") {
        this.#taskLocalAuthentication.delete(id);
        return proxy;
      }
    }
    const taskLocal =
      task.agent === "codex"
        ? await codexTaskAccountStatus(id)
        : (() => {
            const result = command("sbx", [
              "exec",
              id,
              "env",
              "-u",
              "ANTHROPIC_API_KEY",
              ...authentication.statusCommand,
            ]);
            if (result.status === 0)
              return {
                state: "ready" as const,
                detail: "task-local Claude subscription is authenticated",
              };
            const detail = (result.stderr || result.stdout).trim();
            if (
              result.status === 126 ||
              result.status === 127 ||
              /not found|no such sandbox|cannot connect|connection refused/i.test(detail)
            )
              return { state: "unknown" as const, detail };
            return { state: "missing" as const, detail: detail || "no task-local Claude login" };
          })();
    if (taskLocal.state === "ready") {
      this.#taskLocalAuthentication.add(id);
      return taskLocal;
    }
    this.#taskLocalAuthentication.delete(id);
    if (taskLocal.state === "reauth_required" || taskLocal.state === "unknown") return taskLocal;

    const scoped = command("sbx", ["secret", "ls", "--sandbox", id]);
    const native = command("sbx", ["exec", id, ...authentication.statusCommand]);
    if (
      native.status === 0 ||
      (scoped.status === 0 && serviceIsConfigured(scoped.stdout, authentication.service))
    )
      return externalCredentialStatus(id, task.agent);
    const nativeDetail = (native.stderr || native.stdout).trim();
    if (
      scoped.status !== 0 ||
      native.status === 126 ||
      native.status === 127 ||
      /not found|no such sandbox|cannot connect|connection refused/i.test(nativeDetail)
    )
      return {
        state: "unknown",
        detail: nativeDetail || "could not inspect scoped credentials or task-local authentication",
      };
    return {
      state: "missing",
      detail: `no ${authentication.service} proxy credential or task-local ${task.agent} login is available`,
    };
  }

  async assertAgentCredential(task: TaskManifest): Promise<void> {
    const status = await this.agentAuthenticationStatus(task);
    if (status.state === "ready" || status.state === "external_unverified") return;
    throw new Error(
      status.state === "unknown"
        ? `Could not verify ${task.agent} authentication for task ${task.name}: ${status.detail}`
        : `${task.agent} authentication is required for task ${task.name}. Run "boxers ${task.name} attach" from an interactive terminal to sign in.`,
    );
  }

  workspacePath(task: TaskManifest): string {
    return requireSuccess(
      command("sbx", ["exec", runtimeId(task), "pwd", "-P"]),
      `Could not resolve the workspace for ${task.name}`,
    );
  }

  agentLaunchSpec(task: TaskManifest, args: readonly string[]) {
    const taskLocalVariable = task.agent === "codex" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
    return {
      command: "sbx",
      args: [
        "run",
        task.agent,
        "--name",
        runtimeId(task),
        ...(this.#taskLocalAuthentication.has(runtimeId(task))
          ? ["--env", `${taskLocalVariable}=`]
          : []),
        ...(task.agent === "codex" && this.#taskLocalAuthentication.has(runtimeId(task))
          ? ["--env", CODEX_TASK_HOME_ENV]
          : []),
        "--",
        ...(task.agent === "codex" && this.#taskLocalAuthentication.has(runtimeId(task))
          ? CODEX_CHATGPT_CONFIG_ARGS
          : []),
        ...args,
      ],
    };
  }

  destroy(task: TaskManifest): void {
    removeSandbox(dockerTask(task));
  }
}

export const dockerSandboxesRuntime = new DockerSandboxesRuntime();
