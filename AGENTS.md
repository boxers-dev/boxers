# boxers Codebase Guide

## Project overview

`boxers` is a TypeScript CLI that manages durable Codex and Claude tasks in
Docker Sandboxes. Docker Sandboxes owns each isolated workspace and the agent's
native session. Boxers owns host-side project/task metadata, optional
checks, review snapshots, and promotion into a local branch or remote.

There is one architecture: Sandbox-native tasks. Do not add a second execution
or migration path.

The `boxers` executable starts in `src/index.ts`, delegates parsing to
`src/cli.ts`, and is bundled as `dist/index.mjs`.

## Boundaries

- Project: a registered Git checkout plus its integration mode and sanitized
  seed repository.
- Task: a user-facing name mapped to one `boxers-<project>-<task>` Docker Sandbox.
- Agent: Codex or Claude, launched through the Sandbox-native agent command.
- Session: provider history stored inside the durable Sandbox. Attach resumes
  the recorded provider session; it must not create a fresh conversation.
- Review: captures and displays the exact candidate without running checks.
- Check: optional setup and configured checks execute in the Sandbox and stream
  output to the terminal and host-side logs.
- Promotion: Boxers snapshots the exact Sandbox working tree, then host Git
  creates and advances the reviewed commit. Agents do not receive host Git
  credentials.

Sandboxes are created from an application-owned seed containing committed,
tracked content only. The real checkout's untracked/ignored files, hooks,
credential helpers, and remote metadata must never be copied into a Sandbox.

## Source layout

- `src/cli.ts`: usage, parsing, and command routing.
- `src/core/`: small shared output and version helpers.
- `src/v2/commands.ts`: project/task lifecycle, review, reconciliation, preview,
  and merge orchestration.
- `src/v2/auth.ts`: provider credentials and authentication prompts.
- `src/v2/config.ts`: strict `.boxers/config.yml` parsing.
- `src/v2/init.ts`: repository command detection and config rendering.
- `src/v2/paths.ts`: state paths and atomic JSON writes.
- `src/v2/process.ts`: captured and streaming child processes.
- `src/v2/registry.ts`: project/task manifests and sanitized seeds.
- `src/v2/sandbox.ts`: the `sbx` adapter and workspace Git operations.
- `src/v2/session.ts`: provider-specific launch, resume, and trust arguments.
- `src/v2/types.ts`: persisted and runtime data contracts.
- `test/v2/`: Vitest specs mirroring the modules above.

Keep orchestration in `commands.ts` and reusable behavior in the focused module
that owns it. Do not build Docker resource names or state paths inline.

## Command surface

Project commands:

- `boxers doctor [--agent codex|claude] [--json]`
- `boxers auth codex|claude`
- `boxers init` with optional integration and feature switches

Task commands:

- `boxers <task> new --agent codex|claude [--prompt <text>] [-d]`
- `boxers list [--json]`
- `boxers <task> attach|inspect|review|check|merge|sync|stop|shell|rm`
- `boxers <task> preview [start|stop|restart|logs]`

Keep `README.md`, the `src/cli.ts` usage text, parsing tests, and behavior in
sync whenever the surface changes.

## Development

- `npm run dev -- <command>`: run from TypeScript source.
- `npm run build`: bundle the executable.
- `npm run check`: run Oxlint and TypeScript.
- `npm test`: run Vitest.
- `npm run format`: format the repository.

Run `npm run check` for ordinary validation. Add focused tests for CLI parsing,
manifest persistence, Sandbox arguments, session continuity, reconciliation,
streaming processes, and promotion behavior.

## Implementation rules

- Docker Sandboxes is a rapidly evolving product. Before changing Sandbox,
  template, kit, `sbx` CLI, security, or lifecycle behavior, check the current
  official Docker Sandboxes documentation and CLI reference; do not rely on
  remembered behavior or an older boxers implementation.
- Treat persisted Git OIDs and the reviewed tree as the promotion boundary.
- Keep networked Git authentication and branch advancement on the host.
- Shell commands from project config are intentionally executed with
  `bash -lc` inside the Sandbox; pass all other user-controlled values as
  discrete process arguments.
- Use captured process results for expected failures. Throw only when the
  caller cannot continue safely.
- Stream long-running setup and check output as it arrives and retain the same
  bytes in restricted host-side log files.
- Preserve Codex trust/full-access arguments and Claude permission arguments;
  the Docker Sandbox is the security boundary.
- Preserve provider-native resume behavior and the `sessionStartedAt` marker.
- Never overwrite unrelated user work in the host checkout. Local promotion
  requires the configured branch, expected HEAD, and a clean worktree; remote
  promotion must remain fast-forward-only.
