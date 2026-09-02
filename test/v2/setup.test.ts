import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTaskManifest, initProject } from "../../src/v2/registry.ts";
import {
  readSetupStatus,
  retryTaskSetup,
  startBackgroundSetup,
  waitForSetup,
} from "../../src/v2/setup.ts";
import type { ProjectManifest, TaskManifest } from "../../src/v2/types.ts";

const cleanup: string[] = [];
const originalHome = process.env["BOXERS_HOME"];
const originalPath = process.env.PATH;

afterEach(() => {
  if (originalHome === undefined) delete process.env["BOXERS_HOME"];
  else process.env["BOXERS_HOME"] = originalHome;
  process.env.PATH = originalPath;
  delete process.env.SBX_ARGS;
  delete process.env.SBX_FAKE_HOME;
  delete process.env.SBX_WORKSPACE;
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(name: string): {
  root: string;
  project: ProjectManifest;
  task: TaskManifest;
  calls: string;
} {
  const root = mkdtempSync(join(tmpdir(), `boxers-setup-${name}-project-`));
  const state = mkdtempSync(join(tmpdir(), `boxers-setup-${name}-state-`));
  const bin = mkdtempSync(join(tmpdir(), `boxers-setup-${name}-bin-`));
  const sandboxHome = join(bin, "sandbox-home");
  const calls = join(bin, "calls");
  cleanup.push(root, state, bin);
  process.env["BOXERS_HOME"] = state;
  execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Test User"]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  writeFileSync(join(root, "base.txt"), "base\n");
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "base"]);
  const project = initProject({ integration: "local", base: "main", cwd: root });
  const task = createTaskManifest(project, name, "codex");
  writeFileSync(
    join(bin, "sbx"),
    `#!/bin/bash
set -eu
printf '%s\n' "$*" >> "$SBX_ARGS"
test "$1" = exec
shift
detached=false
if test "\${1:-}" = -d; then detached=true; shift; fi
shift
export HOME="$SBX_FAKE_HOME"
mkdir -p "$HOME"
cd "$SBX_WORKSPACE"
if test "$detached" = true; then
  nohup "$@" >/dev/null 2>&1 </dev/null &
  exit 0
fi
exec "$@"
`,
  );
  chmodSync(join(bin, "sbx"), 0o755);
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
  process.env.SBX_ARGS = calls;
  process.env.SBX_FAKE_HOME = sandboxHome;
  process.env.SBX_WORKSPACE = root;
  return { root, project, task, calls };
}

describe("Sandbox-owned task setup", () => {
  it("records the exact detached result and retains its Sandbox log", async () => {
    const { root, task, calls } = fixture("setup");
    const initial = startBackgroundSetup(task, {
      run: "printf 'dependencies ready\\n'",
      timeoutMs: 10_000,
    });

    expect(initial).toMatchObject({ state: "running", attempt: 1, maxAttempts: 2 });
    await expect(waitForSetup(task)).resolves.toMatchObject({ state: "passed", exitCode: 0 });
    const result = readSetupStatus(task)!;
    expect(result.jobId).toMatch(/^setup-/);
    expect(result.configHash).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(result.logPath, "utf8")).toBe("dependencies ready\n");
    expect(readFileSync(join(root, ".git", "boxers", "setup-status"), "utf8")).toBe("passed\n");
    expect(readFileSync(calls, "utf8")).toContain("exec -d");
  });

  it("retries a terminal failure, streams retained bytes, and changes config identity", async () => {
    const { task } = fixture("retry");
    startBackgroundSetup(task, { run: "printf 'failed bytes\\n'; exit 1", timeoutMs: 10_000 });
    await expect(waitForSetup(task)).resolves.toMatchObject({ state: "failed", attempt: 1 });
    const failedHash = readSetupStatus(task)!.configHash;

    let streamed = "";
    const stdout = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      streamed += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(
        retryTaskSetup(task, { run: "printf 'retry bytes\\n'", timeoutMs: 10_000 }),
      ).resolves.toBe(0);
    } finally {
      process.stdout.write = stdout;
    }
    const result = readSetupStatus(task)!;
    expect(result).toMatchObject({ state: "passed", attempt: 2, maxAttempts: 2 });
    expect(result.configHash).not.toBe(failedHash);
    expect(streamed).toBe("retry bytes\n");
    expect(readFileSync(result.logPath, "utf8")).toBe(streamed);
  });
});
