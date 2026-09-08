import { boxersLaunch } from "../core/launcher.ts";
import { spawn } from "node:child_process";
import { readFleet } from "./fleet.ts";
import { reconcileManagedPeerAuthorizations } from "./ssh-identity.ts";
import { installDaemonService } from "./service.ts";
import { activeManagedBuildId, installReleaseCapsule, stableExecutablePath } from "./release.ts";
import { boxersHome } from "./paths.ts";
import { daemonReleaseMatches } from "./daemon-identity.ts";

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
    return !service.active || !daemonReleaseMatches(service, { version: packageVersion, buildId });
  } catch (error) {
    if (process.platform === "linux" || process.platform === "darwin") throw error;
    return true;
  }
}

function replaceDaemon(buildId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const launch = boxersLaunch(stableExecutablePath(), ["__daemon-replace", buildId]);
    const child = spawn(launch.command, launch.args, {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, BOXERS_HOME: boxersHome() },
    });
    let stderr = "";
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", (error) => finish(error));
    child.once("close", (code) =>
      finish(
        code === 0
          ? undefined
          : new Error(stderr.trim() || `Replacing the Boxers daemon exited ${code ?? 1}.`),
      ),
    );
  });
}

/** Shared activation for connect, local update, and incoming fleet releases. */
export async function activateHostRelease(capsule: Buffer) {
  const installed = installReleaseCapsule(capsule);
  const daemonReplacementRequired = finalizeManagedActivation(
    installed.manifest.packageVersion,
    installed.manifest.buildId,
  );
  if (daemonReplacementRequired) await replaceDaemon(installed.manifest.buildId);
  if (activeManagedBuildId() !== installed.manifest.buildId)
    throw new Error(
      `Boxers build ${installed.manifest.buildId.slice(0, 8)} was superseded during activation.`,
    );
  return { ...installed, daemonReplacementRequired };
}
