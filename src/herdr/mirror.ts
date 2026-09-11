import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { command, requireSuccess } from "./process.ts";
import { parseProjectConfig } from "./config.ts";
import type { HerdrProject, ProjectConfig } from "./types.ts";
import { withPidFileLock } from "./lock.ts";

function git(cwd: string, args: readonly string[], description: string): string {
  return requireSuccess(command("git", ["-C", cwd, ...args]), description).trim();
}

function optionalGit(cwd: string, args: readonly string[]): string | undefined {
  const result = command("git", ["-C", cwd, ...args]);
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
}

export interface ResolvedProjectTarget {
  root: string;
  remote: string;
  url: string;
  branch: string;
  oid: string;
  config: ProjectConfig;
  configHash: string;
}

export function resolveProjectTarget(cwd: string): ResolvedProjectTarget {
  const root = realpathSync(
    git(cwd, ["rev-parse", "--show-toplevel"], "Not inside a Git repository"),
  );
  const configPath = join(root, ".boxers", "config.yml");
  const configText = existsSync(configPath) ? readFileSync(configPath, "utf8") : "version: 1\n";
  const config = parseProjectConfig(configText);
  const currentBranch = optionalGit(root, ["symbolic-ref", "--short", "HEAD"]);
  const remote =
    config.integration?.remote ??
    (currentBranch ? optionalGit(root, ["config", `branch.${currentBranch}.remote`]) : undefined) ??
    "origin";
  const branch =
    config.integration?.branch ??
    (currentBranch
      ? optionalGit(root, ["config", `branch.${currentBranch}.merge`])?.replace(
          /^refs\/heads\//,
          "",
        )
      : undefined) ??
    currentBranch;
  if (!branch)
    throw new Error("Configure integration.branch in .boxers/config.yml for a detached checkout.");
  const configuredUrl = optionalGit(root, ["remote", "get-url", remote]);
  const url = configuredUrl ?? remote;
  const listing = git(
    root,
    ["ls-remote", "--exit-code", url, `refs/heads/${branch}`],
    `Could not resolve ${remote}/${branch}`,
  );
  const oid = listing.split(/\s/)[0];
  if (!oid || !/^[a-f0-9]{40,64}$/.test(oid))
    throw new Error(`Remote ${remote}/${branch} returned an invalid Git object ID.`);
  return {
    root,
    remote,
    url,
    branch,
    oid,
    config,
    configHash: createHash("sha256").update(configText).digest("hex"),
  };
}

export function projectId(target: Pick<ResolvedProjectTarget, "root">): string {
  return createHash("sha256").update(target.root).digest("hex").slice(0, 24);
}

/**
 * Materialize only the configured committed target. The mirror never receives an
 * upstream remote, checkout-local hooks, or data from the user's worktree.
 */
export function refreshProjectMirror(
  stateDir: string,
  target: ResolvedProjectTarget,
  existingProjectId?: string,
): HerdrProject {
  const id = existingProjectId ?? projectId(target);
  const mirrorPath = join(stateDir, "projects", id, "mirror");
  withPidFileLock(join(stateDir, "projects", id, "mirror.lock"), () => {
    if (!existsSync(join(mirrorPath, ".git"))) {
      mkdirSync(mirrorPath, { recursive: true, mode: 0o700 });
      git(mirrorPath, ["init", "--quiet"], "Could not initialize the sanitized project mirror");
    }
    git(
      mirrorPath,
      ["config", "--local", "core.hooksPath", "/dev/null"],
      "Could not disable hooks in the project mirror",
    );
    git(
      mirrorPath,
      [
        "fetch",
        "--no-tags",
        "--force",
        target.url,
        `+refs/heads/${target.branch}:refs/boxers/target`,
      ],
      `Could not refresh ${target.branch} in the sanitized project mirror`,
    );
    git(
      mirrorPath,
      ["checkout", "--quiet", "--detach", "refs/boxers/target"],
      "Could not materialize the project mirror",
    );
    git(
      mirrorPath,
      ["reset", "--quiet", "--hard", target.oid],
      "Could not reset the project mirror",
    );
    git(mirrorPath, ["clean", "-q", "-dffx"], "Could not clean the project mirror");
    const hooks = join(mirrorPath, ".git", "hooks");
    if (existsSync(hooks)) rmSync(hooks, { recursive: true, force: true });
    for (const name of readdirSync(join(mirrorPath, ".git"))) {
      if (name === "config.worktree") rmSync(join(mirrorPath, ".git", name), { force: true });
    }
  });
  return {
    version: 1,
    id,
    root: target.root,
    mirrorPath,
    targetUrl: target.url,
    targetBranch: target.branch,
    targetOid: target.oid,
    configHash: target.configHash,
    updatedAt: new Date().toISOString(),
  };
}
