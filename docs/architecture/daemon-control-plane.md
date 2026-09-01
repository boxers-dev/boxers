# Daemon control plane

Status: implemented. This document is authoritative for the current control
plane.

The host-local daemon owns durable provider PTYs, provider lifecycle-event
ingestion, one cancellable settlement generation per task, typed task intents,
state revisions, fleet projection, and host-only promotion boundaries. It does
not infer provider activity from terminal output or process behavior.

## Lifecycle transport

Codex and Claude durable sessions install task-local synchronous hooks outside
the candidate tree. A hook first writes a strictly sequenced event below the
Sandbox repository's Git directory, then emits a versioned, token-bound control
frame through the daemon-owned PTY. The streaming parser strips valid private
frames from viewer output and replay. It handles split, combined, invalid, and
oversized frames without treating ordinary terminal data as control traffic.

The frame is only a wake-up. A short-lived ingestion worker reads and validates
the durable event, advances the conversation high-water mark, and records the
provider session/turn identity. Lost wake-ups are recovered at bounded session
boundaries such as start, recovery, attach, or a strong intent. Event files are
never continuously polled and provider transcripts are never parsed.

`UserPromptSubmit` records `working` and cancels settlement. `Stop` records
`awaiting_input` and starts or supersedes the task's settlement generation.
Ordinary PTY output, attach, replay, and resize do not alter turn state.

## Settlement generations

One composite worker owns refresh, reconciliation, exact candidate capture,
isolated checks, and conversation-aware commit metadata for a generation.
Workers for different tasks may run concurrently; a task has at most one
current generation. There are no host-wide check or metadata worker pools.

Progress is recorded as `queued`, `refreshing`, `reconciling`, `capturing`,
`checking`, `generating`, and then `ready`, `cancelled`, or `failed`. Publication
is accepted only for the current run ID and trigger sequence. Candidate check
results remain keyed by target, tree, and check configuration; commit metadata
is keyed by target, tree, and conversation high-water.

The first raw input byte cancels the complete worker process group before the
input is forwarded. Input is buffered only while the narrow live-workspace
mutation barrier unwinds. That barrier publishes matching host and
Sandbox-visible markers with one run ID and clears both in `finally`. Startup
recovery clears a crash-left companion only after proving its host owner dead.

If setup is still running, the generation remains queued. The setup worker
sends one terminal-state event that resumes the same eligible generation; no
setup scheduler or polling loop exists.

## Intents and state

Plain `list` and `status` read only strict versioned state and start no
subprocesses. Strong intents drain lifecycle events and reuse the same
refresh/reconcile/capture/check/metadata primitives. A same-task intent
preempts automatic settlement, runs under the task intent lease, and cannot
race another same-task mutation. Different tasks continue independently.

Task state separates `agentTurnState` from settlement. `needsAttention` is
derived: an awaiting provider or a failure needs attention; a working provider
does not. Fleet snapshot protocol 2 carries this explicit turn state. Exact
candidate and promotion facts remain based on persisted Git OIDs, not display
phases.

## Session and fleet ownership

Interactive and detached prompted sessions are both daemon-owned PTYs. A later
attach adds a viewer to the existing PTY; native Codex/Claude resume behavior
and `sessionStartedAt` remain intact. Viewers are disposable projections with
bounded replay and backpressure, while the durable provider session survives a
CLI or SSH disconnect. The PTY is not expected to survive a daemon restart. A
provider-confirmed `awaiting_input` state is the safe boundary for releasing
it; the next attach asks Docker Sandboxes to reattach directly and supplies the
provider-native resume arguments without first stopping the Sandbox.

Every host remains authoritative for its own projects, credentials, runtimes,
and tasks. Enrolled peers exchange strict snapshots and revisions over SSH.
Cached offline data is labeled stale; strong intents execute only on the task's
originating host. `fleet.json` is the sole remote-membership authority. Peer
projection caches are derived state and are enumerated only through current
fleet membership; there is no parallel machine registry or compatibility
reader.
