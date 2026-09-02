import { describe, expect, it } from "vitest";
import { SettlementCoordinator } from "../../src/v2/settlement.ts";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => (resolve = accept));
  return { promise, resolve };
}

describe("task settlement coordinator", () => {
  it("starts one run and ignores duplicate events", async () => {
    const release = deferred();
    let starts = 0;
    const coordinator = new SettlementCoordinator();
    const first = coordinator.start("task", 1, async () => {
      starts++;
      await release.promise;
    });
    expect(coordinator.start("task", 1, async () => undefined).status).toBe("duplicate");
    release.resolve();
    await first.completion;
    expect(starts).toBe(1);
    expect(coordinator.current("task")?.phase).toBe("ready");
  });

  it("supersedes an older generation and prevents its late publication", async () => {
    const oldRelease = deferred();
    let oldPublished = false;
    let oldContext:
      | {
          runId: string;
          triggerSequence: number;
          identify: (base: string, tree: string) => boolean;
        }
      | undefined;
    const coordinator = new SettlementCoordinator();
    const old = coordinator.start("task", 1, async (context) => {
      oldContext = context;
      context.identify("base", "tree");
      await oldRelease.promise;
    });
    await Promise.resolve();
    const current = coordinator.start("task", 2, async (context) => {
      context.identify("new-base", "new-tree");
    });
    oldRelease.resolve();
    await Promise.all([old.completion, current.completion]);
    expect(oldContext).toBeDefined();
    expect(
      coordinator.guardedPublish(
        {
          runId: oldContext!.runId,
          triggerSequence: oldContext!.triggerSequence,
          targetOid: "base",
          candidateTreeOid: "tree",
        },
        () => (oldPublished = true),
      ),
    ).toBe(false);
    expect(oldPublished).toBe(false);
    expect(coordinator.current("task")).toMatchObject({ triggerSequence: 2, phase: "ready" });
  });

  it("cancels before work continues on the first input boundary", async () => {
    const noticed = deferred();
    const coordinator = new SettlementCoordinator();
    const run = coordinator.start("task", 1, async ({ signal }) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            noticed.resolve();
            resolve();
          },
          { once: true },
        ),
      );
    });
    await Promise.resolve();
    expect(coordinator.cancel("task")).toBe(true);
    await noticed.promise;
    await run.completion;
    expect(coordinator.current("task")?.phase).toBe("cancelled");
  });

  it("waits for mutation unwind before handing a strong intent the task", async () => {
    const release = deferred();
    const coordinator = new SettlementCoordinator();
    coordinator.start("task", 1, async ({ signal }) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      await release.promise;
    });
    await Promise.resolve();
    let handedOff = false;
    const waiting = coordinator.cancelAndWait("task").then(() => (handedOff = true));
    await Promise.resolve();
    expect(handedOff).toBe(false);
    release.resolve();
    await waiting;
    expect(handedOff).toBe(true);
  });

  it("allows different tasks to settle concurrently", async () => {
    const entered = new Set<string>();
    const both = deferred();
    const release = deferred();
    const coordinator = new SettlementCoordinator();
    const work = async (task: string) => {
      entered.add(task);
      if (entered.size === 2) both.resolve();
      await release.promise;
    };
    const one = coordinator.start("one", 1, () => work("one"));
    const two = coordinator.start("two", 1, () => work("two"));
    await both.promise;
    expect(entered).toEqual(new Set(["one", "two"]));
    release.resolve();
    await Promise.all([one.completion, two.completion]);
  });

  it("resumes the same eligible generation after setup completes", async () => {
    const coordinator = new SettlementCoordinator();
    const deferredRun = coordinator.start("task", 5, async (context) => {
      context.defer();
    });
    expect(coordinator.hasActiveRuns()).toBe(true);
    await deferredRun.completion;
    expect(coordinator.current("task")?.phase).toBe("queued");
    expect(coordinator.hasActiveRuns()).toBe(false);
    expect(coordinator.start("task", 5, async () => undefined).status).toBe("duplicate");
    let resumed = false;
    const run = coordinator.resume("task", 5, async () => {
      resumed = true;
    });
    expect(run.status).toBe("started");
    await run.completion;
    expect(resumed).toBe(true);
    expect(coordinator.current("task")?.phase).toBe("ready");
  });

  it("restarts a cancelled generation after a successful strong intent", async () => {
    const coordinator = new SettlementCoordinator();
    const first = coordinator.start("task", 6, async ({ signal }) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    });
    await Promise.resolve();
    coordinator.cancel("task");
    await first.completion;
    let restarted = false;
    const second = coordinator.restart("task", 6, async () => {
      restarted = true;
    });
    expect(second.status).toBe("started");
    await second.completion;
    expect(restarted).toBe(true);
    expect(coordinator.current("task")?.phase).toBe("ready");
  });

  it("publishes reconciliation questions as a terminal needs-input result", async () => {
    const coordinator = new SettlementCoordinator();
    const run = coordinator.start("task", 8, async (context) => {
      context.needsInput("Reconciliation conflicts: shared.txt");
    });
    await run.completion;
    expect(coordinator.current("task")).toMatchObject({
      phase: "needs_input",
      failure: "Reconciliation conflicts: shared.txt",
    });
  });
});
