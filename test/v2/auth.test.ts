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

const cleanup: string[] = [];
const originalPath = process.env.PATH;
const originalSshConnection = process.env.SSH_CONNECTION;

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalSshConnection === undefined) delete process.env.SSH_CONNECTION;
  else process.env.SSH_CONNECTION = originalSshConnection;
  delete process.env.SBX_AUTH_ARGS;
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
    expect(readFileSync(output, "utf8")).toContain("secret ls ");
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

  it("stores Claude API keys globally and opens subscription login per Sandbox", () => {
    const output = fakeSbx("anthropic");
    expect(authenticateAgent("claude")).toBe(0);
    authenticateClaudeSubscription("boxers-project-task");
    const args = readFileSync(output, "utf8");
    expect(args).toContain("secret set anthropic");
    expect(args).toContain("run --name boxers-project-task");
  });

  it("provides provider-specific non-interactive remediation", () => {
    expect(remediationFor("codex")).toContain("device code");
    expect(remediationFor("claude")).toContain("Anthropic API key");
    expect(remediationFor("claude")).toContain("interactive terminal");
  });
});
