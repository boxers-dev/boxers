import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readPackageName } from "../core/version.ts";
import { signHostProjection, verifyHostProjection, readFleet } from "./fleet.ts";
import { localMachineIdentity } from "./registry.ts";
import { listRemoteMachines, type RemoteMachine } from "./machines.ts";
import type { DoctorResult } from "./commands.ts";
import {
  atomicWriteJson,
  fleetAdminStateLockPath,
  fleetAdminStatePath,
  readJson,
} from "./paths.ts";
import { withPidFileLock } from "./lock.ts";
import { captureSsh } from "./ssh-transport.ts";
import { officialReleaseCapsule } from "./release.ts";
import { activateHostRelease } from "./host-release.ts";

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
  timeout = 180_000,
  acceptNonZeroStdout = false,
): Promise<string> {
  return captureSsh(machine.sshHost, args, { timeout, acceptNonZeroStdout });
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

/** Legacy wire request; installation and activation use the current shared path. */
export async function acceptManagedUpdate(encoded: string) {
  const request = decodeAdminRequest(encoded);
  const installed = await activateHostRelease(
    officialReleaseCapsule(readPackageName(), request.version),
  );
  return {
    version: installed.manifest.packageVersion,
    executable: installed.stableExecutable,
    daemonRestartRequired: installed.daemonReplacementRequired,
  };
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
