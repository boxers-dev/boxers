import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readDaemonHandoffState, recordDaemonHandoff } from "../../src/v2/daemon-handoff.ts";

const previousHome = process.env.BOXERS_HOME;
let home: string | undefined;

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
  if (previousHome === undefined) delete process.env.BOXERS_HOME;
  else process.env.BOXERS_HOME = previousHome;
});

describe("daemon handoff status", () => {
  it("persists structured activation blockers", () => {
    home = mkdtempSync(join(tmpdir(), "boxers-handoff-"));
    process.env.BOXERS_HOME = home;
    const buildId = "a".repeat(64);
    recordDaemonHandoff(buildId, "waiting", [
      { kind: "working", task: "parser", detail: "Task parser is still working." },
    ]);
    expect(readDaemonHandoffState()).toMatchObject({
      desiredBuildId: buildId,
      status: "waiting",
      blockers: [{ kind: "working", task: "parser" }],
    });
  });
});
