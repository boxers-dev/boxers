import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTaskManifest, initProject, requireTask, updateTask } from "../../src/v2/registry.ts";
import { readSetupStatus, retryTaskSetup, runSetupWorker } from "../../src/v2/setup.ts";

const cleanup: string[] = [];
const originalHome = process.env["BOXERS_HOME"];
const originalPath = process.env.PATH;

afterEach(() => {
  if (originalHome === undefined) delete process.env["BOXERS_HOME"];
  else process.env["BOXERS_HOME"] = originalHome;
  process.env.PATH = originalPath;
  delete process.env.SETUP_STATUS;
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("background task setup", () => {
  it("records the exact result and retained log", async () => {
    const root = mkdtempSync(join(tmpdir(), "boxers-setup-project-"));
    const state = mkdtempSync(join(tmpdir(), "boxers-setup-state-"));
    const bin = mkdtempSync(join(tmpdir(), "boxers-setup-bin-"));
    cleanup.push(root, state, bin);
    process.env["BOXERS_HOME"] = state;
    execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
    execFileSync("git", ["-C", root, "config", "user.name", "Test User"]);
    execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
    writeFileSync(join(root, "base.txt"), "base\n");
    execFileSync("git", ["-C", root, "add", "."]);
    execFileSync("git", ["-C", root, "commit", "-q", "-m", "base"]);
    const project = initProject({ integration: "local", base: "main", cwd: root });
    const task = createTaskManifest(project, "setup", "codex");
    updateTask(project, task, {
      phase: "setting_up",
      agent: "codex",
      preview: { state: "starting", urls: ["http://localhost:45173"] },
    });
    const executable = join(bin, "sbx");
    writeFileSync(
      executable,
      "#!/bin/sh\nprintf 'dependencies ready\\n'\nexit \"${SETUP_STATUS:-0}\"\n",
    );
    chmodSync(executable, 0o755);
    process.env.PATH = `${bin}:${originalPath ?? ""}`;

    const startedAt = new Date().toISOString();
    await expect(
      runSetupWorker(project.id, task.id, "npm ci", 10_000, startedAt, "npm run dev"),
    ).resolves.toBe(0);
    expect(readSetupStatus(task)).toMatchObject({
      state: "passed",
      command: "npm ci",
      startedAt,
      exitCode: 0,
    });
    expect(requireTask(project, task.name).lastSnapshot?.preview).toEqual({
      state: "running",
      urls: ["http://localhost:45173"],
    });
  });

  it("retries a terminal failure, streams the same bytes, and records attempt two", async () => {
    const root = mkdtempSync(join(tmpdir(), "boxers-setup-retry-project-"));
    const state = mkdtempSync(join(tmpdir(), "boxers-setup-retry-state-"));
    const bin = mkdtempSync(join(tmpdir(), "boxers-setup-retry-bin-"));
    cleanup.push(root, state, bin);
    process.env["BOXERS_HOME"] = state;
    execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
    execFileSync("git", ["-C", root, "config", "user.name", "Test User"]);
    execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
    writeFileSync(join(root, "base.txt"), "base\n");
    execFileSync("git", ["-C", root, "add", "."]);
    execFileSync("git", ["-C", root, "commit", "-q", "-m", "base"]);
    const project = initProject({ integration: "local", base: "main", cwd: root });
    const task = createTaskManifest(project, "retry", "codex");
    const executable = join(bin, "sbx");
    writeFileSync(executable, "#!/bin/sh\nprintf 'retry bytes\\n'\nexit \"${SETUP_STATUS:-0}\"\n");
    chmodSync(executable, 0o755);
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    process.env["SETUP_STATUS"] = "1";
    await expect(
      runSetupWorker(project.id, task.id, "npm ci", 10_000, new Date().toISOString()),
    ).resolves.toBe(1);
    expect(readSetupStatus(task)).toMatchObject({ state: "failed", attempt: 1, maxAttempts: 2 });

    process.env["SETUP_STATUS"] = "0";
    let streamed = "";
    const stdout = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      streamed += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await expect(retryTaskSetup(task, { run: "npm ci", timeoutMs: 10_000 })).resolves.toBe(0);
    } finally {
      process.stdout.write = stdout;
    }
    const result = readSetupStatus(task);
    expect(result).toMatchObject({ state: "passed", attempt: 2, maxAttempts: 2 });
    expect(streamed).toBe("retry bytes\n");
    expect(readFileSync(result!.logPath, "utf8")).toBe(streamed);
  });
});
