import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { isInteractive, isSshSession, authenticateAgent } from "./auth.ts";
import { daemonStart } from "./daemon-commands.ts";
import { collectHostStatus } from "./host-status.ts";
import { markMachineSetupComplete } from "./machine-setup.ts";
import { command } from "./process.ts";
import { daemonServiceStatus, installDaemonService, resolveBoxersExecutable } from "./service.ts";
import type { HostStatusCheck } from "./types.ts";

const DOCKER_INSTALL_URL = "https://docs.docker.com/ai/sandboxes/install/";

function accepted(answer: string, defaultValue: boolean): boolean {
  const normalized = answer.trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (normalized === "y" || normalized === "yes") return true;
  if (normalized === "n" || normalized === "no") return false;
  throw new Error("Answer yes or no.");
}

function runInteractive(cmd: string, args: readonly string[], description: string): void {
  const result = command(cmd, args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${description} failed (exit ${result.status}).`);
}

function ubuntuRelease(): number | undefined {
  if (platform() !== "linux") return undefined;
  try {
    const release = readFileSync("/etc/os-release", "utf8");
    if (!/^ID=(?:"?)ubuntu(?:"?)$/m.test(release)) return undefined;
    const version = /^VERSION_ID=(?:"?)([^"\n]+)(?:"?)$/m.exec(release)?.[1];
    return version === undefined ? undefined : Number.parseFloat(version);
  } catch {
    return undefined;
  }
}

/** Install the currently required Docker Sandboxes runtime using Docker's documented method. */
export function installDockerSandboxes(): void {
  if (platform() === "darwin") {
    runInteractive("brew", ["trust", "docker/tap"], "Homebrew tap trust");
    runInteractive("brew", ["install", "docker/tap/sbx"], "Docker Sandboxes installation");
    return;
  }
  if (platform() === "win32") {
    runInteractive("winget", ["install", "-h", "Docker.sbx"], "Docker Sandboxes installation");
    return;
  }
  const release = ubuntuRelease();
  if (release === undefined || release < 24.04)
    throw new Error(
      `Automatic sbx installation is supported only on Ubuntu 24.04 or newer. Follow ${DOCKER_INSTALL_URL}`,
    );
  const directory = mkdtempSync(join(tmpdir(), "boxers-sbx-install-"));
  const installer = join(directory, "get-docker.sh");
  try {
    runInteractive(
      "curl",
      ["-fsSL", "https://get.docker.com", "-o", installer],
      "Docker repository installer download",
    );
    runInteractive(
      "sudo",
      ["env", "REPO_ONLY=1", "sh", installer],
      "Docker package repository configuration",
    );
    runInteractive("sudo", ["apt", "install", "docker-sbx"], "Docker Sandboxes installation");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function check(
  status: ReturnType<typeof collectHostStatus>,
  id: string,
): HostStatusCheck | undefined {
  return status.checks.find((candidate) => candidate.id === id);
}

function configuredGitValue(key: "user.name" | "user.email"): string | undefined {
  const result = command("git", ["config", "--global", "--get", key]);
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
}

function setGitValue(key: "user.name" | "user.email", value: string): void {
  const result = command("git", ["config", "--global", key, value]);
  if (result.status !== 0)
    throw new Error(
      `Could not configure Git ${key}: ${(result.stderr || result.stdout).trim() || `exit ${result.status}`}`,
    );
}

function printChecks(checks: readonly HostStatusCheck[]): void {
  for (const item of checks.filter((candidate) => candidate.category === "health"))
    process.stdout.write(
      `${item.status === "ok" ? "ok" : item.status === "warning" ? "WARN" : "FAIL"}  ${item.id}: ${item.detail}\n`,
    );
}

export async function initializeMachine(): Promise<number> {
  if (!isInteractive())
    throw new Error(
      "Machine initialization is interactive. Run `boxers init` from a terminal, then use `boxers doctor` for non-interactive verification.",
    );

  process.stdout.write(
    "Boxers machine setup\n\nThis configures the local task runtime and daemon. Git authentication stays on the host; before initializing a project, make sure Git can read that project's remote with your normal SSH key, credential helper, or access token.\n\n",
  );
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const git = command("git", ["--version"]);
    if (git.status !== 0)
      throw new Error(
        "Git is required. Install Git, ensure it is on PATH, and run `boxers init` again.",
      );
    process.stdout.write(`ok  git: ${git.stdout.trim()}\n`);

    for (const [key, label] of [
      ["user.name", "Git author name"],
      ["user.email", "Git author email"],
    ] as const) {
      if (configuredGitValue(key)) continue;
      const value = (await readline.question(`${label}: `)).trim();
      if (!value) throw new Error(`${label} is required for Boxers promotion commits.`);
      setGitValue(key, value);
      process.stdout.write(`Configured global Git ${key}.\n`);
    }

    let acknowledgeOpenNetwork = false;
    let status = collectHostStatus();
    if (check(status, "runtime.host")?.status === "failed")
      throw new Error(
        `This host cannot run Docker Sandboxes: ${check(status, "runtime.host")?.detail}`,
      );

    if (check(status, "runtime.docker-sandboxes")?.status !== "ok") {
      process.stdout.write(
        `Docker Sandboxes (sbx) is required. Boxers can install it using Docker's documented platform installer.\nSee ${DOCKER_INSTALL_URL}\n`,
      );
      if (!accepted(await readline.question("Install Docker Sandboxes now? [Y/n]: "), true))
        throw new Error(`Install sbx from ${DOCKER_INSTALL_URL}, then run \`boxers init\` again.`);
      installDockerSandboxes();
      status = collectHostStatus();
      if (check(status, "runtime.docker-sandboxes")?.status !== "ok")
        throw new Error("sbx is still unavailable or too old after installation.");
    }

    if (check(status, "runtime.docker-login")?.status !== "ok") {
      if (!accepted(await readline.question("Sign in to Docker Sandboxes now? [Y/n]: "), true))
        throw new Error(
          "Docker Sandboxes authentication is required. Run `sbx login`, then `boxers init` again.",
        );
      runInteractive("sbx", ["login"], "Docker Sandboxes authentication");
      status = collectHostStatus();
      if (check(status, "runtime.docker-login")?.status !== "ok")
        throw new Error("Docker Sandboxes still reports that authentication is incomplete.");
    }

    if (check(status, "runtime.network-policy")?.status === "failed") {
      process.stdout.write(
        "Docker Sandboxes needs a network policy. The balanced preset allows common development services while denying other destinations.\n",
      );
      if (
        !accepted(await readline.question("Initialize the balanced network policy? [Y/n]: "), true)
      )
        throw new Error(
          "Initialize a Docker Sandboxes network policy, then run `boxers init` again.",
        );
      runInteractive("sbx", ["policy", "init", "balanced"], "Network policy initialization");
      status = collectHostStatus();
    }
    if (check(status, "runtime.network-policy")?.status === "warning") {
      process.stdout.write(
        "The current Docker Sandboxes policy allows unrestricted outbound access. This is less restrictive than the recommended balanced preset.\n",
      );
      acknowledgeOpenNetwork = accepted(
        await readline.question("Acknowledge the open network policy for this setup? [y/N]: "),
        false,
      );
      if (!acknowledgeOpenNetwork)
        throw new Error(
          "Choose a restricted Docker Sandboxes policy, or explicitly run `boxers doctor --acknowledge-open-network`.",
        );
      process.stdout.write(
        "Open network access acknowledged. Future doctor runs require `--acknowledge-open-network`.\n",
      );
    }

    for (const agent of ["codex", "claude"] as const) {
      if (status.authentication[agent] === "configured") continue;
      const label = agent === "codex" ? "Codex" : "Claude";
      if (
        !accepted(await readline.question(`Authenticate ${label} for future tasks? [y/N]: `), false)
      )
        continue;
      authenticateAgent(
        agent,
        agent === "codex" ? { mode: isSshSession() ? "api-key" : "oauth" } : {},
      );
      status = collectHostStatus();
    }

    let service = daemonServiceStatus();
    if (service.supported && (!service.installed || !service.enabled)) {
      if (!accepted(await readline.question("Install the Boxers login-time daemon? [Y/n]: "), true))
        throw new Error(
          "Install the daemon with `boxers daemon install`, then run `boxers init` again.",
        );
      service = installDaemonService(resolveBoxersExecutable());
      process.stdout.write(`Installed the Boxers daemon service: ${service.detail}\n`);
    }
    if (!service.active) await daemonStart();

    const finalStatus = collectHostStatus({ acknowledgeOpenNetwork });
    process.stdout.write("\nFinal machine checks:\n");
    printChecks(finalStatus.checks);
    if (finalStatus.health !== "healthy")
      throw new Error(
        "Machine setup is incomplete. Resolve the failed checks above and rerun `boxers init` or `boxers doctor`.",
      );
    markMachineSetupComplete();
    process.stdout.write(
      "\nBoxers is ready. In a reachable Git checkout, run `boxers project init`.\n",
    );
    return 0;
  } finally {
    readline.close();
  }
}
