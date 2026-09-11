# Herdr plugin feasibility spike

This spike follows the current Herdr `0.9` plugin-v1 contract and the current
Docker Sandboxes CLI documentation, checked on 2026-09-10:

- <https://herdr.dev/docs/plugins/>
- <https://herdr.dev/docs/session-state/>
- <https://herdr.dev/docs/integrations/>
- <https://docs.docker.com/ai/sandboxes/usage/>
- <https://docs.docker.com/ai/sandboxes/workflows/git/>
- <https://docs.docker.com/ai/sandboxes/configuration/credentials/>
- <https://developers.openai.com/codex/cli/reference/>

## Result

The vertical slice is feasible with one important restoration limitation.

- Plugin v1 supports static actions, startup hooks, and Herdr-managed terminal
  panes. Boxers uses fixed agent, preview, and review entrypoints and passes
  only opaque task IDs through pane environment variables.
- `HERDR_AGENT=codex|claude` makes the host-visible attach wrapper use Herdr's
  normal screen manifest. The wrapper reports display metadata; it does not
  expose the Herdr socket or CLI to the sandbox.
- Detach and reattach preserve the wrapper and sandbox agent because the Herdr
  server and PTY remain live.
- A full ordinary server restart kills arbitrary pane processes. Herdr's native
  provider restoration cannot be used because it would run `codex resume` or
  `claude --resume` on the host. The startup hook instead reconciles durable
  sandboxes and opens replacement agent tabs whose wrappers reattach with
  `sbx run --name`. The replacement tab may not occupy the exact former split.
- Experimental Herdr live handoff preserves the original wrapper process. The
  reconciler detects that live pane and avoids opening a duplicate.

The smallest useful upstream extension is a plugin-owned pane restoration
entrypoint: persist the pane entrypoint ID and plugin-owned environment, then
relaunch that entrypoint in the restored pane. Until that exists, the startup
hook is the supported recovery path.

This development environment contained neither `herdr` nor `sbx`, so live
detach/restart and port-publication exercises remain machine acceptance tests.
Automated tests cover the manifest, invocation context, trust-plane
environment, mirror sanitization, host-checkout non-mutation, and immutable
candidate capture.

## Security findings

Docker Sandboxes enables SSH-agent forwarding by default when its client has
`SSH_AUTH_SOCK`. Every Boxers `sbx` invocation uses a sanitized environment
without that socket. It also removes the raw Herdr socket, binary path, and
invocation context before entering the Docker CLI process.

Clone mode copies remotes from the source repository and exposes that source
read-only at `/run/sandbox/source`. Boxers creates clone-mode sandboxes only
from its plugin-state mirror. The mirror is fetched by URL without recording an
upstream remote, contains only the selected committed tree, and has no checkout
hooks or local credential helper. Docker's local `sandbox-<name>` remote is
retained because it transports immutable candidate objects to the host and has
no upstream publication authority.

## Manual acceptance exercise

1. Build Boxers and run `herdr plugin link /path/to/boxers`.
2. Invoke **New sandboxed Codex** in a disposable Git workspace. Confirm the
   pane label and that `/run/sandbox/source` has no real-checkout secrets.
3. Detach and reattach Herdr. Confirm the wrapper PID remains.
4. Stop and restart the server. Confirm the startup hook opens one replacement
   tab and resumes in the same named sandbox.
5. Start preview and open its visible URL.
6. Change tracked and untracked files, inspect the review diff, and promote to
   a disposable bare remote.
7. Race the target. Promotion must stop and require a new review.
8. Interrupt after an accepted push. Reopening review must reuse the journaled
   commit and must not publish a duplicate.
