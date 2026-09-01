import { arch, platform, release } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { MIN_SBX_VERSION, type TaskManifest } from "../types.ts";
import { command, commandWithInput, requireSuccess } from "../process.ts";
import {
  createSandbox,
  advanceNativeWorkspace,
  isRunning,
  listSandboxes,
  listSandboxesAsync,
  nativeConflictPaths,
  nativeGitStatus,
  nativePreviewLogs,
  nativeWorkspaceTreeAt,
  prepareNativeCheckWorkspace,
  nativeWorkspacePatch,
  publishPorts,
  publishedUrls,
  reconcileNativeWorkspace,
  removeSandbox,
  runSandboxShell,
  runSandboxShellStreaming,
  runSandboxShellStreamingAt,
  runSandboxSetupStreaming,
  sbx,
  sbxAsync,
  shellSandbox,
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
  TaskEnvironmentSpec,
  TaskRuntime,
  RuntimeAuthMode,
} from "./types.ts";

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

    const secrets = command("sbx", ["secret", "ls"]);
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
              ? `${provider} is configured globally`
              : `${provider} is not configured globally`,
        ...(secrets.status === 0 && !credentialAvailable
          ? {
              remediation: {
                kind: "command" as const,
                value: `boxers auth ${agent}`,
                interactive: true,
              },
            }
          : {}),
      });
    }
    return diagnostics;
  }

  globalCredentialServices(): string[] {
    const result = command("sbx", ["secret", "ls"]);
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
    const result =
      agent === "codex"
        ? command("sbx", ["exec", runtimeId, "codex", "login", "--device-auth"], {
            stdio: "inherit",
          })
        : command("sbx", ["run", "--name", runtimeId], { stdio: "inherit" });
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

  prepareCheckWorkspace(
    task: TaskManifest,
    base: string,
    targetOid: string,
    candidateTreeOid: string,
    candidatePatch: string,
  ) {
    return prepareNativeCheckWorkspace(
      dockerTask(task),
      base,
      targetOid,
      candidateTreeOid,
      candidatePatch,
    );
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

  startPreview(task: TaskManifest, run: string): void {
    startNativePreview(dockerTask(task), run);
  }

  stopPreview(task: TaskManifest): void {
    stopNativePreview(dockerTask(task));
  }

  previewLogs(task: TaskManifest) {
    return nativePreviewLogs(dockerTask(task));
  }

  openShell(task: TaskManifest): number {
    return shellSandbox(dockerTask(task));
  }

  suspend(task: TaskManifest): void {
    stopSandbox(dockerTask(task));
  }

  assertAgentCredential(task: TaskManifest): void {
    const service = task.agent === "codex" ? "openai" : "anthropic";
    const id = runtimeId(task);
    const scoped = command("sbx", ["secret", "ls", id]);
    if (scoped.status !== 0)
      throw new Error(
        `Could not inspect task runtime credentials: ${(scoped.stderr || scoped.stdout).trim()}`,
      );
    const services = [
      ...new Set([...this.globalCredentialServices(), ...configuredServices(scoped.stdout)]),
    ];
    if (!services.includes(service))
      throw new Error(
        `The ${service} credential is not available to task runtime ${id}. Run "boxers auth ${task.agent}".`,
      );
  }

  workspacePath(task: TaskManifest): string {
    return requireSuccess(
      command("sbx", ["exec", runtimeId(task), "pwd", "-P"]),
      `Could not resolve the workspace for ${task.name}`,
    );
  }

  agentLaunchSpec(task: TaskManifest, args: readonly string[]) {
    return {
      command: "sbx",
      args: ["run", task.agent, "--name", runtimeId(task), "--", ...args],
    };
  }

  destroy(task: TaskManifest): void {
    removeSandbox(dockerTask(task));
  }
}

export const dockerSandboxesRuntime = new DockerSandboxesRuntime();
