import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { connect } from "node:net";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  check,
  list,
  promote,
  preview,
  discard,
  refreshAutomaticCheck,
  refreshAutomaticCommitMessage,
  review,
  runPostTurn,
  status,
  sync,
} from "../../src/v2/commands.ts";
import {
  createTaskManifest,
  initProject,
  requireTask,
  updateTask,
  refreshSeed,
  readProjectTarget,
  markTaskSessionStarted,
} from "../../src/v2/registry.ts";
import { drainTaskLifecycleEvents } from "../../src/v2/lifecycle-ingestion.ts";
import { runDaemon } from "../../src/v2/daemon.ts";
import { executeIntentInWorker, postTurnInWorker } from "../../src/v2/daemon-worker.ts";
import {
  taskDir,
  taskReconciliationPath,
  taskRepairStatePath,
  taskDeliveryPath,
  projectPromotionLockPath,
  projectSeedLockPath,
  daemonSocketPath,
} from "../../src/v2/paths.ts";
import { suspendTaskEnvironment } from "../../src/v2/runtime/task.ts";
import * as runtimeTasks from "../../src/v2/runtime/task.ts";
import {
  advanceNativeWorkspace,
  nativeWorkspacePatch,
  nativeWorkspaceTreeAt,
} from "../../src/v2/sandbox.ts";
import {
  readTaskState,
  recordLifecycleEvent,
  recordTaskSnapshot,
  updateTaskState,
} from "../../src/v2/state.ts";
import { projectTaskView } from "../../src/v2/projection.ts";
import { readSetupStatus, waitForSetup } from "../../src/v2/setup.ts";

const cleanup: string[] = [];
const targetRoots = new Set<string>();
const originalCwd = process.cwd();
const originalHome = process.env["BOXERS_HOME"];
const originalPath = process.env.PATH;
const originalGit = process.env["FAKE_REAL_GIT"];

afterEach(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env["BOXERS_HOME"];
  else process.env["BOXERS_HOME"] = originalHome;
  process.env.PATH = originalPath;
  if (originalGit === undefined) delete process.env["FAKE_REAL_GIT"];
  else process.env["FAKE_REAL_GIT"] = originalGit;
  delete process.env.FAKE_WORKSPACE;
  delete process.env.FAKE_SBX_LOG;
  delete process.env.FAKE_SBX_STATUS;
  delete process.env.FAKE_SBX_INVENTORY;
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  targetRoots.clear();
  vi.restoreAllMocks();
});

function git(cwd: string, ...args: string[]): string {
  const result = execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  // Commits in these fixture roots represent external target advances.
  // Task promotions are asserted against the separate bare remote.
  if (args[0] === "commit" && targetRoots.has(cwd))
    execFileSync("git", ["-C", cwd, "push", "-q", "origin", "main"]);
  return result;
}

function registerTarget(root: string) {
  const remote = mkdtempSync(join(tmpdir(), "boxers-test-target-"));
  cleanup.push(remote);
  git(remote, "init", "--bare", "-q");
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "-q", "origin", "main");
  targetRoots.add(root);
  return initProject({ base: "main", remote: "origin", cwd: root });
}

function target(root: string): string {
  return git(root, "remote", "get-url", "origin");
}

function installFakeSbx(bin: string): void {
  const executable = join(bin, "sbx");
  const fakeAgent = join(bin, "codex");
  writeFileSync(
    fakeAgent,
    `#!/bin/sh
cat >/dev/null
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"subject\\":\\"Update tracked files and assets\\",\\"note\\":\\"Preserve tracked, untracked, binary, and deleted content in one exact candidate snapshot.\\"}"}}'
`,
  );
  chmodSync(fakeAgent, 0o755);
  writeFileSync(
    executable,
    `#!/bin/sh
command_name="$1"
shift
if [ -n "$FAKE_SBX_LOG" ]; then
  printf '%s' "$command_name" >> "$FAKE_SBX_LOG"
  for arg in "$@"; do printf ' <%s>' "$arg" >> "$FAKE_SBX_LOG"; done
  printf '\n' >> "$FAKE_SBX_LOG"
fi
case "$command_name" in
  ls)
    if test -n "$FAKE_SBX_INVENTORY"; then printf '%s\\n' "$FAKE_SBX_INVENTORY"; exit 0; fi
    printf '{"sandboxes":[{"name":"boxers-project-task","status":"%s"}]}\\n' "\${FAKE_SBX_STATUS:-running}"
    ;;
  stop|run|rm)
    ;;
  ports)
    case " $* " in
      *" --json "*) printf '{"ports":[{"host_port":45173}]}\\n' ;;
    esac
    ;;
  exec)
    if [ "$1" = "-d" ]; then
      shift
      shift
      cd "$FAKE_WORKSPACE"
      "$@" >/dev/null 2>&1 </dev/null &
      exit 0
    fi
    shift
    cd "$FAKE_WORKSPACE"
    exec "$@"
    ;;
  *)
    printf 'unsupported sbx command: %s\\n' "$command_name" >&2
    exit 1
    ;;
esac
`,
  );
  chmodSync(executable, 0o755);
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
}

function useFakeRuntime(
  task: ReturnType<typeof createTaskManifest>,
  id = "boxers-project-task",
): void {
  task.runtime.id = id;
  task.runtime = { kind: "docker-sandboxes", id };
}

function reconciliationFixture(agent: "codex" | "claude" = "codex") {
  const root = mkdtempSync(join(tmpdir(), "boxers-reconcile-root-"));
  const state = mkdtempSync(join(tmpdir(), "boxers-reconcile-state-"));
  const workspace = mkdtempSync(join(tmpdir(), "boxers-reconcile-workspace-"));
  const bin = mkdtempSync(join(tmpdir(), "boxers-reconcile-bin-"));
  cleanup.push(root, state, workspace, bin);
  process.env.BOXERS_HOME = state;
  process.env.FAKE_WORKSPACE = workspace;
  process.chdir(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Test User");
  git(root, "config", "user.email", "test@example.invalid");
  mkdirSync(join(root, ".boxers"));
  writeFileSync(join(root, ".boxers", "config.yml"), "version: 3\n");
  writeFileSync(join(root, "tracked.txt"), "base\n");
  writeFileSync(join(root, ".gitignore"), "ignored.txt\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "base");
  const project = registerTarget(root);
  git(workspace, "clone", "-q", project.seedPath, ".");
  installFakeSbx(bin);
  const task = createTaskManifest(project, "native", agent);
  useFakeRuntime(task);
  const baseOid = git(root, "rev-parse", "HEAD");
  updateTask(project, task, { phase: "idle", agent, targetOid: baseOid });
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  return { root, project, task, workspace, bin, baseOid };
}

function correctiveRepairFixture(correction = "correct repair", extraCorrection = "") {
  const fixture = reconciliationFixture();
  const { root, workspace, bin } = fixture;
  writeFileSync(join(workspace, "tracked.txt"), "task increment\n");
  writeFileSync(join(root, "tracked.txt"), "upstream change\n");
  writeFileSync(
    join(root, ".boxers/config.yml"),
    "version: 3\ncheck:\n  commands:\n    verify:\n      run: grep -q '^correct repair$' tracked.txt\n      timeout: 10s\n",
  );
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "conflicting target with checks");
  writeFileSync(
    join(bin, "codex"),
    `#!/bin/sh
count_file="$FAKE_WORKSPACE/.git/repair-count"
if test -f "$count_file"; then
  printf '2' > "$count_file"
  printf '%s\n' '${correction}' > "$FAKE_WORKSPACE/tracked.txt"
  ${extraCorrection}
else
  printf '1' > "$count_file"
  printf 'bad first repair\n' > "$FAKE_WORKSPACE/tracked.txt"
fi
git -C "$FAKE_WORKSPACE" add tracked.txt
`,
  );
  chmodSync(join(bin, "codex"), 0o755);
  return fixture;
}

function remotePromotionFixture() {
  const fixture = reconciliationFixture();
  const remote = target(fixture.root);
  const project = fixture.project;
  writeFileSync(join(fixture.workspace, "tracked.txt"), "increment\n");
  process.env.FAKE_REAL_GIT = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  return { ...fixture, project, remote };
}

describe("native review, promotion, and preview", () => {
  it("plain status fetches the target during generation without entering the Sandbox", async () => {
    const { root, project, task, bin, workspace, baseOid } = reconciliationFixture();
    const trace = join(bin, "status-sbx.log");
    process.env.FAKE_SBX_LOG = trace;
    recordLifecycleEvent(project, task, {
      version: 1,
      sequence: 1,
      event: {
        version: 1,
        kind: "user_prompt",
        provider: "codex",
        providerSessionId: "session",
        prompt: "work",
        recordedAt: new Date().toISOString(),
      },
      source: { provider: "codex", hookEvent: "UserPromptSubmit", rawBytes: 1 },
    });
    writeFileSync(join(workspace, "tracked.txt"), "working increment\n");
    writeFileSync(join(root, "upstream.txt"), "latest\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "upstream");
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await expect(status("native", true)).resolves.toBe(0);
    const result = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
    expect(result.view.target).toMatchObject({
      state: "observed",
      installedOid: baseOid,
      observedOid: git(root, "rev-parse", "HEAD"),
    });
    expect(result.view.reconciliation.state).toBe("queued");
    expect(result.view.agent.state).toBe("working");
    expect(existsSync(trace)).toBe(false);
    expect(git(workspace, "rev-parse", "HEAD")).toBe(baseOid);
    expect(readFileSync(join(workspace, "tracked.txt"), "utf8")).toBe("working increment\n");
  });

  it("retains the last target observation and reports offline freshness explicitly", async () => {
    const { root, project, baseOid } = reconciliationFixture();
    const observedAt = readProjectTarget(project)?.observedAt;
    git(root, "remote", "set-url", "origin", join(root, "unreachable.git"));
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await expect(status("native", true)).resolves.toBe(1);
    const result = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
    expect(result.view.target).toMatchObject({
      state: "unavailable",
      observedOid: baseOid,
      observedAt,
    });
    expect(result.view.reconciliation.state).toBe("failed");
    expect(result.view.issues).toContainEqual(
      expect.objectContaining({ code: "target_refresh_failed" }),
    );
    expect(projectTaskView(project, requireTask(project, "native")).target?.state).toBe(
      "unavailable",
    );
  });

  it("bounds target fetch time and keeps the previous successful observation", async () => {
    const { bin, project, baseOid } = reconciliationFixture();
    process.env.FAKE_REAL_GIT = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(bin, "git"),
      '#!/bin/sh\nif test "$3" = fetch; then exec sleep 10; fi\nexec "$FAKE_REAL_GIT" "$@"\n',
    );
    chmodSync(join(bin, "git"), 0o755);
    const start = Date.now();
    await expect(status("native", true)).resolves.toBe(1);
    expect(Date.now() - start).toBeLessThan(5_000);
    expect(readProjectTarget(project)).toMatchObject({
      oid: baseOid,
      failure: expect.stringContaining("ETIMEDOUT"),
    });
  }, 10_000);

  it("does not publish credential-bearing fetch failures or retain failed-fetch metadata", async () => {
    const { root, bin, project } = reconciliationFixture();
    const secret = "test-only-credential";
    git(root, "remote", "set-url", "origin", `https://user:${secret}@example.invalid/repo`);
    process.env.FAKE_REAL_GIT = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh
if test "$3" = fetch; then
  printf '%s\\n' '${secret}' > "$2/.git/FETCH_HEAD"
  printf '%s\\n' 'https://user:${secret}@example.invalid/repo helper token ${secret}' >&2
  exit 1
fi
exec "$FAKE_REAL_GIT" "$@"
`,
    );
    chmodSync(join(bin, "git"), 0o755);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await expect(status("native", true)).resolves.toBe(1);
    const output = String(stdout.mock.calls.at(-1)?.[0]);
    expect(output).toContain("target_refresh_failed");
    expect(output).not.toContain(secret);
    expect(JSON.stringify(readProjectTarget(project))).not.toContain(secret);
    expect(existsSync(join(project.seedPath, ".git/FETCH_HEAD"))).toBe(false);
  });

  it.each(["rev-parse", "remote", "config"])(
    "bounds status when the target's %s metadata command stalls",
    async (operation) => {
      const { bin, project, baseOid } = reconciliationFixture();
      const observedAt = readProjectTarget(project)?.observedAt;
      process.env.FAKE_REAL_GIT = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
      writeFileSync(
        join(bin, "git"),
        `#!/bin/sh\nif test "$3" = ${operation}; then exec sleep 10; fi\nexec "$FAKE_REAL_GIT" "$@"\n`,
      );
      chmodSync(join(bin, "git"), 0o755);
      const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const started = Date.now();
      await expect(status("native", true)).resolves.toBe(1);
      expect(Date.now() - started).toBeLessThan(5_000);
      const view = JSON.parse(String(stdout.mock.calls.at(-1)?.[0])).view;
      expect(view.target).toMatchObject({
        state: "unavailable",
        observedOid: baseOid,
        observedAt,
        failure: expect.stringContaining("ETIMEDOUT"),
      });
      expect(readProjectTarget(project)).toMatchObject({
        oid: baseOid,
        observedAt,
        failure: expect.stringContaining("ETIMEDOUT"),
      });
      expect(existsSync(join(project.seedPath, ".git/FETCH_HEAD"))).toBe(false);
    },
    10_000,
  );

  it("returns status during another process's seed transaction without overwriting its observation", async () => {
    const { project } = reconciliationFixture();
    const previous = readProjectTarget(project);
    const module = pathToFileURL(join(originalCwd, "src/v2/lock.ts")).href;
    const holder = spawn(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        "--input-type=module",
        "-e",
        `
import { acquirePidFileLock } from ${JSON.stringify(module)};
const release = acquirePidFileLock(${JSON.stringify(projectSeedLockPath(project.id))});
process.send('ready');
process.once('message', () => { release(); process.disconnect(); });
`,
      ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    const closed = once(holder, "close");
    try {
      await once(holder, "message");
      const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const started = Date.now();
      await expect(status("native", true)).resolves.toBe(1);
      expect(Date.now() - started).toBeLessThan(4_500);
      const view = JSON.parse(String(stdout.mock.calls.at(-1)?.[0])).view;
      expect(view.target.state).toBe("unavailable");
      expect(view.target.failure).toContain("Timed out waiting");
      expect(readProjectTarget(project)).toEqual(previous);
      expect(holder.exitCode).toBeNull();
    } finally {
      if (holder.connected) holder.send("release");
      else if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
      await closed;
    }
  }, 10_000);

  it("both status forms return with live repair state without waiting for its worker", async () => {
    const { project, task, root, bin, workspace } = reconciliationFixture();
    const marker = taskReconciliationPath(project.id, task.id);
    const releasePath = join(bin, "release-repair");
    const entry = join(bin, "repair-worker.mjs");
    const ownershipModule = pathToFileURL(join(originalCwd, "src/v2/worker-ownership.ts")).href;
    writeFileSync(
      entry,
      `
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { enableWorkerWorkspaceOwnership, withWorkerWorkspaceMutation } from ${JSON.stringify(ownershipModule)};
enableWorkerWorkspaceOwnership();
await withWorkerWorkspaceMutation(() => {
  writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ checkpointOid: 'retained', pid: process.pid }));
  process.send({ type: 'boxers-worker-progress', phase: 'reconciling' });
  const deadline = Date.now() + 15000;
  while (!existsSync(${JSON.stringify(releasePath)})) {
    if (Date.now() > deadline) throw new Error('Test repair was not released');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  unlinkSync(${JSON.stringify(marker)});
});
process.send({ type: 'boxers-worker-result' });
process.disconnect();
`,
    );
    const daemon = runDaemon(daemonSocketPath(), {
      startupInventory: async () => [{ ...task.runtime, state: "running" }],
      ingestLifecycle: async () => [],
      executePostTurn: (name, sequence, signal, progress, targetChanged, ownership) =>
        postTurnInWorker(
          name,
          sequence,
          signal,
          progress,
          { entry, execArgv: ["--import", import.meta.resolve("tsx")] },
          targetChanged,
          ownership,
        ),
    });
    try {
      writeFileSync(join(root, "upstream.txt"), "latest\n");
      git(root, "add", ".");
      git(root, "commit", "-q", "-m", "upstream");
      refreshSeed(project);
      await expect.poll(() => existsSync(marker)).toBe(true);
      const workerPid = JSON.parse(readFileSync(marker, "utf8")).pid;
      expect(workerPid).not.toBe(process.pid);
      const trace = join(bin, "repair-status.log");
      process.env.FAKE_SBX_LOG = trace;
      const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      for (const refresh of [false, true]) {
        await expect(status("native", true, refresh)).resolves.toBe(0);
        const result = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
        expect(result.view.reconciliation.state).toBe("running");
        expect(result.view.operations).toContainEqual(
          expect.objectContaining({ kind: "reconciling", state: "running" }),
        );
        expect(existsSync(marker)).toBe(true);
        expect(() => process.kill(workerPid, 0)).not.toThrow();
      }
      expect(readFileSync(trace, "utf8")).not.toContain("exec");
      expect(existsSync(join(workspace, "upstream.txt"))).toBe(false);
    } finally {
      writeFileSync(releasePath, "release");
      await daemon.close();
    }
  });

  it("rechecks daemon activity after runtime inventory before observing the workspace", async () => {
    const { task, bin } = reconciliationFixture();
    let release!: () => void;
    const operation = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    const inventory = [{ ...task.runtime, state: "running" as const }];
    const daemon = runDaemon(daemonSocketPath(), {
      startupInventory: async () => inventory,
      ingestLifecycle: async () => [],
      executeIntent: async () => {
        started = true;
        await operation;
        return 0;
      },
    });
    const client = connect(daemonSocketPath());
    client.on("data", () => {});
    try {
      await once(client, "connect");
      vi.spyOn(runtimeTasks, "runtimeInventoryAsync").mockImplementation(async () => {
        client.write(
          `${JSON.stringify({ type: "run_intent", intentId: "racing-check", task: task.name, intent: { kind: "check" } })}\n`,
        );
        await expect.poll(() => started).toBe(true);
        return inventory;
      });
      const trace = join(bin, "racing-status.log");
      process.env.FAKE_SBX_LOG = trace;
      const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      await expect(status("native", true, true)).resolves.toBe(0);
      const view = JSON.parse(String(stdout.mock.calls.at(-1)?.[0])).view;
      expect(view.operations).toContainEqual(
        expect.objectContaining({ kind: "running_checks", state: "running" }),
      );
      expect(existsSync(trace)).toBe(false);
    } finally {
      release();
      client.destroy();
      await daemon.close();
    }
  });

  it.each(["during_read", "before_render"])(
    "discards status workspace observations when a new turn arrives %s",
    async (timing) => {
      const { project, task } = reconciliationFixture();
      updateTaskState(project, task, { hasUnmergedChanges: "unknown" }, "git");
      const original = runtimeTasks.taskWorkspaceTreeAt;
      const startTurn = () =>
        recordLifecycleEvent(project, task, {
          version: 1,
          sequence: 1,
          event: {
            version: 1,
            kind: "user_prompt",
            provider: "codex",
            providerSessionId: "session",
            prompt: "continue",
            recordedAt: new Date().toISOString(),
          },
          source: { provider: "codex", hookEvent: "UserPromptSubmit", rawBytes: 1 },
        });
      vi.spyOn(runtimeTasks, "taskWorkspaceTreeAt").mockImplementation((candidate, directory) => {
        if (timing === "during_read") {
          startTurn();
          throw new Error("Index changed during observation");
        }
        const tree = original(candidate, directory);
        queueMicrotask(startTurn);
        return tree;
      });
      const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      await expect(status("native", true, true)).resolves.toBe(0);
      const result = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
      expect(result.view.agent.state).toBe("working");
      expect(result.view.changes.state).toBe("unknown");
      expect(readTaskState(project, task).candidateTreeOid).toBeUndefined();
    },
  );

  it("promotes through a target hint into a real sibling worker without waking stopped or unrelated tasks", async () => {
    const { project, task, bin, workspace, baseOid, remote } = remotePromotionFixture();
    const siblingWorkspace = mkdtempSync(join(tmpdir(), "boxers-sibling-workspace-"));
    const unrelatedRoot = mkdtempSync(join(tmpdir(), "boxers-unrelated-root-"));
    cleanup.push(siblingWorkspace, unrelatedRoot);
    git(siblingWorkspace, "clone", "-q", project.seedPath, ".");
    writeFileSync(join(siblingWorkspace, "sibling.txt"), "keep sibling increment\n");
    const sibling = createTaskManifest(project, "sibling", "codex");
    useFakeRuntime(sibling, "boxers-project-sibling");
    updateTask(project, sibling, {
      phase: "idle",
      agent: "codex",
      targetOid: baseOid,
      runtimeState: "running",
    });
    const stopped = createTaskManifest(project, "stopped-sibling", "codex");
    useFakeRuntime(stopped, "boxers-project-stopped");
    updateTask(project, stopped, {
      phase: "idle",
      agent: "codex",
      targetOid: baseOid,
      runtimeState: "stopped",
    });
    git(unrelatedRoot, "init", "-q", "-b", "main");
    git(unrelatedRoot, "config", "user.name", "Test");
    git(unrelatedRoot, "config", "user.email", "test@example.invalid");
    git(unrelatedRoot, "commit", "--allow-empty", "-q", "-m", "unrelated");
    const unrelatedProject = registerTarget(unrelatedRoot);
    const unrelated = createTaskManifest(unrelatedProject, "unrelated", "codex");
    useFakeRuntime(unrelated, "boxers-unrelated-task");
    const unrelatedBase = git(unrelatedRoot, "rev-parse", "HEAD");
    updateTask(unrelatedProject, unrelated, {
      phase: "idle",
      agent: "codex",
      targetOid: unrelatedBase,
      runtimeState: "running",
    });
    const inventory = [task, sibling, stopped, unrelated].map((candidate) => ({
      ...candidate.runtime,
      state: candidate.id === stopped.id ? ("stopped" as const) : ("running" as const),
    }));
    process.env.FAKE_SBX_INVENTORY = JSON.stringify({
      sandboxes: inventory.map((info) => ({ name: info.id, status: info.state })),
    });
    const entry = join(bin, "sibling-worker.mjs");
    writeFileSync(
      entry,
      `
const payload = JSON.parse(Buffer.from(process.argv[3], 'base64').toString('utf8'));
if (payload.taskName !== 'sibling') throw new Error('Unexpected task worker: ' + payload.taskName);
process.env.FAKE_WORKSPACE = ${JSON.stringify(siblingWorkspace)};
await import(${JSON.stringify(pathToFileURL(join(originalCwd, "src/index.ts")).href)});
`,
    );
    const launches: string[] = [];
    const completions: Promise<unknown>[] = [];
    const daemon = runDaemon(daemonSocketPath(), {
      startupInventory: async () => inventory,
      ingestLifecycle: async () => [],
      executePostTurn: (name, sequence, signal, progress, targetChanged, ownership) => {
        launches.push(name);
        const pending = postTurnInWorker(
          name,
          sequence,
          signal,
          progress,
          { entry, execArgv: ["--import", import.meta.resolve("tsx")] },
          targetChanged,
          ownership,
        );
        completions.push(pending);
        return pending;
      },
    });
    try {
      await expect(promote("native", "first increment")).resolves.toBe(0);
      const accepted = git(remote, "rev-parse", "main");
      await expect.poll(() => launches).toEqual(["sibling"]);
      await Promise.all(completions);
      expect(readTaskState(project, requireTask(project, sibling.name))).toMatchObject({
        baseOid: accepted,
        candidateTreeOid: expect.any(String),
      });
      expect(git(siblingWorkspace, "rev-parse", "HEAD")).toBe(accepted);
      expect(readFileSync(join(siblingWorkspace, "tracked.txt"), "utf8")).toBe("increment\n");
      expect(readFileSync(join(siblingWorkspace, "sibling.txt"), "utf8")).toBe(
        "keep sibling increment\n",
      );
      expect(git(workspace, "rev-parse", "HEAD")).toBe(accepted);
      expect(readTaskState(project, requireTask(project, stopped.name)).baseOid).toBe(baseOid);
      expect(
        readTaskState(unrelatedProject, requireTask(unrelatedProject, unrelated.name)).baseOid,
      ).toBe(unrelatedBase);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(launches).toEqual(["sibling"]);
    } finally {
      await daemon.close();
    }
  }, 15_000);

  it("status exposes an uncertain interrupted reconciliation without attempting recovery", async () => {
    const { project, task, bin } = reconciliationFixture();
    writeFileSync(taskReconciliationPath(project.id, task.id), "{}\n");
    const trace = join(bin, "status.log");
    process.env.FAKE_SBX_LOG = trace;
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await expect(status("native", true)).resolves.toBe(1);
    const result = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
    expect(result.view.reconciliation.state).toBe("failed");
    expect(result.view.issues).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("mutation outcome is unknown") }),
    );
    expect(existsSync(trace)).toBe(false);
  });

  it("rejects a racing target push and reconciles on the next explicit promotion", async () => {
    const { project, task, bin, workspace, remote } = remotePromotionFixture();
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh
if test "$3" = push; then
  parent=$("$FAKE_REAL_GIT" -C '${remote}' rev-parse main)
  tree=$("$FAKE_REAL_GIT" -C '${remote}' rev-parse "$parent^{tree}")
  next=$("$FAKE_REAL_GIT" -C '${remote}' -c user.name=Test -c user.email=test@example.invalid commit-tree "$tree" -p "$parent" -m competing)
  "$FAKE_REAL_GIT" -C '${remote}' update-ref refs/heads/main "$next" "$parent"
fi
exec "$FAKE_REAL_GIT" "$@"
`,
    );
    chmodSync(join(bin, "git"), 0o755);
    await expect(promote("native", "increment")).rejects.toThrow("Target push was not accepted");
    const upstream = git(remote, "rev-parse", "main");
    expect(readFileSync(join(workspace, "tracked.txt"), "utf8")).toBe("increment\n");
    expect(readTaskState(project, task).lastDelivery).toBeUndefined();
    unlinkSync(join(bin, "git"));
    await expect(promote("native", "increment")).resolves.toBe(0);
    expect(git(remote, "rev-parse", "main^")).toBe(upstream);
    expect(git(remote, "rev-list", "--count", "main")).toBe("3");
    expect(git(remote, "show", "main:tracked.txt")).toBe("increment");
  });

  it("does not retry a rejected push from sync, and promote retries the same commit", async () => {
    const { project, task, bin, remote, workspace } = remotePromotionFixture();
    const trace = join(bin, "pushes");
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh
if test "$3" = push; then printf '%s\\n' "$*" >> '${trace}'; fi
exec "$FAKE_REAL_GIT" "$@"
`,
    );
    chmodSync(join(bin, "git"), 0o755);
    const hook = join(remote, "hooks/pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho 'protected branch' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    await expect(promote("native", "increment")).rejects.toThrow("protected branch");
    const pending = JSON.parse(readFileSync(taskDeliveryPath(project.id, task.id), "utf8"));
    await expect(sync("native")).rejects.toThrow("delivery push is still unconfirmed");
    expect(readFileSync(trace, "utf8").trim().split("\n")).toHaveLength(1);
    unlinkSync(hook);
    await expect(promote("native", "a retry must not create this commit")).resolves.toBe(0);
    const pushes = readFileSync(trace, "utf8").trim().split("\n");
    expect(pushes).toHaveLength(2);
    expect(pushes[0]).toBe(pushes[1]);
    expect(pushes[0]).not.toContain("--force");
    expect(git(remote, "rev-parse", "main")).toBe(pending.commitOid);
    expect(git(workspace, "rev-parse", "HEAD")).toBe(pending.commitOid);
  });

  it("sync finishes an accepted delivery without another push", async () => {
    const { project, task, bin, remote } = remotePromotionFixture();
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh
if test "$PWD" = "$FAKE_WORKSPACE" && test "$1" = fetch; then exit 1; fi
exec "$FAKE_REAL_GIT" "$@"
`,
    );
    chmodSync(join(bin, "git"), 0o755);
    await expect(promote("native", "increment")).resolves.toBe(1);
    const accepted = git(remote, "rev-parse", "main");
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh
if test "$3" = push; then touch '${bin}/unexpected-push'; exit 1; fi
exec "$FAKE_REAL_GIT" "$@"
`,
    );
    await expect(sync("native")).resolves.toBe(0);
    expect(existsSync(join(bin, "unexpected-push"))).toBe(false);
    expect(readTaskState(project, task).baseOid).toBe(accepted);
    expect(existsSync(taskDeliveryPath(project.id, task.id))).toBe(false);
  });

  it("never executes inside a stopped Sandbox for a target-change hint", async () => {
    const { root, bin, workspace } = reconciliationFixture();
    writeFileSync(join(root, "upstream.txt"), "new target\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "advance");
    const trace = join(bin, "sbx.log");
    process.env.FAKE_SBX_LOG = trace;
    process.env.FAKE_SBX_STATUS = "stopped";
    await expect(runPostTurn("native", 0, undefined, true)).resolves.toEqual({ deferred: true });
    expect(readFileSync(trace, "utf8")).not.toContain("exec");
    expect(existsSync(join(workspace, "upstream.txt"))).toBe(false);
    process.env.FAKE_SBX_STATUS = "running";
    await expect(runPostTurn("native", 0, undefined, true)).resolves.toHaveProperty("targetOid");
    expect(readFileSync(join(workspace, "upstream.txt"), "utf8")).toBe("new target\n");
  });

  it.each([false, true])(
    "does not duplicate an accepted push after a lost response (failed confirmation: %s)",
    async (failConfirmation) => {
      const { project, task, bin, remote } = remotePromotionFixture();
      const pushedMarker = join(bin, "pushed");
      writeFileSync(
        join(bin, "git"),
        `#!/bin/sh
if test "$3" = push; then
  "$FAKE_REAL_GIT" "$@" || exit $?
  touch '${pushedMarker}'
  exit 1
fi
if test '${failConfirmation}' = true && test "$3" = fetch && test -f '${pushedMarker}'; then exit 1; fi
exec "$FAKE_REAL_GIT" "$@"
`,
      );
      chmodSync(join(bin, "git"), 0o755);
      if (failConfirmation)
        await expect(promote("native", "increment")).rejects.toThrow("Could not refresh");
      else await expect(promote("native", "increment")).resolves.toBe(0);
      const accepted = git(remote, "rev-parse", "main");
      unlinkSync(join(bin, "git"));
      await expect(promote("native", "do not duplicate")).resolves.toBe(0);
      expect(git(remote, "rev-parse", "main")).toBe(accepted);
      expect(git(remote, "rev-list", "--count", "main")).toBe("2");
      expect(readTaskState(project, requireTask(project, task.name)).lastDelivery?.value.oid).toBe(
        accepted,
      );
      expect(existsSync(taskDeliveryPath(project.id, task.id))).toBe(false);
    },
  );

  it("records acceptance before advancement and resumes without losing newer edits", async () => {
    const { root, project, task, bin, workspace, remote, baseOid } = remotePromotionFixture();
    writeFileSync(join(root, "tracked.txt"), "unrelated host edit\n");
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh
if test "$PWD" = "$FAKE_WORKSPACE" && test "$1" = fetch; then exit 1; fi
exec "$FAKE_REAL_GIT" "$@"
`,
    );
    chmodSync(join(bin, "git"), 0o755);
    await expect(promote("native", "increment")).resolves.toBe(1);
    const accepted = git(remote, "rev-parse", "main");
    expect(readTaskState(project, requireTask(project, task.name))).toMatchObject({
      baseOid,
      lastDelivery: { value: { oid: accepted } },
      failure: expect.stringContaining("workspace reconciliation pending"),
    });
    expect(JSON.parse(readFileSync(taskDeliveryPath(project.id, task.id), "utf8"))).toMatchObject({
      acceptedAt: expect.any(String),
    });
    expect(existsSync(taskReconciliationPath(project.id, task.id))).toBe(false);
    unlinkSync(join(bin, "git"));
    writeFileSync(join(workspace, "tracked.txt"), "newer agent edit\n");
    writeFileSync(projectPromotionLockPath(project.id), "99999999\ninterrupted-test\n");
    await expect(promote("native", "retry accepted increment")).resolves.toBe(0);
    expect(git(remote, "rev-list", "--count", "main")).toBe("2");
    expect(git(workspace, "rev-parse", "HEAD")).toBe(accepted);
    expect(readFileSync(join(workspace, "tracked.txt"), "utf8")).toBe("newer agent edit\n");
    expect(readFileSync(join(root, "tracked.txt"), "utf8")).toBe("unrelated host edit\n");
  });

  it("retains delivered work and blocks generation when advancement has no terminal receipt", async () => {
    const { project, task, bin, workspace, remote, baseOid } = remotePromotionFixture();
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh
if test "$PWD" = "$FAKE_WORKSPACE" && test "$1" = reset && test "$2" = --mixed; then
  "$FAKE_REAL_GIT" "$@" || exit $?
  kill -KILL "$PPID"
  exit 1
fi
exec "$FAKE_REAL_GIT" "$@"
`,
    );
    chmodSync(join(bin, "git"), 0o755);
    await expect(promote("native", "increment")).resolves.toBe(1);
    const accepted = git(remote, "rev-parse", "main");
    expect(git(workspace, "rev-parse", "HEAD")).toBe(accepted);
    expect(readTaskState(project, requireTask(project, task.name))).toMatchObject({
      baseOid,
      lastDelivery: { value: { oid: accepted } },
    });
    const marker = taskReconciliationPath(project.id, task.id);
    expect(JSON.parse(readFileSync(marker, "utf8"))).toMatchObject({
      kind: "delivery_advance",
      checkpointOid: accepted,
    });
    expect(projectTaskView(project, requireTask(project, task.name)).removal.state).toBe(
      "blocked_by_activity",
    );
    await expect(promote("native", "do not duplicate")).rejects.toThrow(
      "unfinished reconciliation",
    );
    await expect(sync("native")).rejects.toThrow("unfinished reconciliation");
    expect(git(remote, "rev-list", "--count", "main")).toBe("2");
    await expect(discard("native", true)).resolves.toBe(0);
    expect(git(remote, "rev-parse", "main")).toBe(accepted);
  });

  it("retains advancement ownership when the host worker dies while its mutator is still alive", async () => {
    const { project, task, bin, workspace, remote } = remotePromotionFixture();
    const started = join(bin, "advancement-started");
    const release = join(bin, "release-advancement");
    const ended = join(bin, "advancement-ended");
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh
if test "$PWD" = "$FAKE_WORKSPACE" && test "$1" = reset && test "$2" = --mixed; then
  "$FAKE_REAL_GIT" "$@" || exit $?
  printf '%s\\n' "$$" > '${started}'
  while ! test -f '${release}'; do sleep 0.02; done
  touch '${ended}'
  exit 0
fi
exec "$FAKE_REAL_GIT" "$@"
`,
    );
    chmodSync(join(bin, "git"), 0o755);
    let workerPid: number | undefined;
    const completion = executeIntentInWorker(
      "native",
      { kind: "promote", message: "increment", skipChecks: false },
      { stdout() {}, stderr() {} },
      {
        entry: join(originalCwd, "src/index.ts"),
        execArgv: ["--import", import.meta.resolve("tsx")],
      },
      (pid) => {
        workerPid = pid;
      },
    ).then(
      (code) => ({ code, error: undefined }),
      (error) => ({ code: undefined, error }),
    );
    try {
      await expect.poll(() => existsSync(started), { timeout: 10_000 }).toBe(true);
      const mutatorPid = Number(readFileSync(started, "utf8").trim());
      expect(workerPid).toEqual(expect.any(Number));
      process.kill(workerPid!, "SIGKILL");
      expect((await completion).error).toHaveProperty(
        "message",
        expect.stringContaining("SIGKILL"),
      );
      expect(() => process.kill(mutatorPid, 0)).not.toThrow();
      const accepted = git(remote, "rev-parse", "main");
      expect(git(workspace, "rev-parse", "HEAD")).toBe(accepted);
      expect(readTaskState(project, requireTask(project, task.name)).lastDelivery?.value.oid).toBe(
        accepted,
      );
      expect(existsSync(taskReconciliationPath(project.id, task.id))).toBe(true);
      await expect(promote("native", "do not duplicate")).rejects.toThrow(
        "unfinished reconciliation",
      );
    } finally {
      writeFileSync(release, "release");
      if (existsSync(started)) await expect.poll(() => existsSync(ended)).toBe(true);
      await completion;
    }
  }, 15_000);

  it("installs the exact accepted commit when another writer immediately advances the target", async () => {
    const { project, task, bin, workspace, remote } = remotePromotionFixture();
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh
if test "$3" = push; then
  "$FAKE_REAL_GIT" "$@" || exit $?
  accepted=$("$FAKE_REAL_GIT" -C '${remote}' rev-parse main)
  tree=$("$FAKE_REAL_GIT" -C '${remote}' rev-parse "$accepted^{tree}")
  next=$("$FAKE_REAL_GIT" -C '${remote}' -c user.name=Test -c user.email=test@example.invalid commit-tree "$tree" -p "$accepted" -m sibling)
  "$FAKE_REAL_GIT" -C '${remote}' update-ref refs/heads/main "$next" "$accepted"
  exit 0
fi
exec "$FAKE_REAL_GIT" "$@"
`,
    );
    chmodSync(join(bin, "git"), 0o755);
    await expect(promote("native", "increment")).resolves.toBe(0);
    const latest = git(remote, "rev-parse", "main");
    const accepted = git(remote, "rev-parse", "main^");
    expect(git(workspace, "rev-parse", "HEAD")).toBe(accepted);
    expect(readTaskState(project, requireTask(project, task.name))).toMatchObject({
      baseOid: accepted,
      observedTargetOid: latest,
    });
  });
  it("allows one check-driven correction and promotes the corrected tree", async () => {
    const { root, project, task, workspace } = correctiveRepairFixture();
    await expect(review("native", false)).resolves.toBe(0);
    const firstTree = requireTask(project, "native").lastSnapshot?.candidateTreeOid;
    expect(requireTask(project, "native").lastSnapshot?.check).toBeUndefined();
    expect(readFileSync(join(workspace, ".git/repair-count"), "utf8")).toBe("1");
    await expect(promote("native", "Correct increment")).resolves.toBe(0);
    expect(git(target(root), "show", "main:tracked.txt")).toBe("correct repair");
    expect(git(target(root), "rev-parse", "main^{tree}")).not.toBe(firstTree);
    expect(readFileSync(join(workspace, ".git/repair-count"), "utf8")).toBe("2");
    expect(existsSync(taskRepairStatePath(project.id, task.id))).toBe(false);
    expect(existsSync(taskReconciliationPath(project.id, task.id))).toBe(false);
  });

  it("does not restart exhausted repair after repeated checks or another target change", async () => {
    const { root, workspace } = correctiveRepairFixture("still wrong");
    await expect(check("native")).resolves.toBe(1);
    expect(readFileSync(join(workspace, ".git/repair-count"), "utf8")).toBe("2");
    // A third invocation would overwrite this sentinel in the fake provider.
    writeFileSync(join(workspace, ".git/repair-count"), "exhausted");
    await expect(check("native")).resolves.toBe(1);
    await expect(refreshAutomaticCheck("native")).resolves.toMatchObject({
      check: { status: "failed" },
    });
    expect(readFileSync(join(workspace, ".git/repair-count"), "utf8")).toBe("exhausted");
    writeFileSync(join(root, "tracked.txt"), "another upstream change\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "target advances again");
    await expect(sync("native")).resolves.toBe(1);
    expect(readFileSync(join(workspace, ".git/repair-count"), "utf8")).toBe("exhausted");
  });

  it("does not turn ordinary failing checks into an automatic repair session", async () => {
    const { root, workspace, bin } = reconciliationFixture();
    writeFileSync(join(bin, "codex"), '#!/bin/sh\ntouch "$FAKE_WORKSPACE/.git/repair-count"\n');
    writeFileSync(
      join(root, ".boxers/config.yml"),
      "version: 3\ncheck:\n  commands:\n    failing: exit 1\n",
    );
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "add failing check without conflict");
    writeFileSync(join(workspace, "tracked.txt"), "normal increment\n");
    await expect(check("native")).resolves.toBe(1);
    expect(existsSync(join(workspace, ".git/repair-count"))).toBe(false);
  });

  it("retains a recovery checkpoint if correction expands beyond the conflict paths", async () => {
    const { project, task } = correctiveRepairFixture(
      "correct repair",
      'printf unrelated > "$FAKE_WORKSPACE/unrelated.txt"',
    );
    await expect(check("native")).rejects.toThrow("modified unrelated paths");
    const marker = JSON.parse(readFileSync(taskReconciliationPath(project.id, task.id), "utf8"));
    expect(git(project.seedPath, "show", `${marker.checkpointOid}:tracked.txt`)).toBe(
      "bad first repair",
    );
    expect(git(project.seedPath, "rev-parse", `refs/boxers/correction/${task.id}`)).toBe(
      marker.checkpointOid,
    );
    await expect(review("native", false)).rejects.toThrow("unfinished reconciliation");
  });

  it("installs target files before starting that target's new setup command", async () => {
    const { root, project, workspace } = reconciliationFixture();
    writeFileSync(join(root, "upstream.txt"), "required by new setup\n");
    writeFileSync(
      join(root, ".boxers/config.yml"),
      "version: 3\nsetup:\n  run: test -f upstream.txt\n  timeout: 10s\n",
    );
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "new setup needs target files");
    await expect(sync("native")).resolves.toBe(0);
    const task = requireTask(project, "native");
    await waitForSetup(task);
    expect(readSetupStatus(task)?.state).toBe("passed");
    expect(git(workspace, "rev-parse", "HEAD")).toBe(git(root, "rev-parse", "HEAD"));
  });

  it.each([9, 124, 137])(
    "rejects repair exit %s even when the provider staged away every conflict",
    async (exitCode) => {
      const { root, project, task, workspace, bin } = reconciliationFixture();
      writeFileSync(join(workspace, "tracked.txt"), "task intent\n");
      writeFileSync(join(root, "tracked.txt"), "upstream intent\n");
      git(root, "add", ".");
      git(root, "commit", "-q", "-m", "conflicting target");
      writeFileSync(
        join(bin, "codex"),
        `#!/bin/sh
printf 'partial repair\n' > "$FAKE_WORKSPACE/tracked.txt"
git -C "$FAKE_WORKSPACE" add tracked.txt
exit ${exitCode}
`,
      );
      chmodSync(join(bin, "codex"), 0o755);
      await expect(sync("native")).rejects.toThrow(
        `did not complete successfully (exit ${exitCode})`,
      );
      expect(git(workspace, "diff", "--name-only", "--diff-filter=U")).toBe("");
      expect(existsSync(taskReconciliationPath(project.id, task.id))).toBe(true);
      await expect(review("native", false)).rejects.toThrow("unfinished reconciliation");
    },
  );

  it.each([9, 124])(
    "retains the exhausted corrective checkpoint after provider exit %s",
    async (exitCode) => {
      const { project, task, workspace } = correctiveRepairFixture(
        "partial correction",
        `exit ${exitCode}`,
      );
      await expect(check("native")).rejects.toThrow(
        `Corrective repair did not complete successfully (exit ${exitCode})`,
      );
      expect(
        JSON.parse(readFileSync(taskRepairStatePath(project.id, task.id), "utf8")).attempts,
      ).toBe(2);
      expect(existsSync(taskReconciliationPath(project.id, task.id))).toBe(true);
      await expect(check("native")).rejects.toThrow("unfinished reconciliation");
      expect(readFileSync(join(workspace, ".git/repair-count"), "utf8")).toBe("2");
    },
  );

  it("keeps repair blocked after a real bounded provider-process timeout", async () => {
    const { root, project, task, workspace, bin } = reconciliationFixture();
    const timeout = execFileSync("which", ["timeout"], { encoding: "utf8" }).trim();
    const lateWrite = join(workspace, ".git/late-provider-write");
    writeFileSync(join(workspace, "tracked.txt"), "task intent\n");
    writeFileSync(join(root, "tracked.txt"), "upstream intent\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "conflicting target");
    writeFileSync(
      join(bin, "timeout"),
      `#!/bin/sh
test "$1" = --signal=TERM && test "$2" = --kill-after=10s && test "$3" = 10m || exit 99
shift 3
exec '${timeout}' --signal=TERM --kill-after=0.1s 0.2s "$@"
`,
    );
    chmodSync(join(bin, "timeout"), 0o755);
    writeFileSync(
      join(bin, "codex"),
      `#!/bin/sh
printf 'partial repair\\n' > "$FAKE_WORKSPACE/tracked.txt"
git -C "$FAKE_WORKSPACE" add tracked.txt
exec '${process.execPath}' -e ${JSON.stringify(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(lateWrite)}, 'unsafe'), 900);`)}
`,
    );
    chmodSync(join(bin, "codex"), 0o755);
    await expect(sync("native")).rejects.toThrow("did not complete successfully");
    expect(existsSync(taskReconciliationPath(project.id, task.id))).toBe(true);
    await expect(review("native", false)).rejects.toThrow("unfinished reconciliation");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(existsSync(lateWrite)).toBe(false);
  });

  it.each(["codex", "claude"] as const)(
    "supplies recent task context to %s repair without replacing its native session",
    async (agent) => {
      const { root, project, task, workspace, bin } = reconciliationFixture(agent);
      const startedAt = markTaskSessionStarted(project, task).sessionStartedAt;
      const conversation = join(workspace, ".git/boxers/conversation");
      mkdirSync(join(conversation, "events"), { recursive: true });
      for (let sequence = 1; sequence <= 4; sequence++) {
        const isPrompt = sequence % 2 === 1;
        writeFileSync(
          join(conversation, "events", `${sequence}.json`),
          JSON.stringify({
            version: 1,
            sequence,
            provider: agent,
            recordedAt: new Date().toISOString(),
            raw: {
              hook_event_name: isPrompt ? "UserPromptSubmit" : "Stop",
              session_id: "original-session",
              ...(isPrompt
                ? {
                    prompt:
                      sequence === 1 ? "previous delivered goal" : "Keep parser compatibility",
                  }
                : { last_assistant_message: "implemented" }),
            },
          }),
        );
      }
      writeFileSync(join(conversation, "sequence"), "4");
      drainTaskLifecycleEvents(project, task);
      updateTaskState(project, task, { promotionConversationCheckpoint: 2 }, "git");
      writeFileSync(join(workspace, "tracked.txt"), "task increment\n");
      writeFileSync(join(root, "tracked.txt"), "upstream increment\n");
      git(root, "add", ".");
      git(root, "commit", "-q", "-m", "conflicting target");
      const argumentsPath = join(workspace, ".git/repair-arguments");
      writeFileSync(
        join(bin, agent),
        `#!/bin/sh
printf '%s\\0' "$@" > '${argumentsPath}'
printf 'combined increment\\n' > "$FAKE_WORKSPACE/tracked.txt"
git -C "$FAKE_WORKSPACE" add tracked.txt
`,
      );
      chmodSync(join(bin, agent), 0o755);
      await expect(sync("native")).resolves.toBe(0);
      const args = readFileSync(argumentsPath, "utf8").split("\0").filter(Boolean);
      const prompt = args.at(-1)!;
      expect(prompt).toContain("Keep parser compatibility");
      expect(prompt).toContain("task increment");
      expect(prompt).not.toContain("previous delivered goal");
      expect(args).toContain(agent === "codex" ? "--ephemeral" : "--no-session-persistence");
      expect(args).not.toContain("resume");
      expect(args).not.toContain("--continue");
      expect(args).not.toContain("--settings");
      expect(args.some((arg) => arg.startsWith("hooks."))).toBe(false);
      expect(requireTask(project, task.name).sessionStartedAt).toBe(startedAt);
      expect(readTaskState(project, task)).toMatchObject({
        conversationHighWaterSequence: 4,
        promotionConversationCheckpoint: 2,
      });
      expect(readFileSync(join(conversation, "sequence"), "utf8")).toBe("4");
    },
  );

  it("uses the same tree for review and checks with force-staged ignored additions", async () => {
    const { project, task, workspace } = reconciliationFixture();
    writeFileSync(join(workspace, "ignored.txt"), "explicitly included\n");
    git(workspace, "add", "-f", "ignored.txt");
    const indexBefore = readFileSync(join(workspace, ".git", "index"));
    await expect(review("native", false)).resolves.toBe(0);
    const candidate = requireTask(project, "native").lastSnapshot?.candidateTreeOid;
    expect(candidate).toBe(nativeWorkspaceTreeAt(task, workspace));
    expect(git(project.seedPath, "show", `${candidate}:ignored.txt`)).toBe("explicitly included");
    expect(readFileSync(join(workspace, ".git", "index"))).toEqual(indexBefore);
  });

  it("retains its original checkpoint and installed base after interruption following reset", async () => {
    const { root, project, task, workspace, bin, baseOid } = reconciliationFixture();
    writeFileSync(join(workspace, "tracked.txt"), "original task work\n");
    writeFileSync(join(root, "upstream.txt"), "upstream\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "advance");
    const targetOid = git(root, "rev-parse", "HEAD");
    process.env.FAKE_REAL_GIT = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh
if test "$PWD" = "$FAKE_WORKSPACE" && test "$1" = reset && test "$2" = --hard; then
  "$FAKE_REAL_GIT" "$@"
  exit 88
fi
exec "$FAKE_REAL_GIT" "$@"
`,
    );
    chmodSync(join(bin, "git"), 0o755);

    await expect(sync("native")).rejects.toThrow("Could not reconcile native workspace");
    const markerPath = taskReconciliationPath(project.id, task.id);
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    expect(marker).toMatchObject({ oldTargetOid: baseOid, targetOid });
    expect(git(workspace, "rev-parse", "HEAD")).toBe(targetOid);
    expect(readFileSync(join(workspace, "tracked.txt"), "utf8")).toBe("base\n");
    expect(readTaskState(project, requireTask(project, "native"))).toMatchObject({
      baseOid,
      observedTargetOid: targetOid,
    });
    await expect(sync("native")).rejects.toThrow("unfinished reconciliation");
    await expect(review("native", false)).rejects.toThrow("unfinished reconciliation");
    expect(JSON.parse(readFileSync(markerPath, "utf8"))).toEqual(marker);
    expect(git(project.seedPath, "show", `${marker.checkpointOid}:tracked.txt`)).toBe(
      "original task work",
    );
    expect(git(workspace, "show", "refs/boxers/reconcile/work:tracked.txt")).toBe(
      "original task work",
    );
  });

  it("refuses to certify a check that modifies the live workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "boxers-readonly-check-root-"));
    const state = mkdtempSync(join(tmpdir(), "boxers-readonly-check-state-"));
    const workspace = mkdtempSync(join(tmpdir(), "boxers-readonly-check-workspace-"));
    const bin = mkdtempSync(join(tmpdir(), "boxers-readonly-check-bin-"));
    cleanup.push(root, state, workspace, bin);
    process.env["BOXERS_HOME"] = state;
    process.env["FAKE_WORKSPACE"] = workspace;
    process.chdir(root);

    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.invalid");
    mkdirSync(join(root, ".boxers"));
    writeFileSync(
      join(root, ".boxers", "config.yml"),
      "version: 3\ncheck:\n  commands:\n    mutating:\n      run: printf 'changed by check\\n' > tracked.txt\n      timeout: 10s\n",
    );
    writeFileSync(join(root, "tracked.txt"), "base\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
    const project = registerTarget(root);
    git(workspace, "clone", "-q", project.seedPath, ".");
    installFakeSbx(bin);

    const task = createTaskManifest(project, "readonly", "codex");
    useFakeRuntime(task);
    updateTask(project, task, {
      phase: "active",
      agent: "codex",
      targetOid: git(root, "rev-parse", "HEAD"),
    });
    writeFileSync(join(workspace, "tracked.txt"), "candidate\n");
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await expect(check("readonly")).rejects.toThrow(
      "Check command modified tracked content. Checks must be read-only",
    );
    expect(requireTask(project, "readonly").lastSnapshot?.check).toBeUndefined();
  });

  it("invalidates a captured check when the live workspace advances", async () => {
    const root = mkdtempSync(join(tmpdir(), "boxers-exact-check-root-"));
    const state = mkdtempSync(join(tmpdir(), "boxers-exact-check-state-"));
    const workspace = mkdtempSync(join(tmpdir(), "boxers-exact-check-workspace-"));
    const bin = mkdtempSync(join(tmpdir(), "boxers-exact-check-bin-"));
    cleanup.push(root, state, workspace, bin);
    process.env["BOXERS_HOME"] = state;
    process.env["FAKE_WORKSPACE"] = workspace;
    process.chdir(root);

    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.invalid");
    mkdirSync(join(root, ".boxers"));
    const delayedMarker = join(bin, "delayed-check-started");
    writeFileSync(
      join(root, ".boxers", "config.yml"),
      `version: 3
check:
  commands:
    exact:
      run: grep -qx 'captured candidate' tracked.txt
      timeout: 10s
    delayed:
      run: touch '${delayedMarker}' && sleep 0.3 && grep -qx 'captured candidate' tracked.txt
      timeout: 10s
`,
    );
    writeFileSync(join(root, "tracked.txt"), "base\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
    const project = registerTarget(root);
    git(workspace, "clone", "-q", project.seedPath, ".");
    installFakeSbx(bin);

    const task = createTaskManifest(project, "native", "codex");
    useFakeRuntime(task);
    updateTask(project, task, {
      phase: "idle",
      agent: "codex",
      targetOid: git(root, "rev-parse", "HEAD"),
    });
    writeFileSync(join(workspace, "tracked.txt"), "captured candidate\n");
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await expect(review("native")).resolves.toBe(0);
    const captured = requireTask(project, "native").lastSnapshot?.candidateTreeOid;
    expect(captured).toMatch(/^[0-9a-f]{40}$/);

    writeFileSync(join(workspace, "tracked.txt"), "newer live edit\n");
    await expect(refreshAutomaticCheck("native")).resolves.toMatchObject({
      candidateTreeOid: captured,
    });
    expect(existsSync(delayedMarker)).toBe(false);
    expect(requireTask(project, "native").lastSnapshot?.check).toBeUndefined();
    expect(readFileSync(join(workspace, "tracked.txt"), "utf8")).toBe("newer live edit\n");
  });

  it("promotes one commit directly to the remote target and reuses the task", async () => {
    const root = mkdtempSync(join(tmpdir(), "boxers-native-remote-root-"));
    const remote = mkdtempSync(join(tmpdir(), "boxers-native-remote-bare-"));
    const state = mkdtempSync(join(tmpdir(), "boxers-native-remote-state-"));
    const workspace = mkdtempSync(join(tmpdir(), "boxers-native-remote-workspace-"));
    const bin = mkdtempSync(join(tmpdir(), "boxers-native-remote-bin-"));
    cleanup.push(root, remote, state, workspace, bin);
    process.env["BOXERS_HOME"] = state;
    process.env["FAKE_WORKSPACE"] = workspace;
    process.chdir(root);

    git(remote, "init", "--bare", "-q");
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.invalid");
    mkdirSync(join(root, ".boxers"));
    writeFileSync(
      join(root, ".boxers", "config.yml"),
      "version: 3\nintegration:\n  base: main\n  remote: origin\n",
      { flag: "w" },
    );
    writeFileSync(join(root, "tracked.txt"), "before\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
    git(root, "remote", "add", "origin", remote);
    git(root, "push", "-q", "-u", "origin", "main");
    const base = git(root, "rev-parse", "HEAD");
    const project = initProject({
      base: "main",
      remote: "origin",
      cwd: root,
    });
    git(workspace, "clone", "-q", project.seedPath, ".");
    installFakeSbx(bin);

    const task = createTaskManifest(project, "native", "codex");
    useFakeRuntime(task);
    updateTask(project, task, { phase: "active", agent: "codex", targetOid: base });
    writeFileSync(join(workspace, "tracked.txt"), "after\n");
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await expect(promote("native", "Publish native")).resolves.toBe(0);

    const published = git(remote, "rev-parse", "refs/heads/main");
    expect(git(remote, "rev-parse", `${published}^`)).toBe(base);
    expect(git(remote, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe(
      "refs/heads/main",
    );
    expect(git(remote, "show", `${published}:tracked.txt`)).toBe("after");
    expect(git(root, "rev-parse", "HEAD")).toBe(base);
    expect(readFileSync(join(root, "tracked.txt"), "utf8")).toBe("before\n");
    expect(git(workspace, "rev-parse", "HEAD")).toBe(published);
    expect(requireTask(project, "native").lastSnapshot?.targetOid).toBe(published);
    expect(
      readTaskState(project, requireTask(project, "native")).lastDelivery?.value,
    ).toMatchObject({
      ref: "main",
      oid: published,
      checks: "not_configured",
      deliveredAt: expect.any(String),
    });
    expect(stdout.mock.calls.map((call) => String(call[0])).join("")).not.toContain("pull request");
    expect(readTaskState(project, requireTask(project, "native")).hasUnmergedChanges.value).toBe(
      false,
    );

    writeFileSync(join(workspace, "continued.txt"), "continued work\n");
    await expect(promote("native", "Continue native")).resolves.toBe(0);

    const republished = git(remote, "rev-parse", "refs/heads/main");
    expect(republished).not.toBe(published);
    expect(git(remote, "rev-parse", `${republished}^`)).toBe(published);
    expect(git(remote, "show", `${republished}:continued.txt`)).toBe("continued work");
  });

  it("advances the merged baseline without discarding newer workspace changes", () => {
    const root = mkdtempSync(join(tmpdir(), "boxers-native-preserve-root-"));
    const state = mkdtempSync(join(tmpdir(), "boxers-native-preserve-state-"));
    const workspace = mkdtempSync(join(tmpdir(), "boxers-native-preserve-workspace-"));
    const bin = mkdtempSync(join(tmpdir(), "boxers-native-preserve-bin-"));
    cleanup.push(root, state, workspace, bin);
    process.env["BOXERS_HOME"] = state;
    process.env["FAKE_WORKSPACE"] = workspace;

    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.invalid");
    writeFileSync(join(root, "tracked.txt"), "base\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
    const project = registerTarget(root);
    git(workspace, "clone", "-q", root, ".");
    installFakeSbx(bin);

    const task = createTaskManifest(project, "native", "codex");
    useFakeRuntime(task);
    writeFileSync(join(root, "tracked.txt"), "merged candidate\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "merge candidate");
    const mergedCommit = git(root, "rev-parse", "HEAD");

    writeFileSync(join(workspace, "tracked.txt"), "newer agent edit\n");
    writeFileSync(join(workspace, "newer.txt"), "preserve me\n");

    expect(advanceNativeWorkspace(task, "main", mergedCommit)).toBe(true);
    expect(git(workspace, "rev-parse", "HEAD")).toBe(mergedCommit);
    expect(readFileSync(join(workspace, "tracked.txt"), "utf8")).toBe("newer agent edit\n");
    expect(readFileSync(join(workspace, "newer.txt"), "utf8")).toBe("preserve me\n");
    expect(git(workspace, "status", "--porcelain")).toContain("tracked.txt");
    expect(git(workspace, "status", "--porcelain")).toContain("newer.txt");
  });

  it("refuses to capture a workspace against a target that is not its installed base", () => {
    const root = mkdtempSync(join(tmpdir(), "boxers-native-mismatch-root-"));
    const state = mkdtempSync(join(tmpdir(), "boxers-native-mismatch-state-"));
    const workspace = mkdtempSync(join(tmpdir(), "boxers-native-mismatch-workspace-"));
    const bin = mkdtempSync(join(tmpdir(), "boxers-native-mismatch-bin-"));
    cleanup.push(root, state, workspace, bin);
    process.env["BOXERS_HOME"] = state;
    process.env["FAKE_WORKSPACE"] = workspace;

    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.invalid");
    writeFileSync(join(root, "base.txt"), "base\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
    const project = registerTarget(root);
    git(workspace, "clone", "-q", project.seedPath, ".");
    installFakeSbx(bin);

    const task = createTaskManifest(project, "native", "codex");
    task.runtime.id = "boxers-project-task";
    writeFileSync(join(root, "upstream.txt"), "must not become a task deletion\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "upstream work");
    const wrongTarget = git(root, "rev-parse", "HEAD");
    git(workspace, "fetch", "-q", root, wrongTarget);

    expect(() => nativeWorkspacePatch(task, wrongTarget)).toThrow(
      /does not match its recorded target/i,
    );
    expect(readFileSync(join(workspace, "base.txt"), "utf8")).toBe("base\n");
  });

  it("refetches when a stale commit graph hides a missing fetched object", () => {
    const root = mkdtempSync(join(tmpdir(), "boxers-native-refetch-root-"));
    const state = mkdtempSync(join(tmpdir(), "boxers-native-refetch-state-"));
    const workspace = mkdtempSync(join(tmpdir(), "boxers-native-refetch-workspace-"));
    const bin = mkdtempSync(join(tmpdir(), "boxers-native-refetch-bin-"));
    cleanup.push(root, state, workspace, bin);
    process.env["BOXERS_HOME"] = state;
    process.env["FAKE_WORKSPACE"] = workspace;

    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.invalid");
    writeFileSync(join(root, "tracked.txt"), "base\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
    const project = registerTarget(root);
    git(workspace, "clone", "-q", root, ".");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    process.env["FAKE_REAL_GIT"] = realGit;
    installFakeSbx(bin);

    const task = createTaskManifest(project, "native", "codex");
    useFakeRuntime(task);
    writeFileSync(join(root, "tracked.txt"), "merged candidate\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "merge candidate");
    const mergedCommit = git(root, "rev-parse", "HEAD");
    writeFileSync(join(workspace, "tracked.txt"), "merged candidate\n");

    const fetchLog = join(bin, "git-fetch.log");
    const failedMarker = join(bin, "git-fetch-failed");
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh
case " $* " in
  *" fetch "*)
    printf '%s\\n' "$*" >> ${JSON.stringify(fetchLog)}
    case " $* " in
      *" --refetch "*) ;;
      *)
        if [ ! -f ${JSON.stringify(failedMarker)} ]; then
          : > ${JSON.stringify(failedMarker)}
          printf '%s\\n' 'fatal: requested commit is in the commit graph file but not in the object database.' >&2
          exit 128
        fi
        ;;
    esac
    ;;
esac
exec "$FAKE_REAL_GIT" "$@"
`,
    );
    chmodSync(join(bin, "git"), 0o755);

    expect(advanceNativeWorkspace(task, "main", mergedCommit)).toBe(true);
    expect(readFileSync(fetchLog, "utf8")).toContain("--refetch");
    expect(git(workspace, "rev-parse", "HEAD")).toBe(mergedCommit);
  });

  it("removes an idle task when its native workspace is still clean", async () => {
    const root = mkdtempSync(join(tmpdir(), "boxers-native-clean-root-"));
    const state = mkdtempSync(join(tmpdir(), "boxers-native-clean-state-"));
    const workspace = mkdtempSync(join(tmpdir(), "boxers-native-clean-workspace-"));
    const bin = mkdtempSync(join(tmpdir(), "boxers-native-clean-bin-"));
    cleanup.push(root, state, workspace, bin);
    process.env["BOXERS_HOME"] = state;
    process.env["FAKE_WORKSPACE"] = workspace;
    process.chdir(root);

    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.invalid");
    writeFileSync(join(root, "tracked.txt"), "unchanged\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
    const project = registerTarget(root);
    git(workspace, "clone", "-q", project.seedPath, ".");
    installFakeSbx(bin);

    const task = createTaskManifest(project, "native", "codex");
    useFakeRuntime(task);
    updateTask(
      project,
      task,
      {
        phase: "idle",
        agent: "codex",
        targetOid: git(root, "rev-parse", "HEAD"),
      },
      true,
    );
    expect(readTaskState(project, requireTask(project, "native")).hasUnmergedChanges.value).toBe(
      true,
    );

    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await expect(discard("native", false)).rejects.toThrow("contains unmerged work");
    expect(stdout).not.toHaveBeenCalled();
    expect(requireTask(project, "native").name).toBe("native");
    await expect(discard("native", true)).resolves.toBe(0);

    const forced = createTaskManifest(project, "forced", "codex");
    useFakeRuntime(forced, "boxers-project-forced");
    stdout.mockClear();
    await expect(discard("forced", true)).resolves.toBe(0);
    expect(stdout.mock.calls.map(([message]) => message)).toEqual(["Discarded task forced.\n"]);

    const settingUp = createTaskManifest(project, "setting-up", "codex");
    useFakeRuntime(settingUp);
    const targetOid = git(root, "rev-parse", "HEAD");
    let current = updateTask(
      project,
      settingUp,
      { phase: "idle", agent: "codex", targetOid },
      false,
      "git",
    );
    const runningSetup = {
      state: "running" as const,
      command: "npm ci",
      startedAt: new Date().toISOString(),
      logPath: join(taskDir(project.id, current.id), "setup.log"),
      jobId: "setup-job",
      configHash: "setup-config",
    };
    writeFileSync(
      join(taskDir(project.id, current.id), "setup.json"),
      JSON.stringify(runningSetup),
    );
    current = updateTask(
      project,
      current,
      { ...current.lastSnapshot!, setup: runningSetup },
      undefined,
      "worker",
    );
    expect(projectTaskView(project, current).removal.state).toBe("safe");

    stdout.mockClear();
    await expect(discard("setting-up", false)).resolves.toBe(0);
    expect(stdout.mock.calls.map(([message]) => message)).toEqual([
      "Unmerged changes: no\nNo other changes by this task\n",
      "Discarded task setting-up.\n",
    ]);
  });

  it("reuses a recorded delivery only while lifecycle state permits it", async () => {
    const root = mkdtempSync(join(tmpdir(), "boxers-native-delivered-root-"));
    const state = mkdtempSync(join(tmpdir(), "boxers-native-delivered-state-"));
    const workspace = mkdtempSync(join(tmpdir(), "boxers-native-delivered-workspace-"));
    const bin = mkdtempSync(join(tmpdir(), "boxers-native-delivered-bin-"));
    cleanup.push(root, state, workspace, bin);
    process.env["BOXERS_HOME"] = state;
    process.env["FAKE_WORKSPACE"] = workspace;
    process.env["FAKE_SBX_LOG"] = join(bin, "sbx.log");
    process.chdir(root);

    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.invalid");
    writeFileSync(join(root, "tracked.txt"), "delivered\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "Deliver the task");
    const deliveredOid = git(root, "rev-parse", "HEAD");
    const project = registerTarget(root);
    git(workspace, "clone", "-q", project.seedPath, ".");
    installFakeSbx(bin);

    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    let logOffset = 0;
    for (const [phase, usesRecordedDelivery] of [
      ["idle", true],
      ["stopped", true],
      ["needs_input", true],
      ["reviewed", true],
      ["working", false],
    ] as const) {
      const name = `delivered-${phase.replace("_", "-")}`;
      const task = createTaskManifest(project, name, "codex");
      useFakeRuntime(task);
      const snapshot = { phase, agent: "codex" as const, targetOid: deliveredOid };
      const updated = updateTask(project, task, snapshot, false, "git");
      recordTaskSnapshot(project, updated, snapshot, {
        source: "git",
        workspaceRelation: "on_base",
        lastDelivery: { ref: "main", oid: deliveredOid, subject: "Deliver the task" },
      });
      if (phase === "working")
        recordLifecycleEvent(project, updated, {
          version: 1,
          sequence: 1,
          event: {
            version: 1,
            kind: "user_prompt",
            provider: "codex",
            providerSessionId: name,
            prompt: "continue",
            recordedAt: "2030-01-01T00:00:00.000Z",
          },
          source: { provider: "codex", hookEvent: "UserPromptSubmit", rawBytes: 20 },
        });

      if (usesRecordedDelivery) await expect(discard(name, false)).resolves.toBe(0);
      else await expect(discard(name, false)).rejects.toThrow("is active");
      expect(stdout.mock.calls.map(([message]) => message)).toEqual(
        usesRecordedDelivery
          ? [
              'Unmerged changes: no\nLast commit on main: "Deliver the task"\nNo other changes by this task\n',
              `Discarded task ${name}.\n`,
            ]
          : [],
      );
      stdout.mockClear();
      const log = readFileSync(process.env["FAKE_SBX_LOG"], "utf8");
      expect(log.slice(logOffset).includes("exec ")).toBe(false);
      logOffset = log.length;
      if (usesRecordedDelivery)
        expect(() => requireTask(project, name)).toThrow(`Unknown task "${name}"`);
      else {
        expect(requireTask(project, name).name).toBe(name);
        await discard(name, true);
        stdout.mockClear();
      }
    }
  });

  it("retains verified clean Git state when the runtime is suspended", async () => {
    const root = mkdtempSync(join(tmpdir(), "boxers-native-stop-clean-root-"));
    const state = mkdtempSync(join(tmpdir(), "boxers-native-stop-clean-state-"));
    const workspace = mkdtempSync(join(tmpdir(), "boxers-native-stop-clean-workspace-"));
    const bin = mkdtempSync(join(tmpdir(), "boxers-native-stop-clean-bin-"));
    cleanup.push(root, state, workspace, bin);
    process.env["BOXERS_HOME"] = state;
    process.env["FAKE_WORKSPACE"] = workspace;
    const sbxLog = join(bin, "sbx.log");
    process.env["FAKE_SBX_LOG"] = sbxLog;
    process.chdir(root);

    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.invalid");
    writeFileSync(join(root, "tracked.txt"), "unchanged\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
    const project = registerTarget(root);
    git(workspace, "clone", "-q", project.seedPath, ".");
    installFakeSbx(bin);

    const task = createTaskManifest(project, "native", "codex");
    useFakeRuntime(task);
    updateTask(project, task, {
      phase: "active",
      agent: "codex",
      targetOid: git(root, "rev-parse", "HEAD"),
    });
    // Lifecycle activity alone is not evidence of workspace changes.
    expect(readTaskState(project, requireTask(project, "native")).hasUnmergedChanges.value).toBe(
      false,
    );

    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await expect(sync("native")).resolves.toBe(0);
    await expect(status("native", true, true)).resolves.toBe(0);
    const refreshed = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
    expect(refreshed.view.operations).toEqual([]);
    await expect(status("native", false, true)).resolves.toBe(0);
    const refreshedText = String(stdout.mock.calls.at(-1)?.[0]);
    expect(refreshedText).not.toContain("Operations:");
    expect(refreshedText).not.toContain("  Wait");
    suspendTaskEnvironment(task);
    const stopped = requireTask(project, "native");
    expect(readTaskState(project, stopped).hasUnmergedChanges.value).toBe(false);
    expect(stopped.lastSnapshot).toMatchObject({
      phase: "idle",
      targetOid: expect.any(String),
    });
    const log = readFileSync(sbxLog, "utf8");
    expect(log.indexOf("exec <boxers-project-task>")).toBeLessThan(
      log.indexOf("stop <boxers-project-task>"),
    );

    process.env["FAKE_SBX_STATUS"] = "stopped";
    await expect(status("native", true, true)).resolves.toBe(0);
    const inspected = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
    expect(inspected.internal.state).toMatchObject({ hasUnmergedChanges: { value: false } });
    expect(readFileSync(sbxLog, "utf8")).toContain("exec <boxers-project-task>");

    writeFileSync(join(root, "upstream.txt"), "new target work\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "advance target after stop");
    const pending = requireTask(project, "native");
    recordTaskSnapshot(
      project,
      pending,
      { ...pending.lastSnapshot!, targetOid: git(root, "rev-parse", "HEAD") },
      { source: "git", workspaceRelation: "reconcile_pending" },
    );
    await expect(status("native", true, true)).resolves.toBe(0);
    const stale = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
    expect(stale.internal.state).toMatchObject({ baseOid: expect.any(String) });

    await expect(discard("native", false)).resolves.toBe(0);
    expect(() => requireTask(project, "native")).toThrow('Unknown task "native"');
  });

  it("caches Git status when stop finds the Sandbox already stopped", async () => {
    const root = mkdtempSync(join(tmpdir(), "boxers-native-stop-stopped-root-"));
    const state = mkdtempSync(join(tmpdir(), "boxers-native-stop-stopped-state-"));
    const workspace = mkdtempSync(join(tmpdir(), "boxers-native-stop-stopped-workspace-"));
    const bin = mkdtempSync(join(tmpdir(), "boxers-native-stop-stopped-bin-"));
    cleanup.push(root, state, workspace, bin);
    process.env["BOXERS_HOME"] = state;
    process.env["FAKE_WORKSPACE"] = workspace;
    process.env["FAKE_SBX_STATUS"] = "stopped";
    process.chdir(root);

    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.invalid");
    writeFileSync(join(root, "tracked.txt"), "base\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
    const project = registerTarget(root);
    git(workspace, "clone", "-q", project.seedPath, ".");
    installFakeSbx(bin);

    const task = createTaskManifest(project, "native", "codex");
    useFakeRuntime(task);
    updateTask(project, task, { phase: "stopped", agent: "codex" });

    await expect(status("native", true, true)).resolves.toBe(0);
    suspendTaskEnvironment(task);
    expect(readTaskState(project, requireTask(project, "native"))).toMatchObject({
      hasUnmergedChanges: { value: false },
    });
    expect(readTaskState(project, requireTask(project, "native")).baseOid).toBeUndefined();
  });

  it("does not start an auto-stopped Sandbox to obtain Git status", async () => {
    const root = mkdtempSync(join(tmpdir(), "boxers-native-idle-stop-root-"));
    const state = mkdtempSync(join(tmpdir(), "boxers-native-idle-stop-state-"));
    const workspace = mkdtempSync(join(tmpdir(), "boxers-native-idle-stop-workspace-"));
    const bin = mkdtempSync(join(tmpdir(), "boxers-native-idle-stop-bin-"));
    cleanup.push(root, state, workspace, bin);
    process.env["BOXERS_HOME"] = state;
    process.env["FAKE_WORKSPACE"] = workspace;
    process.env["FAKE_SBX_STATUS"] = "stopped";
    const sbxLog = join(bin, "sbx.log");
    process.env["FAKE_SBX_LOG"] = sbxLog;
    process.chdir(root);

    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.invalid");
    writeFileSync(join(root, "tracked.txt"), "base\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
    const project = registerTarget(root);
    git(workspace, "clone", "-q", project.seedPath, ".");
    installFakeSbx(bin);

    const task = createTaskManifest(project, "native", "codex");
    useFakeRuntime(task);
    updateTask(project, task, { phase: "idle", agent: "codex" });

    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await expect(list(true)).resolves.toBe(0);
    const listed = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
    const listedTask = listed.machines
      .find((machine: { name: string }) => machine.name === "local")
      ?.snapshot.tasks.find((candidate: { name: string }) => candidate.name === "native");
    expect(listedTask).toMatchObject({
      view: { changes: { state: "none" } },
      internal: { state: expect.any(Object) },
    });
    expect(listedTask).not.toHaveProperty("git");
    expect(readFileSync(sbxLog, "utf8")).toBe("ls <--json>\n");
  });

  it("keeps the removal guard when stop finds uncommitted changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "boxers-native-stop-dirty-root-"));
    const state = mkdtempSync(join(tmpdir(), "boxers-native-stop-dirty-state-"));
    const workspace = mkdtempSync(join(tmpdir(), "boxers-native-stop-dirty-workspace-"));
    const bin = mkdtempSync(join(tmpdir(), "boxers-native-stop-dirty-bin-"));
    cleanup.push(root, state, workspace, bin);
    process.env["BOXERS_HOME"] = state;
    process.env["FAKE_WORKSPACE"] = workspace;
    process.chdir(root);

    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.invalid");
    writeFileSync(join(root, "tracked.txt"), "before\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
    const project = registerTarget(root);
    git(workspace, "clone", "-q", project.seedPath, ".");
    installFakeSbx(bin);

    const task = createTaskManifest(project, "native", "codex");
    useFakeRuntime(task);
    updateTask(project, task, {
      phase: "active",
      agent: "codex",
      targetOid: git(root, "rev-parse", "HEAD"),
    });
    writeFileSync(join(workspace, "tracked.txt"), "after\n");

    await expect(sync("native")).resolves.toBe(0);
    await expect(status("native", true, true)).resolves.toBe(0);
    suspendTaskEnvironment(task);
    const stopped = requireTask(project, "native");
    expect(readTaskState(project, stopped).hasUnmergedChanges.value).toBe(true);
    expect(stopped.lastSnapshot?.candidateTreeOid).toEqual(expect.any(String));
    process.env["FAKE_SBX_STATUS"] = "stopped";
    await expect(discard("native", false)).rejects.toThrow("contains unmerged work");
  });

  it("promotes the exact native working tree and runs previews", async () => {
    const root = mkdtempSync(join(tmpdir(), "boxers-native-root-"));
    const state = mkdtempSync(join(tmpdir(), "boxers-native-state-"));
    const workspace = mkdtempSync(join(tmpdir(), "boxers-native-workspace-"));
    const bin = mkdtempSync(join(tmpdir(), "boxers-native-bin-"));
    cleanup.push(root, state, workspace, bin);
    process.env["BOXERS_HOME"] = state;
    process.env["FAKE_WORKSPACE"] = workspace;
    const sbxLog = join(bin, "sbx.log");
    process.env["FAKE_SBX_LOG"] = sbxLog;
    process.chdir(root);

    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.invalid");
    mkdirSync(join(root, ".boxers"));
    writeFileSync(
      join(root, ".boxers", "config.yml"),
      `version: 3
check:
  commands:
    files:
      run: test -f untracked.txt
      timeout: 10s
preview:
  run: printf 'preview ready\\n'; sleep 30
  ports: [5173]
`,
    );
    writeFileSync(join(root, "tracked.txt"), "before\n");
    writeFileSync(join(root, "delete-me.txt"), "delete me\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
    const project = registerTarget(root);
    git(workspace, "clone", "-q", project.seedPath, ".");
    git(workspace, "config", "user.name", "Test User");
    git(workspace, "config", "user.email", "test@example.invalid");

    installFakeSbx(bin);

    const task = createTaskManifest(project, "native", "codex");
    useFakeRuntime(task);
    updateTask(project, task, {
      phase: "active",
      agent: "codex",
      targetOid: git(root, "rev-parse", "HEAD"),
    });
    writeFileSync(join(workspace, "tracked.txt"), "after\n");
    writeFileSync(join(workspace, "untracked.txt"), "new\n");
    writeFileSync(join(workspace, "binary.bin"), Buffer.from([0, 1, 2, 255]));
    unlinkSync(join(workspace, "delete-me.txt"));
    git(workspace, "add", "tracked.txt");
    git(workspace, "commit", "-q", "-m", "task checkpoint");

    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await expect(status("native", true, true)).resolves.toBe(0);
    const inspected = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
    expect(inspected.view.changes.state).toBe("unmerged");
    expect(inspected.internal.state.candidateTreeOid).toBeUndefined();
    // Status observes live bytes; only preparation publishes a candidate.
    await expect(sync("native")).resolves.toBe(0);
    expect(readTaskState(project, requireTask(project, "native")).hasUnmergedChanges.value).toBe(
      true,
    );
    const stale = requireTask(project, "native");
    updateTask(project, stale, stale.lastSnapshot!, false, "git");
    expect(readTaskState(project, stale).hasUnmergedChanges.value).toBe(false);
    await expect(sync("native")).resolves.toBe(0);
    expect(readTaskState(project, requireTask(project, "native")).hasUnmergedChanges.value).toBe(
      true,
    );

    writeFileSync(join(root, "upstream.txt"), "advanced target\n");
    git(root, "add", "upstream.txt");
    git(root, "commit", "-q", "-m", "advance target");
    const advancedTarget = git(root, "rev-parse", "HEAD");

    recordLifecycleEvent(project, requireTask(project, "native"), {
      version: 1,
      sequence: 1,
      event: {
        version: 1,
        kind: "user_prompt",
        provider: "codex",
        providerSessionId: "session",
        prompt: "continue",
        recordedAt: "2030-01-01T00:00:00.000Z",
      },
      source: { provider: "codex", hookEvent: "UserPromptSubmit", rawBytes: 20 },
    });
    await expect(status("native", true, true)).resolves.toBe(0);
    const deferred = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
    expect(deferred.internal.state.agentTurnState).toBe("working");
    expect(readTaskState(project, requireTask(project, "native")).hasUnmergedChanges.value).toBe(
      true,
    );
    expect(() => readFileSync(join(workspace, "upstream.txt"), "utf8")).toThrow();

    recordLifecycleEvent(project, requireTask(project, "native"), {
      version: 1,
      sequence: 2,
      event: {
        version: 1,
        kind: "turn_finished",
        provider: "codex",
        providerSessionId: "session",
        lastAssistantMessage: "done",
        recordedAt: "2030-01-01T00:00:01.000Z",
      },
      source: { provider: "codex", hookEvent: "Stop", rawBytes: 20 },
    });
    const postTurnPhases: string[] = [];
    await expect(runPostTurn("native", 2, (phase) => postTurnPhases.push(phase))).resolves.toEqual({
      targetOid: advancedTarget,
      candidateTreeOid: expect.any(String),
    });
    expect(postTurnPhases).toEqual([
      "refreshing",
      "reconciling",
      "capturing",
      "checking",
      "generating_metadata",
    ]);
    await expect(status("native", true, true)).resolves.toBe(0);
    const diverged = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
    expect(diverged.internal.state).toMatchObject({
      agentTurnState: "awaiting_input",
      baseOid: advancedTarget,
      hasUnmergedChanges: { value: true },
    });
    expect(readFileSync(join(workspace, "upstream.txt"), "utf8")).toBe("advanced target\n");
    expect(requireTask(project, "native").lastSnapshot?.targetOid).toBe(advancedTarget);
    await expect(review("native")).resolves.toBe(0);
    expect(readFileSync(sbxLog, "utf8")).not.toContain("stop <boxers-project-task>");
    expect(readFileSync(join(workspace, "upstream.txt"), "utf8")).toBe("advanced target\n");
    expect(readFileSync(join(workspace, "tracked.txt"), "utf8")).toBe("after\n");
    expect(requireTask(project, "native").lastSnapshot?.targetOid).toBe(advancedTarget);
    expect(requireTask(project, "native").lastSnapshot).toMatchObject({
      phase: "reviewed",
    });

    await expect(check("native")).resolves.toBe(0);
    expect(requireTask(project, "native").lastSnapshot?.check).toMatchObject({
      status: "passed",
      results: [{ name: "files", status: "passed" }],
    });
    const sandboxLogBeforeCachedRefresh = readFileSync(sbxLog, "utf8");
    expect(refreshAutomaticCommitMessage("native")).toBe(
      "Update tracked files and assets\n\n" +
        "Preserve tracked, untracked, binary, and deleted content in one exact candidate snapshot.",
    );
    expect(readFileSync(sbxLog, "utf8")).toBe(sandboxLogBeforeCachedRefresh);
    const generatedFor = readTaskState(project, requireTask(project, "native")).commitMessage;
    expect(generatedFor).toMatchObject({
      targetOid: advancedTarget,
      candidateTreeOid: requireTask(project, "native").lastSnapshot?.candidateTreeOid,
      subject: "Update tracked files and assets",
      note: "Preserve tracked, untracked, binary, and deleted content in one exact candidate snapshot.",
    });

    await expect(preview("native", "start")).resolves.toBe(0);
    expect(stdout.mock.calls.flat().join("")).toContain("Preview available at:\n");
    // Start acknowledges a detached launch; log creation is asynchronous.
    const previewTask = requireTask(project, "native");
    await expect
      .poll(() =>
        runtimeTasks.taskPreviewLogs(previewTask, previewTask.lastSnapshot!.preview!.jobId!),
      )
      .toBeDefined();
    await expect(preview("native", "logs")).resolves.toBe(0);
    await expect(preview("native", "stop")).resolves.toBe(0);

    stdout.mockClear();
    stderr.mockClear();
    const sandboxLogBeforePromotion = readFileSync(sbxLog, "utf8");
    await expect(promote("native")).resolves.toBe(0);
    const promotionOutput = stdout.mock.calls.map((call) => String(call[0])).join("");
    const promotionProgress = stderr.mock.calls.map((call) => String(call[0])).join("");
    expect(promotionOutput).toContain("All checks have successfully completed.\n");
    expect(`${promotionOutput}${promotionProgress}`).not.toMatch(
      /Preparing native|Capturing the exact candidate tree|Reusing|Generated commit message/,
    );
    const sandboxLogAfterPromotion = readFileSync(sbxLog, "utf8");
    const promotionSandboxLog = sandboxLogAfterPromotion.slice(sandboxLogBeforePromotion.length);
    expect(sandboxLogAfterPromotion).not.toContain("stop <boxers-project-task>");
    expect(promotionSandboxLog).not.toContain("ls <--json>");
    expect(promotionSandboxLog).not.toContain("<git> <diff>");
    expect(sandboxLogAfterPromotion).toContain("<--model> <gpt-5.6-luna>");
    expect(sandboxLogAfterPromotion.match(/test -f untracked\.txt/g)).toHaveLength(2);
    expect(git(target(root), "show", "main:tracked.txt")).toBe("after");
    expect(git(target(root), "show", "main:untracked.txt")).toBe("new");
    expect([...execFileSync("git", ["-C", target(root), "show", "main:binary.bin"])]).toEqual([
      0, 1, 2, 255,
    ]);
    expect(git(target(root), "ls-tree", "main", "delete-me.txt")).toBe("");
    expect(git(target(root), "log", "main", "-1", "--pretty=%s")).toBe(
      "Update tracked files and assets",
    );
    expect(git(target(root), "log", "main", "-1", "--pretty=%b")).toBe(
      "Preserve tracked, untracked, binary, and deleted content in one exact candidate snapshot.",
    );
    expect(
      readTaskState(project, requireTask(project, "native")).lastDelivery?.value,
    ).toMatchObject({
      ref: "main",
      oid: git(target(root), "rev-parse", "main"),
      subject: "Update tracked files and assets",
      checks: "passed",
      conversationSequence: 2,
      deliveredAt: expect.any(String),
    });
    expect(git(workspace, "status", "--porcelain")).toBe("");
    const merged = requireTask(project, "native").lastSnapshot;
    expect(merged?.phase).toBe("idle");
    expect(merged?.candidateTreeOid).toBeUndefined();

    const direct = createTaskManifest(project, "direct-merge", "codex");
    useFakeRuntime(direct);
    updateTask(project, direct, {
      phase: "active",
      agent: "codex",
      targetOid: git(workspace, "rev-parse", "HEAD"),
    });
    writeFileSync(join(workspace, "direct.txt"), "merged without review\n");
    await expect(promote("direct-merge")).resolves.toBe(0);
    expect(git(target(root), "show", "main:direct.txt")).toBe("merged without review");
  }, 15_000);

  it("keeps review independent and reruns failed checks during promotion", async () => {
    const root = mkdtempSync(join(tmpdir(), "boxers-native-failed-root-"));
    const state = mkdtempSync(join(tmpdir(), "boxers-native-failed-state-"));
    const workspace = mkdtempSync(join(tmpdir(), "boxers-native-failed-workspace-"));
    const bin = mkdtempSync(join(tmpdir(), "boxers-native-failed-bin-"));
    cleanup.push(root, state, workspace, bin);
    process.env["BOXERS_HOME"] = state;
    process.env["FAKE_WORKSPACE"] = workspace;
    process.chdir(root);

    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.invalid");
    mkdirSync(join(root, ".boxers"));
    writeFileSync(
      join(root, ".boxers", "config.yml"),
      `version: 3
check:
  commands:
    failing-check:
      run: exit 1
      timeout: 10s
`,
    );
    writeFileSync(join(root, "tracked.txt"), "before\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
    const project = registerTarget(root);
    git(workspace, "clone", "-q", project.seedPath, ".");
    installFakeSbx(bin);

    const task = createTaskManifest(project, "failed-gate", "codex");
    useFakeRuntime(task);
    updateTask(project, task, {
      phase: "active",
      agent: "codex",
      targetOid: git(root, "rev-parse", "HEAD"),
    });
    writeFileSync(join(workspace, "tracked.txt"), "sensitive patch body\n");

    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const setupPath = join(taskDir(project.id, task.id), "setup.json");
    const setupLog = join(taskDir(project.id, task.id), "setup.log");
    const setupStartedAt = new Date().toISOString();
    const runningSetup = {
      state: "running" as const,
      command: "npm ci",
      startedAt: setupStartedAt,
      logPath: setupLog,
      jobId: "setup-job",
      configHash: "setup-config",
    };
    writeFileSync(setupPath, JSON.stringify(runningSetup));
    const beforeSetup = requireTask(project, "failed-gate");
    updateTask(project, beforeSetup, { ...beforeSetup.lastSnapshot!, setup: runningSetup });
    setTimeout(() => {
      const passedSetup = {
        ...runningSetup,
        state: "passed" as const,
        finishedAt: new Date().toISOString(),
        exitCode: 0,
      };
      writeFileSync(setupPath, JSON.stringify(passedSetup));
      const current = requireTask(project, "failed-gate");
      updateTask(
        project,
        current,
        { ...current.lastSnapshot!, setup: passedSetup },
        undefined,
        "worker",
      );
    }, 20);
    await expect(review("failed-gate", true)).resolves.toBe(0);
    expect(requireTask(project, "failed-gate").lastSnapshot?.setup?.state).toBe("passed");
    const reviewOutput = stdout.mock.calls.map((call) => String(call[0])).join("");
    expect(reviewOutput).toContain("\x1b[1mfailed-gate\x1b[0m");
    expect(reviewOutput).toMatch(/\x1b\[3[12]m/);
    expect(reviewOutput).toContain("tracked.txt");
    expect(reviewOutput).toContain("sensitive patch body");

    await expect(check("failed-gate")).resolves.toBe(1);
    expect(requireTask(project, "failed-gate").lastSnapshot).toMatchObject({
      phase: "reviewed",
      check: { status: "failed", results: [{ name: "failing-check", status: "failed" }] },
    });

    await expect(promote("failed-gate")).resolves.toBe(1);
    expect(requireTask(project, "failed-gate").lastSnapshot).toMatchObject({
      check: { status: "failed", results: [{ name: "failing-check", status: "failed" }] },
    });
    await expect(promote("failed-gate", undefined, true)).resolves.toBe(0);
    expect(git(target(root), "show", "main:tracked.txt")).toBe("sensitive patch body");
    expect(
      readTaskState(project, requireTask(project, "failed-gate")).lastDelivery?.value.checks,
    ).toBe("skipped");
  });

  it("automatically repairs reconciliation conflicts in a fresh provider session", async () => {
    const root = mkdtempSync(join(tmpdir(), "boxers-auto-repair-root-"));
    const state = mkdtempSync(join(tmpdir(), "boxers-auto-repair-state-"));
    const workspace = mkdtempSync(join(tmpdir(), "boxers-auto-repair-workspace-"));
    const bin = mkdtempSync(join(tmpdir(), "boxers-auto-repair-bin-"));
    cleanup.push(root, state, workspace, bin);
    process.env["BOXERS_HOME"] = state;
    process.env["FAKE_WORKSPACE"] = workspace;
    process.env["FAKE_SBX_LOG"] = join(bin, "sbx.log");
    process.chdir(root);

    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.invalid");
    mkdirSync(join(root, ".boxers"));
    writeFileSync(join(root, ".boxers", "config.yml"), "version: 3\n");
    writeFileSync(join(root, "shared.txt"), "base\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
    const project = registerTarget(root);
    git(workspace, "clone", "-q", project.seedPath, ".");
    installFakeSbx(bin);
    writeFileSync(
      join(bin, "codex"),
      `#!/bin/sh
printf 'combined task and upstream intent\n' > "$FAKE_WORKSPACE/shared.txt"
git -C "$FAKE_WORKSPACE" add shared.txt
printf 'resolved and staged shared.txt\n'
`,
    );
    chmodSync(join(bin, "codex"), 0o755);

    const task = createTaskManifest(project, "native", "codex");
    useFakeRuntime(task);
    const oldTarget = git(root, "rev-parse", "HEAD");
    updateTask(project, task, { phase: "idle", agent: "codex", targetOid: oldTarget });
    writeFileSync(join(workspace, "shared.txt"), "task change\n");
    writeFileSync(join(root, "shared.txt"), "upstream change\n");
    git(root, "add", "shared.txt");
    git(root, "commit", "-q", "-m", "conflicting target change");
    const advancedTarget = git(root, "rev-parse", "HEAD");

    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await expect(sync("native")).resolves.toBe(0);
    expect(readFileSync(join(workspace, "shared.txt"), "utf8")).toBe(
      "combined task and upstream intent\n",
    );
    expect(git(workspace, "diff", "--name-only", "--diff-filter=U")).toBe("");
    expect(requireTask(project, "native").lastSnapshot).toMatchObject({
      phase: "reviewed",
      targetOid: advancedTarget,
    });
    expect(requireTask(project, "native").lastSnapshot?.failure).toBeUndefined();
    expect(requireTask(project, "native").lastSnapshot?.question).toBeUndefined();
    expect(projectTaskView(project, requireTask(project, "native")).issues).toEqual([]);
    expect(readTaskState(project, requireTask(project, "native"))).toMatchObject({
      hasUnmergedChanges: { value: true },
    });
    expect(readFileSync(join(taskDir(project.id, task.id), "repair.log"), "utf8")).toContain(
      "Exit status: 0",
    );
    expect(readFileSync(process.env["FAKE_SBX_LOG"], "utf8")).toContain(
      "<timeout> <--signal=TERM> <--kill-after=10s> <10m> <sh> <-c>",
    );
  });

  it("falls back to the attached session when automatic conflict repair is inconclusive", async () => {
    const root = mkdtempSync(join(tmpdir(), "boxers-native-conflict-root-"));
    const state = mkdtempSync(join(tmpdir(), "boxers-native-conflict-state-"));
    const workspace = mkdtempSync(join(tmpdir(), "boxers-native-conflict-workspace-"));
    const bin = mkdtempSync(join(tmpdir(), "boxers-native-conflict-bin-"));
    cleanup.push(root, state, workspace, bin);
    process.env["BOXERS_HOME"] = state;
    process.env["FAKE_WORKSPACE"] = workspace;
    process.env["FAKE_SBX_LOG"] = join(bin, "sbx.log");
    process.chdir(root);

    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.invalid");
    mkdirSync(join(root, ".boxers"));
    writeFileSync(
      join(root, ".boxers", "config.yml"),
      `version: 3
check:
  commands:
    files:
      run: exit 0
      timeout: 10s
`,
    );
    writeFileSync(join(root, "shared.txt"), "base\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
    const project = registerTarget(root);
    git(workspace, "clone", "-q", project.seedPath, ".");
    installFakeSbx(bin);

    const task = createTaskManifest(project, "native", "codex");
    useFakeRuntime(task);
    const oldTarget = git(root, "rev-parse", "HEAD");
    updateTask(project, task, {
      phase: "active",
      agent: "codex",
      targetOid: oldTarget,
    });
    writeFileSync(join(workspace, "shared.txt"), "task change\n");
    writeFileSync(join(root, "shared.txt"), "upstream change\n");
    git(root, "add", "shared.txt");
    git(root, "commit", "-q", "-m", "conflicting target change");
    const advancedTarget = git(root, "rev-parse", "HEAD");

    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await expect(sync("native")).resolves.toBe(1);
    expect(readFileSync(join(workspace, "shared.txt"), "utf8")).toContain("<<<<<<<");
    expect(git(workspace, "show", "refs/boxers/reconcile/work:shared.txt")).toBe("task change");
    expect(requireTask(project, "native").lastSnapshot).toMatchObject({
      phase: "needs_input",
      targetOid: advancedTarget,
      failure: "Reconciliation conflicts: shared.txt",
      question:
        "Attach and ask the agent to resolve and stage every conflicted file, then try again.",
    });
    const conflictedState = readTaskState(project, requireTask(project, "native"));
    expect(projectTaskView(project, requireTask(project, "native"))).toMatchObject({
      agent: { label: "Not started" },
      reconciliation: { state: "conflicted" },
      issues: [{ code: "reconciliation_conflict" }],
    });
    expect(conflictedState).toMatchObject({ failure: "Reconciliation conflicts: shared.txt" });
    const calls = readFileSync(process.env["FAKE_SBX_LOG"], "utf8");
    expect(calls).not.toContain("run <-d> <codex> <--name> <boxers-project-task>");
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining("Automatic reconciliation repair could not safely resolve"),
    );

    writeFileSync(join(workspace, "shared.txt"), "resolved change\n");
    git(workspace, "add", "shared.txt");
    await expect(review("native")).resolves.toBe(0);
    expect(readTaskState(project, requireTask(project, "native")).agentTurnState).not.toBe(
      "working",
    );
    expect(requireTask(project, "native").lastSnapshot).toMatchObject({
      phase: "reviewed",
      targetOid: advancedTarget,
    });
  });

  it("refuses promotion while the lifecycle state is working without probing the Sandbox", async () => {
    const root = mkdtempSync(join(tmpdir(), "boxers-native-working-root-"));
    const state = mkdtempSync(join(tmpdir(), "boxers-native-working-state-"));
    const workspace = mkdtempSync(join(tmpdir(), "boxers-native-working-workspace-"));
    const bin = mkdtempSync(join(tmpdir(), "boxers-native-working-bin-"));
    cleanup.push(root, state, workspace, bin);
    process.env["BOXERS_HOME"] = state;
    process.env["FAKE_WORKSPACE"] = workspace;
    process.env["FAKE_AGENT_ACTIVITY"] = "working";
    const sbxLog = join(bin, "sbx.log");
    process.env["FAKE_SBX_LOG"] = sbxLog;
    process.chdir(root);

    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.invalid");
    mkdirSync(join(root, ".boxers"));
    writeFileSync(join(root, ".boxers", "config.yml"), "version: 3\n");
    writeFileSync(join(root, "tracked.txt"), "before\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
    const project = registerTarget(root);
    git(workspace, "clone", "-q", project.seedPath, ".");
    installFakeSbx(bin);

    const task = createTaskManifest(project, "native", "codex");
    useFakeRuntime(task);
    updateTask(project, task, {
      phase: "working",
      agent: "codex",
      targetOid: git(root, "rev-parse", "HEAD"),
    });
    recordLifecycleEvent(project, requireTask(project, "native"), {
      version: 1,
      sequence: 1,
      event: {
        version: 1,
        kind: "user_prompt",
        provider: "codex",
        providerSessionId: "session",
        prompt: "continue",
        recordedAt: "2030-01-01T00:00:00.000Z",
      },
      source: { provider: "codex", hookEvent: "UserPromptSubmit", rawBytes: 20 },
    });
    writeFileSync(join(workspace, "tracked.txt"), "still being edited\n");

    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await expect(promote("native")).rejects.toThrow(/actively working/);
    const calls = readFileSync(sbxLog, "utf8").split("\n").filter(Boolean);
    expect(calls.filter((call) => call.startsWith("ls "))).toHaveLength(0);
    expect(calls.join("\n")).not.toContain("stop <boxers-project-task>");
    expect(readFileSync(join(root, "tracked.txt"), "utf8")).toBe("before\n");
  });
});
