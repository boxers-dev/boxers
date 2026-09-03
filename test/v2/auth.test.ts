import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  authenticateAgent,
  authenticateCodexSubscription,
  authenticateClaudeSubscription,
  providerForAgent,
  remediationFor,
  servicesFromSecretOutput,
} from "../../src/v2/auth.ts";
import { DockerSandboxesRuntime } from "../../src/v2/runtime/docker-sandboxes.ts";
import type { TaskManifest } from "../../src/v2/types.ts";

const cleanup: string[] = [];
const originalPath = process.env.PATH;
const originalSshConnection = process.env.SSH_CONNECTION;

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalSshConnection === undefined) delete process.env.SSH_CONNECTION;
  else process.env.SSH_CONNECTION = originalSshConnection;
  delete process.env.SBX_AUTH_ARGS;
  delete process.env.SBX_AUTH_TEST_STATE;
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fakeSbx(service: "openai" | "anthropic"): string {
  const bin = mkdtempSync(join(tmpdir(), "boxers-auth-bin-"));
  cleanup.push(bin);
  const executable = join(bin, "sbx");
  const output = join(bin, "args");
  writeFileSync(
    executable,
    `#!/bin/sh\nprintf '%s ' "$@" >> "$SBX_AUTH_ARGS"\nprintf '\\n' >> "$SBX_AUTH_ARGS"\nif [ "$1" = secret ] && [ "$2" = ls ]; then printf '(global) service ${service} configured\\n'; fi\n`,
  );
  chmodSync(executable, 0o755);
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
  process.env.SBX_AUTH_ARGS = output;
  return output;
}

function task(agent: "codex" | "claude" = "codex"): TaskManifest {
  return {
    version: 3,
    id: "task-id",
    projectId: "project-id",
    name: "task",
    runtime: { kind: "docker-sandboxes", id: "boxers-project-task" },
    agent,
    sessionMode: "native",
    lifecycleBridgeToken: "0123456789abcdef0123456789abcdef",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function fakeAuthenticationStatusSbx(state: "scoped" | "task" | "missing" | "unavailable") {
  const bin = mkdtempSync(join(tmpdir(), "boxers-auth-status-bin-"));
  cleanup.push(bin);
  const executable = join(bin, "sbx");
  const calls = join(bin, "calls");
  writeFileSync(
    executable,
    `#!/bin/sh
printf '%s\n' "$*" >> "$SBX_AUTH_ARGS"
if [ "$1 $2" = "secret ls" ]; then
  [ "$SBX_AUTH_TEST_STATE" = scoped ] && printf 'service openai configured\n'
  exit 0
fi
if [ "$1" = exec ]; then
  [ "$SBX_AUTH_TEST_STATE" = task ] && exit 0
  [ "$SBX_AUTH_TEST_STATE" = unavailable ] && { printf 'no such sandbox\n' >&2; exit 1; }
  printf 'Not logged in\n' >&2
  exit 1
fi
exit 0
`,
  );
  chmodSync(executable, 0o755);
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
  process.env.SBX_AUTH_ARGS = calls;
  process.env.SBX_AUTH_TEST_STATE = state;
  return calls;
}

describe("agent authentication", () => {
  it("maps agents and parses service listings without substring matches", () => {
    expect(providerForAgent("codex")).toBe("openai");
    expect(providerForAgent("claude")).toBe("anthropic");
    expect(
      servicesFromSecretOutput(
        "(global) service OPENAI configured\n(global) service anthropic configured\nnotopenai",
      ),
    ).toEqual(["openai", "anthropic"]);
  });

  it("runs the global Codex OAuth flow and verifies the stored service", () => {
    const output = fakeSbx("openai");
    expect(authenticateAgent("codex")).toBe(0);
    expect(readFileSync(output, "utf8")).toContain("secret set openai --oauth");
    expect(readFileSync(output, "utf8")).toContain("secret ls --global");
  });

  it("supports API-key authentication over SSH and prevents accidental localhost OAuth", () => {
    const output = fakeSbx("openai");
    process.env.SSH_CONNECTION = "client 123 remote 22";
    expect(() => authenticateAgent("codex")).toThrow("localhost callback");
    expect(authenticateAgent("codex", { mode: "api-key" })).toBe(0);
    expect(readFileSync(output, "utf8")).toContain("secret set openai \n");
    expect(readFileSync(output, "utf8")).not.toContain("--oauth");
    expect(authenticateAgent("codex", { mode: "oauth", allowSshOAuth: true })).toBe(0);
    expect(readFileSync(output, "utf8")).toContain("secret set openai --oauth");
  });

  it("runs Codex device authentication inside a durable Sandbox", () => {
    const output = fakeSbx("openai");
    authenticateCodexSubscription("boxers-project-task");
    expect(readFileSync(output, "utf8")).toContain(
      "exec boxers-project-task codex login --device-auth",
    );
  });

  it("stores Claude API keys globally and uses dedicated subscription login per Sandbox", () => {
    const output = fakeSbx("anthropic");
    expect(authenticateAgent("claude")).toBe(0);
    authenticateClaudeSubscription("boxers-project-task");
    const args = readFileSync(output, "utf8");
    expect(args).toContain("secret set anthropic");
    expect(args).toContain(
      "exec --interactive --tty boxers-project-task claude auth login --claudeai",
    );
  });

  it("provides provider-specific non-interactive remediation", () => {
    expect(remediationFor("codex")).toContain("device code");
    expect(remediationFor("claude")).toContain("Anthropic API key");
    expect(remediationFor("claude")).toContain("interactive terminal");
  });

  it("distinguishes scoped credentials, task-local login, missing auth, and inspection failure", () => {
    const runtime = new DockerSandboxesRuntime();

    const calls = fakeAuthenticationStatusSbx("scoped");
    expect(runtime.agentAuthenticationStatus(task())).toMatchObject({
      state: "configured",
      detail: expect.stringContaining("scoped to this task"),
    });

    process.env.SBX_AUTH_TEST_STATE = "task";
    expect(runtime.agentAuthenticationStatus(task())).toMatchObject({
      state: "configured",
      detail: expect.stringContaining("inside this task"),
    });

    process.env.SBX_AUTH_TEST_STATE = "missing";
    expect(runtime.agentAuthenticationStatus(task())).toMatchObject({ state: "missing" });

    process.env.SBX_AUTH_TEST_STATE = "unavailable";
    expect(runtime.agentAuthenticationStatus(task())).toMatchObject({ state: "unknown" });

    const commands = readFileSync(calls, "utf8");
    expect(commands).toContain("secret ls --sandbox boxers-project-task");
    expect(commands).not.toContain("secret ls --global");
    expect(commands).toContain("exec boxers-project-task codex login status");
  });
});
