# Shared command lifecycle review

This review follows public CLI routes, daemon intents, peer RPCs, automatic
post-turn work, release activation, and their supporting modules. It addresses
behavioral duplication rather than making unrelated commands perform identical
side effects.

## Findings and changes

| Finding                                                                            | Shared owner and correction                                                                                                                                                                   |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connect accepted equal npm versions even when their code differed                  | `release.ts` produces the exact capsule; connect stages that capsule before enrollment and verifies its build ID                                                                              |
| Connect, update, and the legacy update RPC installed and activated differently     | `activateHostRelease` owns managed activation, SSH authorization repair, service installation, and daemon replacement; `officialReleaseCapsule` owns npm release acquisition                  |
| A reconnect could retain an older desired fleet build                              | Connect learns the remote generation, records the selected release, and uses `sendFleetReleaseWithBootstrap` before reciprocal snapshot verification                                          |
| Inactive daemons and same-version incompatible daemons could pass activation       | `daemonReleaseMatches` checks protocol, package version, and known build ID for activation, health reporting, client negotiation, and daemon replacement                                      |
| Service startup could find Node while subsequent internal launches could not       | Internal Boxers launches and SSH gateway authorizations use the absolute Node executable; the stable application path remains authoritative                                                   |
| Installed package-manager entry points could bypass the selected managed build     | `managedInvocation` delegates ordinary published-package commands to the stable executable; pinned workers, version validation, and explicit source checkouts retain their specified artifact |
| Task commands duplicated stable-workspace preparation                              | `prepareTaskWorkspace` waits for setup, drains lifecycle events, reloads state, and rejects active/uncertain agent work                                                                       |
| Setup and preview could consume target configuration before installing its files   | `prepareTaskCandidate` routes them through the same reconciliation/capture passage as review, check, sync, and promotion                                                                      |
| Reconciliation could start new setup while explicit commands continued             | Explicit preparation waits for that setup and captures afterward; automatic post-turn work can still defer                                                                                    |
| Reconciliation had two implementations in the candidate preparation chain          | `refreshSettledCandidate` owns the single reconciliation step; capture consumes its installed target                                                                                          |
| Check reuse duplicated candidate identity comparisons                              | `candidateCheckMatches` compares target OID, tree OID, and configuration hash                                                                                                                 |
| Direct CLI and daemon parsing disagreed on preview arguments and repeated messages | `parseTaskIntent` validates both paths; `executeTaskIntent` routes both paths                                                                                                                 |
| Several SSH RPC implementations handled timeouts, input, and failures separately   | `captureSsh` uses `commandStreaming` for text/JSON RPCs and streamed capsule input; binary capsule downloads retain their size-limited reader                                                 |
| An incompatible project snapshot schema still advertised the old protocol          | `TASK_VIEW_PROTOCOL_VERSION` is shared by producer, decoder, and type contract; the incompatible schema has a new protocol number                                                             |

## Command coverage and intentional differences

| Commands/entry points                            | Shared passage                                                            | Command-specific behavior                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| review, check, sync                              | `prepareTaskCandidate`                                                    | Display only; run/reuse checks; report reconciliation                                                             |
| promote                                          | `prepareTaskWorkspace`, pending delivery recovery, `prepareTaskCandidate` | Preserve exact reviewed tree, validate checks, host-only fast-forward push, durable accepted-delivery recovery    |
| setup                                            | `prepareTaskCandidate` without automatic setup submission                 | Retry the reconciled setup command once                                                                           |
| preview start/restart                            | `prepareTaskCandidate`                                                    | Validate reconciled preview config before stopping/replacing the previous job                                     |
| post-turn and target-change workers              | `refreshSettledCandidate`                                                 | Defer for active agents, running setup, or stopped runtimes; do not wake stopped Sandboxes for target hints       |
| status, list, remote snapshot/watch              | Existing projection and observation modules                               | Observe; do not synchronously reconcile or capture a running agent's workspace                                    |
| preview show/logs/stop                           | Existing runtime job adapter                                              | Inspect or stop the recorded job without requiring Git/network availability                                       |
| attach, debug shell                              | Existing session/runtime modules                                          | Preserve native history and access for conflict repair; reconciliation cannot be a prerequisite for repair access |
| discard                                          | Existing removal safety policy; `sync` when reconciliation is needed      | Preserve confirmed clean-removal shortcut and explicit forced-removal semantics                                   |
| new, remote new, project add/init                | Existing project registry, sanitized seed, runtime/session adapters       | Creation starts from committed target content; no existing task workspace to reconcile                            |
| connect, update, incoming release, legacy update | `activateHostRelease`, release capsule methods                            | Normal SSH bootstrap and one-time enrollment versus signed managed fleet rollout                                  |
| daemon start/restart/replacement                 | Existing daemon lifecycle functions and `daemonReleaseMatches`            | Normal lifecycle authorization differs from explicit release replacement                                          |
| doctor, host status, auth status                 | Existing `collectHostStatus` and shared daemon comparison                 | Diagnostics observe; authentication stays host/provider scoped                                                    |
| auth, task authentication                        | Existing provider registry and auth/runtime adapters                      | Host OAuth may require interactive normal SSH; managed keys cannot forward ports                                  |
| rename/disconnect                                | Existing fleet membership and managed authorization methods               | Propagate rename/removal while retaining partial-outage reporting                                                 |

Project configuration is not copied between unrelated projects or hosts. Matching
the application build aligns its parser and protocols. Task commands obtain the
configuration from the exact target OID used for reconciliation and capture.

## Verification boundaries

Validation completed: all 427 tests across 52 files passed. After the final
service-launcher adjustment, all 31 focused tests across five files passed.
`npm run check` and `npm run build` passed. The existing control-character regex
lint warning in `native-promotion.test.ts` remains.

Regression tests exercise equal-version/different-build enrollment, activation
failure, exact capsule transfer without a preinstalled Boxers protocol, daemon
identity mismatches, shared task argument validation, and all explicit task
preparation consumers with real temporary Git repositories and a simulated
Sandbox adapter. Existing promotion, session continuity, process, and fleet tests
remain part of the full suite.

The review does not uninstall user-managed packages, edit remote shell profiles,
or deploy code to an existing fleet. Already-published older entry points cannot
gain delegation until upgraded; their managed launcher can be used directly.

Docker's current CLI reference was checked before changing task preparation:
[`sbx exec`](https://docs.docker.com/reference/cli/sbx/exec/) starts a stopped
Sandbox, so observation and automatic target hints must retain their existing
non-mutating/stopped-runtime boundaries.
