import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalProjectSource,
  canonicalizeProjectSource,
  createTaskManifest,
  initProject,
  localMachineIdentity,
  renameLocalMachine,
  requireRegisteredTask,
  refreshSeed,
  publishAcceptedTarget,
  readSeedTarget,
  readProjectTarget,
} from "../../src/v2/registry.ts";
import {
  atomicWriteJson,
  daemonSocketPath,
  projectTargetPath,
  taskDir,
} from "../../src/v2/paths.ts";
import type { ProjectManifest } from "../../src/v2/types.ts";

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
  it("validates target observations and ignores observations of another configured target", () => {
    const state = mkdtempSync(join(tmpdir(), "boxers-target-observation-"));
    paths.push(state);
    process.env.BOXERS_HOME = state;
    const project = {
      id: "project",
      integration: { remote: "origin", base: "main" },
    } as ProjectManifest;
    const valid = {
      ...project.integration,
      attemptedAt: "2030-01-01T00:00:00.000Z",
      oid: "a".repeat(40),
      observedAt: "2030-01-01T00:00:00.000Z",
    };
    const path = projectTargetPath(project.id);
    atomicWriteJson(path, valid);
    expect(readProjectTarget(project)).toEqual(valid);
    for (const invalid of [
      null,
      { ...valid, oid: 4 },
      { ...valid, observedAt: undefined },
      { ...valid, failure: false },
    ]) {
      atomicWriteJson(path, invalid);
      expect(() => readProjectTarget(project)).toThrow("Invalid target observation");
    }
    atomicWriteJson(path, { ...valid, base: "other" });
    expect(readProjectTarget(project)).toBeUndefined();
  });

  it("notifies only changed targets, including confirmed delivery without another fetch", async () => {
    const root = mkdtempSync(join(tmpdir(), "boxers-target-notify-root-"));
    const state = mkdtempSync(join(tmpdir(), "boxers-target-notify-state-"));
    paths.push(root, state);
    process.env.BOXERS_HOME = state;
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test");
    git(root, "config", "user.email", "test@example.invalid");
    git(root, "commit", "--allow-empty", "-q", "-m", "base");
    const messages: { type: string; projectId?: string }[] = [];
    const server = createServer((socket) => {
      let buffer = "";
      socket.on("data", (data) => {
        buffer += String(data);
        const lines = buffer.split("\n");
        buffer = lines.pop()!;
        for (const line of lines) messages.push(JSON.parse(line));
      });
    });
    await new Promise<void>((resolve) => server.listen(daemonSocketPath(), resolve));
    try {
      const project = initProject({ base: "main", remote: root, cwd: root });
      const hints = () => messages.filter((message) => message.type === "target_changed");
      await expect.poll(() => hints().length).toBe(1);
      const base = refreshSeed(project);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(hints()).toEqual([{ type: "target_changed", projectId: project.id }]);
      const accepted = git(
        project.seedPath,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit-tree",
        `${base}^{tree}`,
        "-p",
        base,
        "-m",
        "accepted",
      );
      publishAcceptedTarget(project, base, accepted);
      await expect.poll(() => hints().length).toBe(2);
      expect(readSeedTarget(project)).toBe(accepted);
      // A delayed acceptance callback cannot regress an already newer seed.
      publishAcceptedTarget(project, base, base);
      expect(readSeedTarget(project)).toBe(accepted);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(hints()).toHaveLength(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("serializes the shared seed across concurrent task workers", async () => {
    const root = mkdtempSync(join(tmpdir(), "boxers-seed-concurrent-root-"));
    const state = mkdtempSync(join(tmpdir(), "boxers-seed-concurrent-state-"));
    const bin = mkdtempSync(join(tmpdir(), "boxers-seed-concurrent-bin-"));
    paths.push(root, state, bin);
    process.env.BOXERS_HOME = state;
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.invalid");
    writeFileSync(join(root, "tracked.txt"), "base\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
    const project = initProject({ remote: root, base: "main", cwd: root });
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const trace = join(bin, "trace");
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh
if test "$3" = fetch; then
  printf 'begin %s\n' "$BOXERS_TEST_WORKER_ID" >> "$BOXERS_TEST_SEED_TRACE"
  sleep 0.1
fi
"$BOXERS_TEST_REAL_GIT" "$@"
code=$?
if test "$3" = reset; then printf 'end %s\n' "$BOXERS_TEST_WORKER_ID" >> "$BOXERS_TEST_SEED_TRACE"; fi
exit "$code"
`,
    );
    chmodSync(join(bin, "git"), 0o755);
    const moduleUrl = pathToFileURL(join(process.cwd(), "src/v2/registry.ts")).href;
    await Promise.all(
      Array.from(
        { length: 4 },
        () =>
          new Promise<void>((resolve, reject) => {
            const child = spawn(
              process.execPath,
              [
                "--import",
                "tsx",
                "--input-type=module",
                "-e",
                `import { refreshSeed } from ${JSON.stringify(moduleUrl)}; process.env.BOXERS_TEST_WORKER_ID = String(process.pid); refreshSeed(${JSON.stringify(project)});`,
              ],
              {
                env: {
                  ...process.env,
                  PATH: `${bin}:${process.env.PATH}`,
                  BOXERS_TEST_REAL_GIT: realGit,
                  BOXERS_TEST_SEED_TRACE: trace,
                },
                stdio: ["ignore", "ignore", "pipe"],
              },
            );
            let stderr = "";
            child.stderr.on("data", (chunk) => {
              stderr += String(chunk);
            });
            child.once("error", reject);
            child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
          }),
      ),
    );
    const events = readFileSync(trace, "utf8").trim().split("\n");
    expect(events).toHaveLength(8);
    for (let index = 0; index < events.length; index += 2) {
      expect(events[index]).toMatch(/^begin \d+$/);
      expect(events[index + 1]).toBe(events[index]!.replace("begin", "end"));
    }
    expect(git(project.seedPath, "rev-parse", "HEAD")).toBe(git(root, "rev-parse", "HEAD"));
  });

  it.skipIf(process.platform === "win32").each(["SIGKILL", "SIGTERM"] as const)(
    "handles a seed worker's %s without overlapping surviving Git writers",
    async (signal) => {
      const root = mkdtempSync(join(tmpdir(), "boxers-seed-worker-loss-"));
      const state = mkdtempSync(join(tmpdir(), "boxers-seed-worker-state-"));
      const bin = mkdtempSync(join(tmpdir(), "boxers-seed-worker-bin-"));
      paths.push(root, state, bin);
      process.env.BOXERS_HOME = state;
      git(root, "init", "-q", "-b", "main");
      git(root, "config", "user.name", "Test");
      git(root, "config", "user.email", "test@example.invalid");
      git(root, "commit", "--allow-empty", "-q", "-m", "base");
      const project = initProject({ remote: root, base: "main", cwd: root });
      const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
      const started = join(bin, "started");
      const release = join(bin, "release");
      const finished = join(bin, "finished");
      writeFileSync(
        join(bin, "git"),
        `#!/bin/sh
if test "$3" = fetch; then
  printf '%s' "$$" > "$BOXERS_TEST_SEED_STARTED"
  while ! test -f "$BOXERS_TEST_SEED_RELEASE"; do sleep 0.02; done
  "$BOXERS_TEST_REAL_GIT" "$@"
  code=$?
  touch "$BOXERS_TEST_SEED_FINISHED"
  exit "$code"
fi
exec "$BOXERS_TEST_REAL_GIT" "$@"
`,
      );
      chmodSync(join(bin, "git"), 0o755);
      const moduleUrl = pathToFileURL(join(process.cwd(), "src/v2/registry.ts")).href;
      const ownershipUrl = pathToFileURL(join(process.cwd(), "src/v2/worker-ownership.ts")).href;
      const worker = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `import { refreshSeed } from ${JSON.stringify(moduleUrl)}; import { enableWorkerWorkspaceOwnership } from ${JSON.stringify(ownershipUrl)}; enableWorkerWorkspaceOwnership(); refreshSeed(${JSON.stringify(project)});`,
        ],
        {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            BOXERS_TEST_REAL_GIT: realGit,
            BOXERS_TEST_SEED_STARTED: started,
            BOXERS_TEST_SEED_RELEASE: release,
            BOXERS_TEST_SEED_FINISHED: finished,
          },
          stdio: "ignore",
          detached: true,
        },
      );
      const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
      try {
        await expect.poll(() => existsSync(started)).toBe(true);
        const gitPid = Number(readFileSync(started, "utf8"));
        if (signal === "SIGTERM") process.kill(-worker.pid!, signal);
        else worker.kill(signal);
        await exited;
        const base = readSeedTarget(project)!;
        if (signal === "SIGKILL") {
          expect(() => process.kill(gitPid, 0)).not.toThrow();
          expect(() => refreshSeed(project, 500)).toThrow("child processes");
          expect(() => publishAcceptedTarget(project, base, base)).toThrow("child processes");
        } else {
          expect(refreshSeed(project)).toBe(base);
        }
        expect(existsSync(finished)).toBe(false);
      } finally {
        if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
        await exited;
        writeFileSync(release, "release");
        if (signal === "SIGKILL" && existsSync(started))
          await expect.poll(() => existsSync(finished)).toBe(true);
      }
    },
  );

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

    const project = initProject({ remote: root, base: "main", cwd: root });
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
        remote: root,
        base: "main",
        cwd: root,
        configText,
      }),
    ).toEqual(project);
    expect(readFileSync(configPath, "utf8")).toBe(configText);
    git(root, "branch", "other");
    expect(initProject({ remote: root, base: "other", cwd: root, configText })).toMatchObject({
      id: project.id,
      integration: { remote: root, base: "other" },
    });
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
    const project = initProject({ remote: root, base: "main", cwd: root });

    git(root, "remote", "add", "origin", "git@github.com:Owner/Repo.git");
    project.integration.remote = "origin";
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
      return initProject({ remote: root, base: "main", cwd: root });
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
