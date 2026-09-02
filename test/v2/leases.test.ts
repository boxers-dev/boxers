import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readTaskIntentOperation } from "../../src/v2/leases.ts";
import { atomicWriteJson, taskIntentLeasePath } from "../../src/v2/paths.ts";

const originalHome = process.env.BOXERS_HOME;
const cleanup: string[] = [];

afterEach(() => {
  if (originalHome === undefined) delete process.env.BOXERS_HOME;
  else process.env.BOXERS_HOME = originalHome;
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("recorded task operations", () => {
  it("exposes a live typed operation and recovers a dead owner", () => {
    const home = mkdtempSync(join(tmpdir(), "boxers-operation-lease-"));
    cleanup.push(home);
    process.env.BOXERS_HOME = home;
    const path = taskIntentLeasePath("task");
    atomicWriteJson(path, {
      version: 1,
      task: "task",
      daemonPid: process.pid,
      intentId: "intent",
      kind: "running_checks",
      state: "running",
      startedAt: "2030-01-01T00:00:00.000Z",
    });
    expect(readTaskIntentOperation("task")).toEqual({
      intentId: "intent",
      kind: "running_checks",
      state: "running",
      startedAt: "2030-01-01T00:00:00.000Z",
    });

    atomicWriteJson(path, {
      version: 1,
      task: "task",
      daemonPid: 2_147_483_647,
      kind: "promoting",
      state: "running",
    });
    expect(readTaskIntentOperation("task")).toBeUndefined();
    expect(existsSync(path)).toBe(false);
  });
});
