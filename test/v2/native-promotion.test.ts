import { execFileSync } from "node:child_process";
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
import { createTaskManifest, initProject, requireTask, updateTask } from "../../src/v2/registry.ts";
import { taskDir } from "../../src/v2/paths.ts";
import { suspendTaskEnvironment } from "../../src/v2/runtime/task.ts";
import { advanceNativeWorkspace, nativeWorkspacePatch } from "../../src/v2/sandbox.ts";
import { readTaskState, recordLifecycleEvent, recordTaskSnapshot } from "../../src/v2/state.ts";
import { projectTaskView } from "../../src/v2/projection.ts";

const cleanup: string[] = [];
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
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
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

describe("native review, promotion, and preview", () => {
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
    const project = initProject({ integration: "local", base: "main", cwd: root });
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
    const project = initProject({ integration: "local", base: "main", cwd: root });
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

  it("publishes remote integration to a task branch without advancing the base", async () => {
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
      "version: 3\nintegration:\n  mode: remote\n  base: main\n  remote: origin\n",
      { flag: "w" },
    );
    writeFileSync(join(root, "tracked.txt"), "before\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
    git(root, "remote", "add", "origin", remote);
    git(root, "push", "-q", "-u", "origin", "main");
    const base = git(root, "rev-parse", "HEAD");
    const project = initProject({
      integration: "remote",
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

    expect(git(remote, "rev-parse", "refs/heads/main")).toBe(base);
    const branch = `agent/${root.split("/").at(-1)}/native`;
    const published = git(remote, "rev-parse", `refs/heads/${branch}`);
    expect(git(remote, "show", `${published}:tracked.txt`)).toBe("after");
    expect(git(workspace, "rev-parse", "HEAD")).toBe(published);
    expect(requireTask(project, "native").lastSnapshot?.targetOid).toBe(published);
    expect(
      readTaskState(project, requireTask(project, "native")).lastDelivery?.value,
    ).toMatchObject({
      ref: branch,
      oid: published,
      checks: "not_configured",
      deliveredAt: expect.any(String),
    });
    expect(stdout.mock.calls.map((call) => String(call[0])).join("")).toContain(
      "Open a pull request to merge it into main.",
    );

    git(root, "fetch", "-q", "origin", branch);
    git(root, "merge", "--squash", "-q", "FETCH_HEAD");
    git(root, "commit", "-q", "-m", "Squash merge native PR");
    git(root, "push", "-q", "origin", "main");
    const updatedBase = git(root, "rev-parse", "HEAD");

    writeFileSync(join(workspace, "continued.txt"), "continued work\n");
    await expect(promote("native", "Continue native")).resolves.toBe(0);

    expect(git(remote, "rev-parse", "refs/heads/main")).toBe(updatedBase);
    const republished = git(remote, "rev-parse", `refs/heads/${branch}`);
    expect(republished).not.toBe(published);
    expect(git(remote, "merge-base", "--is-ancestor", updatedBase, republished)).toBe("");
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
    const project = initProject({ integration: "local", base: "main", cwd: root });
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
    const project = initProject({ integration: "local", base: "main", cwd: root });
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
    const project = initProject({ integration: "local", base: "main", cwd: root });
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
    const project = initProject({ integration: "local", base: "main", cwd: root });
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
    const project = initProject({ integration: "local", base: "main", cwd: root });
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
    const project = initProject({ integration: "local", base: "main", cwd: root });
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
    const project = initProject({ integration: "local", base: "main", cwd: root });
    git(workspace, "clone", "-q", project.seedPath, ".");
    installFakeSbx(bin);

    const task = createTaskManifest(project, "native", "codex");
    useFakeRuntime(task);
    updateTask(project, task, { phase: "stopped", agent: "codex" });

    await expect(status("native", true, true)).resolves.toBe(0);
    suspendTaskEnvironment(task);
    expect(readTaskState(project, requireTask(project, "native"))).toMatchObject({
      hasUnmergedChanges: { value: false },
      baseOid: expect.any(String),
    });
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
    const project = initProject({ integration: "local", base: "main", cwd: root });
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
    expect(existsSync(sbxLog)).toBe(false);
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
    const project = initProject({ integration: "local", base: "main", cwd: root });
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
    const project = initProject({ integration: "local", base: "main", cwd: root });
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
    expect(inspected.internal.state).toMatchObject({
      hasUnmergedChanges: { value: true },
      candidateTreeOid: expect.any(String),
    });
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
    expect(readFileSync(join(root, "tracked.txt"), "utf8")).toBe("after\n");
    expect(readFileSync(join(root, "untracked.txt"), "utf8")).toBe("new\n");
    expect([...readFileSync(join(root, "binary.bin"))]).toEqual([0, 1, 2, 255]);
    expect(() => readFileSync(join(root, "delete-me.txt"))).toThrow();
    expect(git(root, "log", "-1", "--pretty=%s")).toBe("Update tracked files and assets");
    expect(git(root, "log", "-1", "--pretty=%b")).toBe(
      "Preserve tracked, untracked, binary, and deleted content in one exact candidate snapshot.",
    );
    expect(
      readTaskState(project, requireTask(project, "native")).lastDelivery?.value,
    ).toMatchObject({
      ref: "main",
      oid: git(root, "rev-parse", "HEAD"),
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
      targetOid: git(root, "rev-parse", "HEAD"),
    });
    writeFileSync(join(workspace, "direct.txt"), "merged without review\n");
    await expect(promote("direct-merge")).resolves.toBe(0);
    expect(readFileSync(join(root, "direct.txt"), "utf8")).toBe("merged without review\n");
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
    const project = initProject({ integration: "local", base: "main", cwd: root });
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
    expect(readFileSync(join(root, "tracked.txt"), "utf8")).toBe("sensitive patch body\n");
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
    const project = initProject({ integration: "local", base: "main", cwd: root });
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
      "<timeout> <--signal=TERM> <--kill-after=10s> <10m> <codex>",
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
    const project = initProject({ integration: "local", base: "main", cwd: root });
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
    const project = initProject({ integration: "local", base: "main", cwd: root });
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
