import { fork } from "node:child_process";
import { executeTaskIntent, runPostTurn } from "./commands.ts";
import { withOutputSink, type OutputSink } from "../core/output.ts";
import type { TaskIntent } from "./daemon-protocol.ts";
import { requireRegisteredTask } from "./registry.ts";
import { drainTaskLifecycleEvents, recordedLifecycleHighWater } from "./lifecycle-ingestion.ts";
import { readTaskState } from "./state.ts";

interface WorkerResult {
  type: "boxers-worker-result";
  changed?: boolean;
  code?: number;
  error?: string;
  targetOid?: string;
  candidateTreeOid?: string;
  deferred?: boolean;
  needsInput?: string;
  lifecycleEvents?: { sequence: number; kind: "user_prompt" | "turn_finished" }[];
  drainedThroughSequence?: number;
  requestedThroughSequence?: number;
}

interface WorkerProgress {
  type: "boxers-worker-progress";
  phase: "refreshing" | "reconciling" | "capturing" | "checking";
}

interface WorkerOutput {
  type: "boxers-worker-output";
  stream: "stdout" | "stderr";
  chunk: string;
}

interface WorkerReady {
  type: "boxers-worker-ready";
}

interface WorkerStart {
  type: "boxers-worker-start";
}

export interface DaemonWorkerLaunch {
  entry?: string;
  execArgv?: string[];
}

function runWorker(
  args: string[],
  expectResult: boolean,
  launch: DaemonWorkerLaunch = {},
  abortSignal?: AbortSignal,
  output?: OutputSink,
  onSpawn?: (pid: number) => void,
  startAfterReady = false,
  onProgress?: (phase: WorkerProgress["phase"]) => void,
): Promise<WorkerResult | undefined> {
  const entry = launch.entry ?? process.argv[1];
  if (!entry) throw new Error("Could not locate the boxers executable for a daemon worker.");
  return new Promise((resolve, reject) => {
    let result: WorkerResult | undefined;
    let ready = false;
    let settled = false;
    let aborted = false;
    let abortKillTimer: ReturnType<typeof setTimeout> | undefined;
    const child = fork(entry, args, {
      execArgv: launch.execArgv ?? process.execArgv,
      // Worker commands report intentional output and progress over IPC. Do not
      // dump incidental command output into the combined daemon debug log.
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      // Post-turn and intent workers invoke synchronous CLI commands. Give each worker
      // its own process group so cancellation can also stop a blocked `sbx`
      // descendant instead of waiting forever for the worker's event loop.
      detached: process.platform !== "win32",
    });
    if (!startAfterReady && child.pid !== undefined) onSpawn?.(child.pid);
    child.on("message", (message: unknown) => {
      if (
        message &&
        typeof message === "object" &&
        (message as { type?: unknown }).type === "boxers-worker-progress"
      ) {
        onProgress?.((message as WorkerProgress).phase);
        return;
      }
      if (
        message &&
        typeof message === "object" &&
        (message as { type?: unknown }).type === "boxers-worker-output"
      ) {
        const workerOutput = message as WorkerOutput;
        output?.[workerOutput.stream](workerOutput.chunk);
        return;
      }
      if (
        message &&
        typeof message === "object" &&
        (message as { type?: unknown }).type === "boxers-worker-ready"
      ) {
        ready = true;
        if (startAfterReady) {
          try {
            if (child.pid === undefined) throw new Error("Daemon worker did not report its PID.");
            onSpawn?.(child.pid);
            child.send({ type: "boxers-worker-start" } satisfies WorkerStart);
          } catch (error) {
            settled = true;
            cleanup();
            child.kill();
            reject(error);
            return;
          }
        }
        if (abortSignal?.aborted) child.send({ type: "boxers-worker-abort" });
        return;
      }
      if (
        message &&
        typeof message === "object" &&
        (message as { type?: unknown }).type === "boxers-worker-result"
      )
        result = message as WorkerResult;
    });
    const signalWorkerTree = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {
        // The worker may have completed between the abort and the signal.
      }
    };
    const onAbort = (): void => {
      aborted = true;
      if (ready && child.connected) child.send({ type: "boxers-worker-abort" });
      signalWorkerTree("SIGTERM");
      abortKillTimer = setTimeout(() => signalWorkerTree("SIGKILL"), 2_000);
      abortKillTimer.unref();
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = (): void => {
      abortSignal?.removeEventListener("abort", onAbort);
      if (abortKillTimer) clearTimeout(abortKillTimer);
    };
    if (abortSignal?.aborted) onAbort();
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (aborted) {
        resolve(undefined);
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `Daemon worker exited ${signal ? `after ${signal}` : `with status ${code ?? 1}`}.`,
          ),
        );
        return;
      }
      if (expectResult && !result) {
        reject(new Error("Daemon worker exited without reporting its result."));
        return;
      }
      if (result?.error) {
        reject(new Error(result.error));
        return;
      }
      resolve(result);
    });
  });
}

export async function postTurnInWorker(
  taskName: string,
  triggerSequence: number,
  signal: AbortSignal,
  onProgress?: (phase: WorkerProgress["phase"]) => void,
  launch?: DaemonWorkerLaunch,
): Promise<
  | { targetOid?: string; candidateTreeOid?: string; deferred?: boolean; needsInput?: string }
  | undefined
> {
  const payload = Buffer.from(JSON.stringify({ taskName, triggerSequence }), "utf8").toString(
    "base64",
  );
  const result = await runWorker(
    ["__daemon-post-turn-worker", payload],
    true,
    launch,
    signal,
    undefined,
    undefined,
    false,
    onProgress,
  );
  if (!result) return undefined;
  return {
    ...(result.targetOid ? { targetOid: result.targetOid } : {}),
    ...(result.candidateTreeOid ? { candidateTreeOid: result.candidateTreeOid } : {}),
    ...(result.deferred ? { deferred: true } : {}),
    ...(result.needsInput ? { needsInput: result.needsInput } : {}),
  };
}

export async function ingestLifecycleInWorker(
  taskName: string,
  throughSequence?: number,
  launch?: DaemonWorkerLaunch,
): Promise<{ sequence: number; kind: "user_prompt" | "turn_finished" }[]> {
  const accepted: { sequence: number; kind: "user_prompt" | "turn_finished" }[] = [];
  let requested = throughSequence;
  for (;;) {
    const payload = Buffer.from(
      JSON.stringify({ taskName, throughSequence: requested }),
      "utf8",
    ).toString("base64");
    const result = await runWorker(["__daemon-lifecycle-worker", payload], true, launch);
    accepted.push(...(result?.lifecycleEvents ?? []));
    const target = result?.requestedThroughSequence ?? requested ?? 0;
    const drained = result?.drainedThroughSequence ?? target;
    if (drained >= target) return accepted;
    requested = target;
  }
}

/** Execute an explicit task intent outside the daemon's PTY event loop. */
export async function executeIntentInWorker(
  taskName: string,
  intent: TaskIntent,
  output: OutputSink,
  launch?: DaemonWorkerLaunch,
  onSpawn?: (pid: number) => void,
  signal?: AbortSignal,
): Promise<number> {
  const payload = Buffer.from(JSON.stringify({ taskName, intent }), "utf8").toString("base64");
  const result = await runWorker(
    ["__daemon-intent-worker", payload],
    true,
    launch,
    signal,
    output,
    onSpawn,
    true,
  );
  return result?.code ?? 1;
}

/** Direct form retained for isolated daemon unit tests; production uses a child worker. */
export function executeIntentDirect(
  taskName: string,
  intent: TaskIntent,
  output: OutputSink,
): Promise<number> {
  return withOutputSink(output, () => executeTaskIntent(taskName, intent));
}

export async function runDaemonIntentWorker(value: string): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onMessage = (message: unknown): void => {
      if (
        message &&
        typeof message === "object" &&
        (message as { type?: unknown }).type === "boxers-worker-start"
      ) {
        cleanup();
        resolve();
      }
    };
    const onDisconnect = (): void => {
      cleanup();
      reject(new Error("Daemon disconnected before transferring intent ownership."));
    };
    const cleanup = (): void => {
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
    };
    process.on("message", onMessage);
    process.once("disconnect", onDisconnect);
    process.send?.({ type: "boxers-worker-ready" } satisfies WorkerReady);
  });
  const payload = JSON.parse(Buffer.from(value, "base64").toString("utf8")) as {
    taskName?: unknown;
    intent?: unknown;
  };
  if (typeof payload.taskName !== "string" || !payload.intent || typeof payload.intent !== "object")
    throw new Error("Invalid daemon intent worker payload.");
  const forward = (stream: "stdout" | "stderr", chunk: string): void => {
    process.send?.({ type: "boxers-worker-output", stream, chunk } satisfies WorkerOutput);
  };
  try {
    const code = await withOutputSink(
      { stdout: (chunk) => forward("stdout", chunk), stderr: (chunk) => forward("stderr", chunk) },
      () => executeTaskIntent(payload.taskName as string, payload.intent as TaskIntent),
    );
    process.send?.({ type: "boxers-worker-result", code } satisfies WorkerResult);
  } catch (error) {
    process.send?.({
      type: "boxers-worker-result",
      error: error instanceof Error ? error.message : String(error),
    } satisfies WorkerResult);
  }
  return 0;
}

export async function runDaemonPostTurnWorker(value: string): Promise<number> {
  const payload = JSON.parse(Buffer.from(value, "base64").toString("utf8")) as {
    taskName?: unknown;
    triggerSequence?: unknown;
  };
  if (
    typeof payload.taskName !== "string" ||
    !Number.isSafeInteger(payload.triggerSequence) ||
    Number(payload.triggerSequence) < 1
  )
    throw new Error("Invalid daemon post-turn worker payload.");
  const result = await runPostTurn(payload.taskName, Number(payload.triggerSequence), (phase) =>
    process.send?.({ type: "boxers-worker-progress", phase } satisfies WorkerProgress),
  );
  process.send?.({ type: "boxers-worker-result", ...result } satisfies WorkerResult);
  return 0;
}

export function runDaemonLifecycleWorker(value: string): number {
  const payload = JSON.parse(Buffer.from(value, "base64").toString("utf8")) as {
    taskName?: unknown;
    throughSequence?: unknown;
  };
  if (
    typeof payload.taskName !== "string" ||
    (payload.throughSequence !== undefined &&
      (!Number.isSafeInteger(payload.throughSequence) || Number(payload.throughSequence) < 1))
  )
    throw new Error("Invalid daemon lifecycle worker payload.");
  const { project, task } = requireRegisteredTask(payload.taskName);
  const requestedThrough =
    payload.throughSequence === undefined
      ? recordedLifecycleHighWater(task)
      : Number(payload.throughSequence);
  const records = drainTaskLifecycleEvents(project, task, requestedThrough);
  const drainedThrough = readTaskState(project, task).lifecycleDrainSequence;
  process.send?.({
    type: "boxers-worker-result",
    requestedThroughSequence: requestedThrough,
    drainedThroughSequence: drainedThrough,
    lifecycleEvents: records.map((record) => ({
      sequence: record.sequence,
      kind: record.event.kind,
    })),
  } satisfies WorkerResult);
  return 0;
}
