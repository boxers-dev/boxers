import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalProjectSource,
  canonicalizeProjectSource,
  createTaskManifest,
  initProject,
  localMachineIdentity,
  renameLocalMachine,
  requireRegisteredTask,
} from "../../src/v2/registry.ts";
import { taskDir } from "../../src/v2/paths.ts";

const paths: string[] = [];
const oldHome = process.env["BOXERS_HOME"];

afterEach(() => {
  if (oldHome === undefined) delete process.env["BOXERS_HOME"];
  else process.env["BOXERS_HOME"] = oldHome;
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

describe("sanitized project seed", () => {
  it("persists a stable machine identity", () => {
    const state = mkdtempSync(join(tmpdir(), "boxers-state-"));
    paths.push(state);
    process.env["BOXERS_HOME"] = state;

    const identity = localMachineIdentity();
    expect(localMachineIdentity()).toEqual(identity);
    expect(identity.id).toBeTruthy();
  });

  it("renames a machine without replacing its durable identity", () => {
    const state = mkdtempSync(join(tmpdir(), "boxers-state-"));
    paths.push(state);
    process.env.BOXERS_HOME = state;
    const identity = localMachineIdentity();

    expect(renameLocalMachine("build-box")).toEqual({ ...identity, name: "build-box" });
    expect(localMachineIdentity()).toEqual({ ...identity, name: "build-box" });
    expect(() => renameLocalMachine("bad name")).toThrow("Machine names may contain");
  });

  it("contains committed tracked content but no real-worktree secrets or host Git settings", () => {
    const root = mkdtempSync(join(tmpdir(), "boxers-project-"));
    const state = mkdtempSync(join(tmpdir(), "boxers-state-"));
    paths.push(root, state);
    process.env["BOXERS_HOME"] = state;
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.invalid");
    git(root, "config", "credential.helper", "dangerous-helper");
    git(root, "config", "core.hooksPath", "/private/hooks");
    writeFileSync(join(root, "tracked.txt"), "tracked\n");
    writeFileSync(join(root, ".gitignore"), ".env\n");
    git(root, "add", "tracked.txt", ".gitignore");
    git(root, "commit", "-q", "-m", "base");
    writeFileSync(join(root, ".env"), "SECRET=do-not-copy\n");

    const project = initProject({ integration: "local", base: "main", cwd: root });
    expect(readFileSync(join(project.seedPath, "tracked.txt"), "utf8")).toBe("tracked\n");
    expect(existsSync(join(project.seedPath, ".env"))).toBe(false);
    expect(git(project.seedPath, "remote")).toBe("");
    const seedConfig = readFileSync(join(project.seedPath, ".git", "config"), "utf8");
    expect(seedConfig).not.toContain("dangerous-helper");
    expect(seedConfig).not.toContain("/private/hooks");
    expect(existsSync(join(root, ".boxers", "config.yml"))).toBe(true);
    const task = createTaskManifest(project, "native-task", "codex");
    expect(task.sessionMode).toBe("native");
    expect(task.runtime.id).toBe(`boxers-${basename(root)}-native-task`);

    const manifestPath = join(taskDir(project.id, task.id), "task.json");
    const currentManifest = readFileSync(manifestPath, "utf8");
    writeFileSync(manifestPath, JSON.stringify({ ...task, sandboxName: task.runtime.id }));
    expect(() => requireRegisteredTask(task.name)).toThrow("Invalid task manifest");
    writeFileSync(manifestPath, currentManifest);

    const collidingTask = createTaskManifest(project, "native_task", "codex");
    expect(collidingTask.runtime.id).toMatch(
      new RegExp(`^boxers-${basename(root)}-native-task-[a-f0-9]{8}$`),
    );

    const configPath = join(root, ".boxers", "config.yml");
    const configText = readFileSync(configPath, "utf8");
    rmSync(configPath);
    expect(
      initProject({
        integration: "local",
        base: "main",
        cwd: root,
        configText,
      }),
    ).toEqual(project);
    expect(readFileSync(configPath, "utf8")).toBe(configText);
    git(root, "branch", "other");
    expect(
      initProject({ integration: "local", base: "other", cwd: root, configText }),
    ).toMatchObject({ id: project.id, integration: { mode: "local", base: "other" } });
  });

  it("normalizes equivalent Git URLs without retaining credentials", () => {
    const root = mkdtempSync(join(tmpdir(), "boxers-source-"));
    const state = mkdtempSync(join(tmpdir(), "boxers-state-"));
    paths.push(root, state);
    process.env["BOXERS_HOME"] = state;
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.invalid");
    writeFileSync(join(root, "tracked.txt"), "tracked\n");
    git(root, "add", "tracked.txt");
    git(root, "commit", "-q", "-m", "base");
    const project = initProject({ integration: "local", base: "main", cwd: root });

    git(root, "remote", "add", "origin", "git@github.com:Owner/Repo.git");
    expect(canonicalProjectSource(project)).toBe("github.com/Owner/Repo");
    expect(canonicalizeProjectSource("ssh://git@github.com/Owner/Repo.git")).toBe(
      "github.com/Owner/Repo",
    );
    git(root, "remote", "set-url", "origin", "https://token@github.com/Owner/Repo.git");
    expect(canonicalProjectSource(project)).toBe("github.com/Owner/Repo");
  });

  it("enforces machine-wide task names and resolves them without repository context", () => {
    const state = mkdtempSync(join(tmpdir(), "boxers-state-"));
    paths.push(state);
    process.env["BOXERS_HOME"] = state;

    const initialize = (name: string) => {
      const root = mkdtempSync(join(tmpdir(), `boxers-${name}-`));
      paths.push(root);
      git(root, "init", "-q", "-b", "main");
      git(root, "config", "user.name", "Test User");
      git(root, "config", "user.email", "test@example.invalid");
      writeFileSync(join(root, "tracked.txt"), `${name}\n`);
      git(root, "add", "tracked.txt");
      git(root, "commit", "-q", "-m", "base");
      return initProject({ integration: "local" as const, base: "main", cwd: root });
    };

    const first = initialize("first");
    const second = initialize("second");
    const task = createTaskManifest(first, "shared-name", "codex");

    expect(requireRegisteredTask("SHARED-NAME")).toEqual({ project: first, task });
    expect(() => createTaskManifest(second, "Shared-Name", "claude")).toThrow(
      "task names must be unique on this machine",
    );
    expect(() => createTaskManifest(second, "list", "claude")).toThrow(
      'Task name "list" is reserved',
    );
    for (const reserved of ["connect", "hosts", "disconnect", "update", "debug", "daemon"])
      expect(() => createTaskManifest(second, reserved, "claude")).toThrow(
        `Task name "${reserved}" is reserved`,
      );
  });
});
