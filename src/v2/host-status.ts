import { existsSync } from "node:fs";
import { humanTimestamp } from "../core/time.ts";
import { readVersion } from "../core/version.ts";
import { DAEMON_PROTOCOL_VERSION } from "./daemon-protocol.ts";
import { atomicWriteJson, hostStatusPath, readJson } from "./paths.ts";
import { command } from "./process.ts";
import { defaultRuntime } from "./runtime/registry.ts";
import type { RuntimeDiagnostic, RuntimeDiagnosticOptions } from "./runtime/types.ts";
import { daemonServiceStatus, type DaemonServiceStatus } from "./service.ts";
import { activeManagedBuildId } from "./release.ts";
import type {
  Agent,
  AuthenticationStatus,
  HostStatusCheck,
  HostStatusObservation,
} from "./types.ts";

export function daemonStatusChecks(
  service: DaemonServiceStatus,
  cliVersion = readVersion(),
  managedBuildId: string | null | undefined = activeManagedBuildId(),
): HostStatusCheck[] {
  const serviceReady = !service.supported || (service.installed && service.enabled);
  const buildReady =
    managedBuildId === null ||
    managedBuildId === undefined ||
    service.boxersBuildId === managedBuildId;
  const protocolReady =
    service.active &&
    service.protocolVersion === DAEMON_PROTOCOL_VERSION &&
    service.boxersVersion === cliVersion &&
    buildReady;
  return [
    {
      id: "daemon.process",
      category: "health",
      status: service.active ? "ok" : "warning",
      detail: service.active
        ? `active${service.pid === undefined ? "" : ` (pid ${service.pid})`}${service.startedAt ? ` since ${humanTimestamp(service.startedAt)}` : ""}`
        : "inactive",
      ...(!service.active
        ? {
            remediation: {
              kind: "manual" as const,
              value: "The next task attach or lifecycle command starts the daemon automatically.",
            },
          }
        : {}),
    },
    {
      id: "daemon.service",
      category: "health",
      status: serviceReady ? "ok" : "failed",
      detail: service.detail,
      ...(!serviceReady && service.supported
        ? { remediation: { kind: "command" as const, value: "boxers daemon install" } }
        : {}),
    },
    {
      id: "daemon.protocol",
      category: "health",
      status: service.active ? (protocolReady ? "ok" : "failed") : "unknown",
      detail: service.active
        ? `protocol ${service.protocolVersion ?? "unknown"}; daemon ${service.boxersVersion ?? "unknown"}; CLI ${cliVersion}${managedBuildId && service.boxersBuildId !== managedBuildId ? `; daemon build ${service.boxersBuildId?.slice(0, 8) ?? "unknown"}; active build ${managedBuildId.slice(0, 8)}` : ""}`
        : "unavailable while daemon is inactive",
      ...(service.active && !protocolReady
        ? {
            remediation: {
              kind: "manual" as const,
              value:
                "Run `boxers daemon status`; if it reports no running sessions or intents, run `boxers daemon stop`. If the daemon is unresponsive and interrupting daemon-owned work is acceptable, run `boxers daemon stop --force`. The next daemon-backed command starts the current version automatically.",
            },
          }
        : {}),
    },
  ];
}

function diagnosticCheck(diagnostic: RuntimeDiagnostic): HostStatusCheck {
  return {
    id: diagnostic.component,
    category: diagnostic.component.startsWith("runtime.credential.") ? "authentication" : "health",
    status: diagnostic.status,
    detail: diagnostic.detail,
    ...(diagnostic.remediation ? { remediation: diagnostic.remediation } : {}),
  };
}

function authenticationStatus(
  checks: readonly HostStatusCheck[],
  agent: Agent,
): AuthenticationStatus {
  const check = checks.find((candidate) => candidate.id === `runtime.credential.${agent}`);
  if (!check || check.status === "unknown" || check.status === "warning") return "unknown";
  return check.status === "ok" ? "configured" : "missing";
}

export function collectHostStatus(
  options: Pick<RuntimeDiagnosticOptions, "acknowledgeOpenNetwork"> = {},
): HostStatusObservation {
  const checks = daemonStatusChecks(daemonServiceStatus());
  for (const diagnostic of defaultRuntime().diagnose(options))
    checks.push(diagnosticCheck(diagnostic));
  const git = command("git", ["--version"]);
  checks.push({
    id: "git",
    category: "health",
    status: git.status === 0 ? "ok" : "failed",
    detail: (git.stdout || git.stderr || "not installed").trim(),
  });
  if (git.status === 0) {
    for (const [key, id] of [
      ["user.name", "git.user-name"],
      ["user.email", "git.user-email"],
    ] as const) {
      const configured = command("git", ["config", "--global", "--get", key]);
      checks.push({
        id,
        category: "health",
        status: configured.status === 0 && Boolean(configured.stdout.trim()) ? "ok" : "failed",
        detail:
          configured.status === 0 && configured.stdout.trim()
            ? configured.stdout.trim()
            : `${key} is not configured globally`,
        ...(configured.status === 0 && configured.stdout.trim()
          ? {}
          : {
              remediation: {
                kind: "command" as const,
                value: `git config --global ${key} <value>`,
              },
            }),
      });
    }
  }
  const healthChecks = checks.filter((check) => check.category === "health");
  const health = healthChecks.some((check) => check.status === "failed")
    ? "unhealthy"
    : healthChecks.some((check) => check.status === "warning")
      ? "degraded"
      : healthChecks.some((check) => check.status === "unknown")
        ? "unknown"
        : "healthy";
  const observation: HostStatusObservation = {
    version: 1,
    observedAt: new Date().toISOString(),
    boxersVersion: readVersion(),
    health,
    daemon:
      checks.find((check) => check.id === "daemon.process")?.status === "ok"
        ? "running"
        : "stopped",
    authentication: {
      codex: authenticationStatus(checks, "codex"),
      claude: authenticationStatus(checks, "claude"),
    },
    checks,
  };
  atomicWriteJson(hostStatusPath(), observation);
  return observation;
}

export function readHostStatus(): HostStatusObservation | undefined {
  const path = hostStatusPath();
  if (!existsSync(path)) return undefined;
  try {
    const status = readJson<HostStatusObservation>(path);
    return isHostStatusObservation(status) ? status : undefined;
  } catch {
    return undefined;
  }
}

export function isHostStatusObservation(value: unknown): value is HostStatusObservation {
  if (!value || typeof value !== "object") return false;
  const status = value as Partial<HostStatusObservation>;
  return (
    status.version === 1 &&
    typeof status.observedAt === "string" &&
    typeof status.boxersVersion === "string" &&
    ["healthy", "degraded", "unhealthy", "unknown"].includes(String(status.health)) &&
    ["running", "stopped", "unknown"].includes(String(status.daemon)) &&
    Boolean(
      status.authentication &&
      ["configured", "missing", "unknown"].includes(status.authentication.codex) &&
      ["configured", "missing", "unknown"].includes(status.authentication.claude),
    ) &&
    Array.isArray(status.checks) &&
    status.checks.every(
      (check) =>
        check &&
        typeof check.id === "string" &&
        (check.category === "health" || check.category === "authentication") &&
        ["ok", "warning", "failed", "unknown"].includes(check.status) &&
        typeof check.detail === "string" &&
        (check.remediation === undefined ||
          (check.remediation !== null &&
            typeof check.remediation === "object" &&
            ["command", "url", "manual"].includes(String(check.remediation.kind)) &&
            typeof check.remediation.value === "string" &&
            (check.remediation.privileged === undefined ||
              typeof check.remediation.privileged === "boolean") &&
            (check.remediation.interactive === undefined ||
              typeof check.remediation.interactive === "boolean"))),
    )
  );
}
