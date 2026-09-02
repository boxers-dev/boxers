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
reuse exact read-only checks. New input aborts that orchestration and invalidates
its identities. Interrupted work is simply recomputed.

Only one explicit operation per task is accepted at a time. It is kept in daemon
memory and is aborted during shutdown; a concurrent request is rejected for retry.
Narrow host Git locks and exact expected-OID checks protect reconciliation and
promotion. In-flight orchestration has no durable composite recovery machinery.

Ordinary `list` and `status` read host projections without invoking `sbx`.
`status --refresh` inventories the runtime, drains lifecycle events, observes
Sandbox jobs, refreshes target/workspace Git facts, and repairs the host cache.

> Sandboxes, workspaces, provider histories, and completed Sandbox jobs are
> durable. Interactive PTYs and in-flight host orchestration are disposable. A
> daemon restart may pause work; the next attach or refresh resumes or recomputes
> it safely.
