import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { postTurnInWorker } from "../../src/v2/daemon-worker.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture(beforeAcquire = false, crash = false) {
  const directory = mkdtempSync(join(tmpdir(), "boxers-worker-ownership-"));
  directories.push(directory);
  const entry = join(directory, "worker.mjs");
  const resultPath = join(directory, "result");
  const helper = pathToFileURL(join(process.cwd(), "src/v2/worker-ownership.ts")).href;
  writeFileSync(
    entry,
    `
import { writeFileSync } from 'node:fs';
import { enableWorkerWorkspaceOwnership, withWorkerWorkspaceMutation } from ${JSON.stringify(helper)};
enableWorkerWorkspaceOwnership();
if (${beforeAcquire}) {
  process.send({ type: 'boxers-worker-progress', phase: 'refreshing' });
  await new Promise(resolve => setTimeout(resolve, 200));
}
await withWorkerWorkspaceMutation(() => {
  writeFileSync(${JSON.stringify(resultPath)}, 'started');
  process.send({ type: 'boxers-worker-progress', phase: 'reconciling' });
  if (${crash}) process.exit(2);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  writeFileSync(${JSON.stringify(resultPath)}, 'finished');
});
process.send({ type: 'boxers-worker-result' });
process.disconnect();
`,
  );
  return { resultPath, launch: { entry, execArgv: ["--import", "tsx"] } };
}

describe("worker workspace ownership", () => {
  it("waits through the acknowledged mutation before honoring cancellation", async () => {
    const { resultPath, launch } = fixture();
    const abort = new AbortController();
    const phases: string[] = [];
    const result = await postTurnInWorker(
      "task",
      1,
      abort.signal,
      (phase) => {
        phases.push(phase);
        if (phase === "reconciling") abort.abort();
      },
      launch,
    );
    expect(phases).toEqual(["reconciling"]);
    expect(result).toBeUndefined();
    expect(readFileSync(resultPath, "utf8")).toBe("finished");
  });

  it("does not authorize mutation when input cancels before acquisition", async () => {
    const { resultPath, launch } = fixture(true);
    const abort = new AbortController();
    await postTurnInWorker("task", 1, abort.signal, () => abort.abort(), launch);
    expect(existsSync(resultPath)).toBe(false);
  });

  it("reports unexpected worker death instead of treating it as a completed mutation", async () => {
    const { resultPath, launch } = fixture(false, true);
    await expect(
      postTurnInWorker("task", 1, new AbortController().signal, undefined, launch),
    ).rejects.toThrow("status 2");
    expect(readFileSync(resultPath, "utf8")).toBe("started");
  });
});
