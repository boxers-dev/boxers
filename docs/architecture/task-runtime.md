# Task runtime boundary

Status: implemented for the Docker Sandboxes adapter.

Boxers core models tasks and exact Git workspaces, not Docker Sandbox CLI
resources. Docker Sandboxes is the only supported runtime today, but all
runtime-specific commands, status values, identifiers, diagnostics, session
launch details, and port behavior live behind one `TaskRuntime` adapter.

Core Boxers and the provider harness layer own these invariants:

- environments are provisioned only from the sanitized committed seed;
- host credentials, hooks, and untracked work never enter an environment;
- persisted Git OIDs and exact trees are the review and promotion boundary;
- networked Git authentication and branch advancement remain on the host;
- provider lifecycle hooks, native resume arguments, and auxiliary provider
  invocations are independent of Docker runtime mechanics;
- checks run read-only against an exact live-workspace tree identity;
- a runtime that lacks a required safety capability is unsupported rather than
  routed through a second execution architecture.

The runtime owns environment creation and destruction, availability,
captured/streaming execution, agent-session transport, port publication,
inventory, and backend diagnostics. Provider lifecycle events are deliberately
not modeled as Docker events. Runtime inventory is used only at explicit
resource and recovery boundaries, never as an activity scheduler.

Persisted version-3 task records contain a runtime kind and opaque runtime ID.
Older or incomplete records are rejected rather than migrated.

User commands describe task lifecycle. Provider hooks author the explicit turn
state, while runtime suspension is not a provider activity signal. The
supported lifecycle is creation, durable agent work, disposable post-turn
observation, integration, and discard. Detached setup/check/preview jobs retain
their status and logs in Sandbox operational state independently of the daemon.
