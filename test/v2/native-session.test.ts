import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attach, discard, newTask, resolveTemplate } from "../../src/v2/commands.ts";
import { runDaemon, type DaemonHandle } from "../../src/v2/daemon.ts";
import { taskDir } from "../../src/v2/paths.ts";
import { createTaskManifest, initProject, listTasks, requireTask } from "../../src/v2/registry.ts";
import { generateCommitMessage, parseGeneratedCommitMessage } from "../../src/v2/session.ts";
import type { TaskManifest } from "../../src/v2/types.ts";

const cleanup: string[] = [];
const originalCwd = process.cwd();
const originalHome = process.env["BOXERS_HOME"];
const originalPath = process.env.PATH;
let daemon: DaemonHandle | undefined;

afterEach(async () => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env["BOXERS_HOME"];
  else process.env["BOXERS_HOME"] = originalHome;
  process.env.PATH = originalPath;
  delete process.env.SBX_LOG;
  if (daemon) {
    await daemon.close();
    daemon = undefined;
  }
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

describe("native agent task lifecycle", () => {
  it("resolves built-in templates per agent and preserves explicit references", () => {
    expect(resolveTemplate("codex")).toBe("ghcr.io/boxers-dev/boxers-templates:codex-default");
    expect(resolveTemplate("claude", "tauri")).toBe(
      "ghcr.io/boxers-dev/boxers-templates:claude-tauri",
    );
    expect(resolveTemplate("codex", "bun")).toBe("ghcr.io/boxers-dev/boxers-templates:codex-bun");
    expect(resolveTemplate("codex", "rust")).toBe("rust");
    expect(resolveTemplate("codex", "local/template:v1")).toBe("local/template:v1");
  });

  it("creates and starts a trusted native Sandbox session", async () => {
    const root = mkdtempSync(join(tmpdir(), "boxers-native-project-"));
    const state = mkdtempSync(join(tmpdir(), "boxers-native-state-"));
    const bin = mkdtempSync(join(tmpdir(), "boxers-native-bin-"));
    cleanup.push(root, state, bin);
    process.env["BOXERS_HOME"] = state;
    process.chdir(root);
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.invalid");
    writeFileSync(join(root, "base.txt"), "base\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
    const project = initProject({ integration: "local", base: "main", cwd: root });
    writeFileSync(
      join(root, ".boxers", "config.yml"),
      "version: 3\nintegration: { mode: local, base: main }\ndefaults: { agent: codex, model: gpt-example, effort: high, fast: true }\n",
    );
    git(root, "add", ".boxers/config.yml");
    git(root, "commit", "-q", "-m", "boxers config");

    const log = join(bin, "sbx.log");
    const executable = join(bin, "sbx");
    writeFileSync(
      executable,
      `#!/bin/sh
command_name="$1"
printf '%s' "$1" >> "$SBX_LOG"
shift
for arg in "$@"; do printf ' <%s>' "$arg" >> "$SBX_LOG"; done
printf '\n' >> "$SBX_LOG"
if [ "$command_name" = version ]; then printf 'sbx version: v0.37.1\n'; fi
if [ "$command_name" = ls ]; then printf '{"sandboxes":[]}\n'; fi
if [ "$command_name" = secret ] && [ "$1" = ls ]; then printf 'service openai configured\n'; fi
if [ "$command_name" = exec ] && [ "$2" = pwd ]; then printf '/workspace/project\n'; fi
if [ "$command_name" = exec ] && [ "$2" = git ]; then printf '/workspace/project/.git\n'; fi
if [ "$command_name" = exec ] && [ "$2" = sh ]; then cat > /dev/null; fi
`,
    );
    chmodSync(executable, 0o755);
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    process.env.SBX_LOG = log;

    const interrupted = createTaskManifest(project, "native", "codex");
    interrupted.creationPid = 2_147_483_647;
    writeFileSync(
      join(taskDir(project.id, interrupted.id), "task.json"),
      `${JSON.stringify(interrupted)}\n`,
    );

    daemon = runDaemon(undefined, { ingestLifecycle: async () => [] });
    await expect(newTask("native", { detach: false })).resolves.toBe(0);

    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("create <--clone> <--no-share-skills> <--name>");
    expect(calls).toContain("<--template> <ghcr.io/boxers-dev/boxers-templates:codex-default>");
    expect(calls.split("\n").find((line) => line.startsWith("create <--clone>"))).toContain(
      "<codex>",
    );
    expect(calls).toContain("run <codex> <--name>");
    expect(calls).toContain("<--> <--model>");
    expect(calls).toContain("<--model> <gpt-example>");
    expect(calls).toContain('<model_reasoning_effort="high">');
    expect(calls).toContain('<service_tier="fast">');
    expect(calls).not.toContain("<--dangerously-bypass-approvals-and-sandbox>");
    expect(calls).toContain('<projects."/workspace/project".trust_level="trusted">');
    expect(calls).not.toContain("cp ");
    const prepared = listTasks(project)[0]!;
    expect(prepared).toMatchObject({
      name: "native",
      sessionMode: "native",
      template: "ghcr.io/boxers-dev/boxers-templates:codex-default",
      sessionStartedAt: expect.any(String),
      lastSnapshot: { phase: "idle" },
    });
    expect(prepared.lifecycleBridgeToken).not.toBe(interrupted.lifecycleBridgeToken);
    expect(calls).toContain(`<${prepared.lifecycleBridgeToken}>`);

    await expect(attach("native")).resolves.toBe(0);
    const reattachedCalls = readFileSync(log, "utf8");
    expect(reattachedCalls.match(/^run /gm)).toHaveLength(2);
    expect(reattachedCalls).not.toContain("stop <boxers-");
    expect(reattachedCalls).toContain("<resume> <--last>");

    createTaskManifest(project, "aborted", "codex");
    await expect(discard("aborted", false)).resolves.toBe(0);
    expect(() => requireTask(project, "aborted")).toThrow('Unknown task "aborted"');
    expect(readFileSync(log, "utf8")).not.toContain("rm <--force>");
  });
});

describe("generated commit messages", () => {
  it("summarizes an overlong first response once", () => {
    const bin = mkdtempSync(join(tmpdir(), "boxers-commit-summary-bin-"));
    cleanup.push(bin);
    const marker = join(bin, "attempted");
    const log = join(bin, "args.log");
    writeFileSync(
      join(bin, "sbx"),
      `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
if [ ! -f ${JSON.stringify(marker)} ]; then
  touch ${JSON.stringify(marker)}
  cat > /dev/null
  node -e 'const note = "x".repeat(8001); console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ subject: "Keep summary notes concise", note }) } }))'
else
  cat > ${JSON.stringify(join(bin, "summary-input.json"))}
  printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"subject\\":\\"Keep summary notes concise\\",\\"note\\":\\"Keep only the essential context from the original note.\\"}"}}'
fi
`,
    );
    chmodSync(join(bin, "sbx"), 0o755);
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    const task: TaskManifest = {
      version: 3,
      id: "task-id",
      projectId: "project-id",
      name: "summary",
      runtime: { kind: "docker-sandboxes", id: "boxers-project-summary" },
      agent: "codex",
      sessionMode: "native",
      lifecycleBridgeToken: "0123456789abcdef0123456789abcdef",
      createdAt: "2030-01-01T00:00:00.000Z",
    };

    const generated = generateCommitMessage(task, "diff --git a/file b/file");
    const calls = readFileSync(log, "utf8");
    expect(calls.match(/codex exec/g)).toHaveLength(2);
    expect(calls).toContain("overlong development note");
    expect(calls).toContain("summarize the note once");
    expect(calls).toContain("the whole supplied conversation");
    expect(calls).toContain("Key decisions");
    expect(calls).toContain("Implementation");
    expect(readFileSync(join(bin, "summary-input.json"), "utf8")).toContain("x".repeat(8_001));
    expect(generated).toEqual({
      subject: "Keep summary notes concise",
      note: "Keep only the essential context from the original note.",
    });
  });

  it("fails cleanly when the single summary is invalid or still overlong", () => {
    for (const mode of ["invalid", "overlong"] as const) {
      const bin = mkdtempSync(join(tmpdir(), `boxers-commit-${mode}-`));
      cleanup.push(bin);
      const count = join(bin, "count");
      writeFileSync(
        join(bin, "sbx"),
        `#!/bin/sh
cat >/dev/null
n=0; test ! -f ${JSON.stringify(count)} || read -r n < ${JSON.stringify(count)}
n=$((n + 1)); printf '%s\n' "$n" > ${JSON.stringify(count)}
if [ "$n" -eq 1 ] || [ ${JSON.stringify(mode)} = overlong ]; then
  node -e 'const note="x".repeat(8001); console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify({subject:"Keep the subject",note})}}))'
else
  printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"not json"}}'
fi
`,
      );
      chmodSync(join(bin, "sbx"), 0o755);
      process.env.PATH = `${bin}:${originalPath ?? ""}`;
      const task: TaskManifest = {
        version: 3,
        id: `task-${mode}`,
        projectId: "project-id",
        name: mode,
        runtime: { kind: "docker-sandboxes", id: `boxers-project-${mode}` },
        agent: "codex",
        sessionMode: "native",
        lifecycleBridgeToken: "0123456789abcdef0123456789abcdef",
        createdAt: "2030-01-01T00:00:00.000Z",
      };
      expect(generateCommitMessage(task, "envelope")).toBeUndefined();
      expect(readFileSync(count, "utf8").trim()).toBe("2");
    }
  });

  it("extracts only a structured Codex final message", () => {
    const output = [
      JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "Ignore me" } }),
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            subject: "Fix session parsing",
            note: "Keep provider envelopes separate from their structured payloads.",
          }),
        },
      }),
    ].join("\n");
    expect(parseGeneratedCommitMessage("codex", output)).toEqual({
      subject: "Fix session parsing",
      note: "Keep provider envelopes separate from their structured payloads.",
    });
    expect(parseGeneratedCommitMessage("codex", "A seemingly random sentence")).toBeUndefined();
  });

  it("extracts Claude structured output and rejects malformed messages", () => {
    expect(
      parseGeneratedCommitMessage(
        "claude",
        JSON.stringify({
          structured_output: {
            subject: "Improve merge messages",
            note: "Explain the promotion decision as well as the outcome.",
          },
        }),
      ),
    ).toEqual({
      subject: "Improve merge messages",
      note: "Explain the promotion decision as well as the outcome.",
    });
    expect(
      parseGeneratedCommitMessage(
        "claude",
        JSON.stringify({
          structured_output: {
            subject: "First line\nUnexpected explanation",
            note: "Valid note",
          },
        }),
      ),
    ).toBeUndefined();
    expect(
      parseGeneratedCommitMessage(
        "claude",
        JSON.stringify({ structured_output: { subject: "x".repeat(73), note: "Valid note" } }),
      ),
    ).toBeUndefined();
    expect(
      parseGeneratedCommitMessage(
        "claude",
        JSON.stringify({ structured_output: { subject: "Missing development note" } }),
      ),
    ).toBeUndefined();
  });
});
