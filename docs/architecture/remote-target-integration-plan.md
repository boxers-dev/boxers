# Remote target integration implementation plan

Status: proposed, not implemented. Written on 2026-09-08.

This plan records the agreed Git integration design and the work needed to
implement it. It does not describe current behavior. Existing architecture
documentation remains the description of the running implementation until the
corresponding changes land.

Compatibility constraint: this product is not currently in use. Backward
compatibility, migration support, old-schema readers, deprecated command aliases,
and mixed-version fleet operation are not requirements. Change the configuration,
state, protocol, and tests directly to the new contract. Development registrations
and fixtures can be recreated; this plan does not authorize deleting existing
workspaces or other user data automatically.

## Objective and agreed decisions

Simplify Boxers around one configured remote target branch per project. Each
task has a private Sandbox workspace and a reusable provider conversation. Each
successful promotion delivers the current increment as one commit directly to
the target, then advances the originating workspace to that accepted commit.

Tasks remain usable after promotion. For example, an agent can implement a
feature, promote it, and later use the same conversation to fix a problem found
while testing the result elsewhere. The follow-up promotion is another commit
containing only the new increment.

The agreed contract is:

- All tasks in a project integrate against the same remote branch, whether that
  is `main` or another explicitly configured branch.
- Remove local promotion, persistent remote delivery branches, PR-branch reuse,
  and force-push replacement logic. Host Git owns upstream authentication,
  delivery-commit creation, and the push.
- Keep the existing Sandbox-native architecture and sanitized seed. The real
  host checkout's working files, Git configuration, hooks, and credentials must
  not be copied into task workspaces.
- A task's deliverable is its current file tree relative to its installed base.
  Agent-created commits and staging choices do not define delivery history.
  Internal checkpoint commits are permitted and are not published as task
  history.
- Reconcile automatically after agent turns and on project target-change events,
  with command-triggered preparation as needed. New ordinary turns do not require
  a fresh fetch or reconciliation; strict pre-turn freshness is deferred.
  Conflicts should trigger bounded
  repair in a fresh, non-persistent provider session with explicit task intent
  and relevant context. Keep the original task conversation available for normal
  work; generating in the main session and repair must never overlap.
- Review should present the increment against the latest observed target.
  Status should report target freshness and preparation progress accurately.
- A successful promotion, or any fetch that discovers a changed target, should
  notify other tasks in that project that reconciliation may be required.
- A task is durable across interruptions but intended for reasonably recent,
  active work. Expensive or ambiguous recovery may stop with a clear
  discard/restart option. There is no automatic expiry or deletion.
- Promotion does not complete, close, or discard the task. A subsequent turn
  starts another increment on its updated base.
- Never silently lose work, force a target update, duplicate an accepted
  promotion on retry, or claim a stale candidate has current passing checks.

Direct pushes require a target branch whose repository policy permits them.
Branches that require PRs are outside this initial delivery model; do not add a
fallback PR route.

## Current implementation and changes to preserve

The current system already has the major building blocks:

| Current component                                       | Keep or change                                                                                           |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Sanitized seed and Sandbox clone                        | Keep; verify the seed-to-Sandbox fetch contract with current Docker documentation and a live smoke test. |
| Host-side candidate materialization and commit creation | Keep the boundary; unify candidate identity and remove alternative delivery paths.                       |
| `UserPromptSubmit` and `Stop` recorders                 | Keep as lightweight event recorders and daemon notifications.                                            |
| Daemon-owned PTYs and host workers                      | Keep; improve task-operation coordination and cancellation boundaries.                                   |
| Post-turn refresh, capture, checks, and commit metadata | Reuse through a shared preparation operation.                                                            |
| Fresh provider session for conflict repair              | Keep the existing bounded execution path; improve context and exclusive workspace ownership.             |
| Explicit intents aborting post-turn work                | Join compatible preparation instead of routinely canceling it.                                           |
| Matching Git/check identities                           | Keep and make consistent across every caller.                                                            |
| Mixed reset after delivery preserving newer files       | Preserve that safety property while verifying clean advancement.                                         |
| Local promotion and remote PR branches                  | Remove.                                                                                                  |

The assessment found two concrete defects to cover during implementation:

1. An interruption immediately after the reconciliation hard reset can be
   followed by a retry that replaces both checkpoint refs and reports a clean
   result without the original task work.
2. A force-staged ignored file can be present in the review candidate but absent
   from the tree used to validate checks.

The existing promotion tests use real temporary Git repositories behind a fake
`sbx`. They are useful for Git correctness but do not prove Docker clone behavior
or provider-native session continuity.

## Ownership and minimal persisted state

| Responsibility                                                                   | Owner                                                |
| -------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Workspace, provider history, setup/check/preview execution                       | Sandbox                                              |
| Prompt and turn-finished event recording                                         | Sandbox hooks                                        |
| PTYs, viewers, input gating, scheduling, and joining task operations             | Host daemon                                          |
| Fetch, reconciliation orchestration, certification, and promotion                | Host workers scheduled by the daemon                 |
| Git workspace mutation and agent repair                                          | Inside the Sandbox, coordinated by the owning daemon |
| Registry, exact Git identities, checkpoints, delivery attempts, and observations | Host storage and application-owned Git refs          |

Use four distinct identities. Do not overload the installed base with a newer
target merely because a fetch succeeded.

| Identity                | Required meaning                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Observed project target | Configured remote/ref, last fetched OID, observation time, and current fetch failure if any.                                                |
| Installed task base     | Commit actually underneath the current task increment.                                                                                      |
| Candidate identity      | Installed base OID and exact candidate tree OID. Checks additionally bind to check configuration and the relevant conversation observation. |
| Delivery identity       | Attempted/accepted commit OID, parent/base OID, candidate tree OID, destination, and delivery outcome.                                      |

Use unambiguous names such as `observedTargetOid` for the project observation and
`installedBaseOid` for the task baseline. Update the stored state, task snapshots,
and their consumers together; no old field aliases or conversion layer are
needed. Publish the installed baseline through one helper so host representations
cannot drift. Reuse the existing storage architecture rather than redesigning it
as part of these schema changes.

Add only the durable information required at irreversible boundaries:

- A reconciliation checkpoint identifying the operation, original base, intended
  target, checkpoint ref/OID, and enough progress information to detect an
  interrupted workspace replacement.
- A delivery attempt recorded before pushing, so a lost response can be
  resolved without creating another delivery commit.
- A bounded repair-attempt identity/outcome, so repeated status requests or
  daemon restarts cannot reset an exhausted automatic repair budget.

Daemon queues and waiter lists remain disposable. Do not introduce a general
durable workflow engine, persistent execution DAG, or legacy recovery route.

## Shared preparation and event behavior

Preparation has reusable stages:

```text
fetch/observe target
    -> acquire a safe workspace boundary
    -> capture increment against installed base
    -> reconcile onto observed target
    -> repair in a fresh, bounded session when necessary
    -> capture resulting candidate
    -> run/reuse requested checks
    -> prepare matching commit metadata when requested
```

Callers request the stages they need. Review requires reconciliation and capture;
it does not start the configured check suite merely to display a diff. Normal
post-turn preparation may independently run those checks. Check and promotion
require validation; promotion alone adds remote delivery.

Freshness and mutual exclusion are separate requirements. A new prompt does not
start or wait for a fresh-target check merely because the task may be behind.
If no workspace mutation owns the task, the main agent can work on its installed
base and reconcile after its turn. If reconciliation or repair already owns the
workspace, input waits until that operation reaches a safe release point. This
uses task-operation coordination, not a new provider-specific pre-submit hook.

| Trigger                           | Intended behavior                                                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task creation                     | Fetch the target and create the workspace at that exact commit.                                                                                                     |
| New ordinary agent turn           | Start from the installed base without a mandatory fetch/reconciliation. Wait only if a workspace mutation or repair already owns the task.                          |
| Ordinary provider `Stop` event    | Schedule preparation, including automatic reconciliation, checks, and candidate metadata as configured. Never push automatically.                                   |
| Repair subprocess finishes        | Continue the owning preparation operation using its captured result; do not treat it as an ordinary task Stop event.                                                |
| `sync`                            | Join/request reconciliation and capture, waiting for required repair.                                                                                               |
| Task `status`                     | Perform a bounded host target refresh, report actual freshness/activity, and schedule needed preparation without waiting for a lengthy repair.                      |
| `review`                          | Join/request a reconciled candidate and display its exact diff.                                                                                                     |
| `check`                           | Join/request the current candidate's validation.                                                                                                                    |
| `promote`                         | Join/request preparation and required checks, then execute the guarded delivery passage.                                                                            |
| Setup completion observed by host | Resume preparation that was deferred for setup.                                                                                                                     |
| Project target-change event       | Schedule idle tasks, mark working tasks pending for post-turn preparation, and leave stopped tasks pending until a later post-turn or explicit preparation request. |
| Provider process exits            | Preserve recorded work, release execution ownership safely, and report the session state. Process exit is not equivalent to a successful turn finish.               |

Keep aggregate `list`, machine views, and fleet projections cheap and cached,
with freshness information. Task `status` observes the remote target by default;
remove its redundant `--refresh` flag rather than keeping a compatibility alias.
This change is scoped to task status: other commands' refresh controls have their
own semantics and need not be removed. Update help, routing, and JSON expectations
together.

A fetch failure must not be reported as current. Display the last known target
with an unknown/stale freshness indication. Review/promotion requiring a fresh
target cannot silently proceed on that cached observation.

### Project target-change event

Use one semantic event, tentatively named `project_target_changed`, containing
the project/target identity, observed OID, observation ordering information, and
source (`fetch` or `promotion`). This is a host-daemon event, not another Sandbox
hook.

Publish it when:

1. A push is confirmed accepted into the configured target.
2. Any authoritative fetch discovers a target OID different from the project's
   current observation. This includes fetches made during another task's
   reconciliation, status refresh, or preparation.

Do not broadcast solely because a reconciliation succeeded. Reconciliation
changes a workspace, not the remote target. If A and B both reconcile onto C,
B's completion must not trigger A again.

On receipt:

- Skip tasks whose installed base already matches the observed target.
- Join existing preparation for a task rather than start another worker.
- If the target changes during preparation, record the newest pending target
  and reconsider at the next safe stage boundary.
- Queue idle tasks; defer working tasks until their turn finishes; keep stopped
  Sandboxes stopped and retain pending target information. Resuming does not
  force a refresh before user input; a later post-turn or explicit preparation
  request handles that pending target.
- Do not restart an exhausted repair merely because the same target is observed
  again. A newer target also must not enable an unlimited repair loop.
- Coalesce notifications and preserve authoritative observation ordering; Git
  OIDs are identities, not values that can be sorted for recency.
- Treat a potentially delayed promotion notification as a reason to refresh
  when a newer target observation may already exist, rather than overwriting
  that observation with an older accepted commit.

Initially implement fan-out within the owning host. Other hosts stay correct by
fetching at their own post-turn and command-preparation boundaries. Existing fleet notifications may
carry an invalidation hint for the same canonical remote/ref, but must not become
a distributed lock or be trusted as authoritative replacement for a host fetch.

## Delivery and reusable tasks

For installed base B and candidate tree T, promotion prepares a commit P whose
tree is T and sole parent is the freshly verified target B.

```text
remote B -> host creates P(B, T) -> non-forced push -> accepted P
                                                   -> task base becomes P
                                                   -> notify sibling tasks
                                                   -> same session can continue
```

If the remote advances before the push, normal non-fast-forward rejection ends
the attempt without modifying the target. A later preparation reconciles again.
Avoid an unlimited prepare/check/push retry loop.

After acceptance:

- Record delivery independently of whether advancing the originating Sandbox
  succeeds. Never describe an accepted push as an unaccepted promotion just
  because local follow-up failed.
- Advance the task to P and clear the delivered candidate, old checks, and
  candidate metadata. Preserve the provider session and conversation.
- Update the conversation checkpoint used to describe subsequent increments.
- Verify clean state. If files changed after capture, preserve and report the
  residual increment instead of resetting it away.
- Keep discard safety based on current unpromoted work, not on whether the task
  has a past delivery.
- If another remote commit has already followed P, mark the task pending for
  that newer target. Acceptance does not imply perpetual freshness.

On a retry after an uncertain push outcome, fetch and inspect whether the
recorded attempted commit is the target or an ancestor of it. If so, record the
original acceptance and finish workspace advancement; do not generate another
commit. If the result cannot be established, preserve the attempt and report
the uncertainty rather than guessing from the push exit code alone.

## Implementation sequence

The numbered changes are intended as reviewable increments, not new runtime
modes. Reuse the existing fresh-repair and post-turn mechanisms, then land one
coherent execution path. Implement the new schemas and consumers together, with direct
push enabled only once its delivery safeguards are in place. There is no staged
migration or requirement to operate old and new implementations simultaneously.

### Preliminary implementation checks: repair isolation and seed access

Inspect current official Docker Sandboxes documentation/CLI reference and current
provider-native interfaces before changing launch, resume, or lifecycle behavior.
Record the tested versions and concrete behavior with the implementation.

Verify for both Codex and Claude:

- Reuse the existing fresh repair commands for both providers. Verify that their
  sessions are non-persistent and do not change which conversation normal task
  attach/resume selects.
- Exactly one agent generates against the workspace at a time. The main provider
  may remain alive and awaiting input while the repair subprocess runs, but new
  user prompts must be held until repair finishes or is confirmed terminated.
- Acquire that ownership atomically with the agent-state check. Checking that the
  main agent is idle and then launching repair without excluding new input is
  insufficient.
- Repair completion is observed by its owning worker through the subprocess
  result. Do not install the main task's lifecycle bridge for the repair session;
  verify that inherited hooks cannot cancel or recursively start preparation.
- Ordinary input proceeds without fetching or reconciling when no workspace
  mutation owns the task. Input waits while an active mutation or repair owns it;
  once ownership is released, the user turn can proceed without starting another
  mandatory freshness operation.
- The seed remains reachable from the clone without exposing the real host
  repository's remotes or credentials. The Sandbox's seed-fetch remote is not
  the host's authenticated upstream `origin`.

Continuing the original conversation for repair is not required. The existing
fresh-session path avoids a new internal-turn protocol for a live conversation.
Strict pre-turn freshness is out of scope for this implementation. These checks
verify existing runtime boundaries during implementation; they are not an
open-ended investigation into new provider input-control mechanisms.

### Change 1: single-target configuration and precise identities

Primary files: `src/v2/types.ts`, `config.ts`, `init.ts`, `registry.ts`, `state.ts`,
`paths.ts`, `src/cli.ts`, and projection/validation consumers.

1. Replace integration-mode branching with remote plus target branch. Remove the
   mode field and `--integration` option outright. `remote` and `base` remain
   reasonable configuration names because they describe the new destination,
   not because their old spelling must be supported.
2. Add separate project target observations and centralized installed-base
   publication. Define candidate/check/delivery tuple semantics.
3. Define the minimal checkpoint, repair-attempt, and delivery-attempt records;
   use restricted atomic writes and centralized ref/path construction.
4. Update strict validators and fleet projections that currently expose
   `IntegrationMode` or assume the previous state shapes.
5. Change configuration, state, and protocol schemas directly and update their
   fixtures. Keep ordinary input validation; do not add converters, dual-version
   readers, or a schema-version bump solely to support a migration passage.
6. Remove compatibility code for local/PR delivery. Recreate development
   registrations when needed; supporting inspection or execution of old records
   is not a requirement. Existing data is not automatically deleted by this
   documentation or by a compatibility cleanup routine.

Acceptance: one configured delivery destination, precise base/target identities,
and current schemas and consumers that agree without compatibility machinery.

### Change 2: canonical capture and safe reconciliation

Primary files: `src/v2/sandbox.ts`, `registry.ts`, `commands.ts`, `lock.ts`, and
existing runtime adapters. Extract focused reusable Git helpers if needed;
keep lifecycle orchestration in `commands.ts`.

1. Use one canonical tree-capture helper for review, reconciliation, and check
   verification. Capture current bytes without modifying the agent's real index.
   Include tracked files, non-ignored new files, and explicitly index-added new
   files, including force-added ignored files. Staging does not select an older
   version of a file's contents.
2. Export that exact tree to the host using the existing credential-free
   transport boundary. If retaining binary patches, derive them from the
   canonical tree and verify that host materialization yields the same tree OID.
   Disable presentation-only diff transforms for machine capture.
3. Reject unresolved index conflicts before ordinary capture. Explicitly detect
   unsupported Git layouts/history states before replacing files.
4. Serialize shared seed fetch/checkout/ref mutations across project tasks. Keep
   locks narrow and never hold a project Git lock during agent repair or checks.
5. Capture against the installed base before installing a newer target. Persist
   an operation-specific checkpoint before any hard reset or cleanup.
6. Use Git three-way integration with the original base. On conflicts retain
   the original checkpoint and the index stages needed for repair.
7. Establish a consistent installed-base update point and safe cancellation
   boundary. Do not let ordinary new input kill the reset/apply passage halfway
   through. On crash, detect unfinished replacement before any new capture.
8. Keep recovery bounded: finish a clearly identifiable operation or report
   recovery/restart required with the checkpoint preserved. Never replace the
   only checkpoint during an uncertain retry.

Acceptance: equivalent capture everywhere; committed, staged, unstaged, binary,
deleted, and new content survives clean reconciliation; interruption cannot
silently erase the increment.

### Change 3: fresh-session repair context, ownership, and validation

Primary files: `src/v2/session.ts`, provider adapters, `daemon.ts`,
`daemon-protocol.ts`, lifecycle ingestion, and preparation orchestration.

1. Keep `runRepairAgent` and its fresh, bounded provider invocation. Preserve
   trust/access arguments. Do not resume, replace, or append the repair run to the
   original task conversation; preserve `sessionStartedAt` and normal resume
   behavior.
2. Give one operation exclusive workspace ownership during reconciliation and
   repair, while keeping status and observation available. Start only when the
   main agent is not generating, and queue new prompts until repair finishes.
   If repair is canceled, confirm it has stopped before releasing that ownership;
   host worker exit alone must not be treated as proof of Sandbox termination.
3. Supply a self-contained repair request: task goal, relevant recent user
   instructions/recorded context, the captured increment, old/new base identities,
   upstream change evidence, and conflict paths/stages. Reuse existing bounded
   conversation-record reads. A fresh session cannot infer omitted intent from
   the original conversation. If available context cannot disambiguate the goal,
   stop clearly rather than inventing it. Ask the agent to adapt the increment,
   not merely clear conflict markers; do not ask it to commit or push.
4. Use the repair subprocess result to continue the owning preparation. Keep its
   lifecycle separate from the main task's prompt/Stop stream. Persist a repair
   report describing the target update, resolution, and any remaining issues so
   the user and original agent can inspect what changed.
5. Verify the installed base and conflict state, recapture the result, and
   invalidate old checks/messages. When validation is requested, certify only
   the resulting tree and configuration with a causally current observation.
6. Initial bound: one repair turn and, when requested checks expose
   a repair problem, one corrective turn. Retain a bounded timeout. Reuse the
   outcome for repeated requests; require explicit continuation after exhaustion.
7. Give ambiguous intent, unresolved conflicts, and failed validation distinct
   actionable outcomes. Discard/restart remains an ordinary escape hatch.

Acceptance: fresh repair has sufficient task context, cannot overlap main-agent
work or recurse indefinitely, preserves normal task resume, and cannot produce
a passing certificate for stale content.

### Change 4: shared preparation, freshness, and target-change fan-out

Primary files: `src/v2/daemon.ts`, `daemon-worker.ts`, `commands.ts`,
`daemon-protocol.ts`, `daemon-client.ts`, `setup.ts`, task views, and CLI routing.

1. Route post-turn events and explicit intents through one task preparation
   operation with stage-specific waiters. Compatible requests join existing
   work. Serialize incompatible workspace actions with explicit outcomes.
2. Keep target fetch/status observation available while preparation owns the
   workspace. Do not make a status request wait behind a ten-minute repair.
3. Reuse input coordination to exclude new generation only while a workspace
   mutation or repair owns the task. Do not add a fetch/reconciliation gate to
   each new prompt or resume. Distinguish safe cancellation of obsolete
   checks/metadata from interruption of a workspace mutation.
4. Implement the project target-change event and coalescing rules above. Publish
   changes at the common authoritative-fetch boundary, so every discovery path
   can notify sibling tasks.
5. Remember newer pending targets during a turn or preparation. Before issuing
   a ready/current result, compare with the latest project observation.
6. Coordinate setup: wait for existing setup before workspace replacement, run
   new target setup against the installed new workspace, and settle/recapture
   setup-related file changes before candidate certification. Respect the
   existing prohibition on concurrent dependency installation.
7. Account for Boxers-owned preview/check jobs that may still write. Treat
   observed background edits as invalidating the candidate rather than as a
   reason to delete those edits.
8. On daemon restart derive pending work from durable identities and unfinished
   boundary records. Do not require replaying an in-memory queue or waking all
   stopped Sandboxes.

Acceptance: automatic and explicit entry points cooperate, target changes
propagate without loops, status remains truthful/responsive, and active agent
work is not modified underneath it.

### Change 5: direct single-commit promotion and continued use

Primary files: `src/v2/commands.ts`, state/registry helpers, and promotion tests.

1. Delete local branch/worktree advancement, delivery-branch naming and reuse,
   patch-equivalence replacement, and force-with-lease pushes.
2. Join preparation and required checks. Preserve the existing explicit
   `--skip-checks` behavior unless separately changed; it does not bypass target
   or workspace identity verification.
3. Own the task's promotion passage, revalidate the candidate and remote target,
   and create a commit with the candidate tree and one parent: that target.
4. Persist its delivery attempt before a non-forced push to the configured
   target. Resolve races or unknown push outcomes as described above.
5. Once acceptance is known, record it and publish the target-change event even
   if subsequent originating-workspace advancement fails.
6. Advance the originating task base without deleting post-capture edits.
   Clear delivered candidate/check/message state and update the conversation
   checkpoint. Retain the same session and permit subsequent turns/promotions.
7. Handle an empty increment without creating an empty commit. Report when
   upstream already contains the work and leave the reusable task current.
8. Keep the real host checkout's branch, index, and worktree untouched. Host Git
   may read identity/remote configuration but delivery operates from
   application-owned storage.

Acceptance: one accepted commit per promotion, repeated promotions from the same
task contain only subsequent work, no force updates, and no duplicate delivery
after a lost push response.

### Change 6: remove obsolete code, document, and verify

Primary files: `README.md`, `AGENTS.md`, `src/cli.ts`, architecture documents,
strict state/fleet projections, and affected tests.

1. Update help, config examples, JSON views, status wording, and task actions to
   reflect remote-only direct delivery, reusable tasks, and event-driven
   reconciliation.
2. Remove obsolete config examples, flags, compatibility readers, and
   local/PR-delivery documentation. Document the direct-push branch-policy
   requirement. No migration guide or compatibility implementation is needed.
3. Update `daemon-control-plane.md`: its current claim that interrupted
   orchestration is simply recomputed needs the narrow exceptions for workspace
   replacement and uncertain push outcomes.
4. Keep fleet/project source matching tied to the canonical repository and
   target ref. Update fleet message/projection consumers and fixtures together.
   Test with all development hosts on the same new build; mixed-version
   operation and rolling-upgrade compatibility are out of scope.
5. Replace tests that assume local integration or repeated delivery-branch PRs.
   Keep coverage for session continuity, exact candidates, checks, and safe
   discard after promotion and after subsequent edits.
6. Run focused tests during each change, then `npm run check`, the full test
   suite, and a build before release. Respect `.git/boxers/setup-status` before
   running tests; do not launch concurrent dependency installation.
7. Perform a live Docker smoke test with both supported providers. Confirm
   clone/seed access, isolated fresh-session repair, turn events, direct promotion,
   and continuing in the same task after delivery.

Acceptance: the documented contract and all entry points agree, including
installed executable behavior and fleet projections.

## Required verification scenarios

Use real temporary repositories and a local bare remote for Git behavior,
simulated runtime calls for deterministic daemon tests, and limited live tests
for provider/runtime integration. Add meaningful failure injection at mutation
and delivery boundaries.

| Scenario                                                                     | Required result                                                                                                                                |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Upstream advances without overlap                                            | Preserve the increment and install the latest observed base.                                                                                   |
| Upstream overlaps task work                                                  | Repair in a fresh session with supplied task context and validate the resulting candidate.                                                     |
| Upstream already contains the increment                                      | No empty commit; task becomes current and remains usable.                                                                                      |
| Agent made incidental commits or staged only part of a file                  | Deliver current intended file content without publishing agent history.                                                                        |
| Force-added ignored file, binary, deletion, symlink, executable bit          | Capture, review, transfer, and check identity agree.                                                                                           |
| Two tasks promote from the same base                                         | One wins; the other must prepare against the new target before delivery.                                                                       |
| Target changes during repair or checks                                       | Old result cannot be labeled current or authorize a stale promotion.                                                                           |
| Same task promotes, receives another prompt, then promotes again             | Two incremental target commits and one continuous provider conversation.                                                                       |
| Promotion followed by sibling reconciliation                                 | One coalesced refresh wave; no completion-event ping-pong.                                                                                     |
| Sibling fetch discovers an external target update                            | Notify other tasks even though no Boxers promotion caused the update.                                                                          |
| Repeated status/review requests during repair                                | Join/report the existing operation; do not restart its budget.                                                                                 |
| Main agent is generating or a new prompt arrives during repair               | Repair waits for exclusive ownership; queued main-session input cannot create concurrent generation.                                           |
| Repair completes or is canceled                                              | Preserve the original conversation/resume selection, persist the report, and release ownership only after confirmed termination.               |
| User input arrives during reset/apply                                        | Input waits for a consistent workspace boundary; checkpoint survives interruption.                                                             |
| Crash after reset but before application or metadata update                  | Detect unfinished replacement; never recapture and overwrite the sole checkpoint blindly.                                                      |
| Push accepted but response/host record lost                                  | Recognize the attempted commit in target history; no duplicate increment.                                                                      |
| Push accepted but Sandbox advancement fails                                  | Report accepted delivery and pending workspace convergence separately.                                                                         |
| Setup, preview, or another process changes files                             | Invalidate stale identity; preserve residual work.                                                                                             |
| Network unavailable, branch deleted/rewritten, or push policy rejects        | Clear failure/freshness state; no forced update or speculative history repair.                                                                 |
| Stopped task receives target notifications                                   | Remain stopped and retain pending target state. Resume has no mandatory freshness gate; the next post-turn or explicit preparation catches up. |
| New ordinary prompt arrives while the task is behind but no mutation owns it | Allow the turn without a mandatory fetch/reconciliation; preserve the pending target for post-turn preparation.                                |
| Daemon restarts during pending work                                          | Recover from durable boundary records or stop clearly; no correctness dependency on queue memory.                                              |
| Configuration, CLI, and fleet fixtures use the new contract                  | No integration mode, deprecated aliases, old-schema readers, or legacy delivery paths remain.                                                  |

## Risks and scope limits

| Risk                                                               | Why it can make the work harder                                                                                    | Planned containment                                                                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Active mutation and repair ownership: medium                       | New user input must not create concurrent generation while Git replacement or repair owns the workspace.           | Reuse daemon input coordination for active operations; no provider-specific freshness gate before every turn.            |
| Fresh repair context and ownership: medium                         | A fresh session lacks the main conversation, and an idle-state check alone does not exclude incoming user prompts. | Supply bounded task context and integration evidence, hold exclusive generation ownership, and preserve a repair report. |
| Cancellation during Git replacement: high                          | Current workers are disposable process groups; interrupting reset/apply is not safely recomputable.                | Operation-specific checkpoint, narrow consistent mutation boundary, and bounded fail-closed recovery.                    |
| Unknown push outcome: high consequence, bounded work               | Remote acceptance and host persistence cannot be one atomic transaction.                                           | Record attempted commit before push and resolve acceptance by fetching target history.                                   |
| Shared seed and concurrent task observations: medium               | Task-local serialization does not protect shared checkout/ref mutation or delayed target notifications.            | Narrow project Git locking, serialized authoritative observations, and coalesced task work.                              |
| Background writers: medium                                         | A provider Stop event does not establish filesystem quiescence for every child or preview process.                 | Coordinate known jobs and verify identities; preserve and report unexpected edits.                                       |
| Configuration and fleet consumers: low to medium                   | Integration mode is embedded in strict manifests, setup, CLI, and projections.                                     | Update current schemas, consumers, and fixtures together; backward compatibility and migration are not required.         |
| Protected branches and external rewrites: environmental constraint | Direct push may be forbidden, and history rewrites invalidate normal incremental assumptions.                      | Explain unsupported policy/state; no bypass, PR fallback, or complex rewrite recovery.                                   |
| Unusual Git features: variable                                     | Submodules, sparse layouts, linked worktrees, and filters can invalidate simplistic tree capture.                  | Establish tested support; reject unsupported layouts before mutation rather than extending scope silently.               |
| Continuously moving target: inherent                               | Another task or host may advance the target during preparation.                                                    | OID verification and non-forced push; bounded retries, never a promise of continuous global freshness.                   |

## Settled implementation scope and verification

Backward compatibility is out of scope, and the bounded resolutions below are
accepted implementation choices. Fresh repair sessions are also accepted: the
requirement is sufficient task context and exclusive generation, not sharing the
original conversation. Strict freshness before ordinary turns is deferred: use
post-turn preparation, project target-change events, and explicit commands.
No provider-input feasibility question remains as a prerequisite for this plan;
the items below need implementation and verification.

| Item                       | What is already decided                                                                                                                   | What remains to establish                                                                                                                                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fresh repair session       | Keep the existing bounded, non-persistent repair invocation. Supply task context and exclude main-agent generation for the entire repair. | Verify hook isolation, normal resume selection, queued input, and cancellation/termination. No internal-turn API for the original conversation is required.                                                                                |
| New ordinary turns         | No mandatory fetch/reconciliation before a prompt or resume. Working on the installed base until post-turn preparation is acceptable.     | Verify that input waits only for active mutation/repair ownership, and that pending target changes are reconciled after the turn or on explicit preparation. Strict pre-turn freshness may be considered later if needed.                  |
| Interrupted reconciliation | Keep one operation-specific checkpoint, protect the replacement boundary, and detect interruption before recapture.                       | Implement and test the exact mutation/cancellation sequence. On an ambiguous crash, preserving the checkpoint and reporting restart/recovery required is sufficient; automatic reconstruction of every intermediate state is not required. |
| Push response lost         | Persist the attempted commit and check remote ancestry before retrying delivery.                                                          | Implement the small delivery-attempt record and fault-injection tests. This is required correctness work, not an open architecture choice.                                                                                                 |
| Repair effort              | One repair turn plus one check-driven corrective turn, using a bounded timeout; repeated observations do not reset the budget.            | Implement the limit internally and allow manual continuation after exhaustion. Each turn can contain many tool calls.                                                                                                                      |
| Rapidly moving target      | Coalesce target events, stop at safe boundaries, and push without force.                                                                  | Stop a raced promotion with an actionable retry instead of adding an unbounded chase loop. This is an implementation policy, not a reason for distributed locking.                                                                         |
| Setup and other writers    | Wait for Boxers-owned setup, recapture settled content, preserve unexpected edits, and never certify stale content.                       | Identify which existing jobs can write across a turn boundary and verify the candidate before mutation/delivery. Arbitrary external writers do not need a universal locking solution.                                                      |
| Supported repository shape | One normal clone and ordinary Git content are the initial target.                                                                         | Verify seed access and exact-tree behavior with real Git and Docker. Explicitly reject unsupported submodule/sparse/worktree layouts before mutation; broaden support only when required.                                                  |
| Cross-host propagation     | Same-host target-change events fan out immediately; every host fetches at its own post-turn and command-preparation boundaries.           | Reuse fleet invalidation only if straightforward. Immediate fleet-wide synchronization is not required for correctness.                                                                                                                    |

Fresh repair reuses the current execution mechanism, and automatic preparation
continues to start from the existing Stop event. The smaller correctness
resolutions are approved for implementation and have focused acceptance tests.
Implement task-operation exclusion, not a provider-input refactor or strict
pre-turn freshness. No new execution routes, general recovery framework, or
compatibility design are needed.

The accepted design does not require age-based task policies, automatic discard,
recurring remote polling, distributed task locks, PR automation, terminal task
completion, preservation of agent commit history, data migrations, deprecated
aliases, mixed-version fleet support, or strict pre-turn freshness.

Start with safe capture/reconciliation and the focused repair-isolation checks.
Keeping fresh repair and post-turn preparation removes both same-conversation
repair control and strict pre-turn freshness from scope. The remaining work is
bounded Git correctness, operation coordination, and simplification of delivery.
