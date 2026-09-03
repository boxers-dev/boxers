# boxers

Boxers runs Codex and Claude in durable, isolated Docker Sandboxes. Each task
gets its own workspace and keeps the agent's native session, so closing a
terminal or losing an SSH connection does not stop the work.

## Quick start

Boxers requires Node.js 20+, Git, and a
[Docker Sandboxes host](https://docs.docker.com/ai/sandboxes/get-started/).

```sh
npm install -g @boxers-dev/boxers
boxers init
```

`boxers init` prepares the machine, checks Docker Sandboxes, and guides you
through agent authentication.

In a Git repository:

```sh
boxers project init
git add .boxers/config.yml
git commit -m "Configure boxers"

boxers fix-parser new
```

Project setup asks how completed work should be integrated, which agent to use,
and whether the project needs previews or automated checks. After that, a task
name followed by `new` opens the agent.

Press Ctrl-C to detach. The task and conversation keep running in the
background; attach again whenever you want.

## Tasks

```sh
boxers list
boxers fix-parser status
boxers fix-parser attach
```

Task names are unique on a machine, and task commands can be run from any
directory. Status and list use one structured view: agent activity, Boxers
operations, setup, reconciliation, changes, checks, delivery, removal safety,
specific issues, and concrete next commands are reported independently. A
finished provider turn is shown as `Agent: Ready for input`, not as a generic
failure or attention flag. Plain status and list read recorded state; use
`status --refresh` when workspace facts are unknown or stale.

For example, the compact list and detailed status agree on the same facts:

```text
MACHINE  PROJECT  TASK        AGENT            CHANGES  CHECKS  NEXT
local    boxers   fix-parser  Ready for input  Unmerged Passed  review

fix-parser

Agent: Ready for input
Changes: Unmerged changes can be promoted
Checks: All checks passed for the current changes
Removal: Cannot be discarded safely - unmerged changes remain
```

When the work is ready:

```sh
boxers fix-parser review
boxers fix-parser check
boxers fix-parser promote
```

- `review` shows the exact candidate diff without running checks.
- `check` runs the checks selected during project setup.
- `promote` verifies the candidate and integrates it. Local projects receive
  a commit on the configured branch; remote projects receive a pushed task
  branch ready for a pull request.

`promote` runs required checks itself, so `review` and `check` are useful but
not mandatory steps.

Other useful task commands:

```sh
boxers fix-parser sync
boxers fix-parser preview
boxers fix-parser preview logs
boxers fix-parser setup
boxers fix-parser discard
```

`sync` reconciles a task with its configured base. Preview commands are
available when preview support was enabled for the project. If task setup fails
or times out, inspect the setup log shown by `status`, repair the cause in the
existing agent session, and run `setup` to retry the configured command.

```text
Setup: Failed after 2 attempts
Issues:
  Setup failed after 2 attempts.
  Log: ~/.local/state/boxers/.../setup.log
Next:
  boxers fix-parser setup    Diagnose the setup log, then rerun setup.
```

`discard` uses the recorded removal disposition: a causally current clean Git
observation takes the fast path without setup, reconciliation, checks, or
another Sandbox inspection; unmerged work requires promotion or `--force`.
After a verified delivery, status reports `Removal: Can be discarded safely`
and offers `boxers fix-parser discard` without another workspace inspection.

To see the available task environments:

```sh
boxers list templates
```

## Multiple machines

Connect another Boxers machine over SSH:

```sh
boxers connect build-box
boxers hosts
boxers list
```

Give an already connected machine a new fleet-wide name without reconnecting it:

```sh
boxers hosts rename <machine> <new-name>
```

`<machine>` may be its current name, ID, or SSH endpoint. The new name is stored
on the owning machine and propagated to the rest of the fleet. Use `local` to
rename the machine running the command.

On the first connection, Boxers installs the matching CLI release in the
remote user's account and opens the normal interactive machine setup over SSH.
That setup installs and authenticates Docker Sandboxes, initializes its network
policy, offers agent authentication, and installs the daemon. Successful setup
is recorded on the remote machine, so later connections skip it.

The initial connection uses your normal interactive SSH authentication. During
enrollment, each machine creates a dedicated Ed25519 key under its Boxers state
directory and the machines authorize those keys reciprocally. Background
reconnections always select the Boxers key explicitly, so they do not depend on
a desktop keyring, a forwarded agent, or an unlocked personal key. The
authorized key is forced through the Boxers command gateway and cannot be used
for SSH forwarding or arbitrary shell commands.

`list` includes tasks from connected machines. Prefix a remote task with its
machine name:

```sh
boxers build-box/fix-parser attach
boxers build-box/fix-parser review
boxers build-box/fix-parser promote
```

To create a remote task, run `new` from the current project and prefix the task
with the machine:

```sh
boxers build-box/fix-parser new
```

Boxers identifies an existing registration on `build-box` from the project's
canonical Git clone source. If it is not registered there yet, Boxers reuses
the current project's configured clone URL and base branch, then clones and
initializes it under the remote machine's state directory at
`$BOXERS_HOME/checkouts/my-project` (normally
`~/.local/state/boxers/checkouts/my-project`). Existing registered projects are
reused. The clone deliberately uses Git and Git credentials on the remote host;
Boxers does not forward personal SSH keys from the initiating machine. It names
the remote account before cloning and disables interactive Git credential
prompts, so a passphrase request cannot be mistaken for a local one. If access
is not configured, connect to that host and verify `git ls-remote <clone-url>`.
For an SSH clone URL, the remote account's key must be usable non-interactively,
for example through an SSH agent available to non-interactive sessions.

To choose the checkout location when Boxers first provisions the project, pass
an absolute remote path:

```sh
boxers build-box/fix-parser new --remote-path /srv/projects/my-project
```

Both SSH targets must be reachable from their reciprocal machine. Boxers uses
standard SSH host aliases, so stable LAN DNS or an overlay network such as
Tailscale can provide the addresses for laptops that move between networks.

Update Boxers as one fleet:

```sh
boxers update
```

Boxers first checks npm for a newer official release and offers to install it
on the local machine. It then distributes the exact active application build
to every connected machine. Runtime dependencies are installed separately on
each host, so native packages such as `node-pty` match that host's operating
system, CPU architecture, and Node.js ABI. Connected hosts use npm for
dependencies only when their required runtime layer is missing; the initiating
machine also uses npm for the optional official-release check.

The selected build is recorded as durable fleet state. An offline machine is
reported as pending and updates automatically after reconnecting by fetching
the cached application payload from an updated peer. A machine that still has
the legacy gateway performs one final npm bootstrap before joining this flow.
A newer `boxers update` supersedes an older pending rollout. Updating replaces
the owning-host daemon in one bounded passage. This detaches viewers, stops
daemon-owned providers and in-flight orchestration, and starts the new build;
the next attach resumes provider-native history and interrupted recomputable
work is observed or rerun. Boxers never downgrades a newer official release
without an explicit fleet-wide confirmation.

When Boxers is run from its own source checkout, `boxers update` builds that
checkout automatically and distributes the resulting development build. No
publish or package step is required.

## Health and authentication

```sh
boxers status
boxers doctor
boxers auth status
boxers auth codex
boxers auth claude
boxers auth status --host gpu-builder --refresh
boxers auth codex --host gpu-builder --api-key
boxers auth claude --host gpu-builder
boxers project status
```

`status` is the overview for this machine and connected hosts. `doctor`
performs detailed live diagnostics. Run the relevant `auth` command whenever
an agent needs to be connected again. Authentication state belongs to the host
that runs the Sandbox: remote API credentials are entered on that host through
the restricted fleet connection and are never forwarded from the initiating
machine.

ChatGPT and Claude subscription sessions can instead live inside an individual
durable task Sandbox. When a task is created or attached without a usable host
credential or task-local login, Boxers offers the provider-native flow before
starting the agent: Codex device login or `claude auth login --claudeai`. It
then runs the provider's native status command to verify the login. This also
makes an existing task recover cleanly after its subscription session is
logged out without replacing its resumable conversation.

Codex's global ChatGPT OAuth flow uses a localhost browser callback and is not
available through the restricted fleet SSH connection. Use task-local device
login for ChatGPT subscription access, or `--api-key` for a reusable remote-host
credential.

For lower-level troubleshooting:

```sh
boxers daemon status
boxers daemon restart --host old-framework-ubuntu
boxers debug daemon
boxers debug shell fix-parser
```

`daemon restart --host <machine>` uses the managed fleet SSH transport, so no
separate interactive SSH login is required. Remote daemon control requires the
fleet `admin` role. Add `--force` only when interrupting daemon-owned work on
that host is acceptable.

## Safety model

Sandboxes are created from committed, tracked project files only. Untracked
files, Git credentials, hooks, and remote metadata from the real checkout are
not copied into a task. Promotion happens through Git on the host, where Boxers
can verify the expected branch and avoid overwriting unrelated local work.

## Development

```sh
npm install
npm run build
npm run check
npm test
```
