import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { command, requireSuccess } from "./process.ts";
import { daemonHealthPath, daemonPidPath, readJson } from "./paths.ts";

export interface DaemonServiceStatus {
  supported: boolean;
  installed: boolean;
  enabled: boolean;
  active: boolean;
  pid?: number;
  protocolVersion?: number;
  boxersVersion?: string;
  boxersBuildId?: string;
  startedAt?: string;
  platform: string;
  detail: string;
}

function daemonHealth(pid: number):
  | {
      protocolVersion: number;
      boxersVersion: string;
      boxersBuildId?: string;
      startedAt?: string;
    }
  | undefined {
  try {
    const value = readJson<{
      version: number;
      pid: number;
      protocolVersion: number;
      boxersVersion: string;
      boxersBuildId?: string;
      startedAt?: string;
    }>(daemonHealthPath());
    return value.version === 1 &&
      value.pid === pid &&
      Number.isInteger(value.protocolVersion) &&
      typeof value.boxersVersion === "string"
      ? {
          protocolVersion: value.protocolVersion,
          boxersVersion: value.boxersVersion,
          ...(typeof value.boxersBuildId === "string"
            ? { boxersBuildId: value.boxersBuildId }
            : {}),
          ...(typeof value.startedAt === "string" ? { startedAt: value.startedAt } : {}),
        }
      : undefined;
  } catch {
    return undefined;
  }
}

function daemonProcessPid(): number | undefined {
  let pid: number | undefined;
  try {
    pid = Number.parseInt(readFileSync(daemonPidPath(), "utf8").trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    process.kill(pid, 0);
    // Status and doctor must distinguish a live but wedged PID-file owner from
    // an inactive daemon. Process identity is checked only before destructive
    // recovery such as force-stop or replacing a stale lock.
    return pid;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM" ? pid : undefined;
  }
}

function daemonActivity(pid: number | undefined): string {
  return pid === undefined ? "daemon inactive" : `daemon active (pid ${pid})`;
}

function systemdUnitPath(): string {
  return join(homedir(), ".config", "systemd", "user", "boxers.service");
}

function launchdPath(): string {
  return join(homedir(), "Library", "LaunchAgents", "io.boxers.daemon.plist");
}

function executableFile(path: string): string | undefined {
  try {
    const resolved = realpathSync(path);
    if (!statSync(resolved).isFile()) return undefined;
    accessSync(resolved, constants.X_OK);
    return resolved;
  } catch {
    return undefined;
  }
}

/** Resolve a real CLI file without asking a shell to interpret aliases or command text. */
export function resolveBoxersExecutable(
  entry = process.argv[1],
  path = process.env["PATH"],
): string {
  if (entry && isAbsolute(entry)) {
    const resolved = executableFile(entry);
    if (resolved) return resolved;
  }
  for (const directory of (path ?? "").split(delimiter)) {
    if (!directory) continue;
    const resolved = executableFile(join(directory, "boxers"));
    if (resolved) return resolved;
  }
  throw new Error(
    "Could not resolve Boxers to an absolute executable file. Install the CLI before installing its daemon service.",
  );
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function daemonServiceStatus(): DaemonServiceStatus {
  if (platform() === "linux") {
    const installed = existsSync(systemdUnitPath());
    const enabled =
      installed && command("systemctl", ["--user", "is-enabled", "boxers.service"]).status === 0;
    const pid = daemonProcessPid();
    const active = pid !== undefined;
    const health = pid === undefined ? undefined : daemonHealth(pid);
    return {
      supported: true,
      installed,
      enabled,
      active,
      ...(pid === undefined ? {} : { pid }),
      ...health,
      platform: "systemd-user",
      detail: installed
        ? `${systemdUnitPath()} (${enabled ? "enabled" : "disabled"}, ${daemonActivity(pid)})`
        : `user service is not installed; ${daemonActivity(pid)}`,
    };
  }
  if (platform() === "darwin") {
    const installed = existsSync(launchdPath());
    const pid = daemonProcessPid();
    const active = pid !== undefined;
    const health = pid === undefined ? undefined : daemonHealth(pid);
    return {
      supported: true,
      installed,
      enabled: installed,
      active,
      ...(pid === undefined ? {} : { pid }),
      ...health,
      platform: "launchd",
      detail: installed
        ? `${launchdPath()} (${daemonActivity(pid)})`
        : `LaunchAgent is not installed; ${daemonActivity(pid)}`,
    };
  }
  const pid = daemonProcessPid();
  const active = pid !== undefined;
  const health = pid === undefined ? undefined : daemonHealth(pid);
  return {
    supported: false,
    installed: false,
    enabled: false,
    active,
    ...(pid === undefined ? {} : { pid }),
    ...health,
    platform: platform(),
    detail: `automatic login-time daemon startup is not supported on this platform yet; ${daemonActivity(pid)}`,
  };
}

export function installDaemonService(executable: string): DaemonServiceStatus {
  const validated = isAbsolute(executable) ? executableFile(executable) : undefined;
  if (!validated)
    throw new Error("The Boxers service requires an absolute path to an executable file.");
  // Preserve an explicitly supplied stable symlink. Resolving it here would pin
  // the service manager to one content-addressed release and defeat safe handoff.
  const launcher = executable;
  if (platform() === "linux") {
    const path = systemdUnitPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const escaped = launcher.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    writeFileSync(
      path,
      `[Unit]\nDescription=Boxers task daemon\n\n[Service]\nType=simple\nExecStart="${escaped}" __daemon-run\nRestart=on-failure\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n`,
      { mode: 0o600 },
    );
    requireSuccess(command("systemctl", ["--user", "daemon-reload"]), "Could not reload systemd");
    requireSuccess(
      command("systemctl", ["--user", "enable", "--now", "boxers.service"]),
      "Could not enable the Boxers service",
    );
    return daemonServiceStatus();
  }
  if (platform() === "darwin") {
    const path = launchdPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(
      path,
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>io.boxers.daemon</string><key>ProgramArguments</key><array><string>${xml(launcher)}</string><string>__daemon-run</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>\n`,
      { mode: 0o600 },
    );
    // A lazily started daemon may already own durable PTYs. Install the
    // LaunchAgent without replacing that process; it loads at the next login.
    return daemonServiceStatus();
  }
  throw new Error("Automatic daemon service installation is unsupported on this platform.");
}
