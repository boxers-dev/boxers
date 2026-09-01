# Event-driven task settlement refactor

Status: implemented decision record. The authoritative current-state summaries
are `daemon-control-plane.md` and `implementation-plan.md`.

This document is the implementation brief for replacing Boxers's inferred
quiescence polling with provider lifecycle hooks. It describes the intended
end state, not a migration. Boxers is not yet a live compatibility surface:
implement one clean architecture, write only the new schemas, and do not add
legacy readers, fallback polling, dual execution paths, or migration code.

The implemented architecture supports Codex and Claude. Provider-specific behavior
must sit behind an adapter so another harness can be added without changing the
settlement state machine.

## Outcome

When the durable agent finishes a turn and begins awaiting input, Boxers
must immediately start one cancellable post-turn settlement run for that task.
The run refreshes and reconciles Git, captures an exact candidate, runs checks,
and generates a conversation-aware commit subject and development note. If the
user does nothing, that work should normally be ready before they inspect the
task. The first user input cancels the run so the agent can resume promptly.

The daemon remains, but only as the host-local event reactor and authority for
durable PTYs, cancellation, host Git, task state, intents, fleet projection, and
promotion. It must no longer discover local task activity through continuous
runtime inventory, `/proc`, terminal wait-channel inspection, CPU sampling, or
PTY-output heuristics. It must no longer maintain independent observation,
check, and commit-message scheduling lanes.

Heavy work continues to execute in short-lived worker processes, with
workspace reconciliation, setup, checks, and model generation running inside
the task's Docker Sandbox wherever possible. Do not put a second daemon or
autonomous coordinator inside each Sandbox.

## Why the current design changes

Today the daemon continuously:

1. runs runtime inventory;
2. probes each running provider process tree;
3. classifies terminal reads as `needs_input` and otherwise samples CPU for
   approximately 500 ms;
4. refreshes, reconciles, and captures on every quiescent passage;
5. enqueues commit-message generation and checks into two separate host-wide
   single-worker pools.

Checks and commit-message generation already execute inside the Sandbox. The
avoidable complexity is the inferred trigger and the fragmented host-side
coordination. Repeated passages are made tolerable by exact-candidate caches,
but they still require continuous observation and several independently
coalescing state machines.

User input currently aborts only an active observation. It does not cancel an
already-running check or commit-message worker. Checks remain safe because
they use an immutable worktree and publish only while their candidate still
matches, but that is more machinery than the desired clean-slate design needs.

## Architectural principles

The implementation must preserve these rules:

- Provider lifecycle events are the authority for whether the durable agent is
  working or awaiting input.
- A turn-finished event starts work; it does not perform the work in the hook.
- There is at most one current settlement generation per task.
- New user input supersedes that generation immediately.
- Different tasks may settle concurrently. Do not retain an arbitrary
  host-wide one-check or one-message pool.
- Explicit task commands join, reuse, supersede, or synchronously start the
  same settlement machinery. They do not create another Git/check path.
- Exact target OIDs and candidate tree OIDs remain the review, check, and
  promotion boundary.
- Conversation context affects commit metadata, not the identity of the code
  candidate or its check result.
- Networked Git authentication, canonical target refresh, review refs,
  promotion, and real branch advancement remain on the host.
- The live task workspace is mutated only inside the existing narrow per-task
  mutation barrier.
- Checks run against an immutable isolated worktree inside the Sandbox and
  must not mutate it.
- Plain `list` and `status` remain subprocess-free reads of recorded state.
- A late, cancelled, or superseded worker must never publish current results.
- Provider transcript files are not an API. Never parse `transcript_path`.

## Target flow

```text
durable provider session in Sandbox
    |
    | UserPromptSubmit / Stop hook
    v
durable event in .git/boxers + PTY wake-up frame
    |
    v
host daemon event reactor
    |
    | start/supersede one task settlement generation
    v
short-lived settlement worker
    |
    +-- host: refresh canonical target and config
    +-- Sandbox: reconcile live workspace when required
    +-- host: capture exact candidate tree and review ref
    +-- Sandbox: prepare immutable check worktree
    +-- Sandbox: run setup/checks
    +-- Sandbox: generate commit subject and development note
    `-- host: guarded publication for the active generation

raw user input -----------------------> cancel active generation
                                         |
                                         `-- briefly buffer only while a live
                                             workspace mutation unwinds
```

After `turn_finished`, the visible state should progress through `settling`
and useful subphases such as `reconciling`, `checking`, and `generating`, then
become `ready` or `needs_input`. A failed configured check is a completed
settlement result, not a crashed settlement. Infrastructure, reconciliation,
or generation failures must be represented separately and remain retryable.

## Provider lifecycle adapter

Introduce a provider/harness abstraction separate from `TaskRuntime`. Docker
Sandboxes describes where processes run; Codex or Claude describes how the
agent launches, resumes, exposes lifecycle events, and runs an auxiliary
metadata-generation session. Do not add Codex/Claude conditionals throughout
the daemon or settlement coordinator.

A suitable interface should cover at least:

```ts
interface AgentHarness {
  readonly id: "codex" | "claude";
  lifecycleCapabilities(): {
    userPromptSubmit: true;
    turnFinished: true;
  };
  installLifecycleHooks(task: TaskManifest): void;
  durableSessionArguments(task: TaskManifest, options: AgentSessionOptions): string[];
  normalizeLifecycleEvent(raw: unknown): ProviderLifecycleEvent | undefined;
  commitMetadataInvocation(task: TaskManifest): ProviderInvocation;
}
```

The exact names may differ, but the ownership boundary must remain. Place the
interfaces, Codex implementation, Claude implementation, and registry in a
focused provider directory. `session.ts` should compose a provider launch; it
should not own hook JSON parsing or lifecycle normalization.

Only the stable hook fields needed by Boxers should enter the normalized
event model:

```ts
type ProviderLifecycleEvent =
  | {
      version: 1;
      kind: "user_prompt";
      provider: "codex" | "claude";
      providerSessionId: string;
      providerTurnId?: string;
      prompt: string;
      recordedAt: string;
    }
  | {
      version: 1;
      kind: "turn_finished";
      provider: "codex" | "claude";
      providerSessionId: string;
      providerTurnId?: string;
      lastAssistantMessage?: string;
      stopHookActive?: boolean;
      recordedAt: string;
    };
```

Use `providerSessionId`, provider turn identity where available, event kind,
and the hook-side sequence for deduplication. Reject malformed or implausibly
large event payloads without crashing the durable agent session. Persist a
diagnostic when lifecycle capture is unhealthy instead of silently reverting
to activity polling.

### Codex

Use `UserPromptSubmit.prompt` and `Stop.last_assistant_message`. Retain
`session_id`, `turn_id`, and `stop_hook_active` for identity and diagnostics.
The official Codex hook contract explicitly says that `transcript_path` is not
a stable interface, so it must be ignored.

Codex discovers lifecycle hooks through its active configuration layers and
requires non-managed hooks to be trusted. Install or inject the Boxers
hooks only for the durable task session and launch that controlled session with
the documented hook-trust bypass if necessary. Preserve unrelated provider
configuration. Auxiliary provider invocations used for reconciliation repair
or commit metadata must not emit durable-session lifecycle events.

### Claude

Configure the corresponding `UserPromptSubmit` and `Stop` command hooks through
Claude's task-session settings. Normalize Claude's input into the same two
provider-neutral events. Keep the Boxers settings isolated from the user's
other Claude settings when the CLI supports an additional settings file.

The implementation agent must re-check the current official Claude Code hook
schema, hook output contract, settings precedence, and CLI arguments before
writing this adapter. Provider documentation evolves independently; only the
normalized Boxers event contract is stable internally.

### Hook behavior

Hooks must be synchronous only long enough to make the event durable and send
a wake-up signal. They must:

- read the provider's JSON object from standard input;
- atomically allocate a monotonically increasing hook event sequence;
- atomically write the raw event under the repository Git directory, for
  example `.git/boxers/conversation/events/<sequence>.json`;
- notify the daemon over the existing daemon-owned PTY transport;
- return a neutral, valid result for the provider event;
- never run Git reconciliation, checks, model generation, or host commands;
- never block, continue, or otherwise steer the agent turn;
- never add hook data, helper scripts, or configuration to the candidate tree.

The one safety exception is `UserPromptSubmit`: after it records and wakes the
daemon, it must wait while an Boxers live-workspace mutation marker exists
inside `.git/boxers`. The daemon will already have received the cancellation
event and should clear that marker promptly while unwinding the worker. This
prevents an automatic provider continuation from beginning model/tool work in
the middle of reconciliation. The wait must have a bounded failure path and is
not a reason to perform settlement work inside the hook.

Use a small provider-compatible recorder installed outside the worktree, with
restricted permissions. Event allocation must be safe against concurrent hook
processes and crashes: write to a temporary file, flush/close it, then rename
it into the ready-event directory before sending the wake-up signal. A failed
wake-up must not lose the durable event.

Do not configure these hooks as provider background hooks. Background hook
delivery can reorder events and may be cancelled when the session ends. The
recorder should be small enough that synchronous execution is negligible and
have a short timeout.

## Durable event transport

The Sandbox cannot directly own the host daemon's Unix socket, and the daemon
must not poll event files. Use the daemon-owned PTY as the wake-up side channel
and the Git metadata directory as durable storage:

1. At durable-session preparation, create a random per-session bridge token and
   record it in restricted task state and under `.git/boxers`.
2. The hook writes the full event to disk first.
3. The hook writes a short private OSC/DCS control frame containing the bridge
   version, token, and event sequence to `/dev/tty`.
4. The daemon's PTY parser recognizes and removes valid frames before replaying
   output to viewers.
5. The daemon starts asynchronous event ingestion for the identified task.
6. The worker reads and validates the durable event from the Sandbox, advances
   the conversation high-water mark, and reports the normalized event.

Use an explicit, versioned frame format with a strict maximum length. The PTY
parser must handle frames split across chunks, multiple frames in one chunk,
ordinary OSC traffic, invalid tokens, and incomplete frames without corrupting
normal terminal output. The token prevents accidental terminal output from
being mistaken for an Boxers event; it is a collision guard, not a security
boundary against the task's full-access agent.

If the wake-up cannot reach the PTY, the event remains durable. Drain pending
events on the next task-owned lifecycle boundary: daemon startup for already
running owned sessions, session recovery, attach, or an explicit strong task
intent. This is bounded recovery, not continuous polling. A daemon may perform
one runtime inventory at startup for session/event recovery; it must not resume
round-robin local observation afterward.

All durable sessions must therefore become daemon-owned, including a detached
`new --prompt ... -d` launch. Replace direct detached `sbx run -d` ownership
with a daemon start-session request that creates the same PTY without attaching
a viewer. Attaching later adds a viewer to that existing session. Losing a CLI
or SSH connection must not lose the PTY or lifecycle wake-ups. Preserve native
Codex and Claude resume behavior and `sessionStartedAt`; recovery must resume
the provider's recorded conversation rather than create a new one.

The mutation barrier needs a Sandbox-visible companion marker as well as the
current host marker. Create and remove both for the same run ID in `finally`.
Raw terminal input uses the host marker; `UserPromptSubmit` uses the Sandbox
marker. Startup recovery may clear a stale marker only after proving its owning
settlement worker/lease is dead.

## Conversation record and commit context

The canonical captured context lives inside the durable Sandbox under
`.git/boxers`, outside the candidate. Do not read the provider's private
transcript format and do not add a second conversation database that can
diverge from the hook log.

For each accepted event, retain:

- monotonically increasing Boxers sequence;
- provider, provider session ID, and provider turn ID when available;
- normalized user prompt or last assistant message;
- hook recording time;
- enough source metadata to diagnose duplicate or malformed events.

Task state should record the accepted conversation high-water sequence and the
conversation checkpoint associated with the last successful promotion. Commit
metadata generation normally uses captured events after that checkpoint, so a
later commit is not explained by old, already-promoted conversation. Preserve
the full event log even when only a bounded relevant window is supplied to the
metadata model.

The generator input must contain both:

- the exact candidate diff from the captured target and candidate tree; and
- normalized conversation context through a specific high-water sequence.

Use a structured envelope rather than concatenating ambiguous text. The prompt
should request a concise overview of the change based on the conversation and
code, capturing only the most important motivation, decisions, constraints,
non-obvious behavior, trade-offs, and follow-up work. It should naturally scale
from a short paragraph for a small change to a few useful sections for a large
feature or refactor. It must not enumerate files or mechanically retell the
diff.

Keep the existing subject/body validation rules:

- imperative subject, at most 72 characters;
- non-empty plain-text development note suitable for a Git commit body;
- approximately 72-column prose wrapping;
- at most 8,000 characters for the stored note.

The first generation should be explicitly concise but should not be constrained
by a schema-level 8,000-character maximum that converts a useful overlong
answer into an opaque provider failure. Parse and validate it first. If the
note is over 8,000 characters, make exactly one additional model call that
summarizes the first generated subject/note, keeping the subject unchanged and
preserving only the most important context. Fail generation only when that one
summarization is invalid or still too large. Promotion retains its generic
fallback when no valid generated metadata exists, while an explicit user
message always wins.

Commit metadata cache identity must include:

```text
target OID + candidate tree OID + conversation high-water sequence
```

Check cache identity remains:

```text
target OID + candidate tree OID + normalized check-config hash
```

A new conversation turn with the same code may therefore regenerate the note
while reusing the same check. A new code candidate invalidates both as
appropriate. A late generator result for an older conversation high-water mark
must be discarded.

## Settlement coordinator

Replace the observation scheduler, automatic check pool, automatic
commit-message pool, and per-worktree check coordinator with one task-scoped
settlement coordinator owned by the daemon.

For each task, the coordinator tracks:

- current settlement run ID/generation;
- triggering turn-finished event sequence;
- an `AbortController` and child worker process group;
- current phase and immutable identities discovered so far;
- any explicit intents waiting to join the run;
- whether cancellation is waiting for a mutation barrier to unwind.

There is no global single-worker pool. Only one settlement may be current for a
given task, while different task Sandboxes may settle concurrently. If resource
limits become necessary later, add them as an explicit runtime resource policy,
not as independent check/message coordination lanes.

### Trigger and coalescing rules

- `turn_finished` marks the agent as awaiting input and starts a settlement for
  that conversation high-water mark.
- A duplicate event is ignored.
- A newer `turn_finished` supersedes an older queued or active generation.
- Raw PTY input cancels the active generation immediately, before waiting for
  `UserPromptSubmit`.
- `user_prompt` is the durable confirmation that the agent is working and also
  cancels any generation that escaped the raw-input path.
- Attaching, resizing, replaying output, or merely looking at a task does not
  cancel settlement.
- Ordinary provider screen output is not used to infer working/idle state.
- An explicit same-task mutating intent preempts settlement and then either
  joins/restarts the same pipeline or performs its distinct operation under the
  task intent lease.
- Events received while setup is running remain eligible. Resume settlement
  from the setup-completed state event if no newer user input superseded the
  triggering turn; do not add a setup polling loop.

Provider `Stop` is the formal end of foreground agent mutation. Agent-launched
background processes that continue writing the workspace after the provider
turn ends violate this boundary and are unsupported unless a provider exposes
a reliable active-background-task signal that its adapter can honor. Do not
reintroduce generic CPU polling to guess about such processes.

Provider Stop hooks can coexist with hooks that request another agent
continuation. Treat the Stop as a tentative settlement trigger, but guard the
actual live-workspace passage with the current lifecycle generation. If another
hook requests continuation, its `UserPromptSubmit` event must first be made
durable, cancel the generation, and wait on the Sandbox-visible mutation marker
before the provider can continue. Test this sequence for both providers; do not
assume `stop_hook_active` has the same semantics across them and do not force
`continue: false`, because Boxers must not change the behavior of unrelated
provider hooks.

### Settlement stages

One worker performs the following stages under one run ID:

1. **Validate generation**
   - Confirm the task still exists.
   - Confirm the triggering conversation sequence is still current.
   - Confirm the durable agent remains in an awaiting-input state.
   - Load project configuration.

2. **Refresh canonical target on the host**
   - Use host credentials and the sanitized seed.
   - Record the exact target OID and target configuration.
   - Never copy host Git credentials or remote configuration into the Sandbox.

3. **Reconcile when the target advanced**
   - Enter the task mutation barrier.
   - Materialize the old candidate in the host seed as currently required.
   - Run the three-way workspace reconciliation inside the Sandbox.
   - Preserve the bounded ephemeral provider repair attempt for conflicts, but
     ensure it does not emit durable-session lifecycle events.
   - Leave unresolved conflicts in the live workspace and publish
     `needs_input`; do not proceed to checks or metadata generation.

4. **Capture the exact candidate**
   - Still under the narrow mutation barrier, read the live workspace patch.
   - Apply it to an isolated host seed index.
   - write the exact tree and synthetic review commit;
   - update the task review ref;
   - release the mutation barrier as soon as the live workspace is no longer
     needed.

5. **Prepare immutable inputs**
   - Build the exact base-to-candidate patch from host-recorded OIDs.
   - Prepare/reset the persistent detached check worktree in the Sandbox.
   - Verify that its tree equals the captured candidate tree.
   - Read conversation events only through the triggering high-water sequence.

6. **Run candidate work**
   - Run configured setup/check commands in the isolated Sandbox worktree.
   - Run conversation-aware commit metadata generation in a fresh ephemeral
     provider session without touching the durable conversation.
   - These branches may run concurrently only as structured children of the
     same settlement run and must share cancellation. Sequential execution is
     also acceptable if it keeps cancellation and publication simpler.
   - Verify again that checks did not modify the candidate tree.

7. **Guarded publication**
   - Re-read the current task and settlement generation.
   - Publish a result only if run ID, triggering conversation sequence, target
     OID, and candidate tree still match.
   - Atomically record candidate relation, check result, commit metadata,
     settlement completion, and failures owned by this generation.
   - Notify local subscribers and fleet projection clients.

Progress may be published during stages, but every update must be guarded by
the run ID. Immutable artifacts from a cancelled run may remain for later
cleanup or reuse, but they must not be presented as the current candidate.

### Cancellation

Raw terminal input is the earliest cancellation boundary. On the first input
byte for a task:

1. increment/supersede the in-memory settlement generation;
2. abort the settlement worker and its process group;
3. stop queued stage transitions and invalidate guarded publication;
4. if no live-workspace mutation is active, forward the input immediately;
5. if reconciliation/capture is active, retain the existing bounded input
   buffer until the barrier's `finally` cleanup restores a coherent workspace;
6. forward buffered input immediately after the barrier clears.

For the initial implementation, cancel the whole run, including an immutable
check already in progress. This deliberately favors one comprehensible rule
over retaining the current stale-check completion optimization. The next
turn-finished event starts a fresh run and may reuse any previously completed,
exactly matching check result.

Cancellation must propagate through worker processes and streaming Sandbox
commands. Extend captured/streaming process helpers to accept an `AbortSignal`,
terminate the complete host worker/process group, and confirm the current
Docker Sandboxes CLI's signal/disconnect behavior. A cancelled command must not
be recorded as a failed check. Escalate from graceful termination to a bounded
kill only for the exact worker process group.

## State model

Replace inferred activity with explicit event-derived state. A clean model
should separate agent turn state from settlement state, for example:

```ts
type AgentTurnState = "not_started" | "working" | "awaiting_input" | "exited" | "unknown";

type SettlementPhase =
  | "none"
  | "queued"
  | "refreshing"
  | "reconciling"
  | "capturing"
  | "checking"
  | "generating"
  | "ready"
  | "cancelled"
  | "failed";
```

Task state needs enough data to enforce guarded publication:

```ts
interface SettlementState {
  runId: string;
  phase: SettlementPhase;
  triggerSequence: number;
  startedAt: string;
  updatedAt: string;
  targetOid?: string;
  candidateTreeOid?: string;
  finishedAt?: string;
  failure?: string;
}
```

Also persist the provider session/turn identity, last accepted lifecycle event,
conversation high-water sequence, post-promotion conversation checkpoint,
candidate/check identities, and conversation-aware commit-message identity.

Derive user-facing `needsAttention` from explicit events and outcomes:

- false while the provider is working;
- true when it is awaiting input, including while settlement runs;
- true with a focused question for unresolved reconciliation or another
  failure requiring user action;
- do not toggle it from arbitrary PTY output.

Choose one new manifest/state schema and accept only that schema. Bump the task
manifest and task-state versions if their persisted shape changes. Do not add
compatibility readers or conversions for the current polling-era records.
Project configuration does not need a version change unless its public shape
changes.

## Explicit command behavior

All strong commands remain self-sufficient, but use the same event-derived
state and settlement implementation:

| Command               | Required behavior                                                                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`, `status`      | Read recorded state only; never enter Git or a Sandbox.                                                                                                                                |
| `status --refresh`    | Drain pending lifecycle events, then join/start the relevant strong settlement passage if the recorded agent is awaiting input. Report working without probing `/proc` when it is not. |
| `sync`                | Join or start the refresh/reconcile/capture stages; do not create a second reconciliation path.                                                                                        |
| `review`              | Reuse the exact captured candidate as soon as capture completes. It does not need to wait for checks or metadata generation.                                                           |
| `check`               | Join a matching active settlement or run the same exact-candidate check stage and stream its output.                                                                                   |
| `promote`             | Join/reuse matching settlement output, synchronously complete missing work, recheck the canonical target under the project lock, and preserve all current promotion guards.            |
| `attach`              | Add a viewer without cancelling settlement. First real user input cancels it. Recover/resume the native provider session rather than creating a fresh conversation.                    |
| `new ... -d --prompt` | Start a viewerless daemon-owned PTY so hooks and cancellation remain observable.                                                                                                       |
| `preview`             | Remain a typed task intent but do not imply agent activity or candidate freshness.                                                                                                     |
| `stop`, `rm`          | Cancel settlement before stopping/removing the exact task resources.                                                                                                                   |

If a task remains untouched after a turn, its candidate, checks, and commit
metadata become ready automatically. If the configured base advances later,
there is no local provider event that can reveal that fact. The next strong
command must refresh the target and may reconcile and rerun candidate-bound
work. Do not retain continuous target polling merely to keep an abandoned task
fresh against unrelated remote changes.

## Daemon after the refactor

The daemon still owns:

- durable PTYs and viewer replay/backpressure;
- lifecycle-frame recognition and event ingestion;
- earliest-input cancellation and the mutation input barrier;
- one settlement generation per task;
- per-task typed intent serialization and crash-visible leases;
- state revision notifications and local projections;
- fleet subscriptions/gossip that are independently required;
- host-only Git/authentication and promotion boundaries;
- startup recovery of known sessions, pending hook events, and orphaned worker
  leases.

It no longer owns:

- continuous local `sbx ls` circulation;
- per-task `/proc` process discovery;
- terminal `wchan` classification;
- 500 ms CPU tick sampling;
- PTY-output debounce as an activity oracle;
- round-robin background observation;
- a separate automatic-check worker pool;
- a separate automatic-commit-message worker pool;
- repeated quiescent refresh on every inferred idle passage.

Replace `TaskScheduler` with a focused per-task intent/settlement coordinator.
Interactive intents still serialize per task and different tasks still make
progress concurrently. Keep blocking Docker and Git calls outside the daemon's
PTY event loop.

## Module-level implementation map

The implementation should make the following structural changes. Adjust names
if a clearer focused ownership emerges, but preserve the boundaries.

### Add

- `src/v2/providers/types.ts`: provider lifecycle and invocation contracts.
- `src/v2/providers/codex.ts`: Codex hook installation, launch, normalization,
  and auxiliary invocation details.
- `src/v2/providers/claude.ts`: Claude equivalents.
- `src/v2/providers/registry.ts`: exhaustive provider lookup.
- `src/v2/conversation.ts`: durable event validation, normalization,
  sequencing, high-water/checkpoint selection, and generation envelope.
- `src/v2/pty-control.ts`: streaming parser/encoder for private lifecycle wake
  frames.
- `src/v2/settlement.ts`: task-scoped coordinator and guarded state
  transitions.
- a settlement worker entrypoint/module that invokes the existing reusable Git,
  check, and generation behavior outside the PTY reactor.

### Refactor

- `src/v2/session.ts`: delegate provider arguments and hook setup; route all
  durable launches, including detached launches, through the daemon.
- `src/v2/daemon.ts`: remove observation circulation and worker pools; ingest
  lifecycle frames, own settlement generations, and cancel on raw input.
- `src/v2/daemon-protocol.ts`: add any internal start-session or settlement
  messages needed for viewerless PTYs and progress/join behavior; bump the
  protocol version with no compatibility branch.
- `src/v2/daemon-worker.ts`: retain generic intent worker mechanics, replace
  observe/check/message entrypoints with one cancellable settlement worker.
- `src/v2/commands.ts`: expose one reusable settlement passage for automatic
  and explicit commands; preserve host Git/promotion orchestration.
- `src/v2/process.ts`: propagate cancellation through streaming commands and
  exact process groups.
- `src/v2/runtime/types.ts`: remove activity probing; add only capabilities
  genuinely owned by the runtime. Do not model provider hooks as Docker
  lifecycle events.
- `src/v2/runtime/docker-sandboxes.ts` and `src/v2/sandbox.ts`: remove the
  provider activity probe and support hook installation/event reads/check
  cancellation through focused runtime operations where appropriate.
- `src/v2/types.ts`, `src/v2/state.ts`, `src/v2/registry.ts`, and
  `src/v2/projection.ts`: introduce event-derived turn/settlement state and new
  exact cache keys.
- `src/cli.ts`: remove private polling worker entrypoints and add the single
  settlement/event worker entrypoints required by the new design.
- setup completion: notify/reconsider a deferred settlement through an event,
  not a polling scheduler.

### Delete

- `src/v2/observer.ts`;
- `src/v2/quiescence.ts` when no remaining event-derived helper justifies it;
- the current polling-oriented `TaskScheduler` and `BackgroundWorkerPool`;
- `probeAgentActivity`, `probeTaskAgent`, and their runtime interface method;
- observation/check/message worker entrypoints replaced by settlement;
- polling, observer, CPU-probe, and worker-pool tests that assert removed
  behavior;
- activity-update workers and PTY output timers used only for inferred
  activity;
- the separate check worktree coordinator if the single per-task settlement
  owner makes it redundant.

Do not delete the mutation barrier, exact candidate capture, isolated check
worktree, check result verification, intent leases, PTY backpressure, fleet
projection, or promotion locks.

## Failure and recovery semantics

- Hook recorder failure: do not steer or terminate the provider turn. Record a
  visible lifecycle-capture diagnostic when possible. Never start polling as a
  fallback.
- Wake-up loss: ingest the durable file at the next bounded recovery boundary.
- Daemon restart: refuse while a session is working or unclassified, but allow
  provider-confirmed `awaiting_input` sessions to release their PTYs. Recover
  task and settlement metadata, reap only dead worker leases, and start at most
  one current settlement per task. A later attach directly reattaches to the
  named Sandbox and uses provider-native resume; it does not stop the Sandbox
  as an orphan-recovery preflight.
- Settlement worker crash: leave no successful settlement record. Clear or
  mark the active generation failed only if it is still current.
- User cancellation: record cancellation only for the current run; do not call
  it a failed check and do not publish partial check results.
- Target refresh failure: retain conversation context and the last valid
  candidate, but mark the new run retryable and not ready for promotion.
- Reconciliation conflict: preserve conflicted workspace state and ask the
  durable session for input; do not check an unresolved tree.
- Check failure: publish the complete exact-candidate failure result and allow
  review. Promotion remains blocked unless explicitly skipped.
- Metadata failure: preserve valid candidate/check results. Promotion may use
  its generic message fallback.
- Stale publication: ignore it without overwriting current state or reporting a
  misleading failure.

## Tests

Replace polling-oriented coverage with event and settlement coverage. At a
minimum add the following.

### Provider hooks and conversation

- Codex and Claude hook configuration is installed outside the candidate tree.
- Existing unrelated provider settings are preserved.
- Durable interactive/resumed sessions emit events; ephemeral repair and
  commit-generation sessions do not.
- Provider payloads normalize only stable fields.
- `transcript_path` is ignored even when present.
- malformed, duplicate, oversized, and out-of-order events are handled
  deterministically.
- hook sequence allocation and atomic rename survive concurrent writers.
- conversation high-water and post-promotion checkpoint selection are exact.

### PTY bridge

- a valid frame split across every possible chunk boundary is recognized;
- multiple frames and ordinary output in one chunk are handled;
- valid frames are stripped from viewer output and replay buffers;
- invalid token/version/event IDs remain harmless terminal data;
- incomplete/oversized frames cannot grow memory without bound;
- a wake-up starts ingestion without blocking the PTY event loop.

### Session ownership

- interactive and detached prompted sessions are daemon-owned;
- detached sessions produce lifecycle events with no viewer;
- attach without typing does not cancel settlement;
- the first raw input byte cancels before it is forwarded when necessary;
- daemon/session recovery resumes the native provider conversation;
- `sessionStartedAt` behavior remains intact.

### Settlement

- one `turn_finished` event starts exactly one run;
- duplicate events do not duplicate work;
- a newer turn supersedes an older run;
- different tasks settle concurrently;
- setup completion resumes an eligible deferred run;
- input cancels refresh, reconciliation, checks, and generation;
- input is buffered only during the mutation barrier and then forwarded;
- cancellation kills the exact worker/process group;
- a cancelled or stale worker cannot publish;
- target advance reconciles before capture;
- conflicts stop before checks and preserve the live workspace;
- candidate capture records exact target/tree OIDs;
- checks run in the immutable Sandbox worktree and reject mutation;
- matching checks are reused across conversation-only changes;
- commit metadata is regenerated when conversation high-water changes;
- an overlong first note receives one summarization pass;
- an invalid or still-overlong second note fails metadata generation cleanly;
- successful final publication is guarded by run, conversation, target, and
  candidate identity.

### Commands and state

- plain `list` and `status` start no subprocesses;
- strong commands drain events and join/reuse settlement work;
- `review` can use a captured candidate while checks still run;
- `check` does not duplicate a matching active check;
- `promote` remains self-sufficient and rechecks the target under lock;
- explicit commit messages override generated metadata;
- promotion advances the conversation checkpoint;
- state/projection rendering distinguishes awaiting input, settling, ready,
  check failure, and infrastructure failure;
- only the new manifest/state/protocol versions are accepted.

### Deletion assertions

Add source-level assertions or equivalent review checks proving there is no:

- `/proc` provider activity scan;
- `wchan` inspection;
- CPU tick sampling or `sleep 0.5` activity probe;
- continuous local runtime inventory scheduler;
- `observer.ts` import;
- automatic check/message worker pool;
- provider transcript parsing;
- direct detached provider session outside daemon ownership.

## Documentation updates required with implementation

Update all existing descriptions of the polling architecture in the same
change:

- `README.md`, especially daemon circulation, freshness, review/check/promote,
  and generated commit metadata;
- `docs/architecture/daemon-control-plane.md`;
- `docs/architecture/implementation-plan.md` or replace it with the final
  implemented state-machine document;
- `docs/architecture/task-runtime.md` if its capabilities change;
- CLI help and parsing tests if internal/session behavior changes any visible
  wording;
- GUI/fleet documentation where task phases or projection fields change.

After implementation this brief may remain as the decision record, but the
implemented architecture documents must be authoritative and marked
implemented.

## Implementation sequence

Implement in dependency order without preserving an operational polling path:

1. Define provider-neutral lifecycle events, conversation storage, new state
   identities, and strict schemas.
2. Implement and test Codex/Claude adapters and the durable hook recorder.
3. Implement the PTY control-frame parser and viewerless daemon-owned session
   launch.
4. Add event ingestion, high-water tracking, and event-derived agent state.
5. Build the cancellable settlement worker from the existing reconciliation,
   candidate, check, and commit-generation primitives.
6. Add the per-task settlement/intent coordinator and raw-input cancellation.
7. Route explicit commands through the same settlement passage.
8. Remove observation circulation, activity probes, worker pools, obsolete
   state fields, private CLI entrypoints, and their tests.
9. Update documentation and add deletion assertions.
10. Run the complete verification gates and inspect the final diff for any
    accidental compatibility or fallback path.

The worktree currently contains useful in-progress commit-message changes that
add `{subject, note}` validation, persistence, and the one-pass overlength
summary behavior. Preserve and adapt those pieces. Replace their diff-only
generation input with the exact candidate plus normalized conversation context;
do not discard the work or layer a second generator on top of it.

## Acceptance criteria

The refactor is complete only when all of the following are true:

- A Codex or Claude turn finishing causes eager reconciliation, candidate
  capture, checks, and commit metadata generation without a user command.
- The trigger is a provider lifecycle event, never inferred CPU/terminal
  quiescence.
- The first user input cancels the whole current settlement, with only the
  narrow safety delay required to unwind live-workspace mutation.
- Leaving a task alone normally makes it `ready` before review/check/promote.
- Checks and metadata generation execute in the Sandbox and are supervised as
  one task settlement, not independent daemon pools.
- Host-only Git/authentication and exact promotion boundaries remain intact.
- Commit metadata uses both conversation and exact code, and its cache includes
  conversation high-water.
- Overlong metadata receives exactly one summarization attempt before failure.
- Detached and attached durable sessions are daemon-owned and preserve native
  session continuity.
- Plain recorded-state views remain cheap and subprocess-free.
- Late/cancelled work cannot publish against a newer turn or candidate.
- Codex and Claude are implemented through provider adapters suitable for
  future harnesses.
- No polling fallback, migration, legacy schema reader, or second execution
  architecture remains.
- `npm run check`, `npm test -- --run`, `npm run build`, and
  `git diff --check` all pass.

## External references to verify during implementation

- [Codex hooks](https://developers.openai.com/codex/hooks)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Docker Sandboxes architecture](https://docs.docker.com/ai/sandboxes/architecture/)
- [Docker Sandboxes Git workflows](https://docs.docker.com/ai/sandboxes/workflows/git/)
- [`sbx exec` reference](https://docs.docker.com/reference/cli/sbx/exec/)
- [`sbx run` reference](https://docs.docker.com/reference/cli/sbx/run/)

Re-check these references immediately before changing provider configuration or
Docker lifecycle/signal behavior. In particular, verify hook trust/settings
precedence, Stop continuation semantics, whether hook children can write to the
session TTY, and how cancellation propagates through the current `sbx` CLI.
