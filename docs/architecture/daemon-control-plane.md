# Disposable daemon control plane

Status: implemented. This document is authoritative for the current control plane.

Docker Sandboxes owns each durable workspace, provider-native history, and detached
setup/check/preview jobs. Host disk owns the task registry, cached observations,
exact Git identities, and delivery records. The daemon owns only live PTYs,
viewers, lifecycle wake-ups, and short-lived orchestration.

Interactive providers run under a daemon-owned PTY process group. Replacing the
daemon stops the provider and may pause the task. Startup stops any provider whose
recorded lifecycle says it might have survived without a current PTY. The next
attach uses the recorded provider session and provider-native resume arguments.

Setup, checks, and previews use `sbx exec -d` and publish atomic records below
`$HOME/.boxers/jobs/<task-id>/<job-id>` inside the Sandbox. Each job owns its
process group and retains separate stdout/stderr logs. These agent-writable records
are operational evidence: host-side check certification additionally revalidates
the target OID, live workspace tree, configuration hash, and conversation sequence.

A `turn_finished` lifecycle event starts disposable post-turn work: refresh the
target, reconcile when required, compute the live workspace identity, and run or
reuse exact read-only checks. New input cancels safe stages of that orchestration
and invalidates their identities. Workspace replacement, fresh repair, and
accepted-delivery advancement instead
hold acknowledged worker ownership: input waits for a known safe boundary. An
uncertain interruption retains a checkpoint and blocks capture/generation rather
than recapturing a partially replaced workspace.

Initial prompts passed during launch and raw input awaiting a `user_prompt`
lifecycle acknowledgment prevent background preparation and strong commands from
starting against an apparently idle task. This is workspace exclusion, not a
freshness check before a new turn. Attaching another viewer to an existing session
remains observation-only; starting a provider session is refused during an
exclusive operation or an uncertain workspace mutation.

A changed project target, discovered by fetch or confirmed promotion, sends a
same-host hint. The daemon rereads the published seed target and coalesces pending
work into the existing post-turn jobs, including at an unchanged conversation
sequence. Busy tasks drain pending requests after their operation or turn. Target
hints never start stopped Sandboxes or cancel active repair. Unchanged target
observations do not broadcast another hint.

Only one explicit operation per task is accepted at a time. It is kept in daemon
memory and is aborted during shutdown; a concurrent request is rejected for retry.
Narrow host Git locks and exact expected-OID checks protect reconciliation and
promotion. In-flight orchestration has no durable composite recovery machinery.
Ordinary cancellation lets completed host Git calls unwind and release the seed
lock. After abrupt worker loss, that lock is not automatically reclaimed: a Git
child may still be modifying the shared seed. The diagnostic identifies the exact
lock; verify those processes have stopped and inspect the seed before removing
it. Other metadata-only locks retain their dead-owner reclamation behavior.

Task `status` attempts a bounded host target fetch and reads live operations from
an already-running daemon without joining its exclusive command queue. It can
request background preparation but never waits for repair or enters the Sandbox.
`status --refresh` additionally inventories the runtime and observes lifecycle,
preview and idle-workspace facts where no operation owns or is queued for the
workspace. These observations do not publish a prepared candidate. List retains
recorded Git observations; neither command adds a pre-turn freshness gate.

> Sandboxes, workspaces, provider histories, and completed Sandbox jobs are
> durable. Interactive PTYs and in-flight host orchestration are disposable. A
> daemon restart may pause work; the next attach or refresh resumes or recomputes
> safe work. An uncertain replacement, repair, or delivery advancement retains its
> checkpoint and blocks generation until explicitly resolved or discarded. A
> confirmed remote delivery is not undone by discarding its originating task.
