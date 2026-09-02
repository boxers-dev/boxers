import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { isDeepStrictEqual } from "node:util";
import { localMachineIdentity } from "./registry.ts";
import { readFleet } from "./fleet.ts";
import {
  acknowledgeFleetRelease,
  createFleetReleaseIntent,
  fleetReleaseIsAcknowledged,
  mergeFleetUpdateState,
  readFleetUpdateState,
  recordFleetReleaseFailure,
  type FleetUpdateState,
} from "./fleet-update.ts";
import {
  activeReleaseBuildId,
  cachedReleaseCapsule,
  createReleaseCapsule,
  decodeReleaseCapsule,
  installReleaseCapsule,
  stableExecutablePath,
} from "./release.ts";
import { listRemoteMachines, type RemoteMachine } from "./machines.ts";
import { managedSshArgs } from "./ssh-transport.ts";
import { reconcileManagedPeerAuthorizations } from "./ssh-identity.ts";
import { installDaemonService } from "./service.ts";
import { command, requireSuccess } from "./process.ts";
import { encodeAdminRequest } from "./fleet-admin.ts";
import { readVersion } from "../core/version.ts";
import { gossipFleetMembership } from "./fleet-connect.ts";
import { boxersHome } from "./paths.ts";

const REMOTE_UPDATE_TIMEOUT_MS = 5 * 60_000;
const MAX_REMOTE_CAPSULE_BYTES = 64 * 1024 * 1024;

export interface RemoteReleaseResult {
  version: 1;
  hostId: string;
  buildId: string;
  packageVersion: string;
  runtimeInstalled: boolean;
  daemonReplacementRequired: boolean;
  update: FleetUpdateState;
}

function encodeUpdateState(state: FleetUpdateState): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

function decodeUpdateState(encoded: string): FleetUpdateState {
  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as FleetUpdateState;
  } catch {
    throw new Error("Invalid Boxers fleet release state.");
  }
}

function finalizeManagedActivation(packageVersion: string, buildId: string): boolean {
  const fleet = readFleet();
  if (fleet)
    reconcileManagedPeerAuthorizations(
      fleet.members,
      fleet.removedMembers ?? [],
      stableExecutablePath(),
    );
  try {
    const service = installDaemonService(stableExecutablePath());
    return Boolean(
      service.active &&
      (service.boxersVersion !== packageVersion || service.boxersBuildId !== buildId),
    );
  } catch {
    // Unsupported service managers use the lazily started daemon path.
    return true;
  }
}

function scheduleDaemonReplacement(buildId: string): void {
  const child = spawn(stableExecutablePath(), ["__daemon-replace", buildId], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, BOXERS_HOME: boxersHome() },
  });
  child.on("error", () => undefined);
  child.unref();
}

function activateDesiredRelease(capsule: Buffer): RemoteReleaseResult {
  const state = readFleetUpdateState();
  const desired = state.desired;
  if (!desired) throw new Error("The fleet has no desired Boxers release.");
  if (
    !desired.body.allowDowngrade &&
    newerRelease(readVersion(), desired.body.release.packageVersion)
  )
    throw new Error(
      `Refusing to downgrade this host from Boxers ${readVersion()} to ${desired.body.release.packageVersion} without an explicit fleet confirmation.`,
    );
  const decoded = decodeReleaseCapsule(capsule);
  if (!isDeepStrictEqual(decoded.manifest, desired.body.release))
    throw new Error("The streamed Boxers release does not match the fleet's desired manifest.");
  const installed = installReleaseCapsule(capsule);
  const daemonReplacementRequired = finalizeManagedActivation(
    installed.manifest.packageVersion,
    installed.manifest.buildId,
  );
  if (daemonReplacementRequired) scheduleDaemonReplacement(installed.manifest.buildId);
  const update = acknowledgeFleetRelease();
  return {
    version: 1,
    hostId: localMachineIdentity().id,
    buildId: installed.manifest.buildId,
    packageVersion: installed.manifest.packageVersion,
    runtimeInstalled: installed.runtimeInstalled,
    daemonReplacementRequired,
    update,
  };
}

export function acceptFleetRelease(
  encodedState: string,
  capsule: Buffer = readFileSync(0),
): RemoteReleaseResult {
  mergeFleetUpdateState(decodeUpdateState(encodedState));
  try {
    return activateDesiredRelease(capsule);
  } catch (error) {
    try {
      recordFleetReleaseFailure(error instanceof Error ? error.message : String(error));
    } catch {
      // Preserve the installation error if update state itself became unavailable.
    }
    throw error;
  }
}

export function exportFleetRelease(buildId: string): Buffer {
  return cachedReleaseCapsule(buildId);
}

export function fetchFleetRelease(machine: RemoteMachine, buildId: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ssh",
      managedSshArgs(machine.sshHost, ["remote", "export-release", buildId]),
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks));
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`Fetching Boxers from ${machine.name} timed out.`));
    }, REMOTE_UPDATE_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REMOTE_CAPSULE_BYTES) {
        child.kill("SIGTERM");
        finish(new Error(`The Boxers release from ${machine.name} exceeded the size limit.`));
      } else chunks.push(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => finish(error));
    child.on("close", (code) =>
      finish(
        code === 0
          ? undefined
          : new Error(stderr.trim() || `Fetching Boxers from ${machine.name} exited ${code ?? 1}.`),
      ),
    );
  });
}

export async function reconcileFleetRelease(): Promise<{
  status: "none" | "current" | "updated" | "pending";
  detail?: string;
}> {
  let state = readFleetUpdateState();
  const desired = state.desired;
  if (!desired) return { status: "none" };
  const localId = localMachineIdentity().id;
  let status: "current" | "updated" = "current";
  if (!fleetReleaseIsAcknowledged(localId, state)) {
    const available = new Set(
      state.acknowledgements
        .filter((acknowledgement) => acknowledgement.body.status === "installed")
        .map((acknowledgement) => acknowledgement.body.hostId),
    );
    const sources = listRemoteMachines().filter((machine) => available.has(machine.id));
    if (!sources.length)
      return {
        status: "pending",
        detail: "no connected fleet member has the desired release",
      };
    const failures: string[] = [];
    for (const source of sources) {
      try {
        const capsule = await fetchFleetRelease(source, desired.body.release.buildId);
        activateDesiredRelease(capsule);
        status = "updated";
        state = readFleetUpdateState();
        break;
      } catch (error) {
        failures.push(`${source.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!fleetReleaseIsAcknowledged(localId, state)) {
      try {
        recordFleetReleaseFailure(failures.join("; "));
      } catch {
        // A concurrent fleet change may have superseded the desired release.
      }
      return { status: "pending", detail: failures.join("; ") };
    }
  }

  const fleet = readFleet();
  const localMember = fleet?.members.find((member) => member.hostId === localId);
  if (!localMember?.roles.includes("admin")) return { status };
  const pending = listRemoteMachines().filter(
    (machine) => !fleetReleaseIsAcknowledged(machine.id, state),
  );
  if (!pending.length) return { status };
  const capsule = cachedReleaseCapsule(desired.body.release.buildId);
  const results = await Promise.allSettled(
    pending.map((machine) => sendFleetReleaseWithBootstrap(machine, state, capsule)),
  );
  const failures = results.flatMap((result, index) =>
    result.status === "rejected"
      ? [
          `${pending[index]!.name}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        ]
      : [],
  );
  if (failures.length) {
    return { status, detail: failures.join("; ") };
  }
  return { status };
}

export function sendFleetRelease(
  machine: RemoteMachine,
  state: FleetUpdateState,
  capsule: Buffer,
): Promise<RemoteReleaseResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ssh",
      managedSshArgs(machine.sshHost, ["remote", "install-release", encodeUpdateState(state)]),
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else {
        try {
          const result = JSON.parse(stdout) as RemoteReleaseResult;
          if (
            result?.version !== 1 ||
            result.hostId !== machine.id ||
            result.buildId !== state.desired?.body.release.buildId ||
            !result.update
          )
            throw new Error("Remote returned an invalid Boxers release result.");
          mergeFleetUpdateState(result.update);
          if (!fleetReleaseIsAcknowledged(machine.id))
            throw new Error("Remote returned no valid Boxers release acknowledgement.");
          resolve(result);
        } catch (parseError) {
          reject(parseError instanceof Error ? parseError : new Error(String(parseError)));
        }
      }
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`Updating ${machine.name} timed out.`));
    }, REMOTE_UPDATE_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => finish(error));
    child.on("close", (code) =>
      finish(
        code === 0
          ? undefined
          : new Error((stderr || stdout).trim() || `Updating ${machine.name} exited ${code ?? 1}.`),
      ),
    );
    child.stdin.on("error", () => undefined);
    child.stdin.end(capsule);
  });
}

function bootstrapRemoteProtocol(machine: RemoteMachine, version: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ssh",
      managedSshArgs(machine.sshHost, ["remote", "update", encodeAdminRequest(version)]),
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`Bootstrapping the update protocol on ${machine.name} timed out.`));
    }, REMOTE_UPDATE_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code !== 0)
        finish(
          new Error(
            (stderr || stdout).trim() ||
              `Bootstrapping the update protocol on ${machine.name} exited ${code ?? 1}.`,
          ),
        );
      else finish();
    });
  });
}

async function sendFleetReleaseWithBootstrap(
  machine: RemoteMachine,
  state: FleetUpdateState,
  capsule: Buffer,
): Promise<RemoteReleaseResult> {
  try {
    return await sendFleetRelease(machine, state, capsule);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (!releaseProtocolUnavailable(detail)) throw error;
    await bootstrapRemoteProtocol(machine, state.desired!.body.release.packageVersion);
    return sendFleetRelease(machine, state, capsule);
  }
}

export function releaseProtocolUnavailable(detail: string): boolean {
  return [
    "not available through the Boxers SSH gateway",
    "remote requires a supported protocol command",
    "Unexpected argument for remote install-release",
    "remote install-release accepts no arguments",
  ].some((message) => detail.includes(message));
}

function semverParts(value: string): { numbers: number[]; prerelease?: string } | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) return undefined;
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    ...(match[4] ? { prerelease: match[4] } : {}),
  };
}

export function newerRelease(latest: string, current: string): boolean {
  const left = semverParts(latest);
  const right = semverParts(current);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index++) {
    if (left.numbers[index] !== right.numbers[index])
      return left.numbers[index]! > right.numbers[index]!;
  }
  if (left.prerelease === right.prerelease) return false;
  if (!left.prerelease) return true;
  if (!right.prerelease) return false;
  return (
    left.prerelease.localeCompare(right.prerelease, undefined, {
      numeric: true,
    }) > 0
  );
}

function latestRegistryRelease(packageName: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn("npm", ["view", packageName, "dist-tags.latest", "--json"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    let settled = false;
    const finish = (value?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish();
    }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.on("error", () => finish());
    child.on("close", (code) => {
      if (code !== 0) return finish();
      try {
        const value = JSON.parse(stdout) as unknown;
        finish(typeof value === "string" ? value : undefined);
      } catch {
        finish();
      }
    });
  });
}

function remotePackageVersion(machine: RemoteMachine): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn("ssh", managedSshArgs(machine.sshHost, ["remote", "identity"]), {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    let settled = false;
    const finish = (value?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish();
    }, 12_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.on("error", () => finish());
    child.on("close", (code) => {
      if (code !== 0) return finish();
      try {
        const value = JSON.parse(stdout) as { boxersVersion?: unknown };
        finish(typeof value.boxersVersion === "string" ? value.boxersVersion : undefined);
      } catch {
        finish();
      }
    });
  });
}

async function confirmOfficialUpdate(current: string, latest: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await prompt.question(
      `Boxers ${latest} is available on npm; this machine is running ${current}. Install it before updating the fleet? [Y/n] `,
    );
    return (
      answer.trim() === "" ||
      answer.trim().toLowerCase() === "y" ||
      answer.trim().toLowerCase() === "yes"
    );
  } finally {
    prompt.close();
  }
}

async function confirmFleetDowngrade(
  current: string,
  machines: { machine: RemoteMachine; version: string }[],
): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const summary = machines
      .map(({ machine, version }) => `${machine.name} (${version})`)
      .join(", ");
    const answer = await prompt.question(
      `The active build is Boxers ${current}, but these machines run a newer release: ${summary}. Converge them to the active build? [y/N] `,
    );
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    prompt.close();
  }
}

function installOfficialPackage(packageName: string, version: string): void {
  const temporary = mkdtempSync(join(tmpdir(), "boxers-official-release-"));
  try {
    requireSuccess(
      command("npm", [
        "install",
        "--no-audit",
        "--no-fund",
        "--omit=dev",
        "--package-lock=false",
        "--prefix",
        temporary,
        `${packageName}@${version}`,
      ]),
      `Could not install Boxers ${version}`,
    );
    const installedRoot = join(temporary, "node_modules", ...packageName.split("/"));
    installReleaseCapsule(createReleaseCapsule(installedRoot));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export async function updateFleetRelease(
  options: { skipRegistry?: boolean } = {},
): Promise<number> {
  const capsule = createReleaseCapsule();
  const active = decodeReleaseCapsule(capsule).manifest;
  if (!options.skipRegistry) {
    process.stdout.write("Checking npm for a newer Boxers release…\n");
    const latest = await latestRegistryRelease(active.packageName);
    if (latest && newerRelease(latest, active.packageVersion)) {
      if (await confirmOfficialUpdate(active.packageVersion, latest)) {
        process.stdout.write(`Installing Boxers ${latest} on this machine…\n`);
        installOfficialPackage(active.packageName, latest);
        const continued = spawnSync(stableExecutablePath(), ["__update-continue"], {
          stdio: "inherit",
        });
        return continued.status ?? 1;
      }
      process.stdout.write(`Continuing with the active Boxers ${active.packageVersion} build.\n`);
    } else if (!latest)
      process.stdout.write("npm could not be reached; continuing with the active build.\n");
  }
  const fleet = readFleet();
  const machines = fleet ? listRemoteMachines() : [];
  // Learn the fleet's highest Lamport generation before issuing the next one,
  // so an update started from a returning admin supersedes pending rollouts.
  if (machines.length) await gossipFleetMembership();
  let allowDowngrade = false;
  if (machines.length) {
    const observed = await Promise.all(
      machines.map(async (machine) => ({
        machine,
        version: await remotePackageVersion(machine),
      })),
    );
    const newer = observed.flatMap(({ machine, version }) =>
      version && newerRelease(version, active.packageVersion) ? [{ machine, version }] : [],
    );
    if (newer.length) {
      allowDowngrade = await confirmFleetDowngrade(active.packageVersion, newer);
      if (!allowDowngrade) {
        process.stderr.write(
          "Fleet update cancelled because it would downgrade connected machines.\n",
        );
        return 1;
      }
    }
  }
  const local = installReleaseCapsule(capsule);
  if (finalizeManagedActivation(local.manifest.packageVersion, local.manifest.buildId))
    scheduleDaemonReplacement(local.manifest.buildId);
  process.stdout.write(
    `Local machine is up to date with Boxers ${local.manifest.packageVersion} (${local.manifest.buildId.slice(0, 8)}).\n`,
  );
  if (!fleet) {
    process.stdout.write("No connected machines to update.\n");
    return 0;
  }
  let state = createFleetReleaseIntent(local.manifest, allowDowngrade);
  state = acknowledgeFleetRelease();
  if (!machines.length) {
    process.stdout.write("No connected machines to update.\n");
    return 0;
  }
  process.stdout.write("Now updating connected machines…\n\n");
  const results = await Promise.all(
    machines.map(async (machine) => {
      try {
        return {
          machine,
          result: await sendFleetReleaseWithBootstrap(machine, state, capsule),
        };
      } catch (error) {
        return {
          machine,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  for (const item of results) {
    if ("result" in item) {
      const suffix = [
        item.result.runtimeInstalled ? "installed native runtime" : undefined,
        item.result.daemonReplacementRequired ? "daemon replacement scheduled" : undefined,
      ]
        .filter(Boolean)
        .join("; ");
      process.stdout.write(`  ${item.machine.name}\tupdated${suffix ? `; ${suffix}` : ""}\n`);
    } else
      process.stdout.write(
        `  ${item.machine.name}\tpending — ${item.error || "unreachable"}; will update automatically when it reconnects\n`,
      );
  }
  return results.every((item) => "result" in item) ? 0 : 1;
}

export function desiredFleetRelease(): FleetUpdateState {
  return readFleetUpdateState();
}

export function fleetReleaseNeedsDaemonReplacement(): boolean {
  const state = readFleetUpdateState();
  const desired = state.desired;
  if (!desired) return false;
  const localId = localMachineIdentity().id;
  return (
    fleetReleaseIsAcknowledged(localId, state) &&
    activeReleaseBuildId() !== desired.body.release.buildId
  );
}
