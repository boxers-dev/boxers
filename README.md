# Boxers

Boxers is a lightweight Docker Sandboxes runtime and safe Git promotion plugin
for [Herdr](https://herdr.dev/). Herdr owns panes, layouts, navigation, agent
status, notifications, and connections. Boxers owns durable Docker Sandboxes,
previews, immutable review snapshots, checks, and host-authenticated promotion.

Each agent works in a private clone. It can use Git freely, but it receives no
upstream write credentials and its commits are not authoritative. A human
promotes the exact tree shown in Boxers' interactive review pane.

## Requirements and installation

- Node.js 20 or newer and Git
- Herdr 0.9 or newer
- Docker Sandboxes (`sbx`) 0.37 or newer
- Boxers and Docker Sandboxes installed on every Herdr server machine where an
  agent will run

```sh
npm ci
npm run build
herdr plugin link /absolute/path/to/boxers
boxers doctor
```

Boxers stores runtime state in `HERDR_PLUGIN_STATE_DIR`; it does not write
durable state into the installed plugin checkout. Invoke **New sandboxed
Codex** or **New sandboxed Claude** from a Herdr workspace or pane inside a Git
repository. The resulting pane appears in Herdr's normal agent list as
`Codex (sandboxed)` or `Claude (sandboxed)`.

Docker's provider credential proxy can authenticate the model provider. Boxers
removes `SSH_AUTH_SOCK` and every `HERDR_*` variable from all `sbx` processes,
does not mount host Git credentials, and does not expose the Herdr control
socket inside the sandbox.

## Project configuration

Configuration is repository-owned at `.boxers/config.yml`. With no file,
Boxers targets the current branch's upstream and uses Codex or Claude's Docker
Sandbox defaults.

```yaml
version: 1

integration:
  remote: origin
  branch: main

agent:
  default: codex
  model: gpt-5.4
  effort: high

sandbox:
  template: docker.io/example/project-sandbox:v1

setup:
  run: npm ci
  timeout: 15m

checks:
  typecheck:
    run: npm run check
    timeout: 10m
  tests: npm test -- --run

preview:
  run: npm run dev -- --host 0.0.0.0
  ports: [3000]
  review: snapshot
  setup: npm ci
```

Only project commands (`setup.run`, each check's `run`, `preview.run`, and
`preview.setup`) are evaluated by `bash -lc` inside the sandbox. IDs, paths,
refs, ports, and all other user-controlled values are passed as distinct
process arguments.

`preview.review` defaults to `snapshot`. Choose `live` only when materializing
the reviewed tree is too expensive; the review pane labels that preview as
live and still checks workspace staleness before promotion.

## Preview, review, and promotion

Herdr exposes actions to start, show, restart, stop, and inspect preview logs.
A live preview runs as a detached sandbox-owned process from the mutable agent
workspace. Its URL is visible and emitted as an OSC 8 terminal hyperlink.

The **Review sandbox changes** action opens a Boxers terminal UI and captures
the complete candidate without modifying the agent's index: tracked, staged,
unstaged, deleted, untracked non-ignored, and already force-added ignored
files. The candidate tree and an internal transport commit are retained in the
sanitized host mirror. The UI can:

- display the diff from the recorded target to that immutable tree;
- run setup and checks in a detached worktree of that exact tree;
- start a reviewed preview bound to that tree;
- capture newer workspace changes as a new review; and
- interactively confirm publication of the selected review.

There is deliberately no direct **Promote** plugin action. Promotion requires
typed confirmation in the review pane. If the workspace changed after capture,
the UI requires the user to review the latest workspace or explicitly retain
the older snapshot. Skipping configured checks is also an explicit, persisted
decision.

Promotion runs on the trusted host under a per-project lock. It verifies the
remote, branch, target OID, configuration hash, candidate object graph, and
check identities; creates one host-authored commit containing exactly the
reviewed tree; journals that commit before pushing; and uses a non-force
refspec. Target races stop delivery. Ambiguous failures are fetched and
reconciled, and retries reuse the journaled commit rather than creating a
duplicate. The user's checkout, index, branch, and files are never changed.

After confirmed delivery, Boxers advances the sandbox with a mixed reset so
changes made after the snapshot survive as the next increment. Confirmed
delivery remains recorded if that advancement fails.

## Mirrors and restart behavior

Boxers creates clone-mode sandboxes from a sanitized mirror under plugin state,
never from the user's checkout. The mirror contains only the configured
committed target and excludes untracked and ignored files, hooks, credential
helpers, and upstream remote metadata. Docker's local `sandbox-<name>` remote
is retained solely to transport candidate objects back to the host.

Normal Herdr detach and reattach keeps the wrapper and agent alive. After a full
Herdr server restart, the plugin startup hook reconciles `sbx ls`, marks missing
or stopped sandboxes, and reopens panes only for sandboxes that are still
running. Provider-native attachment occurs through `sbx run --name` inside the
same durable sandbox. Current Herdr plugin v1 cannot restore the exact previous
split placement; the replacement opens as a plugin-owned tab. See the
[feasibility report](docs/architecture/herdr-plugin-feasibility.md).

Loopback preview URLs belong to the Herdr server machine. Until Herdr exposes a
plugin-controlled port-forward API, previews on remote Herdr machines require a
separately secured tunnel; Boxers does not misrepresent the remote URL as local.

## Development

```sh
npm run check
npm test -- --run
npm run build
```

The executable entrypoint is `src/index.ts`; the single implementation lives
under `src/herdr/`. There is no Boxers PTY daemon, fleet, SSH transport,
host-worktree manager, or parallel legacy task path.
