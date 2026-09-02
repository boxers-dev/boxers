# Event-driven task state machine

Status: implemented. This is the authoritative implemented state machine; the
detailed decision record is
[`event-driven-settlement-refactor.md`](event-driven-settlement-refactor.md).

## Durable contracts

Boxers has one Sandbox-native task architecture, task manifest version 3,
task state version 3, daemon protocol version 5, and fleet snapshot protocol
version 2. Readers accept only these schemas; there is no migration or fallback
execution path.

The durable task facts are:

| Fact                 | Authority                                                  |
| -------------------- | ---------------------------------------------------------- |
| `agentTurnState`     | Accepted `UserPromptSubmit`, `Stop`, or session exit event |
| `settlement`         | The daemon's current task generation                       |
| `hasUnmergedChanges` | Exact captured base and candidate tree comparison          |
| `setup`              | Task setup worker                                          |
| `check`              | Exact target/tree/config check result                      |
| `commitMessage`      | Exact target/tree/conversation-high-water generation       |
| `failure`            | Current infrastructure or reconciliation failure           |

`TaskView` is the authoritative public observation contract. It independently
projects agent activity, Boxers operations, setup, reconciliation, changes,
checks, delivery, removal safety, structured issues, and ordered actions from
durable facts. There is no public `needsAttention` Boolean or authoritative
flattened phase. Status, list, JSON, and fleet snapshots render the same view
without probing Docker or Git; internal phases remain diagnostics for control
plane orchestration only.

## Event passage

1. A provider hook durably records a normalized prompt or turn-finished event.
2. Its private PTY frame wakes the daemon, which asynchronously drains the
   strictly sequenced event log.
3. A prompt marks the provider working and cancels the current generation.
4. A turn-finished event marks it awaiting input and starts one generation.
5. The worker validates the generation, refreshes the host target, reconciles
   under the mutation barrier if needed, and captures the exact candidate.
6. It prepares the immutable Sandbox check worktree, runs setup/check commands,
   and generates commit metadata from a structured exact-diff plus normalized
   conversation envelope.
7. Current-identity guards publish completion. Cancelled, stale, or late work
   cannot overwrite the new generation.

Check failure is a completed candidate result. Reconciliation conflict stops
before checks and leaves the live workspace for the durable agent. Metadata
failure preserves candidate/check results and promotion retains its generic
fallback.

## Command passage

Typed daemon intents serialize per task. `status --refresh`, `sync`, `review`,
`check`, and `promote` first drain lifecycle events and use the shared strong
capture passage. Review returns after capture. Check reuses or runs the shared
exact-candidate check stage. Promote completes missing work and rechecks the
canonical target under the project lock. Preview is serialized but does not
imply freshness. Stop and discard cancel settlement before resource changes.

Raw input is the earliest cancellation boundary. The settlement worker and its
exact process group receive TERM and then bounded KILL if necessary. The input
is forwarded immediately unless live-workspace mutation is unwinding.

## Candidate and promotion

The live workspace is captured with an isolated Git index into a tree OID and
synthetic review commit. Checks reset a detached worktree to that immutable
candidate, verify its tree before and after commands, and reject mutation.

Promotion stays host-owned. Local promotion requires the configured branch,
expected HEAD, and a clean worktree. Remote delivery is fast-forward/lease
guarded and uses host credentials. A successful promotion advances the
conversation checkpoint so later metadata excludes already-promoted context.

## Verification

The repository includes provider normalization, hook concurrency, PTY parser,
conversation selection, settlement coalescing/cancellation, daemon lifecycle
integration, process-group cancellation, mutation-marker, strict schema, and
source-deletion tests. Release gates are `npm run check`, `npm test -- --run`,
`npm run build`, and `git diff --check`.
