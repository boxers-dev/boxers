import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseInvocationContext,
  readPluginState,
  writePluginState,
} from "../../src/herdr/state.ts";
import { refreshProjectMirror, resolveProjectTarget } from "../../src/herdr/mirror.ts";
import {
  attachPane,
  createPluginSandbox,
  reconcilePluginPanes,
  sandboxName,
  strictSandboxEnvironment,
} from "../../src/herdr/sandbox.ts";
import { parseProjectConfig } from "../../src/herdr/config.ts";
import {
  livePreviewLogs,
  reconcilePreviewJobs,
  startLivePreview,
  stopLivePreview,
} from "../../src/herdr/preview.ts";
import { captureReview, promoteReview } from "../../src/herdr/review.ts";
import type { HerdrPluginState } from "../../src/herdr/types.ts";

const roots: string[] = [];
const originalPath = process.env.PATH;
const originalStateDir = process.env.HERDR_PLUGIN_STATE_DIR;
const originalHerdrBin = process.env.HERDR_BIN_PATH;
const defaultConfigHash = createHash("sha256")
  .update(
    `${createHash("sha256").update("version: 1\n").digest("hex")}\0${createHash("sha256").update("version: 1\n").digest("hex")}`,
  )
  .digest("hex");

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "boxers-herdr-test-"));
  roots.push(root);
  return root;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  }).trim();
}

function repository(root: string): { remote: string; checkout: string; targetOid: string } {
  const remote = join(root, "remote.git");
  const checkout = join(root, "checkout");
  git(root, "init", "--bare", "--quiet", remote);
  git(root, "init", "--quiet", "-b", "main", checkout);
  writeFileSync(join(checkout, ".gitignore"), "ignored.env\n");
  writeFileSync(join(checkout, "tracked.txt"), "base\n");
  writeFileSync(join(checkout, "delete-me.txt"), "delete me\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "--quiet", "-m", "base");
  git(checkout, "remote", "add", "origin", remote);
  git(checkout, "push", "--quiet", "-u", "origin", "main");
  return { remote, checkout, targetOid: git(checkout, "rev-parse", "HEAD") };
}

afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.BOXERS_FAKE_SANDBOX;
  delete process.env.BOXERS_FAKE_LOST_PUSH;
  delete process.env.BOXERS_FAKE_PUSH_DOWN;
  delete process.env.BOXERS_FAKE_ADVANCE_FAIL;
  delete process.env.BOXERS_FAKE_HERDR_LOG;
  delete process.env.BOXERS_FAKE_SBX_LOG;
  delete process.env.BOXERS_FAKE_SANDBOX_HOME;
  delete process.env.BOXERS_FAKE_PORT_MARKER;
  delete process.env.BOXERS_TASK_ID;
  delete process.env.BOXERS_SANDBOX_ID;
  delete process.env.HERDR_PANE_ID;
  if (originalStateDir === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
  else process.env.HERDR_PLUGIN_STATE_DIR = originalStateDir;
  if (originalHerdrBin === undefined) delete process.env.HERDR_BIN_PATH;
  else process.env.HERDR_BIN_PATH = originalHerdrBin;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Herdr plugin contract", () => {
  it("declares static launch and review actions without a direct promotion action", () => {
    const manifest = readFileSync(join(process.cwd(), "herdr-plugin.toml"), "utf8");
    expect(manifest).toContain('min_herdr_version = "0.9.0"');
    expect(manifest).toContain('id = "new-codex"');
    expect(manifest).toContain('id = "new-claude"');
    expect(manifest).toContain('id = "review"');
    expect(manifest).not.toContain('id = "promote"');
  });

  it("parses documented Herdr invocation fields and rejects malformed context", () => {
    expect(
      parseInvocationContext(
        JSON.stringify({
          workspace_id: "w1",
          workspace_cwd: "/repo",
          focused_pane_id: "w1:p2",
          focused_pane_cwd: "/repo/subdir",
        }),
      ),
    ).toEqual({
      workspace_id: "w1",
      workspace_cwd: "/repo",
      focused_pane_id: "w1:p2",
      focused_pane_cwd: "/repo/subdir",
    });
    expect(() => parseInvocationContext("[]")).toThrow("must be an object");
  });

  it("removes SSH publication authority and the raw Herdr control socket from sbx calls", () => {
    const env = strictSandboxEnvironment({
      PATH: "/bin",
      SSH_AUTH_SOCK: "/secret/agent.sock",
      HERDR_SOCKET_PATH: "/secret/herdr.sock",
      HERDR_BIN_PATH: "/bin/herdr",
      HERDR_PLUGIN_CONTEXT_JSON: "{}",
    });
    expect(env.PATH).toBe("/bin");
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.HERDR_SOCKET_PATH).toBeUndefined();
    expect(env.HERDR_BIN_PATH).toBeUndefined();
    expect(env.HERDR_PLUGIN_CONTEXT_JSON).toBeUndefined();
  });

  it("allocates collision-safe Docker names", () => {
    const first = sandboxName("abcdef0123456789", new Set());
    const second = sandboxName("abcdef0123456789", new Set([first]));
    expect(first).toMatch(/^boxers-abcdef01-[a-f0-9]{10}$/);
    expect(second).not.toBe(first);
  });

  it("uses documented clone and template arguments and preserves provider defaults", () => {
    const root = temporaryRoot();
    const bin = join(root, "bin");
    const log = join(root, "sbx.log");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "sbx"),
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$BOXERS_FAKE_SBX_LOG"\ncase "$1" in --version) echo "sbx 0.42.0";; ls) echo "[]";; esac\n',
    );
    chmodSync(join(bin, "sbx"), 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    process.env.BOXERS_FAKE_SBX_LOG = log;

    const config = parseProjectConfig("version: 1\nsandbox:\n  template: example/template:v1\n");
    const name = createPluginSandbox("abcdef0123456789", "/safe/mirror", "codex", config);

    expect(readFileSync(log, "utf8")).toContain(
      `create --clone --name ${name} --template example/template:v1 codex /safe/mirror`,
    );
  });

  it("reports sandboxed agent metadata and appends configured provider flags", () => {
    const root = temporaryRoot();
    const stateDir = join(root, "state");
    const bin = join(root, "bin");
    const log = join(root, "calls.log");
    mkdirSync(bin);
    process.env.HERDR_PLUGIN_STATE_DIR = stateDir;
    process.env.HERDR_BIN_PATH = join(bin, "herdr");
    process.env.HERDR_PANE_ID = "w1:p9";
    process.env.BOXERS_TASK_ID = "task";
    process.env.BOXERS_SANDBOX_ID = "sandbox";
    process.env.BOXERS_FAKE_HERDR_LOG = log;
    writePluginState(
      {
        version: 1,
        projects: [],
        tasks: [
          {
            version: 1,
            id: "task",
            projectId: "project",
            sandboxId: "sandbox",
            agent: "codex",
            agentModel: "gpt-test",
            agentEffort: "high",
            projectRoot: "/project",
            mirrorPath: "/mirror",
            createdAt: new Date().toISOString(),
          },
        ],
      },
      stateDir,
    );
    writeFileSync(
      join(bin, "herdr"),
      '#!/bin/sh\nprintf \'herdr %s\\n\' "$*" >> "$BOXERS_FAKE_HERDR_LOG"\n',
    );
    writeFileSync(
      join(bin, "sbx"),
      '#!/bin/sh\nprintf \'sbx %s\\n\' "$*" >> "$BOXERS_FAKE_HERDR_LOG"\n',
    );
    chmodSync(join(bin, "herdr"), 0o755);
    chmodSync(join(bin, "sbx"), 0o755);
    process.env.PATH = `${bin}:${originalPath}`;

    expect(attachPane("codex")).toBe(0);
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain(
      "herdr pane report-metadata w1:p9 --source boxers --agent codex --display-agent Codex (sandboxed)",
    );
    expect(calls).toContain(
      'sbx run --name sandbox -- --model gpt-test --config model_reasoning_effort="high"',
    );
  });

  it("reopens a durable sandbox through its manifest pane after a full-server restart", () => {
    const root = temporaryRoot();
    const stateDir = join(root, "state");
    process.env.HERDR_PLUGIN_STATE_DIR = stateDir;
    const now = new Date().toISOString();
    writePluginState(
      {
        version: 1,
        projects: [],
        tasks: [
          {
            version: 1,
            id: "task",
            projectId: "project",
            sandboxId: "boxers-project-task",
            agent: "codex",
            projectRoot: "/project",
            mirrorPath: "/mirror",
            workspaceId: "w1",
            paneId: "w1:p2",
            createdAt: now,
          },
          {
            version: 1,
            id: "stopped-task",
            projectId: "project",
            sandboxId: "boxers-project-stopped",
            agent: "claude",
            projectRoot: "/project",
            mirrorPath: "/mirror",
            createdAt: now,
          },
          {
            version: 1,
            id: "missing-task",
            projectId: "project",
            sandboxId: "boxers-project-missing",
            agent: "claude",
            projectRoot: "/project",
            mirrorPath: "/mirror",
            createdAt: now,
          },
        ],
      },
      stateDir,
    );
    const bin = join(root, "bin");
    const log = join(root, "herdr.log");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "sbx"),
      '#!/bin/sh\nif test "$1" = ls; then printf \'[{"name":"boxers-project-task","status":"running"},{"name":"boxers-project-stopped","status":"stopped"}]\\n\'; exit 0; fi\nexit 1\n',
    );
    writeFileSync(
      join(bin, "herdr"),
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$BOXERS_FAKE_HERDR_LOG"\nif test "$1" = agent; then exit 1; fi\nexit 0\n',
    );
    chmodSync(join(bin, "sbx"), 0o755);
    chmodSync(join(bin, "herdr"), 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    process.env.HERDR_BIN_PATH = join(bin, "herdr");
    process.env.BOXERS_FAKE_HERDR_LOG = log;

    reconcilePluginPanes();

    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("agent get w1:p2");
    expect(calls).toContain(
      "plugin pane open --plugin boxers.sandboxes --entrypoint agent-codex --placement tab",
    );
    expect(calls).toContain("--env BOXERS_TASK_ID=task");
    expect(calls).toContain("--env BOXERS_SANDBOX_ID=boxers-project-task");
    expect(calls).toContain("--env HERDR_AGENT=codex");
    expect(calls).not.toContain("BOXERS_TASK_ID=stopped-task");
    expect(calls).not.toContain("BOXERS_TASK_ID=missing-task");
    const tasks = readPluginState(stateDir).tasks;
    expect(tasks.find((task) => task.id === "task")?.runtimeState).toBe("running");
    expect(tasks.find((task) => task.id === "stopped-task")?.runtimeState).toBe("stopped");
    expect(tasks.find((task) => task.id === "missing-task")?.runtimeState).toBe("missing");
  });
});

describe("sanitized project mirrors", () => {
  it("materializes only the committed target without changing the host checkout", () => {
    const root = temporaryRoot();
    const { checkout, targetOid } = repository(root);
    writeFileSync(join(checkout, "untracked-secret.txt"), "secret\n");
    writeFileSync(join(checkout, "ignored.env"), "TOKEN=secret\n");
    writeFileSync(join(checkout, ".git", "hooks", "post-checkout"), "exit 99\n");
    git(checkout, "config", "credential.helper", "store --file=/secret/credentials");
    const before = {
      head: git(checkout, "rev-parse", "HEAD"),
      status: git(checkout, "status", "--porcelain=v1", "--untracked-files=all"),
      config: readFileSync(join(checkout, ".git", "config"), "utf8"),
    };

    const target = resolveProjectTarget(checkout);
    const project = refreshProjectMirror(join(root, "state"), target);

    expect(git(project.mirrorPath, "rev-parse", "HEAD")).toBe(targetOid);
    expect(readFileSync(join(project.mirrorPath, "tracked.txt"), "utf8")).toBe("base\n");
    expect(existsSync(join(project.mirrorPath, "untracked-secret.txt"))).toBe(false);
    expect(existsSync(join(project.mirrorPath, "ignored.env"))).toBe(false);
    expect(existsSync(join(project.mirrorPath, ".git", "hooks"))).toBe(false);
    expect(git(project.mirrorPath, "remote")).toBe("");
    expect(readFileSync(join(project.mirrorPath, ".git", "config"), "utf8")).not.toContain(
      "credential",
    );
    expect({
      head: git(checkout, "rev-parse", "HEAD"),
      status: git(checkout, "status", "--porcelain=v1", "--untracked-files=all"),
      config: readFileSync(join(checkout, ".git", "config"), "utf8"),
    }).toEqual(before);
  });
});

describe("sandbox preview jobs", () => {
  it("runs setup, retains logs, reuses ports, and reconciles a stale detached job", () => {
    const root = temporaryRoot();
    const { checkout } = repository(root);
    mkdirSync(join(checkout, ".boxers"));
    writeFileSync(
      join(checkout, ".boxers", "config.yml"),
      [
        "version: 1",
        "setup:",
        "  run: printf 'setup\\n'",
        "  timeout: 5s",
        "preview:",
        "  run: printf 'preview\\n'",
        "  ports: [3000]",
        "  review: snapshot",
        "",
      ].join("\n"),
    );
    git(checkout, "add", ".boxers/config.yml");
    git(checkout, "commit", "--quiet", "-m", "preview config");
    git(checkout, "push", "--quiet", "origin", "main");
    const stateDir = join(root, "state");
    const target = resolveProjectTarget(checkout);
    const project = refreshProjectMirror(stateDir, target);
    const sandbox = join(root, "sandbox");
    const sandboxHome = join(root, "sandbox-home");
    mkdirSync(sandboxHome);
    git(root, "clone", "--quiet", project.mirrorPath, sandbox);
    process.env.HERDR_PLUGIN_STATE_DIR = stateDir;
    writePluginState(
      {
        version: 1,
        projects: [project],
        tasks: [
          {
            version: 1,
            id: "preview-task",
            projectId: project.id,
            sandboxId: "preview-sandbox",
            agent: "codex",
            projectRoot: checkout,
            mirrorPath: project.mirrorPath,
            runtimeState: "running",
            createdAt: new Date().toISOString(),
          },
        ],
      },
      stateDir,
    );
    const bin = join(root, "bin");
    const sbxLog = join(root, "sbx.log");
    const portMarker = join(root, "port-published");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "sbx"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$BOXERS_FAKE_SBX_LOG"
if test "$1" = exec; then
  shift
  if test "$1" = -d; then shift; fi
  shift
  cd "$BOXERS_FAKE_SANDBOX" || exit 1
  HOME="$BOXERS_FAKE_SANDBOX_HOME" exec "$@"
fi
if test "$1" = ports && test "$3" = --json; then
  if test -f "$BOXERS_FAKE_PORT_MARKER"; then
    printf '[{"host_port":45173,"sandbox_port":3000}]\\n'
  else
    printf '[]\\n'
  fi
  exit 0
fi
if test "$1" = ports && test "$3" = --publish; then
  touch "$BOXERS_FAKE_PORT_MARKER"
  exit 0
fi
exit 1
`,
    );
    chmodSync(join(bin, "sbx"), 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    process.env.BOXERS_FAKE_SANDBOX = sandbox;
    process.env.BOXERS_FAKE_SANDBOX_HOME = sandboxHome;
    process.env.BOXERS_FAKE_SBX_LOG = sbxLog;
    process.env.BOXERS_FAKE_PORT_MARKER = portMarker;

    expect(startLivePreview("preview-task")).toEqual(["http://localhost:45173"]);
    expect(livePreviewLogs("preview-task")).toBe("setup\npreview\n");
    expect(startLivePreview("preview-task")).toEqual(["http://localhost:45173"]);
    expect(readFileSync(sbxLog, "utf8").match(/--publish 3000/g)).toHaveLength(1);

    reconcilePreviewJobs();
    expect(readPluginState(stateDir).tasks[0]!.preview?.state).toBe("stopped");
    stopLivePreview("preview-task");
  });
});

describe("immutable review capture", () => {
  it("captures staged, unstaged, deleted, untracked, and force-added files without changing the index", () => {
    const root = temporaryRoot();
    const { checkout, targetOid } = repository(root);
    const sandbox = join(root, "sandbox");
    git(root, "clone", "--quiet", checkout, sandbox);
    git(sandbox, "checkout", "--quiet", "main");
    const mirror = join(root, "mirror");
    git(root, "clone", "--quiet", checkout, mirror);
    git(mirror, "remote", "remove", "origin");
    git(mirror, "remote", "add", "sandbox-test", sandbox);

    writeFileSync(join(sandbox, "tracked.txt"), "staged then edited\n");
    git(sandbox, "add", "tracked.txt");
    writeFileSync(join(sandbox, "tracked.txt"), "unstaged final\n");
    writeFileSync(join(sandbox, "untracked.txt"), "untracked\n");
    writeFileSync(join(sandbox, "ignored.env"), "force-added\n");
    git(sandbox, "add", "-f", "ignored.env");
    rmSync(join(sandbox, "delete-me.txt"));
    const indexBefore = readFileSync(join(sandbox, ".git", "index"));

    const bin = join(root, "bin");
    mkdirSync(bin);
    const sbx = join(bin, "sbx");
    writeFileSync(
      sbx,
      '#!/bin/sh\nif test "$1" = exec; then shift 2; cd "$BOXERS_FAKE_SANDBOX" || exit; exec "$@"; fi\nexit 1\n',
    );
    chmodSync(sbx, 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    process.env.BOXERS_FAKE_SANDBOX = sandbox;
    const stateDir = join(root, "state");
    process.env.HERDR_PLUGIN_STATE_DIR = stateDir;
    const state: HerdrPluginState = {
      version: 1,
      projects: [
        {
          version: 1,
          id: "project",
          root: checkout,
          mirrorPath: mirror,
          targetUrl: checkout,
          targetBranch: "main",
          targetOid,
          configHash: "config",
          updatedAt: new Date().toISOString(),
        },
      ],
      tasks: [
        {
          version: 1,
          id: "task",
          projectId: "project",
          sandboxId: "test",
          agent: "codex",
          projectRoot: checkout,
          mirrorPath: mirror,
          createdAt: new Date().toISOString(),
        },
      ],
    };
    writePluginState(state, stateDir);

    const review = captureReview("task");

    expect(readFileSync(join(sandbox, ".git", "index"))).toEqual(indexBefore);
    expect(git(mirror, "show", `${review.candidateTreeOid}:tracked.txt`)).toBe("unstaged final");
    expect(git(mirror, "show", `${review.candidateTreeOid}:untracked.txt`)).toBe("untracked");
    expect(git(mirror, "show", `${review.candidateTreeOid}:ignored.env`)).toBe("force-added");
    expect(
      spawnSync("git", ["-C", mirror, "cat-file", "-e", `${review.candidateTreeOid}:delete-me.txt`])
        .status,
    ).not.toBe(0);
    expect(git(mirror, "rev-parse", `${review.transportCommitOid}^{tree}`)).toBe(
      review.candidateTreeOid,
    );
  });

  it("reconciles sandbox work onto an advanced target before recording the review", () => {
    const root = temporaryRoot();
    const { checkout, targetOid } = repository(root);
    const stateDir = join(root, "state");
    process.env.HERDR_PLUGIN_STATE_DIR = stateDir;
    const target = resolveProjectTarget(checkout);
    const project = refreshProjectMirror(stateDir, target);
    const sandbox = join(root, "sandbox");
    mkdirSync(sandbox);
    git(sandbox, "init", "--quiet");
    git(sandbox, "remote", "add", "origin", project.mirrorPath);
    git(sandbox, "fetch", "--quiet", "origin", "refs/boxers/target");
    git(sandbox, "checkout", "--quiet", "--detach", targetOid);
    git(project.mirrorPath, "remote", "add", "sandbox-test", sandbox);
    writeFileSync(join(sandbox, "task.txt"), "sandbox work\n");

    writeFileSync(join(checkout, "upstream.txt"), "new target\n");
    git(checkout, "add", "upstream.txt");
    git(checkout, "commit", "--quiet", "-m", "advance target");
    git(checkout, "push", "--quiet", "origin", "main");
    const advancedOid = git(checkout, "rev-parse", "HEAD");
    const checkoutBefore = git(checkout, "status", "--porcelain=v1", "--untracked-files=all");

    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "sbx"),
      '#!/bin/sh\nif test "$1" = exec; then shift 2; cd "$BOXERS_FAKE_SANDBOX" || exit; exec "$@"; fi\nexit 1\n',
    );
    chmodSync(join(bin, "sbx"), 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    process.env.BOXERS_FAKE_SANDBOX = sandbox;
    writePluginState(
      {
        version: 1,
        projects: [project],
        tasks: [
          {
            version: 1,
            id: "task",
            projectId: project.id,
            sandboxId: "test",
            agent: "codex",
            projectRoot: checkout,
            mirrorPath: project.mirrorPath,
            createdAt: new Date().toISOString(),
          },
        ],
      },
      stateDir,
    );

    const review = captureReview("task");

    expect(review.targetOid).toBe(advancedOid);
    expect(git(project.mirrorPath, "show", `${review.candidateTreeOid}:upstream.txt`)).toBe(
      "new target",
    );
    expect(git(project.mirrorPath, "show", `${review.candidateTreeOid}:task.txt`)).toBe(
      "sandbox work",
    );
    expect(git(checkout, "status", "--porcelain=v1", "--untracked-files=all")).toBe(checkoutBefore);
  });
});

describe("host-side reviewed delivery", () => {
  it("recovers an accepted push with a lost response without creating a duplicate commit", () => {
    const root = temporaryRoot();
    const { remote, checkout, targetOid } = repository(root);
    const mirror = join(root, "delivery-mirror");
    git(root, "clone", "--quiet", checkout, mirror);
    git(mirror, "remote", "remove", "origin");
    writeFileSync(join(mirror, "tracked.txt"), "reviewed candidate\n");
    git(mirror, "add", "-A");
    const candidateTreeOid = git(mirror, "write-tree");
    git(mirror, "reset", "--quiet", "--hard", targetOid);

    const stateDir = join(root, "state");
    process.env.HERDR_PLUGIN_STATE_DIR = stateDir;
    const capturedAt = new Date().toISOString();
    writePluginState(
      {
        version: 1,
        projects: [
          {
            version: 1,
            id: "project",
            root: checkout,
            mirrorPath: mirror,
            targetUrl: remote,
            targetBranch: "main",
            targetOid,
            configHash: "config",
            updatedAt: capturedAt,
          },
        ],
        tasks: [
          {
            version: 1,
            id: "delivery-task",
            projectId: "project",
            sandboxId: "delivery",
            agent: "codex",
            projectRoot: checkout,
            mirrorPath: mirror,
            createdAt: capturedAt,
            review: {
              version: 1,
              id: "review",
              projectId: "project",
              sandboxId: "delivery",
              agent: "codex",
              targetUrl: remote,
              targetBranch: "main",
              targetOid,
              candidateTreeOid,
              transportCommitOid: targetOid,
              configHash: defaultConfigHash,
              capturedAt,
              checks: [],
            },
          },
        ],
      },
      stateDir,
    );

    const bin = join(root, "delivery-bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "git"),
      '#!/bin/sh\nif test "$1" = -C && test "$3" = push && test "$BOXERS_FAKE_PUSH_DOWN" = 1; then echo "network unavailable" >&2; exit 1; fi\nif test "$1" = -C && test "$3" = push && test "$BOXERS_FAKE_LOST_PUSH" = 1; then /usr/bin/git "$@"; exit 1; fi\nexec /usr/bin/git "$@"\n',
    );
    writeFileSync(
      join(bin, "sbx"),
      '#!/bin/sh\nif test "$BOXERS_FAKE_ADVANCE_FAIL" = 1; then printf "advance interrupted\\n" >&2; exit 42; fi\nexit 0\n',
    );
    chmodSync(join(bin, "git"), 0o755);
    chmodSync(join(bin, "sbx"), 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    process.env.BOXERS_FAKE_PUSH_DOWN = "1";
    process.env.BOXERS_FAKE_LOST_PUSH = "0";
    process.env.BOXERS_FAKE_ADVANCE_FAIL = "1";
    const checkoutBefore = {
      head: git(checkout, "rev-parse", "HEAD"),
      status: git(checkout, "status", "--porcelain=v1", "--untracked-files=all"),
    };

    expect(() => promoteReview("delivery-task", "Reviewed increment")).toThrow(
      "outcome is unresolved",
    );
    const pending = readPluginState(stateDir).tasks[0]!.delivery!;
    expect(pending.state).toBe("pending");
    expect(git(remote, "rev-list", "--count", "refs/heads/main")).toBe("1");

    process.env.BOXERS_FAKE_PUSH_DOWN = "0";
    process.env.BOXERS_FAKE_LOST_PUSH = "1";
    const first = promoteReview("delivery-task", "Must reuse the journaled message");

    expect(first.state).toBe("accepted");
    expect(first.commitOid).toBe(pending.commitOid);
    expect(git(remote, "rev-parse", "refs/heads/main")).toBe(first.commitOid);
    expect(git(remote, "rev-parse", `${first.commitOid}^{tree}`)).toBe(candidateTreeOid);
    expect(git(remote, "rev-list", "--count", "refs/heads/main")).toBe("2");
    expect(() => captureReview("delivery-task")).toThrow("unresolved delivery");

    process.env.BOXERS_FAKE_LOST_PUSH = "0";
    process.env.BOXERS_FAKE_ADVANCE_FAIL = "0";
    const retry = promoteReview("delivery-task", "Must not create another commit");

    expect(retry.state).toBe("reconciled");
    expect(retry.commitOid).toBe(first.commitOid);
    expect(git(remote, "rev-list", "--count", "refs/heads/main")).toBe("2");
    expect({
      head: git(checkout, "rev-parse", "HEAD"),
      status: git(checkout, "status", "--porcelain=v1", "--untracked-files=all"),
    }).toEqual(checkoutBefore);
  });

  it("stops when the upstream target advances after review", () => {
    const root = temporaryRoot();
    const { remote, checkout, targetOid } = repository(root);
    const mirror = join(root, "race-mirror");
    git(root, "clone", "--quiet", checkout, mirror);
    git(mirror, "remote", "remove", "origin");
    writeFileSync(join(mirror, "tracked.txt"), "candidate\n");
    git(mirror, "add", "-A");
    const candidateTreeOid = git(mirror, "write-tree");
    git(mirror, "reset", "--quiet", "--hard", targetOid);
    const stateDir = join(root, "race-state");
    process.env.HERDR_PLUGIN_STATE_DIR = stateDir;
    const now = new Date().toISOString();
    writePluginState(
      {
        version: 1,
        projects: [
          {
            version: 1,
            id: "project",
            root: checkout,
            mirrorPath: mirror,
            targetUrl: remote,
            targetBranch: "main",
            targetOid,
            configHash: "config",
            updatedAt: now,
          },
        ],
        tasks: [
          {
            version: 1,
            id: "race-task",
            projectId: "project",
            sandboxId: "race",
            agent: "claude",
            projectRoot: checkout,
            mirrorPath: mirror,
            createdAt: now,
            review: {
              version: 1,
              id: "race-review",
              projectId: "project",
              sandboxId: "race",
              agent: "claude",
              targetUrl: remote,
              targetBranch: "main",
              targetOid,
              candidateTreeOid,
              transportCommitOid: targetOid,
              configHash: defaultConfigHash,
              capturedAt: now,
              checks: [],
            },
          },
        ],
      },
      stateDir,
    );
    writeFileSync(join(checkout, "racer.txt"), "won\n");
    git(checkout, "add", "racer.txt");
    git(checkout, "commit", "--quiet", "-m", "race");
    git(checkout, "push", "--quiet", "origin", "main");

    expect(() => promoteReview("race-task", "must not publish")).toThrow(
      "target or promotion configuration changed",
    );
    expect(git(remote, "rev-parse", "refs/heads/main")).toBe(git(checkout, "rev-parse", "HEAD"));
    expect(readPluginState(stateDir).tasks[0]!.delivery).toBeUndefined();
  });
});
