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
directory.

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
boxers fix-parser discard
```

`sync` reconciles a task with its configured base. Preview commands are
available when preview support was enabled for the project. `discard` removes
a task and refuses to lose unpromoted work.

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

To create a remote task, include the machine, project, and new task name:

```sh
boxers build-box/my-project/fix-parser new
```

When this command is run from the matching local project, Boxers reuses the
project's configured Git clone URL and base branch. If the project is not yet
registered on `build-box`, it is cloned and initialized automatically under
the remote machine's Boxers state directory at
`$BOXERS_HOME/checkouts/my-project` (normally
`~/.local/state/boxers/checkouts/my-project`). Existing registered projects are
reused. The clone deliberately uses Git on the remote host, so the command
fails with Git's error if that host cannot reach the repository or its Git
credentials are not configured.

For a different checkout location, provision the project explicitly first:

```sh
boxers project add build-box --clone --into /srv/projects/my-project
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
A newer `boxers update` supersedes an older pending rollout. Existing agent
sessions continue until a provider-confirmed safe daemon handoff boundary.
Boxers never downgrades a newer official release without an explicit
fleet-wide confirmation.

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
boxers project status
```

`status` is the overview for this machine and connected hosts. `doctor`
performs detailed live diagnostics. Run the relevant `auth` command whenever
an agent needs to be connected again.

For lower-level troubleshooting:

```sh
boxers daemon status
boxers debug daemon
boxers debug shell fix-parser
```

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
