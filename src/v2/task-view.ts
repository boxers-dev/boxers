import type {
  CheckRun,
  OperationView,
  PreviewStatus,
  RecordedTaskOperation,
  SetupStatus,
  TaskActionView,
  TaskIssue,
  TaskState,
  TaskView,
} from "./types.ts";

export interface TaskViewInput {
  name: string;
  state: TaskState;
  setupConfigured?: boolean;
  checksConfigured?: boolean;
  checkConfigHash?: string;
  preview?: PreviewStatus;
  operations?: readonly RecordedTaskOperation[];
  runtimeState?: string;
  reconciliationConflicts?: readonly string[];
}

const AGENT_LABEL = {
  not_started: "Not started",
  working: "Generating",
  awaiting_input: "Ready for input",
  exited: "Session exited",
  unknown: "Activity unknown",
} as const;

const operationForSettlement = {
  queued: ["capturing_changes", "queued"],
  refreshing: ["refreshing_target", "running"],
  reconciling: ["reconciling", "running"],
  capturing: ["capturing_changes", "running"],
  checking: ["running_checks", "running"],
  generating: ["generating_metadata", "running"],
} as const;

function action(
  kind: TaskActionView["kind"],
  label: string,
  reason: string,
  command?: string,
): TaskActionView {
  return { kind, label, reason, ...(command ? { command } : {}) };
}

function exactCheck(state: TaskState, configHash?: string): CheckRun | undefined {
  const check = state.check;
  return check &&
    check.targetOid === state.baseOid &&
    check.candidateTreeOid === state.candidateTreeOid &&
    (!configHash || check.configHash === configHash)
    ? check
    : undefined;
}

/** Derive the complete public status from recorded facts without performing I/O. */
export function deriveTaskView(input: TaskViewInput): TaskView {
  const { name, state } = input;
  const delivery =
    state.lastDelivery &&
    typeof state.lastDelivery.value.deliveredAt === "string" &&
    Number.isSafeInteger(state.lastDelivery.value.conversationSequence) &&
    ["passed", "skipped", "not_configured"].includes(state.lastDelivery.value.checks)
      ? state.lastDelivery.value
      : undefined;
  const setup = setupView(state.setup, input.setupConfigured === true);
  const settlement = state.settlement;
  const recordedConflict = /Reconciliation conflicts:\s*(.+)$/i.exec(
    settlement?.failure ?? state.failure ?? "",
  )?.[1];
  const conflicts = [
    ...(input.reconciliationConflicts ?? []),
    ...(recordedConflict
      ? recordedConflict
          .split(",")
          .map((path) => path.trim())
          .filter(Boolean)
      : []),
  ];
  const conflicted =
    conflicts.length > 0 ||
    settlement?.phase === "needs_input" ||
    /conflict/i.test(settlement?.failure ?? state.failure ?? "");

  const automatic: OperationView[] = [];
  if (state.setup?.state === "running")
    automatic.push({
      kind: "setup",
      state: "running",
      startedAt: state.setup.startedAt,
      detail: state.setup.command,
    });
  const settlementOperation =
    settlement && operationForSettlement[settlement.phase as keyof typeof operationForSettlement];
  if (settlementOperation)
    automatic.push({
      kind: settlementOperation[0],
      state: settlementOperation[1],
      startedAt: settlement?.startedAt,
    });
  const operations = [...(input.operations ?? []), ...automatic].filter(
    (candidate, index, all) =>
      all.findIndex((other) => other.kind === candidate.kind && other.state === candidate.state) ===
      index,
  );

  const reconciliation: TaskView["reconciliation"] = conflicted
    ? { state: "conflicted", ...(conflicts.length ? { conflicts } : {}) }
    : setup.state === "running" || setup.state === "retrying"
      ? { state: "awaiting_setup" }
      : settlement?.phase === "queued"
        ? { state: "queued" }
        : settlement?.phase === "refreshing" || settlement?.phase === "reconciling"
          ? { state: "running" }
          : settlement?.phase === "failed"
            ? { state: "failed" }
            : state.baseOid
              ? { state: "current" }
              : { state: "not_needed" };

  const changes: TaskView["changes"] = conflicted
    ? { state: "conflicted", observedAt: state.hasUnmergedChanges.observedAt }
    : settlement?.phase === "reconciling"
      ? { state: "reconciling", observedAt: state.hasUnmergedChanges.observedAt }
      : settlement?.phase === "refreshing" || settlement?.phase === "capturing"
        ? { state: "capturing", observedAt: state.hasUnmergedChanges.observedAt }
        : state.hasUnmergedChanges.value === "unknown"
          ? { state: "unknown", observedAt: state.hasUnmergedChanges.observedAt }
          : state.hasUnmergedChanges.value
            ? { state: "unmerged", observedAt: state.hasUnmergedChanges.observedAt }
            : { state: "none", observedAt: state.hasUnmergedChanges.observedAt };

  const currentCheck = exactCheck(state, input.checkConfigHash);
  const checksConfigured =
    input.checksConfigured === true || Boolean(state.check || state.checkProgress);
  const checks: TaskView["checks"] = state.checkProgress
    ? { state: "running", progress: state.checkProgress }
    : setup.state === "running" ||
        setup.state === "retrying" ||
        setup.state === "failed" ||
        setup.state === "timed_out"
      ? { state: "awaiting_setup" }
      : ["queued", "running", "conflicted"].includes(reconciliation.state)
        ? { state: "awaiting_reconciliation" }
        : changes.state === "capturing"
          ? { state: "awaiting_candidate" }
          : currentCheck
            ? { state: currentCheck.status, results: currentCheck.results }
            : state.check
              ? { state: "stale", results: state.check.results }
              : delivery && changes.state === "none"
                ? {
                    state:
                      delivery.checks === "passed"
                        ? "passed"
                        : delivery.checks === "not_configured"
                          ? "not_configured"
                          : "not_run",
                  }
                : !checksConfigured
                  ? { state: "not_configured" }
                  : !state.candidateTreeOid
                    ? { state: "awaiting_candidate" }
                    : { state: "not_run" };

  const issues: TaskIssue[] = [];
  if (setup.state === "failed" || setup.state === "timed_out") {
    const retry = action(
      "retry_setup",
      "Retry setup",
      "Rerun the configured setup after diagnosing its log.",
      `boxers ${name} setup`,
    );
    issues.push({
      code: setup.state === "failed" ? "setup_failed" : "setup_timed_out",
      source: "setup",
      message:
        setup.state === "failed"
          ? `Setup failed${setup.attempt ? ` after ${setup.attempt} attempt${setup.attempt === 1 ? "" : "s"}` : ""}.`
          : "Setup timed out.",
      owner: "agent",
      ...(setup.logPath ? { logPath: setup.logPath } : {}),
      remediation: retry,
    });
  }
  if (conflicted)
    issues.push({
      code: "reconciliation_conflict",
      source: "reconciliation",
      message: conflicts.length
        ? `Reconciliation conflicts: ${conflicts.join(", ")}`
        : (settlement?.failure ?? state.failure ?? "Reconciliation has unresolved conflicts."),
      owner: "agent",
      remediation: action(
        "resolve_conflicts",
        "Resolve conflicts",
        "Resolve and stage every conflicted file in the existing session, then retry.",
        `boxers ${name} attach`,
      ),
    });
  if (checks.state === "failed") {
    const failed = checks.results?.filter((result) => result.status !== "passed") ?? [];
    for (const result of failed)
      issues.push({
        code: "checks_failed",
        source: "checks",
        message: `${result.name} ${result.status === "timed_out" ? "timed out" : `exited ${result.exitCode ?? 1}`}.`,
        owner: "agent",
        ...(result.logPath ? { logPath: result.logPath } : {}),
        remediation: action(
          "fix_checks",
          `Fix ${result.name}`,
          "Ask the existing agent to fix this check, then rerun checks.",
          `boxers ${name} attach`,
        ),
      });
  }
  if (input.preview?.state === "failed")
    issues.push({
      code: "preview_failed",
      source: "preview",
      message: input.preview.failure ?? "Preview failed.",
      owner: "agent",
    });
  if (state.lifecycleDiagnostic)
    issues.push({
      code: "lifecycle_capture_failed",
      source: "daemon",
      message: state.lifecycleDiagnostic,
      owner: "boxers",
      remediation: action(
        "doctor",
        "Diagnose Boxers",
        "Inspect host and daemon health.",
        "boxers doctor",
      ),
    });
  if (state.failure && !conflicted)
    issues.push({
      code: "operation_failed",
      source: "daemon",
      message: state.failure,
      owner: "boxers",
    });
  else if (settlement?.phase === "failed")
    issues.push({
      code: "operation_failed",
      source: "daemon",
      message: settlement.failure ?? "Automatic task settlement failed.",
      owner: "boxers",
    });
  if (input.runtimeState === "missing")
    issues.push({
      code: "runtime_unavailable",
      source: "runtime",
      message: "The task runtime is unavailable.",
      owner: "host",
      remediation: action("doctor", "Diagnose runtime", "Inspect runtime health.", "boxers doctor"),
    });

  const mutationActive = operations.length > 0;
  const causalClean =
    Boolean(state.baseOid) &&
    state.hasUnmergedChanges.value === false &&
    state.hasUnmergedChanges.source === "git" &&
    state.hasUnmergedChanges.conversationSequence !== undefined &&
    state.hasUnmergedChanges.conversationSequence === state.conversationHighWaterSequence;
  const removal: TaskView["removal"] =
    mutationActive || state.agentTurnState === "working"
      ? { state: "blocked_by_activity", reason: "A task mutation or agent turn is active." }
      : changes.state === "unmerged" || changes.state === "conflicted"
        ? { state: "blocked_by_unmerged_changes", reason: "Unmerged task changes remain." }
        : changes.state === "unknown"
          ? { state: "unknown", reason: "Workspace state is unknown; refresh is required." }
          : causalClean &&
              !["queued", "running", "conflicted", "failed"].includes(reconciliation.state)
            ? {
                state: "safe",
                reason: "A current causal Git observation proves the workspace clean.",
              }
            : {
                state: "verification_required",
                reason: "A current workspace verification is required.",
              };

  const actions: TaskActionView[] = [];
  if (mutationActive) actions.push(action("wait", "Wait", "A Boxers operation is in progress."));
  else if (conflicted)
    actions.push(
      action(
        "resolve_conflicts",
        "Resolve conflicts",
        "Resolve and stage conflicts in the existing session.",
        `boxers ${name} attach`,
      ),
    );
  else if (setup.state === "failed" || setup.state === "timed_out") {
    actions.push(
      action(
        "retry_setup",
        "Retry setup",
        "Diagnose the setup log, then rerun setup.",
        `boxers ${name} setup`,
      ),
    );
    actions.push(
      action(
        "attach",
        "Attach",
        "Ask the agent to repair the setup failure.",
        `boxers ${name} attach`,
      ),
    );
  } else if (checks.state === "failed") {
    actions.push(
      action(
        "fix_checks",
        "Fix checks",
        "Ask the agent to fix the failed checks.",
        `boxers ${name} attach`,
      ),
    );
    actions.push(
      action("check", "Rerun checks", "Verify the repaired candidate.", `boxers ${name} check`),
    );
  } else if (issues.some((issue) => ["runtime", "daemon"].includes(issue.source)))
    actions.push(
      action(
        "doctor",
        "Diagnose Boxers",
        "Repair the reported infrastructure failure.",
        "boxers doctor",
      ),
    );
  else if (changes.state === "unmerged") {
    actions.push(
      action(
        "review",
        "Review changes",
        "Inspect the exact captured candidate.",
        `boxers ${name} review`,
      ),
    );
    if (checks.state !== "passed" && checks.state !== "not_configured")
      actions.push(
        action("check", "Run checks", "Verify the exact candidate.", `boxers ${name} check`),
      );
    actions.push(
      action(
        "promote",
        "Promote changes",
        "Deliver the captured candidate.",
        `boxers ${name} promote`,
      ),
    );
    actions.push(
      action(
        "attach",
        "Attach",
        state.agentTurnState === "exited"
          ? "Restart and continue the existing provider session."
          : "Continue the existing conversation.",
        `boxers ${name} attach`,
      ),
    );
  } else if (removal.state === "safe") {
    actions.push(
      action(
        "discard",
        "Discard task",
        "Remove the verified completed task.",
        `boxers ${name} discard`,
      ),
    );
    actions.push(
      action("attach", "Attach", "Continue the existing conversation.", `boxers ${name} attach`),
    );
  } else if (changes.state === "unknown" || removal.state === "verification_required")
    actions.push(
      action(
        "refresh",
        "Refresh status",
        "Record current workspace facts.",
        `boxers ${name} status --refresh`,
      ),
    );
  else
    actions.push(
      action(
        "attach",
        "Attach",
        "Start or continue the task conversation.",
        `boxers ${name} attach`,
      ),
    );

  return {
    agent: { state: state.agentTurnState, label: AGENT_LABEL[state.agentTurnState] },
    operations,
    setup,
    reconciliation,
    changes,
    checks,
    ...(delivery ? { delivery } : {}),
    removal,
    ...(input.preview ? { preview: input.preview } : {}),
    issues,
    actions,
  };
}

function setupView(status: SetupStatus | undefined, configured: boolean): TaskView["setup"] {
  if (!status) return { state: configured ? "running" : "not_configured" };
  const state = status.state === "running" && (status.attempt ?? 1) > 1 ? "retrying" : status.state;
  return {
    state,
    command: status.command,
    startedAt: status.startedAt,
    ...(status.finishedAt ? { finishedAt: status.finishedAt } : {}),
    ...(status.attempt ? { attempt: status.attempt } : {}),
    ...(status.maxAttempts ? { maxAttempts: status.maxAttempts } : {}),
    ...(status.exitCode !== undefined ? { exitCode: status.exitCode } : {}),
    logPath: status.logPath,
  };
}

export function formatTaskView(name: string, view: TaskView): string {
  const lines = [name, "", `Agent: ${view.agent.label}`];
  if (view.operations.length)
    lines.push(
      `Operations: ${view.operations.map((operation) => `${operation.kind.replaceAll("_", " ")} (${operation.state})`).join(", ")}`,
    );
  if (view.setup.state !== "not_configured") {
    const attempts = view.setup.attempt
      ? view.setup.state === "retrying"
        ? ` - attempt ${view.setup.attempt} of ${view.setup.maxAttempts ?? view.setup.attempt}`
        : view.setup.state === "failed"
          ? ` after ${view.setup.attempt} attempt${view.setup.attempt === 1 ? "" : "s"}`
          : ""
      : "";
    lines.push(`Setup: ${title(view.setup.state)}${attempts}`);
  }
  if (view.reconciliation.state !== "not_needed")
    lines.push(`Reconciliation: ${reconciliationLabel(view.reconciliation.state)}`);
  lines.push(`Changes: ${changesLabel(view.changes.state)}`);
  lines.push(`Checks: ${checksLabel(view)}`);
  if (view.delivery)
    lines.push(
      `Delivery: Promoted to ${view.delivery.ref} as ${view.delivery.oid.slice(0, 7)} ${JSON.stringify(view.delivery.subject)}`,
    );
  if (view.preview) lines.push(`Preview: ${title(view.preview.state)}`);
  lines.push(`Removal: ${removalLabel(view.removal.state)}`);
  if (view.issues.length) {
    lines.push("", "Issues:");
    for (const issue of view.issues) {
      lines.push(`  ${issue.message}`);
      lines.push(`  Owner: ${title(issue.owner)}`);
      if (issue.logPath) lines.push(`  Log: ${issue.logPath}`);
    }
  }
  if (view.actions.length) {
    lines.push("", "Next:");
    for (const next of view.actions)
      lines.push(`  ${next.command ?? next.label}${next.command ? `    ${next.reason}` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

export function isTaskView(value: unknown): value is TaskView {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const view = value as Partial<TaskView>;
  const oneOf = (candidate: unknown, values: readonly string[]): boolean =>
    typeof candidate === "string" && values.includes(candidate);
  const validAction = (next: TaskActionView | undefined): boolean =>
    Boolean(
      next &&
      oneOf(next.kind, [
        "wait",
        "attach",
        "retry_setup",
        "resolve_conflicts",
        "fix_checks",
        "refresh",
        "review",
        "check",
        "promote",
        "discard",
        "doctor",
      ]) &&
      typeof next.label === "string" &&
      typeof next.reason === "string" &&
      (next.command === undefined || typeof next.command === "string"),
    );
  return Boolean(
    Object.keys(value).every((key) =>
      [
        "agent",
        "operations",
        "setup",
        "reconciliation",
        "changes",
        "checks",
        "delivery",
        "removal",
        "preview",
        "issues",
        "actions",
      ].includes(key),
    ) &&
    view.agent &&
    typeof view.agent.label === "string" &&
    oneOf(view.agent.state, ["not_started", "working", "awaiting_input", "exited", "unknown"]) &&
    Array.isArray(view.operations) &&
    view.operations.every(
      (operation) =>
        operation &&
        typeof operation === "object" &&
        oneOf(operation.state, ["queued", "running", "cancelling"]) &&
        oneOf(operation.kind, [
          "setup",
          "refreshing_target",
          "reconciling",
          "capturing_changes",
          "running_checks",
          "generating_metadata",
          "reviewing",
          "promoting",
          "discarding",
          "starting_preview",
        ]),
    ) &&
    view.setup &&
    typeof view.setup === "object" &&
    oneOf(view.setup.state, [
      "not_configured",
      "running",
      "retrying",
      "passed",
      "failed",
      "timed_out",
    ]) &&
    view.reconciliation &&
    typeof view.reconciliation === "object" &&
    oneOf(view.reconciliation.state, [
      "not_needed",
      "awaiting_setup",
      "queued",
      "running",
      "current",
      "conflicted",
      "failed",
    ]) &&
    view.changes &&
    typeof view.changes === "object" &&
    oneOf(view.changes.state, [
      "unknown",
      "none",
      "capturing",
      "reconciling",
      "conflicted",
      "unmerged",
    ]) &&
    view.checks &&
    typeof view.checks === "object" &&
    oneOf(view.checks.state, [
      "not_configured",
      "awaiting_setup",
      "awaiting_reconciliation",
      "awaiting_candidate",
      "not_run",
      "running",
      "passed",
      "failed",
      "stale",
    ]) &&
    view.removal &&
    typeof view.removal === "object" &&
    oneOf(view.removal.state, [
      "safe",
      "verification_required",
      "blocked_by_activity",
      "blocked_by_unmerged_changes",
      "unknown",
    ]) &&
    typeof view.removal.reason === "string" &&
    Array.isArray(view.issues) &&
    view.issues.every(
      (issue) =>
        issue &&
        oneOf(issue.code, [
          "setup_failed",
          "setup_timed_out",
          "reconciliation_conflict",
          "checks_failed",
          "preview_failed",
          "runtime_unavailable",
          "lifecycle_capture_failed",
          "operation_failed",
        ]) &&
        oneOf(issue.source, [
          "setup",
          "reconciliation",
          "checks",
          "preview",
          "runtime",
          "daemon",
        ]) &&
        oneOf(issue.owner, ["agent", "user", "boxers", "host"]) &&
        typeof issue.message === "string" &&
        (issue.logPath === undefined || typeof issue.logPath === "string") &&
        (issue.remediation === undefined || validAction(issue.remediation)),
    ) &&
    Array.isArray(view.actions) &&
    view.actions.every(validAction) &&
    (view.delivery === undefined ||
      (typeof view.delivery.ref === "string" &&
        typeof view.delivery.oid === "string" &&
        typeof view.delivery.subject === "string" &&
        typeof view.delivery.deliveredAt === "string" &&
        Number.isSafeInteger(view.delivery.conversationSequence) &&
        oneOf(view.delivery.checks, ["passed", "skipped", "not_configured"]))) &&
    (view.preview === undefined ||
      (oneOf(view.preview.state, ["stopped", "starting", "running", "failed"]) &&
        (view.preview.pid === undefined || typeof view.preview.pid === "number") &&
        (view.preview.urls === undefined ||
          (Array.isArray(view.preview.urls) &&
            view.preview.urls.every((url) => typeof url === "string"))) &&
        (view.preview.failure === undefined || typeof view.preview.failure === "string"))),
  );
}

const title = (value: string): string =>
  value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
const reconciliationLabel = (state: TaskView["reconciliation"]["state"]): string =>
  ({
    awaiting_setup: "Waiting for setup",
    queued: "Queued",
    running: "In progress",
    current: "Current with target",
    conflicted: "Conflicted",
    failed: "Failed",
    not_needed: "Not needed",
  })[state];
const changesLabel = (state: TaskView["changes"]["state"]): string =>
  ({
    unknown: "Unknown - refresh required",
    none: "No unmerged changes",
    capturing: "Capturing the current workspace",
    reconciling: "Reconciling with target",
    conflicted: "Unmerged conflicts",
    unmerged: "Unmerged changes can be promoted",
  })[state];
const removalLabel = (state: TaskView["removal"]["state"]): string =>
  ({
    safe: "Can be discarded safely",
    verification_required: "Workspace verification required",
    blocked_by_activity: "Cannot be discarded safely - activity remains",
    blocked_by_unmerged_changes: "Cannot be discarded safely - unmerged changes remain",
    unknown: "Unknown - refresh required",
  })[state];
function checksLabel(view: TaskView): string {
  if (!view.checks.results && view.delivery && view.changes.state === "none")
    return view.delivery.checks === "passed"
      ? "All checks passed for the delivered changes"
      : view.delivery.checks === "skipped"
        ? "Skipped during delivery"
        : "Not configured for the delivered changes";
  if (view.checks.state === "failed") {
    const failed = view.checks.results?.filter((result) => result.status !== "passed").length ?? 0;
    return `Failed - ${failed} of ${view.checks.results?.length ?? 0} failed`;
  }
  if (view.checks.state === "passed") return "All checks passed for the current changes";
  if (view.checks.state === "running" && view.checks.progress)
    return `Running - ${view.checks.progress.completed} of ${view.checks.progress.total} complete${view.checks.progress.current ? ` (${view.checks.progress.current})` : ""}`;
  return title(view.checks.state);
}
