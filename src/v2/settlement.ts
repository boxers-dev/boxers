import { randomUUID } from "node:crypto";

export type SettlementPhase =
  | "queued"
  | "refreshing"
  | "reconciling"
  | "capturing"
  | "checking"
  | "generating"
  | "ready"
  | "needs_input"
  | "cancelled"
  | "failed";

export interface SettlementRunSnapshot {
  runId: string;
  taskKey: string;
  triggerSequence: number;
  phase: SettlementPhase;
  startedAt: string;
  updatedAt: string;
  targetOid?: string;
  candidateTreeOid?: string;
  finishedAt?: string;
  failure?: string;
}

export interface SettlementRunContext {
  readonly runId: string;
  readonly taskKey: string;
  readonly triggerSequence: number;
  readonly signal: AbortSignal;
  transition(
    phase: Exclude<SettlementPhase, "ready" | "needs_input" | "cancelled" | "failed">,
  ): boolean;
  identify(targetOid: string, candidateTreeOid: string): boolean;
  defer(): boolean;
  needsInput(failure: string): boolean;
  isCurrent(): boolean;
}

export interface SettlementIdentity {
  runId: string;
  triggerSequence: number;
  targetOid: string;
  candidateTreeOid: string;
}

interface ActiveRun {
  snapshot: SettlementRunSnapshot;
  abort: AbortController;
  completion: Promise<void>;
  deferred: boolean;
  terminal: boolean;
}

export interface SettlementCoordinatorOptions {
  onTransition?: (snapshot: Readonly<SettlementRunSnapshot>) => void;
  now?: () => string;
  runId?: () => string;
}

/** One cancellable generation per task; separate task keys run concurrently. */
export class SettlementCoordinator {
  readonly #runs = new Map<string, ActiveRun>();
  readonly #highWater = new Map<string, number>();
  readonly #options: SettlementCoordinatorOptions;

  constructor(options: SettlementCoordinatorOptions = {}) {
    this.#options = options;
  }

  current(taskKey: string): Readonly<SettlementRunSnapshot> | undefined {
    return this.#runs.get(taskKey.toLowerCase())?.snapshot;
  }

  start(
    taskKey: string,
    triggerSequence: number,
    work: (context: SettlementRunContext) => Promise<void>,
  ): { status: "started" | "duplicate" | "stale"; completion?: Promise<void> } {
    return this.#start(taskKey, triggerSequence, work, "new");
  }

  resume(
    taskKey: string,
    triggerSequence: number,
    work: (context: SettlementRunContext) => Promise<void>,
  ): { status: "started" | "duplicate" | "stale"; completion?: Promise<void> } {
    return this.#start(taskKey, triggerSequence, work, "deferred");
  }

  restart(
    taskKey: string,
    triggerSequence: number,
    work: (context: SettlementRunContext) => Promise<void>,
  ): { status: "started" | "duplicate" | "stale"; completion?: Promise<void> } {
    return this.#start(taskKey, triggerSequence, work, "cancelled");
  }

  #start(
    taskKey: string,
    triggerSequence: number,
    work: (context: SettlementRunContext) => Promise<void>,
    mode: "new" | "deferred" | "cancelled",
  ): { status: "started" | "duplicate" | "stale"; completion?: Promise<void> } {
    const key = taskKey.toLowerCase();
    if (!Number.isSafeInteger(triggerSequence) || triggerSequence < 1)
      throw new Error("Invalid settlement trigger sequence.");
    const highWater = this.#highWater.get(key) ?? 0;
    if (triggerSequence < highWater) return { status: "stale" };
    if (triggerSequence === highWater) {
      const current = this.#runs.get(key);
      const eligible =
        (mode === "deferred" && current?.deferred) ||
        (mode === "cancelled" &&
          current !== undefined &&
          ["cancelled", "failed", "needs_input"].includes(current.snapshot.phase));
      if (!eligible) return { status: "duplicate" };
    }
    this.#highWater.set(key, triggerSequence);
    this.cancel(key);
    const now = this.#now();
    const snapshot: SettlementRunSnapshot = {
      runId: this.#options.runId?.() ?? randomUUID(),
      taskKey: key,
      triggerSequence,
      phase: "queued",
      startedAt: now,
      updatedAt: now,
    };
    const active: ActiveRun = {
      snapshot,
      abort: new AbortController(),
      completion: Promise.resolve(),
      deferred: false,
      terminal: false,
    };
    this.#runs.set(key, active);
    this.#publish(snapshot);
    const context: SettlementRunContext = {
      runId: snapshot.runId,
      taskKey: key,
      triggerSequence,
      signal: active.abort.signal,
      transition: (phase) => this.#transition(key, snapshot.runId, { phase }),
      identify: (targetOid, candidateTreeOid) =>
        this.#transition(key, snapshot.runId, { targetOid, candidateTreeOid }),
      defer: () => {
        const current = this.#runs.get(key);
        if (!current || current.snapshot.runId !== snapshot.runId || current.abort.signal.aborted)
          return false;
        current.deferred = true;
        return this.#transition(key, snapshot.runId, { phase: "queued" });
      },
      needsInput: (failure) => {
        const current = this.#runs.get(key);
        if (!current || current.snapshot.runId !== snapshot.runId || current.abort.signal.aborted)
          return false;
        current.terminal = true;
        this.#finish(key, snapshot.runId, "needs_input", failure);
        return true;
      },
      isCurrent: () => this.#isCurrent(key, snapshot.runId),
    };
    active.completion = Promise.resolve()
      .then(() => work(context))
      .then(() => {
        if (active.abort.signal.aborted || active.deferred || active.terminal) return;
        active.terminal = true;
        this.#finish(key, snapshot.runId, "ready");
      })
      .catch((error: unknown) => {
        if (active.abort.signal.aborted) return;
        active.terminal = true;
        this.#finish(
          key,
          snapshot.runId,
          "failed",
          error instanceof Error ? error.message : String(error),
        );
      });
    return { status: "started", completion: active.completion };
  }

  cancel(taskKey: string): boolean {
    const key = taskKey.toLowerCase();
    const active = this.#runs.get(key);
    if (!active || active.abort.signal.aborted || active.terminal) return false;
    active.abort.abort();
    this.#finish(key, active.snapshot.runId, "cancelled");
    return true;
  }

  async cancelAndWait(taskKey: string): Promise<boolean> {
    const active = this.#runs.get(taskKey.toLowerCase());
    if (!active) return false;
    const cancelled = this.cancel(taskKey);
    await active.completion;
    return cancelled;
  }

  guardedPublish(identity: SettlementIdentity, action: () => void): boolean {
    const active = [...this.#runs.values()].find(
      (candidate) => candidate.snapshot.runId === identity.runId,
    );
    if (
      !active ||
      active.abort.signal.aborted ||
      active.snapshot.triggerSequence !== identity.triggerSequence ||
      active.snapshot.targetOid !== identity.targetOid ||
      active.snapshot.candidateTreeOid !== identity.candidateTreeOid
    )
      return false;
    action();
    return true;
  }

  async close(): Promise<void> {
    const runs = [...this.#runs.values()];
    for (const active of runs) active.abort.abort();
    await Promise.allSettled(runs.map((active) => active.completion));
  }

  hasActiveRuns(): boolean {
    return [...this.#runs.values()].some(
      (active) => !active.abort.signal.aborted && !active.deferred && !active.terminal,
    );
  }

  #now(): string {
    return this.#options.now?.() ?? new Date().toISOString();
  }

  #isCurrent(key: string, runId: string): boolean {
    const active = this.#runs.get(key);
    return Boolean(active && active.snapshot.runId === runId && !active.abort.signal.aborted);
  }

  #transition(
    key: string,
    runId: string,
    update: Partial<Pick<SettlementRunSnapshot, "phase" | "targetOid" | "candidateTreeOid">>,
  ): boolean {
    const active = this.#runs.get(key);
    if (!active || active.snapshot.runId !== runId || active.abort.signal.aborted) return false;
    active.snapshot = { ...active.snapshot, ...update, updatedAt: this.#now() };
    this.#publish(active.snapshot);
    return true;
  }

  #finish(
    key: string,
    runId: string,
    phase: "ready" | "needs_input" | "cancelled" | "failed",
    failure?: string,
  ) {
    const active = this.#runs.get(key);
    if (!active || active.snapshot.runId !== runId) return;
    const now = this.#now();
    active.snapshot = {
      ...active.snapshot,
      phase,
      updatedAt: now,
      finishedAt: now,
      ...(failure ? { failure } : {}),
    };
    this.#publish(active.snapshot);
  }

  #publish(snapshot: SettlementRunSnapshot): void {
    this.#options.onTransition?.({ ...snapshot });
  }
}
