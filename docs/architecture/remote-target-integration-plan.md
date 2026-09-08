# Remote target integration: gap analysis and minimal plan

Status: implementation in progress. Original code assessment: 2026-09-08 at
`577fc49`. This replaces the earlier, broader plan; the contract and four changes
below remain the completion requirements.

Implementation checkpoint:

- Change 1 implemented with retained reconciliation checkpoints, aligned capture,
  observed-versus-installed target identity, serialized seed refresh, setup after
  installation, repair context, acknowledged mutation ownership, and bounded
  check-driven correction. PID locks now publish complete ownership atomically
  and serialize stale-owner reclamation. Eight-process contention tests cover
  dead-owner recovery without overlapping critical sections. Interrupted lock
  reclamation stops with an explicit diagnostic rather than guessing ownership.
  Seed locks additionally refuse automatic reclamation after abrupt worker loss:
  an actual killed-worker regression demonstrates that its Git child can remain
  alive. Normal group cancellation unwinds and releases the seed lock; both
  outcomes have cross-process tests. Live runtime verification remains.
- Change 2 implemented: remote/base-only configuration, direct non-forced target
  push, retained attempted/accepted delivery, exact accepted-OID advancement, and
  reusable tasks. Fixtures now use separate remote targets; no local/PR delivery
  route remains in application code. Tests cover non-fast-forward and policy
  rejection, lost responses, retrying the same commit, sync without pushing,
  advancement failure, newer edits and two promotions from one task.
- Change 3 implemented through existing daemon post-turn jobs: changed-target
  hints, same-sequence refresh, pending-target coalescing and draining after
  commands/turns. Tests cover idle/working/stopped tasks, changes during repair,
  cancellation by commands, and notification deduplication. Confirmed acceptance
  publishes the seed target even if the subsequent network refresh fails. A real
  Git promotion now has integration coverage through the notification socket,
  daemon and a separate actual command worker into an idle sibling's workspace;
  stopped and unrelated tasks remain untouched. The Sandbox adapter is simulated.
- Change 4 implemented: bounded nonexclusive target observation for both status
  forms, installed/observed target reporting, explicit offline/unknown freshness,
  and live worker operations. Mutation activity is based on acknowledged ownership,
  not an unrelated operation's phase. Tests show status returning while a separate
  repair worker remains blocked. `--refresh` observes runtime/workspace facts without
  publishing a candidate or waiting for reconciliation. Fetch timeout terminates
  the POSIX transport process group, and projected failures omit raw credential-bearing
  Git output. Local Git metadata calls in the target-refresh passage share its
  deadline; tests cover stalls in ref lookup, remote resolution and config cleanup.
  README and control-plane status descriptions are updated.
- Accepted-delivery advancement now uses the existing uncertainty marker and a
  tokenized terminal receipt. Known completed failures remain retryable; missing
  completion or actual host-worker death blocks capture/generation without losing
  the accepted commit. Initial prompts and raw input awaiting lifecycle acknowledgment
  are included in admission checks for both launch forms and strong commands.
- Provider nonzero/timeout outcomes, one-correction exhaustion, recent conversation
  context for both providers, status during cross-process seed contention, and
  status observation races have deterministic regressions. Provider executables
  and Sandbox execution in these tests remain simulated.
- Latest full suite: 398 passing tests across 49 files (2026-09-08).
  `npm run check` and `npm run build` pass, with the existing regex lint warning.
  The previous list display regression is fixed. The preview test now waits for
  the detached job's observable log readiness instead of racing its startup;
  preview production behavior is unchanged. These tests do not establish live
  Sandbox/provider behavior.
- Current official Docker Git-workflow and `sbx exec`/`create` references were
  checked before runtime edits. The official [installation requirements](https://docs.docker.com/ai/sandboxes/install/)
  and [`sbx exec` reference](https://docs.docker.com/reference/cli/sbx/exec/)
  were checked again on 2026-09-08. Docker Engine 29.7.2 is reachable, but no `sbx`
  executable, Sandbox plugin, `/dev/kvm`, running containers, or configured Boxers
  fleet host is available. Linux Sandboxes requires KVM; installing a CLI alone
  would not satisfy the runtime gate. No runtime was installed or host reconfigured.

Remaining completion gates:

- Run the live smoke sequence on a Sandbox-capable host for both providers:
  create from the sanitized seed, reconcile a conflicting increment, verify input
  exclusion and repair hook isolation, promote directly, and resume the original
  conversation for a second increment. Include sibling refresh and a stopped sibling.
- Record actual runtime/provider versions and results. The deterministic evidence
  below does not prove live seed transport, provider hook inheritance, native resume
  selection, or in-Sandbox termination behavior. These remain completion gates,
  not waived requirements.

## Conclusion

Boxers does not need another architecture rewrite. Most of the intended flow
already exists: shared preparation, automatic reconciliation, fresh repair,
exact candidate checks, and continued task use after promotion. The earlier
plan incorrectly presented some of these as new infrastructure.

The smallest defensible change is to protect the existing reconciliation path,
simplify its delivery destination, and add target-change invalidation to the
existing daemon. Status needs a small but real behavior change. Safe cancellation
and workspace ownership are the difficult part, not a new way to run agents.

No backward compatibility or migration is required. Delete obsolete behavior
directly, but do not rename unrelated concepts, rewrite all persisted state, or
delete user work merely because compatibility is unnecessary.

## Agreed contract

- One configured remote target per project, defaulting to `origin` and the selected
  base branch. Host Git owns credentials, fetches, commit creation and
  fast-forward-only pushes. Keep sanitized Sandbox seeds.
- One product increment produces one commit **per promotion**, not per task
  lifetime. Promotion leaves the task and native conversation reusable. Agent
  history is not published; internal checkpoint commits remain permissible.
- Reconcile after agent turns, during candidate-preparing commands, and on
  discovered project target changes. No mandatory fetch/reconciliation before
  new prompts or resume. An active mutation or repair can temporarily hold input.
- Keep fresh automatic repair with relevant task context, bounded to one repair
  turn and at most one check-driven corrective turn. Repeated observations cannot
  restart exhausted repair. Ambiguity/exhaustion leaves an actionable failure;
  discard/recreate is an explicit escape hatch, not automatic deletion.
- Review uses the latest successfully fetched target and does not itself require
  checks. Status fetches target state and reports pending/running preparation
  without waiting for lengthy repair.
- Successful promotion and discovery of a changed target notify same-host sibling
  tasks. Reconciliation against an already-known target does not rebroadcast.
  Busy tasks catch up after their turn/operation.
- Remove local integration, persistent remote task/PR branches, branch reuse and
  forced replacement. Do not add a fallback delivery route.

“Latest” means the latest successful observation at these boundaries, not
continuous synchronization. A remote race can reject promotion; report it and
allow retry, without an unlimited fetch/repair/check/push loop.

## Code comparison: keep, adjust, add, remove

Source links identify existing owners; function names are search anchors.

| Area                     | Already implemented                                                                                                                                                                                 | Actual delta                                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Shared preparation       | `refreshSettledCandidate` already fetches, reconciles and captures for post-turn work and commands; `prepareCandidate` handles changed bases in [commands.ts](../../src/v2/commands.ts).            | **Adjust** safety/ordering inside these functions. No new preparation service.                                              |
| Turn automation          | `runPostTurn` prepares, checks and generates metadata; `acceptLifecycle` launches it on Stop in [daemon.ts](../../src/v2/daemon.ts).                                                                | **Keep**, adding a changed-target reason that can refresh without a new Stop sequence.                                      |
| Work transplantation     | Host `materializeNativeCandidateUnsafe` creates an exact-tree synthetic checkpoint; `reconcileNativeWorkspace` resets to the target and squash-applies it in [sandbox.ts](../../src/v2/sandbox.ts). | **Keep** the algorithm; protect its checkpoint and destructive interval. No history-rebase machinery.                       |
| Automatic repair         | `attemptAutomaticReconciliationRepair` already calls `runRepairAgent`; [session.ts](../../src/v2/session.ts) already uses ephemeral/non-persistent execution with a ten-minute timeout.             | **Adjust** context, validation and exclusive generation. Add one local corrective turn, not a retry service.                |
| Candidate/check identity | `recordedPreparedCandidate`, `executeChecksUnsafe` and metadata caching already compare target/tree/config/conversation identity in [commands.ts](../../src/v2/commands.ts).                        | **Keep** identity/caching; fix differing capture semantics.                                                                 |
| Delivery                 | `promote` already prepares/checks, creates a commit, locks/rechecks the target and advances the Sandbox.                                                                                            | **Remove** local and PR-branch paths; push the existing synthetic commit directly to the target. Record acceptance earlier. |
| Continued task use       | `advanceNativeWorkspace` uses mixed reset to preserve newer files; promotion updates `promotionConversationCheckpoint`.                                                                             | **Keep**. Remove the remote-PR special case that labels clean delivered work unmerged. No task completion changes.          |
| Input coordination       | `postTurnJobs`, `busyTaskNames`, intent tracking and input buffering exist in [daemon.ts](../../src/v2/daemon.ts).                                                                                  | **Adjust** cancellation/ownership in place. Do not replace PTYs or lifecycle architecture.                                  |
| Target observation       | `refreshSeed` publishes the target through the shared seed in [registry.ts](../../src/v2/registry.ts).                                                                                              | **Add** narrow seed serialization and changed-target notification; distinguish observed target from installed base.         |
| Status                   | Plain status is cached; `status --refresh` can synchronously repair. [entrypoint.ts](../../src/core/entrypoint.ts) explicitly routes them differently.                                              | **Adjust** task status to observe the target and request background preparation without waiting for repair.                 |
| Setup                    | `ensureCurrentSetup` already manages durable setup/configuration hashes in [setup.ts](../../src/v2/setup.ts).                                                                                       | **Keep** machinery; run changed-target setup after installing the target files.                                             |
| Project events           | `setup_completed` and `state_changed` provide notification patterns in [daemon-client.ts](../../src/v2/daemon-client.ts) and [daemon-protocol.ts](../../src/v2/daemon-protocol.ts).                 | **Add** one project-target notification. State notifications alone do not schedule sibling reconciliation.                  |

## Concrete issues to fix

1. **Interrupted reconciliation can overwrite its recovery checkpoint.** The
   Sandbox script fetches into fixed work/target refs, then runs hard reset and
   clean. Retrying can recapture that partially replaced workspace and overwrite
   those refs. A disposable-repository reproduction stopped after reset and
   demonstrated the original work disappearing from the retained checkpoint on
   retry. Add a small in-progress marker; never overwrite its checkpoint while
   the outcome is unresolved.
2. **Capture and check trees can disagree.** Patch capture includes a force-staged
   ignored addition; `nativeWorkspaceTreeAt` starts from HEAD and uses `add -A`,
   which can omit it. This was reproduced with unequal tree OIDs. Align
   file-selection semantics while preserving ordinary staged/unstaged/untracked
   behavior.
3. **Observed target becomes installed base too early.**
   `recordAdvancedTargetPending` passes the new target to `recordTaskSnapshot`
   in [state.ts](../../src/v2/state.ts), which writes `baseOid` before workspace
   reconciliation. Keep installed-base updates at the actual transition and
   record target observation separately.
4. **Cancellation crosses unsafe phases.** Input and explicit intents call
   `abortPostTurn` without distinguishing replacement/repair.
   [daemon-worker.ts](../../src/v2/daemon-worker.ts) kills the host worker group;
   that does not prove an in-Sandbox repair process stopped. Progress callbacks
   currently log activity; they are not an ownership handshake.
5. **Shared seed mutations are not serialized.** Different task workers can
   interleave `refreshSeed` fetch/checkout/reset. The promotion lock does not
   cover all callers. Reuse the PID-lock approach in [lock.ts](../../src/v2/lock.ts)
   for a narrow project seed transaction.
6. **Smaller gaps:** repair accepts no remaining unmerged paths even after a failed
   provider exit; changed setup can run on old files; delivery acceptance is saved
   only after Sandbox advancement; [task-view.ts](../../src/v2/task-view.ts) can
   call reconciliation current merely because a base OID exists.

The checkpoint/capture reproductions exercise Git scripts, not live Docker.
Cross-process cancellation and concurrent seed use require additional integration
coverage; existing passing tests do not prove these boundaries safe.

## Four narrowly scoped implementation changes

### 1. Protect the existing reconciliation path

Owners: `sandbox.ts`, `commands.ts`, `registry.ts`, `state.ts`, `daemon.ts`,
`daemon-worker.ts`; small supporting path/type additions.

- Add a reconciliation marker with old base, target, immutable checkpoint and
  bounded repair outcome. Persist before destructive replacement; clear only on
  known completion. Ordinary capture/retry must not overwrite an unresolved
  checkpoint. Interrupted/ambiguous work can stop with a recovery/discard choice;
  do not build arbitrary crash replay.
- Extend existing worker/input coordination for exclusive replacement and repair.
  Input/strong intents wait through that unsafe interval, then proceed. Acquire
  ownership with acknowledgment before mutation, not a late progress message.
  Check already-buffered input as well as recorded lifecycle state. Retain
  cancellation at safe phases and observation-only attach.
- On abnormal worker loss, confirm the Sandbox mutator stopped before allowing
  generation, or expose a blocked operation. Do not solve this by replacing the
  native session. No freshness gate is added before ordinary turns.
- Align candidate/check capture; retain existing exact-identity validation.
  Separate observed target from installed base without globally renaming
  `baseOid`, `targetOid`, `candidateTreeOid` or snapshot storage.
- Serialize shared seed publication/mutations with explicit lock ordering relative
  to promotion. Never hold a project seed lock through repair/checks. Fetch can
  exceed the state-lock timeout, so choose an appropriate bounded wait.
- Move changed-config setup behind successful reconciliation; keep setup deferral.
  Supply repair with intent/relevant instructions using existing bounded
  conversation reading, plus original diff and conflict context. Keep provider
  invocation/resume settings.
- Validate repair completion, base and index before recapturing. When the workflow
  requests checks, allow at most one repair-related corrective turn, then
  recapture/recheck. Persist its small exhausted outcome so events/status cannot
  reset the budget. Unrelated check failures are not a general repair loop.

Tests: interruption after reset/during repair; checkpoint retention; force-staged
ignored additions; observed-versus-installed base; concurrent seed refresh;
changed setup; input exclusion; failed repair exit and bounded correction.
Preserve existing Stop and native-session tests.

### 2. Simplify promotion to direct remote delivery

Owners: `commands.ts`, `registry.ts`, `config.ts`, `types.ts`, `cli.ts`,
and existing integration fields in `projection.ts`.

- Remove local/remote mode selection and local checkout advancement. Retain
  remote/base configuration, defaulting remote to `origin`. Delete delivery-branch
  naming, PR reporting, reuse/cherry comparisons and forced replacement. Update
  readers/fixtures directly; no migrations or legacy aliases.
- Keep preparation, checks, messages and final target recheck. Create one commit
  with the prepared target as parent and the checked candidate as tree. Push it
  to `refs/heads/<base>`, without force.
- Save a small pending-delivery record before push: expected target, candidate,
  delivery commit and conversation checkpoint. After an uncertain response,
  fetch and test whether that exact commit is on the target before retrying.
  Do not duplicate an already accepted increment.
- Persist confirmed acceptance before Sandbox advancement. Reuse mixed reset and
  preserve newer files. Failure after acceptance means “delivered; workspace
  reconciliation pending”, not “promotion failed”. If a sibling advances the
  remote immediately, install the exact accepted commit via the seed or leave
  advancement pending; never substitute an unverified branch tip.
- Keep the task/conversation and existing promotion checkpoint. Invalidate stale
  candidate/check/message state. A clean delivered workspace is on-base.

Tests: exact tree/parent; untouched host checkout; non-fast-forward rejection;
lost push response; accepted push followed by advancement failure; newer local
edits; two promotions from the same task. Replace PR-branch expectations, not
useful working-tree coverage.

### 3. Add target-change fan-out to existing daemon jobs

Owners: `registry.ts`, `commands.ts`, `daemon-client.ts`,
`daemon-protocol.ts`, `daemon.ts`, `daemon-worker.ts`.

- Notify after a successful fetch changes the observed project target. Successful
  promotion must invalidate siblings even if its own workspace advancement fails.
  Coalesce push/fetch duplicates. Treat events as hints and re-read the seed target
  so late notifications cannot regress observations.
- Extend post-turn tracking with pending target/reason per task. Permit refresh at
  the same conversation sequence for a changed target; keep duplicate Stop
  suppression. No second scheduler, event ledger or preparation DAG.
- Run the shared preparation path when safe. During generation, setup, input
  forwarding or another operation, retain the latest pending request and drain at
  the existing completion boundary. Use change 1's ownership; do not interrupt
  active repair to chase a newer target.
- Available not-yet-started workspaces can refresh without fabricated Stop events.
  Do not start stopped Sandboxes for notifications. Later command/turn boundaries
  fetch normally; daemon restart need not replay a durable event log.
- Successful reconciliation against a known target emits no new target event.
  Same-host fan-out suffices; other hosts fetch at command/post-turn boundaries.

Tests: promotion in A updates idle B; busy B defers; same sequence/new target runs;
duplicate/late events coalesce; unrelated projects stay untouched; no event loop,
implicit Sandbox startup or repair-budget reset.

### 4. Expose honest freshness and finish contract cleanup

Owners: `commands.ts`, `task-view.ts`, `core/entrypoint.ts`,
`daemon-client.ts`, CLI/status tests and documentation.

- Ordinary task status attempts a bounded host target fetch, renders installed
  base/observed target/freshness, and requests background preparation. This must
  not queue behind the exclusive operation doing repair. Reuse existing
  observation transport where possible; routing everything through today's
  `status --refresh` strong intent is insufficient.
- Retain `--refresh` for distinct deeper runtime observation without synchronous
  repair; removing this useful flag is unnecessary. Fetch failure displays last observation
  and freshness failure, not false “current”. Cached list views show honestly
  known state; do not add fleet-wide polling requirements.
- Review/sync/check/promote retain existing preparation and wait through active
  unsafe work before inspecting/mutating. Review does not require checks merely
  for display. No general “join preparation at stage X” service.
- Update README, architecture contract, help and parsing tests alongside behavior.
  Delete obsolete local/PR assertions; preserve native launch/resume, setup,
  preview, logs, auth and fleet-routing coverage.

Tests: status returns during repair with actual pending/running state; fetch during
generation does not mutate the task; offline freshness is explicit; review uses
the fetched target without requiring checks; resume has no freshness gate.

## What might make this harder

- **Cancellation/ownership is the main risk.** Killing a host worker does not
  establish that Sandbox work stopped. Prove this boundary first; if a small
  extension is insufficient, reassess that boundary rather than the whole daemon.
- **Direct push requires repository permission.** PR-only protected branches are
  outside this contract. Surface rejection; do not resurrect PR mode.
- **Remote races remain normal.** Exact OIDs, small attempt records and non-forced
  pushes handle them. Avoid continuous-freshness promises, distributed locks and
  unlimited retries.
- **Git correctness extends beyond text conflicts.** Retain committed, staged,
  unstaged, binary, deleted and untracked-file coverage. Add demonstrated
  regressions instead of a general Git recovery framework.
- **Runtime behavior needs a live smoke test.** Consult current official Docker
  documentation before changing Sandbox runtime behavior, as AGENTS.md requires.
  Verify seed fetching, repair input exclusion, hook isolation and conversation
  resume with both providers. Fake-runtime Git tests cannot prove these. A new
  provider-session mechanism is not a prerequisite.

Explicitly excluded: PTY redesign, hook replacement, task-completion states,
global state/OID renames, a new preparation framework, fleet redesign, immediate
cross-host events, migration support, pre-turn freshness gates, automatic expiry,
and elaborate long-stale-work recovery.

## Validation baseline and implementation discipline

During this assessment, `npm run check` passed with the existing control-regex
warning in `native-promotion.test.ts`. Eight focused suites covering promotion,
daemon, Sandbox, registry, setup, state, CLI and protocol passed 114 of 115 tests.
The failure was preview-log availability immediately after preview start; its
isolated rerun passed. Treat it as an existing intermittent baseline issue, not
evidence that Git integration needs a rewrite. No live Docker test was run.

For each change, run focused regressions and `npm run check`; run the full suite
and live smoke tests before declaring the integration contract complete. Changes
1–2 establish safe direct promotion; 3–4 complete automatic freshness. No change
requires unrelated lifecycle cleanup or application redesign.

## Requirement evidence audit

This separates deterministic implementation evidence from the outstanding live
gate. Test descriptions below are search anchors in `test/v2/`; the latest full
run above covers all listed suites. Passing simulated tests is not evidence of
provider-native behavior on a real Sandbox.

| Requirement                                                       | Current evidence                                                                                                                                                                       | Verification boundary                                                                    |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Remote/base only; no local or PR delivery                         | `config.test.ts`, `cli.test.ts`, `initialize.test.ts`, updated registry/projection readers; application search finds no integration-mode or PR/force-push route                        | Host implementation and parsing verified                                                 |
| Sanitized seed; host-owned credentials and Git delivery           | `registry.test.ts`: committed tracked content without real-worktree secrets/settings; `native-promotion.test.ts`: credential-bearing fetch failures excluded                           | Host Git and fake-Sandbox transport verified; live seed access outstanding               |
| One commit with exact candidate tree/target parent; reusable task | `native-promotion.test.ts`: direct remote promotion and task reuse, exact working tree, preserved newer edits                                                                          | Real Git repositories and bare remote; provider resume still requires live verification  |
| Reconciliation checkpoint survives interrupted replacement        | `native-promotion.test.ts`: interruption following reset retains original work and installed base; ordinary retry refused                                                              | Real Git script, simulated Sandbox                                                       |
| Capture/check identity and invalidation                           | `native-promotion.test.ts`: force-staged ignored additions, changed workspace, check modifying files, binary/deleted/untracked content in exact promotion                              | Real Git tree identities verified                                                        |
| Exclusive mutation, input and launch coordination                 | `daemon-worker.test.ts`: acknowledged ownership and cancellation; `daemon.test.ts`: initial/raw input, both launch forms, uncertainty markers and observer attach                      | Host IPC/PTY coordination tested; live in-Sandbox termination and hooks outstanding      |
| Serialized shared seed; safe worker-loss handling                 | `registry.test.ts`: concurrent task workers, group SIGTERM cleanup and SIGKILL with surviving Git child; `lock.test.ts`: eight-process contention and interrupted reclamation          | Actual host processes; abrupt seed-owner loss fails closed, no automatic replay          |
| Setup after target installation                                   | `native-promotion.test.ts`: installs target files before starting changed setup; `setup.test.ts` retained                                                                              | Deterministic ordering and existing setup behavior verified                              |
| Fresh contextual bounded repair plus one correction               | `native-promotion.test.ts`: both provider arguments/context, nonzero/timeouts, correction exhaustion across requests/target changes, unrelated check failures                          | Simulated providers and real timeout; native history/hook isolation outstanding          |
| Retry-safe delivery and accepted advancement                      | `native-promotion.test.ts`: rejected push, lost response, same-commit retry, sync without pushing, newer remote tip, missing terminal receipt and actual host-worker loss              | Real Git and host worker with simulated Sandbox advancement                              |
| Stop and sibling target-change scheduling                         | `daemon.test.ts`: duplicate Stop, deferred setup/turn/intent, latest pending target; `native-promotion.test.ts`: real promotion through socket, daemon and separate sibling worker     | Same-host integration verified with fake Sandbox; stopped-sibling live check outstanding |
| Responsive honest status, no pre-turn freshness gate              | `native-promotion.test.ts`: target fetch during generation, offline/timeout metadata, seed contention, blocked repair, observation races; `entrypoint.test.ts` and `task-view.test.ts` | Host observation/routing verified; no synchronous status repair introduced               |
| Preserve existing architecture and command features               | Provider adapters, lifecycle recording/ingestion, conversation and setup implementation unchanged; full native-session, setup, auth, preview, fleet and routing suites pass            | No new runtime/session/scheduler, migration, task completion or expiry mechanism         |
| Help, README, control-plane contract, plan and validation         | Updated documents/CLI fixtures; check, build, full tests and `git diff --check`                                                                                                        | Live smoke results and tested provider/runtime versions still required before completion |
