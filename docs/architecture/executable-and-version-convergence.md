# Executable and version convergence

Status: historical diagnosis and proposal. The shared lifecycle refactor is
recorded in [Shared command lifecycle review](shared-command-lifecycle.md),
including the implemented activation, launcher, and protocol changes. The
reproduced state and remaining projection suggestions below describe the earlier
incident.

## Summary

An interactive `boxers ls` on `home-linux-server` reported Fedora as:

```text
Remote returned an invalid task snapshot.
```

The Fedora snapshot was valid for the active fleet build. The failure happened
because `home-linux-server` had two different Boxers builds that both reported
package version `0.0.5`:

- the interactive shell resolved `boxers` through Volta to an npm installation
  from September 2;
- the daemon and managed SSH gateway used the fleet-managed stable launcher at
  `$HOME/.local/bin/boxers`, activated on September 3.

The managed build could read and display all four Fedora tasks. The older Volta
build read the same peer cache, applied its older strict decoder, and rejected
new setup fields in the embedded task state.

This is not corruption in Fedora's tasks or Docker Sandboxes. It is an
executable-convergence and wire-contract problem. Pinning background processes
to an absolute stable launcher is correct, but allowing an unrelated interactive
installation to bypass that launcher is not. The task projection protocol also
changed without changing its protocol version.

## Reproduced state

On `home-linux-server`, executable selection was:

```text
interactive shell  /home/imre/.volta/bin/boxers
daemon             /home/imre/.local/bin/boxers
managed SSH        /home/imre/.local/bin/boxers
```

The systemd unit explicitly launched the stable managed path:

```text
ExecStart=".../node" "/home/imre/.local/bin/boxers" __daemon-run
```

The forced SSH authorization also explicitly launched that path:

```text
command="env BOXERS_HOME='...' /home/imre/.local/bin/boxers remote gateway ..."
```

Both executables returned `0.0.5`, but their bundled files had different hashes.
The managed release had build ID `f3fbe105...`; the npm/Volta installation did
not represent that build.

Fedora's current task state contains setup metadata including:

```text
jobId
configHash
observedAt
source
```

The old `0.0.5` decoder allowed only the earlier setup fields and used an
exact-key check. Because the remote task projection includes the complete
persisted state as `internal.state`, any of these new fields made the entire
remote task invalid to the older executable.

The error appeared only in the Fedora direction because Fedora had tasks with
the newer state shape. `home-linux-server` had no local tasks, so the incompatible
nested decoder was not exercised in the other direction.

## Current executable flow

Boxers currently has two overlapping executable-selection mechanisms.

### Interactive and bootstrap discovery

Initial remote discovery executes literal `boxers` through the remote shell's
`PATH`. If its reported package version equals the local package version, Boxers
accepts that installation. `remote identity` then advertises
`BOXERS_EXECUTABLE`, `process.argv[1]`, or `boxers`, in that order. Connection
setup records the selected executable in fleet membership and may install the
daemon service from the currently executing local path.

This means a package-manager shim, tool-manager selection, or development
invocation can become a persisted executable choice. Boxers does not deliberately
look at the current working directory when selecting a production executable,
but tools such as Volta or `direnv` can change resolution by project. Recording
the resolved invocation makes that external choice durable.

### Managed activation

Fleet release activation installs content-addressed releases and atomically
repoints `$HOME/.local/bin/boxers`. It then rewrites managed SSH authorizations
and the daemon service to use this stable launcher. Lazy daemon startup also
prefers the active managed executable.

This mechanism is appropriate for background operation:

- systemd and forced SSH commands do not have the interactive login `PATH`;
- the forced SSH entry deliberately disables user startup files;
- an absolute launcher avoids shell aliases and project-specific tool shims;
- an atomic symlink provides an exact activation and rollback boundary;
- managed SSH must not run an arbitrary executable found through a mutable
  environment.

The problem is not the override itself. The problem is that only managed
operations honor it, while a full second CLI remains reachable interactively.

## Current identity and protocol fields

The code uses several identifiers with distinct purposes:

| Identifier                 | Current purpose                                               |
| -------------------------- | ------------------------------------------------------------- |
| Package version            | Human-facing release name and upgrade/downgrade ordering      |
| Build ID                   | Hash-derived identity of the exact release manifest and files |
| Daemon Boxers version      | Package version reported by the daemon binary                 |
| Daemon protocol version    | CLI-to-local-daemon message compatibility                     |
| Task-view protocol version | Host-to-host projection compatibility                         |
| Watch protocol version     | Peer invalidation stream compatibility                        |
| Persisted state versions   | On-disk schema compatibility for individual records           |

The daemon does not have an independent semantic version. Its reported Boxers
version is the package version of the executable that launched it. Calling this
field `daemon version` makes the model appear more complicated than it is; it is
really `daemonPackageVersion`.

### Why package version is insufficient

The release builder intentionally supports packaging a local development
checkout. It builds the checkout but retains the version in `package.json`.
Consequently, materially different release capsules can all report `0.0.5`.

The build ID is therefore necessary under the current workflow. It provides:

- exact artifact identity even when package versions match;
- content verification before activation;
- fleet convergence on the same files, not merely the same label;
- safe supersession checks and rollback to a known artifact.

Package version could replace build identity only if every distributable code
change received a unique immutable package version and development snapshots
were no longer distributable. Even then, a content hash would remain useful for
integrity verification.

### Why protocol versions are still useful

A package version and a protocol version answer different questions:

- package version: "Which product release is this?"
- build ID: "Which exact executable content is this?"
- protocol version: "Can these two processes understand each other?"

Daemon and peer protocols can evolve independently. Using the package version as
the protocol version would make every release incompatible, even when its wire
format had not changed, and would make rolling fleet upgrades harder.

The current implementation nevertheless weakens this benefit. It requires the
daemon package version to equal the CLI package version even after successful
protocol negotiation, while it does not consistently use build ID for the same
check. Conversely, the peer task schema changed while its protocol remained at
version 3. The result is both over-strict and under-versioned.

## Root causes

The incident has five contributing causes:

1. **Two production entry points.** The interactive npm/Volta CLI and the
   managed stable launcher can execute different code against the same
   `BOXERS_HOME`.
2. **Package equality is treated as build equality.** Bootstrap accepts a remote
   executable when only its package version matches, even though local fleet
   builds can reuse that version.
3. **The public projection leaks internal persisted state.** Peer snapshots carry
   the complete `TaskState`, coupling the remote wire format to setup, check,
   lifecycle, and persistence implementation details.
4. **A breaking schema change did not bump the task-view protocol.** Strict
   validation correctly detected a shape it did not understand, but protocol
   negotiation had already declared the hosts compatible.
5. **Diagnostics discard the failing path.** The reader reports only "invalid
   task snapshot", without the host, task ID, or invalid field.

## Proposed target design

### 1. One authoritative production launcher

After managed installation exists, `$HOME/.local/bin/boxers` should be the
authoritative executable for all production commands on that host.

- systemd and managed SSH should continue using its absolute path;
- normal interactive invocation should run or delegate to it;
- the current working directory and tool-manager selection must not choose a
  second implementation against the same state directory;
- development-source execution must be explicit and visibly identified as a
  development build.

There are two reasonable ways to enforce this:

1. Put the managed launcher first on `PATH` and make installation verify that
   `command -v boxers` resolves to it.
2. Make published/npm launchers detect an active managed installation and
   hand off to it before reading or mutating Boxers state.

The second is more robust because users cannot always control tool-manager
precedence. A noncanonical executable that cannot safely delegate should stop
with an actionable error showing both paths and build IDs. It must not continue
against the shared state directory.

Development commands need an explicit escape hatch. For example, `npm run dev`
can retain source execution, while distribution from a checkout can be an
explicit `update --from-current-checkout` operation. A development executable
should not silently reinstall the production daemon merely because it happened
to run `connect` or another ordinary command.

### 2. Make build ID the operational equality boundary

Every executable involved in managed operation should expose its exact build ID:

- remote identity;
- daemon hello and health record;
- fleet member observation;
- CLI diagnostics.

Bootstrap and daemon readiness should compare build IDs when a managed build is
active. Package version remains useful for display and release ordering, but
must never prove that two executables contain the same code.

Source or unmanaged builds should expose a clear identity such as
`dev:<git-oid>:<dirty-state>` or an artifact hash rather than pretending package
version alone identifies them.

### 3. Stop exporting persisted `TaskState` to peers

The host-to-host snapshot should contain only the stable public projection
needed by list/status/GUI consumers. The current `TaskView`, stable IDs,
observation timestamps, runtime handle, and narrowly defined routing metadata
are sufficient for existing consumers.

`internal.state` should be removed from peer snapshots. If a local debugging or
inspection API needs it, expose it through a separate local-only endpoint or an
explicit diagnostic command. Do not validate the host's private persistence
schema as part of the fleet display protocol.

This change reduces compatibility risk and avoids exposing internal log paths,
job identifiers, and future orchestration details to every observing host.

### 4. Version wire contracts at their actual boundaries

Keep internal protocol/schema versions, but use them consistently:

- bump the task-view protocol for a breaking public projection change;
- support the previous protocol during a bounded rolling-upgrade window where
  practical;
- treat optional additive fields as forward-compatible when readers can safely
  ignore them;
- keep strict validation for required fields and security-sensitive commands;
- do not bump daemon protocol for an implementation change that leaves messages
  compatible.

Protocol versions should usually remain an internal diagnostic. Users should
see them only when explaining an actual incompatibility.

The existing task-view protocol should be bumped from 3 when removing
`internal.state` or otherwise redefining the public envelope. During transition,
new readers can accept protocol 3 and discard `internal`, while new writers emit
the new minimal protocol.

### 5. Make validation errors actionable

Snapshot decoding should report a structured path, for example:

```text
Fedora task fix-500 is incompatible with this Boxers build:
tasks[0].internal.state.setup.jobId is not supported by task-view protocol 3.
Local build: b4f5d7b1; remote build: f3fbe105.
```

An incompatible known schema should produce connection state `incompatible`,
not `error`. `error` should be reserved for malformed data that violates the
declared schema.

### 6. Simplify user-facing terminology

Expose two versions in normal diagnostics:

```text
Boxers 0.0.5 (build f3fbe105)
```

When the daemon differs, say:

```text
CLI build f3fbe105; daemon build b4f5d7b1
```

Call the daemon's semantic field `packageVersion`, not `daemonVersion`. Show
protocol values only as supporting detail for a compatibility failure.

## Suggested implementation sequence

### Phase 1: diagnostics and containment

1. Add the active and invoked executable paths and build IDs to `doctor` and
   `daemon status`.
2. Before ordinary commands access state, detect a noncanonical executable while
   a managed activation exists. Delegate or fail with a precise remediation.
3. Add task ID and validation path to snapshot decoding errors.
4. Add regression coverage for two executables with the same package version but
   different build IDs.

This phase prevents another silent split without changing the wire format.

### Phase 2: executable convergence

1. Add build ID to remote identity and daemon hello.
2. Compare build identity during connection/bootstrap and daemon readiness.
3. Ensure connect, service installation, managed SSH authorization, lazy daemon
   startup, and interactive delegation all converge on the stable launcher.
4. Make development execution explicit and prevent it from silently becoming a
   production service path.

### Phase 3: projection boundary cleanup

1. Define a minimal public remote-task schema independent of `TaskState`.
2. Remove `internal.state` from peer snapshots.
3. Increment the task-view protocol and implement the intended transition policy.
4. Test mixed-build rolling upgrades in both directions, including hosts with no
   tasks, active tasks, setup/check records, and stale caches.

### Phase 4: terminology and dead-path cleanup

1. Rename daemon version fields to package-version terminology.
2. Remove package-version equality checks that duplicate stronger build/protocol
   checks.
3. Audit identity, watch, daemon, peer snapshot, persisted-state, and capsule
   version fields. Keep each only where it protects an independently evolving
   serialized boundary.

## Acceptance criteria

- Running `boxers` from different working directories reaches the same active
  production build.
- Interactive CLI, daemon, and managed SSH report the same build ID after fleet
  activation.
- A stale npm/Volta installation cannot read or mutate the managed installation's
  state without delegation or an explicit error.
- Two builds with the same package version are never considered equal solely
  because that version matches.
- Internal `TaskState` changes do not alter the peer task-view protocol.
- Every breaking public projection change increments or negotiates the relevant
  protocol version.
- Mixed-version peers either interoperate through a documented compatibility
  window or report `incompatible` with both build identities and the failing
  protocol.
- Snapshot diagnostics identify the machine, task, and invalid field.

## Recommended decision

Retain package version, exact build ID, and independently scoped internal
protocol versions. Do not collapse all three into the package version.

At the same time, collapse executable selection to one authoritative managed
launcher, remove full persisted state from the peer protocol, compare exact
builds where equality matters, and hide protocol details unless diagnosing a
real compatibility problem. This preserves the useful safety properties without
allowing multiple same-version implementations to operate on one Boxers state.
