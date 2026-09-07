import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  authenticateAgent,
  authenticateCodexSubscription,
  authenticateClaudeSubscription,
  ensureNewTaskAuthentication,
  providerForAgent,
  remediationFor,
  servicesFromSecretOutput,
} from "../../src/v2/auth.ts";
import {
  DockerSandboxesRuntime,
  EXTERNAL_AUTH_PROBE,
} from "../../src/v2/runtime/docker-sandboxes.ts";
import { codexOAuthSshArgs } from "../../src/v2/ssh-transport.ts";
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

function fakeAuthenticationStatusSbx(
  state:
    | "scoped"
    | "task"
    | "imported"
    | "expired"
    | "external_ready"
    | "external_rejected"
    | "missing"
    | "unavailable",
) {
  const bin = mkdtempSync(join(tmpdir(), "boxers-auth-status-bin-"));
  cleanup.push(bin);
  const executable = join(bin, "sbx");
  const calls = join(bin, "calls");
  writeFileSync(
    executable,
    `#!/bin/sh
printf '%s\n' "$*" >> "$SBX_AUTH_ARGS"
if [ "$1 $2" = "secret ls" ]; then
  case "$SBX_AUTH_TEST_STATE" in
    scoped|external_ready|external_rejected) printf 'service openai configured\n' ;;
  esac
  exit 0
fi
if [ "$1" = exec ]; then
  case "$*" in
    *"node -e"*)
      [ "$SBX_AUTH_TEST_STATE" = imported ] && printf 'imported\n'
      exit 0
      ;;
    *"boxers-auth-probe"*)
      [ "$SBX_AUTH_TEST_STATE" = external_ready ] && exit 0
      [ "$SBX_AUTH_TEST_STATE" = external_rejected ] && exit 11
      [ "$SBX_AUTH_TEST_STATE" = scoped ] && exit 12
      exit 13
      ;;
    *"codex "*"app-server"*)
      if [ "$SBX_AUTH_TEST_STATE" = task ] || [ "$SBX_AUTH_TEST_STATE" = imported ] || [ "$SBX_AUTH_TEST_STATE" = expired ]; then
        IFS= read -r ignored
        printf '{"id":"boxers-initialize","result":{"userAgent":"test"}}\n'
        IFS= read -r ignored
        IFS= read -r ignored
        printf '%s\n' "$ignored" >> "$SBX_AUTH_ARGS"
        if [ "$SBX_AUTH_TEST_STATE" = expired ]; then
          printf '{"id":"boxers-account","error":{"message":"refresh token expired"}}\n'
        else
          printf '{"id":"boxers-account","result":{"account":{"type":"chatgpt"}}}\n'
        fi
        exit 0
      fi
      IFS= read -r ignored
      printf '{"id":"boxers-initialize","result":{}}\n'
      IFS= read -r ignored
      IFS= read -r ignored
      printf '{"id":"boxers-account","result":{"account":null}}\n'
      exit 0
      ;;
  esac
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
      'exec --interactive --tty boxers-project-task env -u OPENAI_API_KEY CODEX_HOME=/home/agent/.boxers/codex codex -c forced_login_method="chatgpt" -c model_provider="openai" -c cli_auth_credentials_store="file" login --device-auth',
    );
  });

  it("stores Claude API keys globally and uses dedicated subscription login per Sandbox", () => {
    const output = fakeSbx("anthropic");
    expect(authenticateAgent("claude")).toBe(0);
    authenticateClaudeSubscription("boxers-project-task");
    const args = readFileSync(output, "utf8");
    expect(args).toContain("secret set anthropic");
    expect(args).toContain(
      "exec --interactive --tty boxers-project-task env -u ANTHROPIC_API_KEY claude auth login --claudeai",
    );
  });

  it("provides provider-specific non-interactive remediation", () => {
    expect(remediationFor("codex")).toContain("boxers auth codex --host");
    expect(remediationFor("claude")).toContain("Claude subscription");
    expect(remediationFor("claude")).toContain("interactive terminal");
  });

  it("distinguishes proxy credentials, saved task login, and inconclusive account errors", async () => {
    const runtime = new DockerSandboxesRuntime();

    const calls = fakeAuthenticationStatusSbx("scoped");
    await expect(runtime.agentAuthenticationStatus(task())).resolves.toMatchObject({
      state: "external_unverified",
      detail: expect.stringContaining("inconclusive"),
    });

    process.env.SBX_AUTH_TEST_STATE = "external_ready";
    await expect(runtime.agentAuthenticationStatus(task())).resolves.toMatchObject({
      state: "ready",
      detail: expect.stringContaining("accepted"),
    });
    expect(runtime.agentLaunchSpec(task(), []).args).not.toContain("OPENAI_API_KEY=");

    process.env.SBX_AUTH_TEST_STATE = "external_rejected";
    await expect(runtime.agentAuthenticationStatus(task())).resolves.toMatchObject({
      state: "reauth_required",
      detail: expect.stringContaining("rejected"),
    });

    process.env.SBX_AUTH_TEST_STATE = "task";
    await expect(runtime.agentAuthenticationStatus(task())).resolves.toMatchObject({
      state: "ready",
      detail: expect.stringContaining("stored"),
    });
    expect(runtime.agentLaunchSpec(task(), [])).toMatchObject({
      args: expect.arrayContaining([
        "--env",
        "OPENAI_API_KEY=",
        "CODEX_HOME=/home/agent/.boxers/codex",
        'forced_login_method="chatgpt"',
        'model_provider="openai"',
      ]),
    });

    process.env.SBX_AUTH_TEST_STATE = "expired";
    await expect(runtime.agentAuthenticationStatus(task())).resolves.toMatchObject({
      state: "unknown",
      detail: expect.stringContaining("expired"),
    });

    process.env.SBX_AUTH_TEST_STATE = "missing";
    await expect(runtime.agentAuthenticationStatus(task())).resolves.toMatchObject({
      state: "missing",
    });

    process.env.SBX_AUTH_TEST_STATE = "unavailable";
    await expect(runtime.agentAuthenticationStatus(task())).resolves.toMatchObject({
      state: "unknown",
    });

    const commands = readFileSync(calls, "utf8");
    expect(commands).toContain("secret ls --sandbox boxers-project-task");
    expect(commands).not.toContain("secret ls --global");
    expect(commands).toContain(
      'env -u OPENAI_API_KEY CODEX_HOME=/home/agent/.boxers/codex codex -c forced_login_method="chatgpt" -c model_provider="openai" -c cli_auth_credentials_store="file" app-server',
    );
    expect(commands).toContain('"refreshToken":false');
    expect(commands).not.toContain('"refreshToken":true');
    expect(commands).toContain("exec boxers-project-task codex login status");
    expect(commands).toContain("boxers-auth-probe codex");
  });

  it("checks Claude subscription state without accepting the proxy sentinel", async () => {
    const runtime = new DockerSandboxesRuntime();
    const calls = fakeAuthenticationStatusSbx("task");
    await expect(runtime.agentAuthenticationStatus(task("claude"))).resolves.toMatchObject({
      state: "ready",
    });
    expect(readFileSync(calls, "utf8")).toContain(
      "exec boxers-project-task env -u ANTHROPIC_API_KEY claude auth status",
    );
    expect(runtime.agentLaunchSpec(task("claude"), [])).toMatchObject({
      args: expect.arrayContaining(["--env", "ANTHROPIC_API_KEY="]),
    });
  });

  it("requests a provider restart when surviving credentials change homes", async () => {
    fakeAuthenticationStatusSbx("imported");
    await expect(
      new DockerSandboxesRuntime().agentAuthenticationStatus(task()),
    ).resolves.toMatchObject({
      state: "ready",
      restartRequired: true,
    });
    process.env.SBX_AUTH_TEST_STATE = "task";
    const status = await new DockerSandboxesRuntime().agentAuthenticationStatus(task());
    expect(status.state).toBe("ready");
    expect(status.restartRequired).toBeUndefined();
  });

  it("reuses a saved host credential across new tasks without starting login", async () => {
    const calls = fakeSbx("openai");
    process.env.SSH_CONNECTION = "client 123 remote 22";
    await ensureNewTaskAuthentication("codex");
    await ensureNewTaskAuthentication("codex");
    expect(readFileSync(calls, "utf8")).not.toContain("secret set");
    fakeSbx("anthropic");
    await expect(ensureNewTaskAuthentication("codex")).rejects.toThrow("boxers auth codex --host");
  });

  it("uses normal SSH with a loopback-only callback for reusable remote OAuth", () => {
    const args = codexOAuthSshArgs("imre@server");
    expect(args).toContain("127.0.0.1:1455:127.0.0.1:1455");
    expect(args).toContain("ExitOnForwardFailure=yes");
    expect(args.slice(-6)).toEqual(["imre@server", "sbx", "secret", "set", "openai", "--oauth"]);
    expect(args).not.toContain("-i");
    expect(args).not.toContain("boxers-gateway-request");
  });

  it("probes ChatGPT OAuth on its own backend and never mistakes API rejection for OAuth expiry", () => {
    const bin = mkdtempSync(join(tmpdir(), "boxers-proxy-probe-"));
    cleanup.push(bin);
    const log = join(bin, "calls");
    writeFileSync(
      join(bin, "curl"),
      `#!/bin/sh
printf '%s\\n' "$@" >> "$PROBE_LOG"
case "$*" in
  *https://chatgpt.com/backend-api/codex/responses*) printf '%s' "\${PROBE_HTTP_STATUS:-400}" ;;
  *https://api.openai.com/v1/responses*) printf 401 ;;
  *) exit 99 ;;
esac
`,
    );
    chmodSync(join(bin, "curl"), 0o755);
    const probe = (mode: string, status = "400") =>
      spawnSync("sh", ["-c", EXTERNAL_AUTH_PROBE, "test", "codex"], {
        env: {
          ...process.env,
          PATH: `${bin}:${originalPath}`,
          SBX_CRED_OPENAI_MODE: mode,
          PROBE_LOG: log,
          PROBE_HTTP_STATUS: status,
          OPENAI_API_KEY: "test-key",
        },
      }).status;
    expect(probe("oauth")).toBe(0);
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("https://chatgpt.com/backend-api/codex/responses");
    expect(calls).not.toContain("https://api.openai.com");
    expect(calls).toContain("Bearer oai-oat01-proxy-managed");
    expect(probe("apikey")).toBe(11);
    expect(probe("oauth", "401")).toBe(11);
    for (const status of ["403", "429", "500", "000"]) expect(probe("oauth", status)).toBe(12);
    expect(probe("none")).toBe(13);
  });
});
