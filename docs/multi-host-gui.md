# Multi-host GUI direction

Status: fleet control-plane foundation implemented; GUI remains future work.

Boxers should be able to render the same fleet from any enrolled host. Each
host remains authoritative for its own projects, credentials, task runtimes,
Git targets, and task state. The local daemon records that state, maintains
peer watches, and serves one provider-neutral projection to the CLI and future
GUI.

The intended topology is:

```text
GUI or CLI
    |
    v
local Boxers daemon and recorded projection
    |-- persistent SSH watch --> peer A daemon/projection
    `-- persistent SSH watch --> peer B daemon/projection
```

An ordinary view reads the local recorded projection only. It does not run Git,
contact a task runtime, or open SSH. Peer invalidations and heartbeats update
the cache in the background; an unreachable peer keeps its last projection but
is labeled `stale`. A strong intent is routed to the host that owns the task.

## Identity and ownership

Every resource includes a stable `hostId`. Task identity is
`(hostId, projectId, taskId)`, not a task name or runtime resource name. Fleet
membership carries stable public keys, roles, and direct SSH endpoints. Full
membership snapshots and removal tombstones converge through daemon gossip, so
an offline peer cannot resurrect a disconnected host; a later explicit
reconnect records a newer enrollment. This fleet manifest is the only remote
membership authority. A peer cache cannot introduce a host that is absent from
the current fleet.

Adding a host with `boxers connect` is reciprocal. It discovers or installs
the exact Boxers release, installs the same user daemon service, exchanges
known fleet membership, verifies the reverse route, and records endpoints on
both hosts. This allows a GUI launched on either side to discover the same
fleet without copying `BOXERS_HOME` or introducing a central database.

## GUI protocol boundary

The GUI should consume daemon snapshots and subscriptions rather than polling
CLI output. Typed intents should mirror the public task lifecycle:

Fleet snapshots expose the explicit provider turn state (`not_started`,
`working`, `awaiting_input`, `exited`, or `unknown`) and timestamped cached
observations. Attention is derived from `awaiting_input` or failure. PTY output
must never synthesize an activity transition.

- create and attach to a durable task;
- read recorded status or request an explicit strong refresh;
- review, check, promote, and discard;
- start or stop a preview;
- open an explicitly labeled debug shell.

Interactive channels need input, output, resize, detach, reconnect, and replay.
The owning-host daemon multiplexes each live PTY and accepts at most one
explicit task operation at a time. Those are disposable live resources; the GUI
must use the daemon protocol rather than create another session coordinator.

Task runtime details remain behind `TaskRuntime`. A GUI action never addresses
Docker Sandboxes or another provider directly. Host Git credentials and branch
advancement also stay on the authoritative host.

## Remaining GUI work

1. Expose the local daemon protocol through a small authenticated GUI bridge.
2. Render fleet snapshots with per-dimension observation times and explicit
   pending, unknown, stale, and offline states.
3. Add typed task intents and durable terminal attachment.
4. Add preview tunneling and an audit view for fleet administration.

The daemon control plane, reciprocal enrollment, peer cache, and runtime
provider boundary are the implementation prerequisites; the GUI should remain
a projection client rather than become a second authority.
