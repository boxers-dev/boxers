# Disposable daemon and Sandbox jobs

Status: implemented and verified on 2026-09-02. This document defines the
current architecture and records the work used to replace the former
settlement-heavy control plane.

## Objective

Simplify Boxers around three explicit durability boundaries:

- Docker Sandboxes owns the durable workspace, provider history, and
  task-local job execution artifacts.
- Host disk owns the project/task registry, a fast disposable observation
  cache, exact Git identities, and promotion/delivery records.
- The daemon owns only live PTYs, viewers, event forwarding, and lightweight
  orchestration. Its in-memory state is never required for correctness.

A daemon restart may detach viewers and stop active agents. The next attach
uses provider-native resume. Incomplete recomputable work becomes interrupted
or stale and is rerun; Boxers does not preserve it through a complex daemon
handoff.

## Target ownership

| State                              | Authority           | Host projection             |
| ---------------------------------- | ------------------- | --------------------------- |
| Workspace and provider history     | Sandbox             | None                        |
| Running task-local jobs            | Sandbox job records | Disposable cache            |
| Setup/check/preview results        | Sandbox             | Cached for fast observation |
| Live interactive PTY and viewers   | Daemon              | None                        |
| Project/task registry              | Host                | Authoritative               |
| Target OIDs and reviewed candidate | Host Git/state      | Authoritative               |
| Promotion and delivery             | Host Git/state      | Authoritative               |
| Fleet status                       | Each owning host    | Cached by peers             |

The execution passages are:

```text
interactive agent
viewer -> owning-host daemon -> one PTY -> sbx run
daemon dies -> provider is stopped -> later attach resumes

noninteractive job
daemon -> sbx exec -d -> Sandbox job record
daemon dies -> job is inspected later or marked interrupted/stale

observation
status -> host cache
status --refresh -> inspect Sandbox/Git -> repair host cache
```

## Core invariants

1. Local, system-service, managed-SSH, and lazy-start entry points resolve one
   canonical per-user daemon state root and socket.
2. A provider process cannot outlive the daemon PTY that owns it. Graceful
   shutdown stops it; startup recovers hard-crash orphans before accepting an
   attach.
3. Daemon memory is disposable. A missing queue, PTY map, replay buffer, or
   active worker never prevents status refresh, attach, or safe recomputation.
4. Checks are read-only pass/fail observations. Formatting and other mutations
   are not checks.
5. A successful check is reusable only for the exact tuple
   `(targetOid, workspaceTreeOid, checkConfigHash)`.
6. New provider input, a changed workspace tree, an advanced target, or changed
   check configuration invalidates an older check.
7. Review and promotion capture and verify exact Git identities on the host.
   Sandbox job output alone never advances a host branch.
8. There is one runtime architecture. The old settlement/check-worktree path is
   deleted rather than retained as a mode or fallback.

## Phase 1: canonical daemon and disposable sessions

1. Resolve and persist one canonical `BOXERS_HOME` per user/host.
2. Explicitly provide that path to systemd/launchd, forced SSH gateway
   commands, managed update workers, and lazy daemon startup.
3. Keep one socket, PID file, health file, and lock below that root.
4. Replace update handoff/restart-boundary coordination with bounded daemon
   replacement.
5. During graceful shutdown:
   - stop accepting requests;
   - detach viewers;
   - terminate every daemon-owned PTY process group;
   - stop the Sandboxes that owned interactive provider sessions when required
     to guarantee provider termination;
   - wait for termination, then exit.
6. During startup:
   - inventory tasks and Sandboxes;
   - recover tasks whose persisted lifecycle says a provider may still be
     active but which have no current daemon PTY;
   - stop any orphaned provider runtime before accepting attach;
   - record the provider observation as interrupted/exited;
   - allow the next attach to use provider-native resume.
7. Verify current `sbx run`, disconnect, stop, and process-lifetime behavior
   against the current official Docker Sandboxes documentation and integration
   tests before choosing the exact termination primitive.

Completion criteria:

- Local and remote viewers converge on the same owning-host daemon.
- Replacing the daemon during a live Codex session cannot leave an active
  thread writer.
- No safe-boundary or handoff worker is required to install a new daemon.

## Phase 2: Sandbox job protocol

Use a Sandbox-level directory independent of any Git worktree:

```text
$HOME/.boxers/jobs/<task-id>/<job-id>/
  request.json
  status.json
  stdout.log
  stderr.log
  pid
  result.json
```

`request.json` records at least:

```json
{
  "version": 1,
  "jobId": "...",
  "taskId": "...",
  "kind": "setup|check|preview-action",
  "conversationSequence": 42,
  "targetOid": "...",
  "workspaceTreeOid": "...",
  "configHash": "...",
  "createdAt": "..."
}
```

The job wrapper atomically transitions through `queued`, `running`, and one of
`passed`, `failed`, `timed_out`, `stale`, or `interrupted`. It owns the process
group, retains identical stdout/stderr bytes, records the exit status, and
publishes `result.json` atomically.

Jobs are idempotent by their semantic identity. Re-submitting an identical
successful job reuses it; stale or interrupted jobs may be replaced.

Determine and document the trust boundary for job results. Prefer a
supervisor-owned location or permissions the agent cannot modify. If Docker
Sandboxes cannot provide that boundary, a job record is operational evidence,
not an authoritative promotion certificate: uncertain/crash-observed checks
must rerun before promotion.

## Phase 3: setup and preview jobs

1. Replace the detached host `__setup-worker` with a detached Sandbox job.
2. Keep setup status and logs in the Sandbox job directory.
3. Cache the latest observed setup outcome on the host.
4. Start preview after successful setup as a Sandbox-managed process.
5. Keep preview PID, status, and logs in Sandbox operational state.
6. Refresh verifies the preview process instead of trusting cached status.
7. A changed setup configuration invalidates a previous setup result.
8. An incomplete setup after runtime restart is interrupted and retryable.

Remove the duplicate host setup-worker PID as an authority.

## Phase 4: live-workspace checks

The automatic stop-hook passage becomes:

1. Accept `turn_finished` at conversation sequence `N`.
2. Confirm setup passed for the current setup configuration.
3. Refresh the host target and reconcile if it advanced.
4. Compute live workspace tree OID `H` using an isolated Git index that
   includes tracked and untracked task content without modifying the index.
5. Compute check configuration hash `C`.
6. Reuse a successful result only for `(targetOid, H, C)`.
7. Otherwise submit a check job against the live task workspace.
8. After the commands finish, recompute the workspace tree.
9. Certify success only when:
   - every configured check passed;
   - the final workspace tree is still `H`;
   - the target and check configuration are unchanged;
   - the conversation sequence is still `N`.

New input invalidates the run immediately by identity. Cancellation may be used
to save resources, but correctness cannot depend on successful cancellation.

If a check modifies tracked task content, fail it with a configuration error:

> Check command modified tracked content. Checks must be read-only; use a
> separate formatting or fix operation.

Remove the persistent isolated check worktree, candidate patch round-trip,
check-worktree setup marker, and pre-check host candidate capture. Candidate
capture remains part of review and promotion only.

## Phase 5: event-triggered orchestration without settlement recovery

Replace the composite recoverable settlement state machine with an idempotent
handler for each accepted `turn_finished` identity:

1. refresh target;
2. reconcile if necessary;
3. compute current workspace identity;
4. submit or reuse checks;
5. update the host observation cache.

If interrupted, leave the observation stale. The next lifecycle event,
explicit command, or `status --refresh` recomputes it.

Delete:

- settlement run IDs, phases, and active-run maps;
- settlement publication guards;
- cancellation/restart recovery whose only purpose is preserving settlement;
- check-progress recovery;
- mutation barriers used only by the composite settlement passage;
- automatic commit-message generation before review or promotion.

Retain only narrow exclusion around operations that can corrupt Git state,
especially reconciliation and promotion.

## Phase 6: explicitly cached host observation

`boxers list` and ordinary `boxers <task> status` read host state only. Every
observation carries `observedAt` and `source` metadata.

`boxers <task> status --refresh` performs the slower convergence passage:

1. inspect runtime state;
2. inspect Sandbox jobs;
3. drain provider lifecycle records;
4. inspect workspace Git state;
5. reconcile the host cache;
6. mark dead or incomplete work interrupted;
7. never infer a live PTY from historical state.

Fleet views continue to consume owning-host projections and expose observation
age/staleness without probing every Sandbox.

## Phase 7: host-owned review and promotion

Review:

1. require a stable provider observation;
2. compute the current Sandbox workspace tree;
3. capture that exact candidate in the sanitized host seed;
4. record `targetOid` and `candidateTreeOid`;
5. display the captured candidate without running checks.

Promotion:

1. refresh and capture the current candidate;
2. require a successful check matching current target, candidate tree, and
   check configuration;
3. rerun checks when no exact valid result exists;
4. preserve existing expected-HEAD, clean-worktree, lease, and fast-forward
   constraints;
5. advance host Git using host credentials only.

Commit-message generation moves to review/promotion demand and is cached only
for the exact target/tree/conversation identity.

## Phase 8: delete obsolete control-plane machinery

Delete rather than deprecate:

- update handoff worker and handoff state;
- restart-boundary classification;
- daemon-owned settlement recovery;
- isolated check worktrees;
- host background setup workers;
- long-lived intent queues where rerunning is safe;
- duplicate setup/check authorities;
- automatic check-time candidate capture;
- in-memory facts used as correctness evidence.

Keep:

- PTY multiplexing with bounded replay and backpressure;
- provider-native resume arguments and `sessionStartedAt`;
- provider lifecycle recording and ingestion;
- host project/task registry;
- host Git promotion locks and exact OID verification;
- remote fleet projection;
- explicit refresh and reconciliation.

## Implementation order

Implement in reviewable slices, but never ship two selectable architectures:

1. daemon identity, shutdown, orphan recovery, and update replacement;
2. Sandbox job schema and runtime adapter;
3. setup/preview conversion;
4. live-workspace check execution and invalidation;
5. stop-hook orchestration simplification;
6. cached status refresh/convergence;
7. review/promotion recoupling;
8. source deletion, documentation, and final schema cleanup.

Each slice must leave the single active path coherent. Temporary compatibility
code may exist only within an unmerged implementation slice and is removed
before that slice is considered complete.

## Verification matrix

Required integration coverage:

- local and managed-SSH attach use the same owning-host daemon;
- daemon restart with a live agent releases the Codex/Claude provider writer;
- the next attach resumes the provider-native session;
- no provider remains active without a daemon PTY or explicit orphan cleanup;
- setup/check jobs are inspectable after daemon restart;
- new input makes an older check stale;
- workspace mutation during a check prevents certification;
- a check that modifies tracked files fails as misconfigured;
- target advancement invalidates old checks;
- check configuration changes invalidate old checks;
- ordinary status performs no `sbx` call;
- refresh reconstructs missing or damaged host cache;
- promotion refuses stale, uncertain, or non-matching checks;
- interruption during reconciliation converges safely on refresh;
- interruption during promotion never advances an unexpected host ref;
- setup and check output is streamed when observed and retained byte-for-byte;
- check, build, formatting, and the complete Vitest suite pass.

The release gates are:

```text
npm run check
npm test -- --run
npm run build
git diff --check
```

Implementation verification completed with 44 Vitest files / 295 tests. All
four release gates above pass. The focused coverage includes canonical daemon
roots for services and managed SSH, provider shutdown and orphan recovery,
durable detached job inspection/cancellation/timeouts/logs, setup identity and
retry, live-workspace check invalidation, exact promotion, cache-only list and
status projection, preview lifecycle, and disposable same-task orchestration.

## Documentation contract

After implementation, replace the current settlement/control-plane documents
with this durability promise:

> Sandboxes, workspaces, provider histories, and completed Sandbox jobs are
> durable. Interactive PTYs and in-flight host orchestration are disposable.
> A daemon restart may pause work; the next attach or refresh resumes or
> recomputes it safely.
