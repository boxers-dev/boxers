import { spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { readPackageName, readVersion } from "../core/version.ts";
import { signHostProjection, verifyHostProjection, readFleet } from "./fleet.ts";
import { localMachineIdentity } from "./registry.ts";
import { listRemoteMachines, type RemoteMachine } from "./machines.ts";
import { command, requireSuccess } from "./process.ts";
import type { DoctorResult } from "./commands.ts";
import { installDaemonService } from "./service.ts";
import {
  atomicWriteJson,
  fleetAdminStateLockPath,
  fleetAdminStatePath,
  readJson,
} from "./paths.ts";
import { withPidFileLock } from "./lock.ts";

interface AdminRequestBody {
  fleetId: string;
  requesterHostId: string;
  version: string;
  nonce: string;
  issuedAt: string;
}

interface AdminRequest {
  body: AdminRequestBody;
  signature: string;
}

export function encodeAdminRequest(version: string): string {
  const fleet = readFleet();
  if (!fleet) throw new Error("This host is not enrolled in an Boxers fleet.");
  const body: AdminRequestBody = {
    fleetId: fleet.fleetId,
    requesterHostId: localMachineIdentity().id,
    version,
    nonce: randomUUID(),
    issuedAt: new Date().toISOString(),
  };
  const payload: AdminRequest = {
    body,
    signature: signHostProjection(JSON.stringify(body)),
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeAdminRequest(encoded: string): AdminRequestBody {
  let request: AdminRequest;
  try {
    request = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as AdminRequest;
  } catch {
    throw new Error("Invalid fleet administration request.");
  }
  const fleet = readFleet();
  if (!fleet || request.body?.fleetId !== fleet.fleetId)
    throw new Error("Fleet administration request belongs to another fleet.");
  const requester = fleet.members.find((member) => member.hostId === request.body.requesterHostId);
  if (!requester || !requester.roles.includes("admin"))
    throw new Error("The requesting fleet member is not an administrator.");
  if (
    !request.body.version ||
    !request.body.nonce ||
    !request.body.issuedAt ||
    !verifyHostProjection(JSON.stringify(request.body), request.signature, requester.publicKey)
  )
    throw new Error("Fleet administration request signature is invalid.");
  const issuedAt = Date.parse(request.body.issuedAt);
  if (!Number.isFinite(issuedAt) || Math.abs(Date.now() - issuedAt) > 5 * 60_000)
    throw new Error("Fleet administration request is expired or has an invalid timestamp.");
  const path = fleetAdminStatePath();
  withPidFileLock(fleetAdminStateLockPath(), () => {
    const previous = existsSync(path)
      ? readJson<{ version: 1; nonces: { value: string; expiresAt: string }[] }>(path)
      : { version: 1 as const, nonces: [] };
    if (previous.version !== 1 || !Array.isArray(previous.nonces))
      throw new Error("Fleet administration replay state is invalid.");
    const active = previous.nonces.filter(
      (item) => item && typeof item.value === "string" && Date.parse(item.expiresAt) > Date.now(),
    );
    if (active.some((item) => item.value === request.body.nonce))
      throw new Error("Fleet administration request was already used.");
    active.push({
      value: request.body.nonce,
      expiresAt: new Date(issuedAt + 5 * 60_000).toISOString(),
    });
    atomicWriteJson(path, { version: 1, nonces: active.slice(-1_000) });
  });
  return request.body;
}

function sshCaptured(
  machine: RemoteMachine,
  args: readonly string[],
  timeoutMs = 180_000,
  acceptNonZeroStdout = false,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        "--",
        machine.sshHost,
        machine.executable ?? "boxers",
        ...args,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(stdout);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`Remote operation timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => finish(error));
    child.on("close", (code) =>
      finish(
        code === 0 || (acceptNonZeroStdout && Boolean(stdout.trim()))
          ? undefined
          : new Error((stderr || stdout).trim() || `Remote operation exited ${code ?? 1}.`),
      ),
    );
  });
}

function parseDoctorResult(value: string): DoctorResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Remote doctor returned invalid JSON.");
  }
  if (!parsed || typeof parsed !== "object")
    throw new Error("Remote doctor returned an invalid result.");
  const result = parsed as Partial<DoctorResult>;
  if (
    typeof result.ok !== "boolean" ||
    !Array.isArray(result.warnings) ||
    result.warnings.some((warning) => typeof warning !== "string") ||
    !Array.isArray(result.checks) ||
    result.checks.some((check) => {
      if (
        !check ||
        typeof check !== "object" ||
        typeof check.name !== "string" ||
        typeof check.ok !== "boolean" ||
        typeof check.detail !== "string"
      )
        return true;
      const remediation = check.remediation;
      return Boolean(
        remediation &&
        (typeof remediation !== "object" ||
          !["command", "url", "manual"].includes(String(remediation.kind)) ||
          typeof remediation.value !== "string" ||
          (remediation.privileged !== undefined && typeof remediation.privileged !== "boolean") ||
          (remediation.interactive !== undefined && typeof remediation.interactive !== "boolean")),
      );
    })
  )
    throw new Error("Remote doctor returned an invalid result.");
  return result as DoctorResult;
}

export function acceptManagedUpdate(encoded: string): {
  version: string;
  executable: string;
  daemonRestartRequired: boolean;
} {
  const request = decodeAdminRequest(encoded);
  if (!/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(request.version))
    throw new Error(`Invalid Boxers version ${request.version}.`);
  const dataRoot = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  const installRoot = join(dataRoot, "boxers", "managed", request.version);
  mkdirSync(installRoot, { recursive: true, mode: 0o700 });
  requireSuccess(
    command("npm", [
      "install",
      "--silent",
      "--no-audit",
      "--no-fund",
      "--omit=dev",
      "--prefix",
      installRoot,
      `${readPackageName()}@${request.version}`,
    ]),
    `Could not install Boxers ${request.version}`,
  );
  const executable = join(installRoot, "node_modules", ".bin", "boxers");
  const stable = join(homedir(), ".local", "bin", "boxers");
  activateManagedExecutable(executable, request.version, stable);
  return {
    version: request.version,
    executable: stable,
    daemonRestartRequired: request.version !== readVersion(),
  };
}

export function activateManagedExecutable(
  executable: string,
  expectedVersion: string,
  stable: string,
  installService: (path: string) => unknown = installDaemonService,
): void {
  if (!existsSync(executable))
    throw new Error(`Installed Boxers has no executable at ${executable}.`);
  const installedVersion = requireSuccess(
    command(executable, ["--version"]),
    `Could not validate Boxers ${expectedVersion}`,
  ).trim();
  if (installedVersion !== expectedVersion)
    throw new Error(
      `Installed Boxers reported ${installedVersion || "no version"}, expected ${expectedVersion}.`,
    );
  mkdirSync(dirname(stable), { recursive: true, mode: 0o700 });
  const temporary = `${stable}.${process.pid}.${randomUUID()}.tmp`;
  symlinkSync(executable, temporary);
  try {
    installService(stable);
    renameSync(temporary, stable);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export async function updateFleet(options: {
  host?: string;
  all: boolean;
  version?: string;
}): Promise<number> {
  const version = options.version ?? readVersion();
  const normalized = options.host?.toLowerCase();
  const machines = listRemoteMachines().filter(
    (machine) =>
      options.all ||
      (normalized !== undefined &&
        (machine.id.toLowerCase() === normalized ||
          machine.name.toLowerCase() === normalized ||
          machine.sshHost.toLowerCase() === normalized)),
  );
  if (!machines.length)
    throw new Error(
      options.all ? "No remote fleet hosts are registered." : `Unknown host "${options.host}".`,
    );
  const request = encodeAdminRequest(version);
  const results = await Promise.all(
    machines.map(async (machine) => {
      try {
        const result = JSON.parse(await sshCaptured(machine, ["remote", "update", request])) as {
          version?: unknown;
          executable?: unknown;
          daemonRestartRequired?: unknown;
        };
        if (
          result.version !== version ||
          typeof result.executable !== "string" ||
          (result.daemonRestartRequired !== undefined &&
            typeof result.daemonRestartRequired !== "boolean")
        )
          throw new Error("Remote returned an invalid update result.");
        return {
          machine,
          ok: true as const,
          executable: result.executable,
          daemonRestartRequired: result.daemonRestartRequired === true,
        };
      } catch (error) {
        return {
          machine,
          ok: false as const,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  for (const result of results)
    process.stdout.write(
      result.ok
        ? `Updated ${result.machine.name} to Boxers ${version}${result.daemonRestartRequired ? "; daemon restart deferred until active sessions are safe to hand off" : ""}.\n`
        : `FAILED  ${result.machine.name}: ${result.error}\n`,
    );
  return results.every((result) => result.ok) ? 0 : 1;
}

export async function doctorFleet(
  local: DoctorResult,
  options: {
    host?: string;
    all: boolean;
    json: boolean;
    agent?: "codex" | "claude";
    acknowledgeOpenNetwork: boolean;
  },
): Promise<number> {
  const normalized = options.host?.toLowerCase();
  const machines = listRemoteMachines().filter(
    (machine) =>
      options.all ||
      (normalized !== undefined &&
        (machine.id.toLowerCase() === normalized ||
          machine.name.toLowerCase() === normalized ||
          machine.sshHost.toLowerCase() === normalized)),
  );
  if (options.host && !machines.length) throw new Error(`Unknown host "${options.host}".`);
  const results = await Promise.all(
    machines.map(async (machine) => {
      try {
        return {
          machine,
          result: parseDoctorResult(
            await sshCaptured(
              machine,
              [
                "doctor",
                "--json",
                ...(options.agent ? ["--agent", options.agent] : []),
                ...(options.acknowledgeOpenNetwork ? ["--acknowledge-open-network"] : []),
              ],
              30_000,
              true,
            ),
          ),
        };
      } catch (error) {
        return { machine, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
  if (options.json) process.stdout.write(`${JSON.stringify({ local, remotes: results })}\n`);
  else {
    const print = (name: string, result: DoctorResult): void => {
      process.stdout.write(`${name}\n`);
      for (const check of result.checks) {
        process.stdout.write(`  ${check.ok ? "ok" : "FAIL"}  ${check.name}: ${check.detail}\n`);
        if (check.remediation)
          process.stdout.write(
            `        remediation (${check.remediation.kind}): ${check.remediation.value}\n`,
          );
      }
      for (const warning of result.warnings) process.stderr.write(`  warning: ${warning}\n`);
    };
    print("local", local);
    for (const item of results) {
      if ("result" in item) print(item.machine.name, item.result);
      else process.stderr.write(`${item.machine.name}\n  FAIL  connection: ${item.error}\n`);
    }
  }
  return local.ok && results.every((item) => "result" in item && item.result.ok) ? 0 : 1;
}
