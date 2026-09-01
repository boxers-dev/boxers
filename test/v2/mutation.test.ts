import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  recoverTaskMutationBarrier,
  taskMutationBarrierActiveAsync,
  withTaskMutationBarrier,
} from "../../src/v2/mutation.ts";
import { taskMutationBarrierPath } from "../../src/v2/paths.ts";
import { atomicWriteJson } from "../../src/v2/paths.ts";
import { dockerSandboxesRuntime } from "../../src/v2/runtime/docker-sandboxes.ts";
import type { TaskManifest } from "../../src/v2/types.ts";

let stateDir: string | undefined;
let previousHome: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.BOXERS_HOME;
  else process.env.BOXERS_HOME = previousHome;
  stateDir = undefined;
  previousHome = undefined;
});

function task(): TaskManifest {
  return {
    version: 3,
    id: "task-id",
    projectId: "project-id",
    name: "barrier",
    runtime: { kind: "docker-sandboxes", id: "runtime-id" },
    agent: "codex",
    sessionMode: "native",
    lifecycleBridgeToken: "0123456789abcdef0123456789abcdef",
    createdAt: "2026-08-29T00:00:00.000Z",
  };
}

function prepare(): { writes: string[]; removals: string[][] } {
  stateDir = mkdtempSync(join(tmpdir(), "boxers-mutation-"));
  previousHome = process.env.BOXERS_HOME;
  process.env.BOXERS_HOME = stateDir;
  const writes: string[] = [];
  const removals: string[][] = [];
  vi.spyOn(dockerSandboxesRuntime, "workspacePath").mockReturnValue("/workspace");
  vi.spyOn(dockerSandboxesRuntime, "executeWithInput").mockImplementation((_task, _args, input) => {
    writes.push(input);
    return { status: 0, stdout: "", stderr: "" };
  });
  vi.spyOn(dockerSandboxesRuntime, "execute").mockImplementation((_task, args) => {
    removals.push([...args]);
    return { status: 0, stdout: "", stderr: "" };
  });
  vi.spyOn(dockerSandboxesRuntime, "executeAsync").mockImplementation(async (_task, args) => {
    removals.push([...args]);
    return { status: 0, stdout: "", stderr: "" };
  });
  return { writes, removals };
}

describe("task mutation barrier", () => {
  it("publishes host and Sandbox markers for the same run and clears both in finally", () => {
    const { writes, removals } = prepare();
    const manifest = task();
    withTaskMutationBarrier(manifest, () => {
      const host = JSON.parse(readFileSync(taskMutationBarrierPath(manifest.name), "utf8")) as {
        runId: string;
      };
      expect(JSON.parse(writes[0] ?? "{}")).toMatchObject({ runId: host.runId, pid: process.pid });
      withTaskMutationBarrier(manifest, () => expect(writes).toHaveLength(1));
    });
    expect(removals).toHaveLength(1);
    expect(() => readFileSync(taskMutationBarrierPath(manifest.name), "utf8")).toThrow();
  });

  it("only clears a stale Sandbox companion after proving the host owner is dead", () => {
    const { removals } = prepare();
    const manifest = task();
    const path = taskMutationBarrierPath(manifest.name);
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteJson(path, { version: 1, task: manifest.name, runId: "stale", pid: 2 ** 30 });
    expect(recoverTaskMutationBarrier(manifest)).toBe(true);
    expect(removals).toHaveLength(1);
    expect(() => readFileSync(path, "utf8")).toThrow();
  });

  it("clears the matching Sandbox companion before releasing buffered input", async () => {
    const { removals } = prepare();
    const manifest = task();
    const path = taskMutationBarrierPath(manifest.name);
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteJson(path, { version: 1, task: manifest.name, runId: "stale", pid: 2 ** 30 });
    await expect(taskMutationBarrierActiveAsync(manifest)).resolves.toBe(false);
    expect(removals).toHaveLength(1);
    expect(() => readFileSync(path, "utf8")).toThrow();
  });

  it("keeps input buffered when the stale Sandbox companion cannot be cleared", async () => {
    prepare();
    const manifest = task();
    const path = taskMutationBarrierPath(manifest.name);
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteJson(path, { version: 1, task: manifest.name, runId: "stale", pid: 2 ** 30 });
    vi.mocked(dockerSandboxesRuntime.executeAsync).mockResolvedValueOnce({
      status: 1,
      stdout: "",
      stderr: "runtime unavailable",
    });
    await expect(taskMutationBarrierActiveAsync(manifest)).resolves.toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ runId: "stale" });
  });
});
