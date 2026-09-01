import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RESET_INPUT_MODES,
  ansi,
  colorEnabled,
  resetTerminalInputModes,
} from "../../src/core/ansi.ts";
import {
  createSandbox,
  parseSandboxList,
  publishPorts,
  publishedUrls,
  runSandboxSetupStreaming,
} from "../../src/v2/sandbox.ts";
import {
  agentArguments,
  repairAgentArguments,
  terminalTitleSequence,
} from "../../src/v2/session.ts";
import type { TaskManifest } from "../../src/v2/types.ts";

const cleanup: string[] = [];
const originalPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.SBX_ARGS;
  delete process.env.SBX_ACTIVITY;
  delete process.env.SBX_PORT_STATE;
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("terminal cleanup", () => {
  it("selects color from terminal and standard environment controls", () => {
    expect(colorEnabled({ isTTY: true }, {})).toBe(true);
    expect(colorEnabled({ isTTY: false }, {})).toBe(false);
    expect(colorEnabled({ isTTY: false }, { FORCE_COLOR: "1" })).toBe(true);
    expect(colorEnabled({ isTTY: true }, { NO_COLOR: "" })).toBe(false);
    expect(ansi(1, "Review", true)).toBe("\x1b[1mReview\x1b[0m");
    expect(ansi(1, "Review", false)).toBe("Review");
  });

  it("disables input reporting and restores the cursor on a TTY", () => {
    const writes: string[] = [];
    resetTerminalInputModes({ isTTY: true, write: (value) => writes.push(value) });

    expect(writes).toEqual([RESET_INPUT_MODES]);
    for (const mode of [
      "?1004l",
      "?2004l",
      "?1000l",
      "?1002l",
      "?1003l",
      "?1006l",
      "?1015l",
      "?1007l",
      "?25h",
    ])
      expect(RESET_INPUT_MODES).toContain(`\x1b[${mode}`);
  });

  it("does not write escape sequences when output is redirected", () => {
    const writes: string[] = [];
    resetTerminalInputModes({ isTTY: false, write: (value) => writes.push(value) });
    expect(writes).toEqual([]);
  });
});

describe("Sandbox adapter", () => {
  it("reuses a published preview mapping and preserves its reported host", () => {
    const bin = mkdtempSync(join(tmpdir(), "boxers-sbx-ports-bin-"));
    const state = join(bin, "published");
    const calls = join(bin, "calls");
    cleanup.push(bin);
    writeFileSync(
      join(bin, "sbx"),
      `#!/bin/sh
printf '%s\n' "$*" >> "$SBX_ARGS"
if [ "$1" != ports ]; then exit 0; fi
if [ "$3" = --publish ]; then touch "$SBX_PORT_STATE"; exit 0; fi
if [ "$3" = --json ]; then
  if test -f "$SBX_PORT_STATE"; then
    printf '{"ports":[{"host_address":"127.0.0.1","host_port":45173,"sandbox_port":5173}]}\n'
  else
    printf '{"ports":[]}\n'
  fi
fi
`,
    );
    chmodSync(join(bin, "sbx"), 0o755);
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    process.env.SBX_ARGS = calls;
    process.env.SBX_PORT_STATE = state;
    const task: TaskManifest = {
      version: 3,
      id: "task-id",
      projectId: "project-id",
      name: "task",
      runtime: { kind: "docker-sandboxes", id: "boxers-project-task" },
      agent: "codex",
      sessionMode: "native",
      lifecycleBridgeToken: "0123456789abcdef0123456789abcdef",
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    expect(publishPorts(task, [5173])).toEqual(["http://localhost:45173"]);
    expect(publishPorts(task, [5173])).toEqual(["http://localhost:45173"]);
    expect(publishedUrls(task)).toEqual(["http://localhost:45173"]);
    expect(readFileSync(calls, "utf8").match(/--publish 5173/g)).toHaveLength(1);
  });

  it("passes setup commands as a discrete argument to the logging wrapper", async () => {
    const bin = mkdtempSync(join(tmpdir(), "boxers-sbx-setup-bin-"));
    const output = join(bin, "args.txt");
    cleanup.push(bin);
    writeFileSync(
      join(bin, "sbx"),
      `#!/bin/sh
last=
for arg do last=$arg; done
printf '%s\n%s\n' "$#" "$last" > "$SBX_ARGS"
`,
    );
    chmodSync(join(bin, "sbx"), 0o755);
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    process.env.SBX_ARGS = output;
    const task: TaskManifest = {
      version: 3,
      id: "task-id",
      projectId: "project-id",
      name: "task",
      runtime: { kind: "docker-sandboxes", id: "boxers-project-task" },
      agent: "codex",
      sessionMode: "native",
      lifecycleBridgeToken: "0123456789abcdef0123456789abcdef",
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    await expect(
      runSandboxSetupStreaming(task, "npm ci && printf 'ready\\n'"),
    ).resolves.toMatchObject({ status: 0 });
    expect(readFileSync(output, "utf8")).toBe("7\nnpm ci && printf 'ready\\n'\n");
  });

  it("accepts array and wrapped sbx ls shapes", () => {
    expect(parseSandboxList([{ name: "one", status: "running", agent: "codex" }])).toEqual([
      { name: "one", status: "running", agent: "codex" },
    ]);
    expect(
      parseSandboxList({ sandboxes: [{ Name: "two", Status: "stopped", Ports: [] }] }),
    ).toEqual([{ name: "two", status: "stopped", ports: [] }]);
  });

  it("ignores malformed rows", () => {
    expect(parseSandboxList({ sandboxes: [{ name: 3 }, null] })).toEqual([]);
  });

  it("passes current clone flags and paths as discrete sbx arguments", () => {
    const progress = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const bin = mkdtempSync(join(tmpdir(), "boxers-sbx-bin-"));
    cleanup.push(bin);
    const executable = join(bin, "sbx");
    const output = join(bin, "args");
    writeFileSync(
      executable,
      '#!/bin/sh\nprintf "%s" "$1" >> "$SBX_ARGS"\nshift\nfor arg in "$@"; do printf " <%s>" "$arg" >> "$SBX_ARGS"; done\nprintf "\\n" >> "$SBX_ARGS"\n',
    );
    chmodSync(executable, 0o755);
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    process.env.SBX_ARGS = output;
    const task: TaskManifest = {
      version: 3,
      id: "task-id",
      projectId: "project-id",
      name: "task",
      runtime: { kind: "docker-sandboxes", id: "boxers-project-task" },
      agent: "codex",
      template: "ghcr.io/boxers-dev/boxers-templates:codex-tauri",
      sessionMode: "native",
      lifecycleBridgeToken: "0123456789abcdef0123456789abcdef",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    createSandbox(task, "/seed path/with spaces");
    expect(readFileSync(output, "utf8").trim().split("\n").at(-1)).toBe(
      "create <--clone> <--no-share-skills> <--name> <boxers-project-task> <--template> <ghcr.io/boxers-dev/boxers-templates:codex-tauri> <codex> </seed path/with spaces>",
    );
    expect(progress.mock.calls.map((call) => String(call[0])).join("")).toContain(
      "The first use may download its template",
    );
    progress.mockRestore();
  });

  it("opts out of shared skills when the installed sbx supports it", () => {
    const progress = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const bin = mkdtempSync(join(tmpdir(), "boxers-sbx-skills-bin-"));
    cleanup.push(bin);
    const executable = join(bin, "sbx");
    const output = join(bin, "args");
    writeFileSync(
      executable,
      '#!/bin/sh\nif [ "$1" = create ] && [ "$2" = --help ]; then printf "  --no-share-skills\\n"; exit 0; fi\nprintf "%s" "$1" >> "$SBX_ARGS"\nshift\nfor arg in "$@"; do printf " <%s>" "$arg" >> "$SBX_ARGS"; done\nprintf "\\n" >> "$SBX_ARGS"\n',
    );
    chmodSync(executable, 0o755);
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    process.env.SBX_ARGS = output;
    const task: TaskManifest = {
      version: 3,
      id: "task-id",
      projectId: "project-id",
      name: "task",
      runtime: { kind: "docker-sandboxes", id: "boxers-project-task" },
      agent: "codex",
      sessionMode: "native",
      lifecycleBridgeToken: "0123456789abcdef0123456789abcdef",
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    createSandbox(task, "/seed");
    expect(readFileSync(output, "utf8").trim()).toContain("<--no-share-skills>");
    progress.mockRestore();
  });

  it("uses the provider-native continuation switch for Claude", () => {
    expect(agentArguments("claude", "/workspace/project", { resume: true })).toEqual([
      "--dangerously-skip-permissions",
      "--continue",
    ]);
  });

  it("adds setup coordination as provider-native developer instructions", () => {
    expect(
      agentArguments("codex", "/workspace/project", { developerInstructions: "wait for setup" }),
    ).toEqual(expect.arrayContaining(["-c", 'developer_instructions="wait for setup"']));
    expect(
      agentArguments("claude", "/workspace/project", {
        developerInstructions: "wait for setup",
      }),
    ).toEqual(["--dangerously-skip-permissions", "--append-system-prompt", "wait for setup"]);
  });

  it("passes task model and effort through each provider's native arguments", () => {
    expect(
      agentArguments("codex", "/workspace/project", {
        model: "gpt-example",
        effort: "high",
        fast: true,
      }),
    ).toEqual(
      expect.arrayContaining([
        "--model",
        "gpt-example",
        "-c",
        'model_reasoning_effort="high"',
        "-c",
        'service_tier="fast"',
      ]),
    );
    expect(
      agentArguments("claude", "/workspace/project", {
        model: "claude-example",
        effort: "high",
      }),
    ).toEqual(["--dangerously-skip-permissions", "--model", "claude-example", "--effort", "high"]);
  });

  it("uses fresh non-interactive provider sessions for reconciliation repair", () => {
    const task: TaskManifest = {
      version: 3,
      id: "task-id",
      projectId: "project-id",
      name: "task",
      runtime: { kind: "docker-sandboxes", id: "boxers-project-task" },
      agent: "codex",
      model: "gpt-example",
      effort: "high",
      sessionMode: "native",
      lifecycleBridgeToken: "0123456789abcdef0123456789abcdef",
      sessionStartedAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(repairAgentArguments(task, "/workspace/project", "resolve it")).toEqual(
      expect.arrayContaining([
        "--model",
        "gpt-example",
        "exec",
        "--ephemeral",
        "--sandbox",
        "danger-full-access",
        "resolve it",
      ]),
    );
    expect(repairAgentArguments({ ...task, agent: "claude" }, "/workspace/project", "fix")).toEqual(
      [
        "--print",
        "--dangerously-skip-permissions",
        "--no-session-persistence",
        "--model",
        "gpt-example",
        "--effort",
        "high",
        "fix",
      ],
    );
  });

  it("uses the Sandbox name as the Codex terminal title", () => {
    expect(terminalTitleSequence("boxers-project-task\u001b\u0007")).toBe(
      "\u001b]0;boxers-project-task\u0007",
    );
  });
});
