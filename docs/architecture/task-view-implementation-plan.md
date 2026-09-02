# Structured task status implementation plan

Status: implemented. This document is the implementation brief for replacing the
current flattened task `phase`/`needsAttention` presentation with one shared,
structured task view. It must be read together with
[`implementation-plan.md`](implementation-plan.md) and
[`daemon-control-plane.md`](daemon-control-plane.md). Those documents describe
the implemented control plane; this plan changes its public status projection,
not the Sandbox-native task architecture.

## Outcome

Boxers must report precise, independent facts about a task and derive concrete
actions from those facts. Remove `needsAttention` from every user-facing and
machine-facing surface. Do not replace it with another broad Boolean or flatten
all task dimensions into one authoritative phase.

Every status surface must use one shared projection and answer:

- Is the agent generating, ready for input, not started, exited, or unknown?
- What Boxers operations are queued, running, or cancelling?
- Did task setup pass, fail, time out, or remain in progress?
- Are changes absent, being captured/reconciled, conflicted, or promotable?
- Do checks wait on another stage, run now, pass, fail, or refer to stale work?
- What was last delivered, and how was that delivery verified?
- Can the task be discarded without another workspace inspection?
- What specifically failed, where is its log, and who can resolve it?
- Which commands can advance, continue, or remove the task?

Internal persisted states remain facts. User-facing labels explain those facts.
Actions tell the user how to advance. A normal completed provider turn is
displayed as `Agent: Ready for input`; it is not itself an error or a request
for attention.

## Architectural constraints

- Keep the single Sandbox-native task architecture.
- Plain `boxers list` and `boxers <task> status` remain subprocess-free reads of
  recorded state. Only explicit refresh/mutating commands may perform live
  inspection.
- Preserve exact target OID, candidate tree OID, and check configuration hash
  as the candidate/check/promotion boundary.
- Do not infer activity from PTY text. Provider lifecycle events remain the
  authority for agent activity.
- Do not persist presentation sentences. Persist facts and format them in one
  projection/formatting layer.
- A stale observation must never produce `Can be discarded safely`.
- Discarding a task already proven safe must not run setup, reconciliation,
  checks, metadata generation, or another workspace probe.
- A running operation must be cancelled and quiesced before its task-owned
  files or Sandbox are destroyed.
- Stream long-running output and retain the identical bytes in the existing
  restricted log locations.
- Do not add a compatibility execution path or migrate to another task
  architecture.

## Public task view

Add a focused module, preferably `src/v2/task-view.ts`, that derives a pure
view from a task manifest, durable task state, and recorded operation state.
Keep rendering separate from derivation so detailed status, list, fleet, and
JSON cannot disagree.

The exact naming may be refined during implementation, but the contract should
have this shape:

```ts
interface TaskView {
  agent: AgentView;
  operations: OperationView[];
  setup: SetupView;
  reconciliation: ReconciliationView;
  changes: ChangesView;
  checks: ChecksView;
  delivery?: DeliveryView;
  removal: RemovalView;
  preview?: PreviewView;
  issues: TaskIssue[];
  actions: TaskActionView[];
}
```

There is deliberately no `needsAttention` field. There is also no single
authoritative public `phase`: several dimensions can be true simultaneously.
If a compact surface needs one word, it should display the first derived next
action, not manufacture another persisted lifecycle state.

### Agent view

Map the existing internal `AgentTurnState` without changing its authority:

| Internal state    | User-facing label |
| ----------------- | ----------------- |
| `not_started`     | Not started       |
| `working`         | Generating        |
| `awaiting_input`  | Ready for input   |
| `exited`          | Session exited    |
| `unknown`         | Activity unknown  |

Setup, checks, Git state, and settlement failures must not alter this value.

### Operation view

Represent every active Boxers-owned operation explicitly:

```ts
type TaskOperationKind =
  | "setup"
  | "refreshing_target"
  | "reconciling"
  | "capturing_changes"
  | "running_checks"
  | "generating_metadata"
  | "reviewing"
  | "promoting"
  | "discarding"
  | "starting_preview";

interface OperationView {
  kind: TaskOperationKind;
  state: "queued" | "running" | "cancelling";
  startedAt?: string;
  detail?: string;
}
```

Derive automatic operations from setup and settlement state. Enrich daemon
intent leases so explicit `refresh`, `sync`, `review`, `check`, `promote`, and
`discard` operations expose their kind, state, and start time. Validate lease
owner liveness so a dead worker cannot appear to run forever.

Agent generation remains in the Agent row rather than being duplicated as a
Boxers operation. A running preview is a service state; only preview startup is
an operation.

### Setup view

Support these internal/view states:

```ts
type SetupViewState =
  | "not_configured"
  | "running"
  | "retrying"
  | "passed"
  | "failed"
  | "timed_out";
```

Retain command, timestamps, attempt count, exit code, and log path. Render
specific results such as `Setup: Retrying - attempt 2 of 2` and
`Setup: Failed after 2 attempts`, never a generic task failure.

The current product has no authoritative recovery transition after an agent
repairs a failed setup manually. Add a task setup command (recommended surface:
`boxers <task> setup`) that reruns the configured setup through the existing
streaming worker and records the new attempt/result. Update CLI usage, parsing,
daemon intents, SSH authorization, README, and tests with the command. Do not
claim setup recovered merely because an unrelated check passed.

### Reconciliation view

Use a derived state with specific blocking semantics:

```ts
type ReconciliationViewState =
  | "not_needed"
  | "awaiting_setup"
  | "queued"
  | "running"
  | "current"
  | "conflicted"
  | "failed";
```

Conflicts must include paths when known and produce an agent-owned action:
attach to the existing session, resolve and stage every conflicted file, then
retry the interrupted command. Do not expose settlement `needs_input` as if it
were agent activity.

### Changes view

Replace the public unmerged Boolean with a richer derived state while retaining
the exact observation internally:

```ts
type ChangesViewState =
  | "unknown"
  | "none"
  | "capturing"
  | "reconciling"
  | "conflicted"
  | "unmerged";
```

Render the states as, for example:

- `Changes: Unknown - refresh required`
- `Changes: Capturing the current workspace`
- `Changes: Reconciling with main`
- `Changes: Unmerged conflicts`
- `Changes: Unmerged changes can be promoted`
- `Changes: No unmerged changes`

`Can be promoted` means a stable exact candidate is captured. It does not mean
checks passed; promotion may still have to run them.

### Checks view

Derive checks for the current exact candidate:

```ts
type ChecksViewState =
  | "not_configured"
  | "awaiting_setup"
  | "awaiting_reconciliation"
  | "awaiting_candidate"
  | "not_run"
  | "running"
  | "passed"
  | "failed"
  | "stale";
```

Use this precedence:

1. A current check process is `running`.
2. Running setup produces `awaiting_setup`.
3. Pending/running/conflicted reconciliation produces
   `awaiting_reconciliation` (with a conflict issue when applicable).
4. Candidate capture in progress produces `awaiting_candidate`.
5. A result matching target OID, tree OID, and config hash is `passed` or
   `failed`.
6. A non-matching result is `stale`.
7. Otherwise checks are `not_run` or `not_configured`.

Add durable, crash-aware progress for a running check passage:

```ts
interface CheckProgress {
  targetOid: string;
  candidateTreeOid: string;
  configHash: string;
  total: number;
  completed: number;
  current?: string;
  startedAt: string;
}
```

Update progress after each command and clear/finalize it on success, failure,
timeout, cancellation, or worker death. Render exact results and log paths,
for example `Checks: Failed - 1 of 4 failed` followed by the failed check.

### Delivery view

Extend the delivery record so post-promotion status remains truthful after the
active candidate/check fields are cleared:

```ts
interface DeliveryRecord {
  ref: string;
  oid: string;
  subject: string;
  deliveredAt: string;
  conversationSequence: number;
  checks: "passed" | "skipped" | "not_configured";
}
```

Promotion must record whether checks passed, were explicitly skipped, or were
not configured. Render `Checks: All checks passed for the delivered changes`
or `Checks: Skipped during delivery` rather than presenting an absent active
check as an unknown result.

### Removal view and causal workspace observations

Use an explicit disposition rather than a task phase:

```ts
type RemovalViewState =
  | "safe"
  | "verification_required"
  | "blocked_by_activity"
  | "blocked_by_unmerged_changes"
  | "unknown";
```

Render `safe` as `Removal: Can be discarded safely`.

The current clean-workspace observation is not causally tied to agent events.
Add the current `conversationHighWaterSequence` to every Git workspace
observation. Make the field optional for existing state files: an old record
without the sequence remains readable but can only yield
`verification_required`. A subsequent refresh records the sequence. This is a
schema extension, not a second reader or migration path.

Derive `safe` only when:

- no mutating operation is active;
- the agent is not generating;
- Git recorded `hasUnmergedChanges === false`;
- the observation came from the authoritative Git passage;
- the observation's conversation sequence equals the current conversation
  high-water sequence; and
- no pending reconciliation or unknown workspace relation invalidates it.

Use this exact derivation in `discard`. Do not maintain a separate discard fast
path predicate. If the result is `safe`, discard must skip setup waiting, target
refresh, sync/reconciliation, checks, metadata generation, and live workspace
inspection. If it is `verification_required`, use the existing live safety
pass. If it is blocked by unmerged work, refuse without `--force`.

### Issues

Replace generic presentation failures with structured issues where the source
is known:

```ts
interface TaskIssue {
  code:
    | "setup_failed"
    | "setup_timed_out"
    | "reconciliation_conflict"
    | "checks_failed"
    | "preview_failed"
    | "runtime_unavailable"
    | "lifecycle_capture_failed"
    | "operation_failed";
  source:
    | "setup"
    | "reconciliation"
    | "checks"
    | "preview"
    | "runtime"
    | "daemon";
  message: string;
  owner: "agent" | "user" | "boxers" | "host";
  logPath?: string;
  remediation?: TaskActionView;
}
```

Prefer deriving issues from authoritative setup/check/reconciliation/preview
records. Upgrade the remaining unstructured command failure only where its
source cannot otherwise be recovered. Show all simultaneous relevant issues;
do not flatten them into one Boolean or silently hide setup/check/preview
failure while the agent is generating.

### Actions

Derive an ordered list, not one mandatory action:

```ts
type TaskActionKind =
  | "wait"
  | "attach"
  | "retry_setup"
  | "resolve_conflicts"
  | "fix_checks"
  | "refresh"
  | "review"
  | "check"
  | "promote"
  | "discard"
  | "doctor";
```

Order actions as follows:

1. Wait for or observe a running mutation.
2. Resolve reconciliation conflicts with the existing agent session.
3. Diagnose and retry terminal setup failure.
4. Attach and fix failed checks, then rerun them.
5. Repair runtime/lifecycle/infrastructure failures with the specific
   diagnostic command.
6. Review, check, or promote a stable unmerged candidate.
7. Discard verified completed work, while continuing to offer attach.
8. Refresh stale/unknown facts.
9. Attach to start or continue an otherwise idle conversation.

Each action carries a display label, concrete command where applicable, and a
reason. Do not describe `Agent: Ready for input` as an issue when no failing
subsystem exists.

## Rendering

### Detailed status

Refactor `boxers <task> status` to render `TaskView`. Always show Agent,
Changes, Checks, and Removal. Show Setup, Reconciliation, Delivery, Preview,
Operations, and Issues when configured or relevant. Put running operations and
specific failures before successful/historical detail.

Example with a failed check:

```text
parser

Agent: Ready for input
Setup: Passed
Changes: Unmerged changes can be promoted
Reconciliation: Current with main
Checks: Failed - 1 of 4 failed
Removal: Cannot be discarded safely - unmerged changes remain

Issues:
  typecheck exited 2
  Log: .../checks/typecheck.log

Next:
  boxers parser attach    Ask the agent to fix typecheck
  boxers parser check     Rerun checks afterward
```

Example after delivery:

```text
docs

Agent: Ready for input
Changes: No unmerged changes
Delivery: Promoted to main as abc1234 "Improve task status"
Checks: All checks passed for the delivered changes
Removal: Can be discarded safely

Next:
  boxers docs discard     Remove the completed task
  boxers docs attach      Continue the existing conversation
```

`status --json` should return identity, the public view, and explicitly named
internal diagnostic state rather than presenting the latter as public status:

```json
{
  "task": {},
  "view": {},
  "internal": {}
}
```

### List and fleet

Replace `NEEDS_ATTENTION` and the raw `UNMERGED_CHANGES` Boolean in the table
with semantic columns derived from the same view:

```text
MACHINE  PROJECT  TASK   AGENT            CHANGES     CHECKS   NEXT
local    boxers   docs   Ready for input  None        Passed   discard
local    boxers   api    Generating       Unmerged    Running  wait
local    boxers   merge  Ready for input  Conflicted  Waiting  attach
```

Keep machine connection, preview URL, and a concise detail column where useful.
Do not contact Docker Sandboxes, Git, SSH, or the daemon while formatting a
plain cached list.

## Fleet and JSON protocol

The remote snapshot currently requires a flattened phase and optionally
contains `needsAttention`. Replace that public contract with `TaskView` and
bump the fleet snapshot protocol version because this is a deliberate semantic
break. Update the strict parser and all fixture snapshots.

Mixed-version peers must fail visibly with a version-specific diagnostic. Do
not silently apply the old `activity === "awaiting_input"` fallback, because
that recreates the behavior this plan removes. There is no need for a second
execution path; the incompatibility is limited to observation until both hosts
run the same protocol.

## Implementation sequence

Implement in small, reviewable passages. Do not change all persistence and
rendering in one untestable rewrite.

### Passage 1: pure projection and vocabulary

- Add the TaskView types and pure projector.
- Derive Agent, Setup, Reconciliation, Changes, Checks, Preview, Issues, and
  Actions from current recorded facts.
- Add exhaustive table-driven projector tests, including simultaneous states.
- Do not switch commands to it yet.

Primary files:

- `src/v2/task-view.ts` (new)
- `src/v2/types.ts`
- `test/v2/task-view.test.ts` (new)

### Passage 2: causal removal safety

- Record conversation sequence with workspace observations.
- Implement RemovalView.
- Reuse RemovalView in discard.
- Ensure older observations degrade to verification-required.
- Strengthen discard tests to prove the safe path performs no setup wait,
  refresh, sync, check, metadata generation, or Sandbox exec.
- Add the regression where a post-promotion turn invalidates the old clean
  observation even after the agent returns to ready-for-input.

Primary files:

- `src/v2/state.ts`
- `src/v2/types.ts`
- `src/v2/commands.ts`
- `test/v2/state.test.ts`
- `test/v2/native-promotion.test.ts`

### Passage 3: delivery verification

- Extend delivery facts with timestamp, conversation sequence, and check
  outcome.
- Record the facts atomically after successful local/remote delivery.
- Render delivered checks distinctly from current-candidate checks.
- Cover passed, skipped, unconfigured, remote publication, and preserved newer
  workspace changes.

Primary files:

- `src/v2/state.ts`
- `src/v2/types.ts`
- `src/v2/commands.ts`
- `test/v2/native-promotion.test.ts`

### Passage 4: operation and check progress visibility

- Enrich daemon intent leases with kind/state/start time.
- Add liveness validation/recovery for recorded operations.
- Persist exact-candidate check progress and update it after every command.
- Project setup, settlement, explicit intent, and preview-start operations.
- Verify cancellation and late-worker publication guards still hold.

Primary files:

- `src/v2/daemon.ts`
- `src/v2/daemon-commands.ts`
- `src/v2/commands.ts`
- `src/v2/state.ts`
- `src/v2/paths.ts`
- `src/v2/types.ts`
- `test/v2/daemon.test.ts`
- `test/v2/daemon-commands.test.ts`
- `test/v2/settlement.test.ts`
- `test/v2/native-promotion.test.ts`

### Passage 5: status, list, JSON, and fleet cutover

- Render detailed task status from TaskView.
- Render list/fleet rows from TaskView.
- Replace the remote task snapshot contract and bump its protocol.
- Remove `needsAttention`, `taskNeedsAttention`, and the awaiting-input
  fallback.
- Stop exposing projectionPhase as the public status. Keep snapshot phase only
  where internal orchestration still uses it.
- Update all strict parsers, JSON fixtures, remote observation tests, and output
  assertions.

Primary files:

- `src/v2/commands.ts`
- `src/v2/projection.ts`
- `src/v2/machines.ts`
- `src/v2/types.ts`
- `src/v2/state.ts`
- `test/v2/state.test.ts`
- `test/v2/list.test.ts`
- `test/v2/machines.test.ts`
- relevant fleet/remote snapshot tests

### Passage 6: setup recovery

- Add `boxers <task> setup` and a typed daemon intent.
- Reuse streaming setup execution and logs; do not introduce a second setup
  implementation.
- Record attempts and terminal outcomes durably.
- Make setup retry serializable/cancellable like other task mutations.
- Add parsing, daemon, streaming, failure, timeout, and successful recovery
  tests.
- Synchronize CLI usage and README.

Primary files:

- `src/cli.ts`
- `src/core/entrypoint.ts`
- `src/v2/commands.ts`
- `src/v2/setup.ts`
- `src/v2/daemon-client.ts`
- `src/v2/daemon-protocol.ts` or the current intent type owner
- `src/v2/ssh-transport.ts`
- `test/v2/cli.test.ts`
- `test/v2/daemon.test.ts`
- setup-focused tests
- `README.md`

### Passage 7: documentation and dead-state audit

- Update `docs/architecture/implementation-plan.md` so it no longer describes
  `needsAttention` as part of the implemented architecture.
- Document TaskView as the authoritative observation contract.
- Update README examples for status, list, setup retry, failure remediation,
  and safe discard.
- Audit `TaskSnapshot.phase` values such as `active`, `working`, `setting_up`,
  and `checking`. Remove only values proven unused after the TaskView cutover;
  do not combine speculative lifecycle cleanup with the projection work.

## Required test matrix

At minimum, cover these end-to-end combinations:

| Agent          | Setup  | Changes    | Checks            | Expected action/status                 |
| -------------- | ------ | ---------- | ----------------- | -------------------------------------- |
| generating     | running| unknown    | awaiting setup    | wait; both running facts visible       |
| ready for input| passed | unmerged   | passed            | promote/review/attach                  |
| ready for input| passed | unmerged   | failed            | attach to fix, then check              |
| ready for input| failed | unknown    | awaiting setup    | diagnose and retry setup               |
| ready for input| passed | conflicted | awaiting reconcile| attach to resolve conflicts            |
| ready for input| passed | none       | delivered passed  | discard or attach                      |
| exited         | passed | unmerged   | not run           | attach/restart or check/promote         |
| unknown        | passed | unknown    | awaiting candidate| refresh; never claim safe discard      |

## Dead-state audit

The TaskView cutover does not remove persisted `TaskSnapshot.phase` values.
Each existing value is still referenced by manifest validation, runtime
snapshot merging, provisioning, reconciliation, candidate capture, promotion,
or internal orchestration tests. They remain internal diagnostics and are not
used as the public status contract. Removing them requires a separate persisted
state change with its own compatibility analysis.

Also verify:

- Multiple issues render independently.
- A check failure does not change Agent from Ready for input.
- A setup or preview failure remains visible while the agent is generating.
- A newer prompt cancels settlement and invalidates removal safety.
- A late cancelled worker cannot overwrite the new TaskView facts.
- A target advance makes candidate/check/removal facts stale until reconciled.
- Local and remote delivery report their distinct refs correctly.
- Plain list/status perform no subprocess or network calls.
- JSON and human output are projections of the same TaskView fixture.
- Mixed fleet protocol versions fail explicitly.

## Validation gates

Before handoff, run:

```sh
npm run check
npm test -- --run
npm run build
git diff --check
```

Run focused tests after each passage rather than waiting for the final cutover.
Before any test command, obey the repository setup coordination marker in
`.git/boxers/setup-status`.

## Completion criteria

The work is complete only when:

- No human or JSON/fleet surface contains `Needs attention` or
  `needsAttention`.
- Agent state is displayed independently as Generating, Ready for input, Not
  started, Session exited, or Activity unknown.
- Every active Boxers process is observable with a specific operation label.
- Setup, reconciliation, changes, checks, delivery, removal, preview, and
  failures have distinct output.
- Check status always names the current exact candidate, is explicitly stale,
  or explains what prerequisite it awaits.
- Every failure identifies its subsystem, available log, responsible actor,
  and concrete remediation.
- A delivered clean task clearly says `Can be discarded safely` and offers both
  discard and attach.
- Safe discard cannot lose post-promotion work and launches no unnecessary
  setup, reconciliation, checks, generation, or workspace inspection.
- Detailed status, list, local JSON, fleet snapshots, and remote fleet views all
  consume the same TaskView projector.
- CLI usage, README, architecture documentation, implementation, and tests use
  the same vocabulary.
