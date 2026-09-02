import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

export function boxersHome(): string {
  const override = process.env["BOXERS_HOME"];
  if (override) return override;
  if (platform() === "win32") {
    return join(process.env["LOCALAPPDATA"] ?? process.env["APPDATA"] ?? homedir(), "Boxers");
  }
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "boxers");
  return join(process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state"), "boxers");
}

export function projectsDir(): string {
  return join(boxersHome(), "projects");
}

/** Git checkouts provisioned automatically when a task targets a new remote project. */
export function checkoutsDir(): string {
  return join(boxersHome(), "checkouts");
}

export function machineIdentityPath(): string {
  return join(boxersHome(), "machine.json");
}

export function daemonSocketPath(): string {
  if (platform() === "win32") return String.raw`\\.\pipe\boxers-daemon`;
  return join(boxersHome(), "daemon.sock");
}

export function daemonPidPath(): string {
  return join(boxersHome(), "daemon.pid");
}

export function daemonLockPath(): string {
  return join(boxersHome(), "daemon.lock");
}

export function daemonLogPath(): string {
  return join(boxersHome(), "daemon.log");
}

export function daemonHealthPath(): string {
  return join(boxersHome(), "daemon-health.json");
}

export function hostStatusPath(): string {
  return join(boxersHome(), "host-status.json");
}

export function machineSetupPath(): string {
  return join(boxersHome(), "machine-setup.json");
}

export function taskIntentLeasePath(taskName: string): string {
  return join(boxersHome(), "intents", `${encodeURIComponent(taskName.toLowerCase())}.json`);
}

export function taskMutationBarrierPath(taskName: string): string {
  return join(boxersHome(), "mutations", `${encodeURIComponent(taskName.toLowerCase())}.json`);
}

export function projectDir(id: string): string {
  return join(projectsDir(), id);
}

export function taskDir(projectId: string, taskId: string): string {
  return join(projectDir(projectId), "tasks", taskId);
}

export function taskStatePath(projectId: string, taskId: string): string {
  return join(taskDir(projectId, taskId), "state.json");
}

export function taskRepairLogPath(projectId: string, taskId: string): string {
  return join(taskDir(projectId, taskId), "repair.log");
}

export function taskManifestLockPath(projectId: string, taskId: string): string {
  return join(taskDir(projectId, taskId), "task.lock");
}

export function fleetPath(): string {
  return join(boxersHome(), "fleet.json");
}

export function fleetLockPath(): string {
  return join(boxersHome(), "fleet.lock");
}

export function peerCacheDir(): string {
  return join(boxersHome(), "peers");
}

export function peerCachePath(hostId: string): string {
  return join(peerCacheDir(), `${hostId}.json`);
}

export function hostKeyPath(): string {
  return join(boxersHome(), "host-key.json");
}

export function hostKeyLockPath(): string {
  return join(boxersHome(), "host-key.lock");
}

export function managedSshDir(): string {
  return join(boxersHome(), "ssh");
}

export function managedSshPrivateKeyPath(): string {
  return join(managedSshDir(), "id_ed25519");
}

export function managedSshPublicKeyPath(): string {
  return `${managedSshPrivateKeyPath()}.pub`;
}

export function managedSshLockPath(): string {
  return join(managedSshDir(), "identity.lock");
}

export function authorizedKeysLockPath(): string {
  return join(boxersHome(), "authorized-keys.lock");
}

export function machineIdentityLockPath(): string {
  return join(boxersHome(), "machine.lock");
}

export function fleetAdminStatePath(): string {
  return join(boxersHome(), "fleet-admin.json");
}

export function fleetAdminStateLockPath(): string {
  return join(boxersHome(), "fleet-admin.lock");
}

export function fleetUpdatePath(): string {
  return join(boxersHome(), "fleet-update.json");
}

export function fleetUpdateLockPath(): string {
  return join(boxersHome(), "fleet-update.lock");
}

export function atomicWriteJson(path: string, value: unknown): void {
  atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`, 0o600);
}

export function atomicWriteText(path: string, value: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, value, { mode });
  renameSync(temporary, path);
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
