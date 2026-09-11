# Boxers Codebase Guide

## Product

Boxers is a TypeScript Docker Sandboxes runtime and Git promotion plugin for
Herdr. There is one Herdr-native architecture. Do not restore a Boxers PTY
daemon, terminal viewer, fleet, SSH transport, task projection, host worktree,
or parallel compatibility path.

Herdr owns panes, layouts, reattachment, agent presentation, status,
notifications, navigation, and machine connections. Boxers owns sanitized
project mirrors, durable named sandboxes, pane mappings, preview jobs,
immutable review trees, exact-tree checks, and crash-safe host promotion.

## Layout

- `herdr-plugin.toml`: static actions, startup hook, and pane entrypoints.
- `src/index.ts`: small executable surface and internal plugin dispatch.
- `src/herdr/plugin.ts`: Herdr action and terminal-UI orchestration.
- `src/herdr/sandbox.ts`: current `sbx` adapter, trust boundary, pane wrapper,
  and lifecycle reconciliation.
- `src/herdr/mirror.ts`: target resolution and sanitized mirrors.
- `src/herdr/review.ts`: capture, checks, target reconciliation, promotion,
  journals, and delivery recovery.
- `src/herdr/preview.ts`: detached live and reviewed previews.
- `src/herdr/config.ts`, `state.ts`, `types.ts`: strict config and atomic state.
- `test/v2/herdr-plugin.test.ts`: focused integration-style tests.

## Invariants

- Strip `SSH_AUTH_SOCK` and every `HERDR_*` variable from all `sbx` processes.
  Never put upstream Git credentials or unrestricted Herdr control inside a
  sandbox.
- Create clone-mode sandboxes only from a mirror containing committed target
  content. Never copy the user's worktree, ignored files, hooks, credential
  configuration, or upstream remote metadata.
- The immutable reviewed tree is the promotion boundary. Checks and reviewed
  previews bind to target OID, tree OID, and configuration hash.
- Project commands intentionally use `bash -lc` in the sandbox. Pass all other
  user-controlled data as discrete arguments.
- Promotion is interactive, host-authenticated, fast-forward-only, journaled
  before push, and idempotent after ambiguous results. Never mutate the user's
  checkout and never duplicate a confirmed increment.
- Preserve changes created after a review when advancing a delivered sandbox.
- Before changing Docker Sandbox lifecycle, templates, CLI arguments, or
  security behavior, verify the current official Docker documentation.

## Development

Use `npm run check`, `npm test -- --run`, and `npm run build`. Keep the manifest,
README, executable surface, and tests synchronized. Boxers' dependency setup may
run in the background; inspect `.git/boxers/setup-status` and wait while it says
`running` before testing.
