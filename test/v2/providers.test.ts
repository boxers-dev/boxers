import { describe, expect, it } from "vitest";
import { claudeHarness } from "../../src/v2/providers/claude.ts";
import { codexHarness } from "../../src/v2/providers/codex.ts";

const now = "2026-08-29T00:00:00.000Z";

describe("provider lifecycle adapters", () => {
  it("declares provider-native authentication checks with each harness", () => {
    expect(codexHarness.authentication).toEqual({
      service: "openai",
      statusCommand: ["codex", "login", "status"],
    });
    expect(claudeHarness.authentication).toEqual({
      service: "anthropic",
      statusCommand: ["claude", "auth", "status"],
    });
  });

  it("normalizes only stable Codex prompt fields and ignores transcript_path", () => {
    expect(
      codexHarness.normalizeLifecycleEvent(
        {
          hook_event_name: "UserPromptSubmit",
          session_id: "session",
          turn_id: "turn",
          prompt: "Build it",
          transcript_path: "/private/unstable.jsonl",
          cwd: "/workspace",
        },
        now,
      ),
    ).toEqual({
      version: 1,
      kind: "user_prompt",
      provider: "codex",
      providerSessionId: "session",
      providerTurnId: "turn",
      prompt: "Build it",
      recordedAt: now,
    });
  });

  it("normalizes Codex Stop without steering continuation", () => {
    expect(
      codexHarness.normalizeLifecycleEvent(
        {
          hook_event_name: "Stop",
          session_id: "session",
          turn_id: "turn",
          last_assistant_message: "Done",
          stop_hook_active: true,
          transcript_path: "/ignore",
        },
        now,
      ),
    ).toEqual({
      version: 1,
      kind: "turn_finished",
      provider: "codex",
      providerSessionId: "session",
      providerTurnId: "turn",
      lastAssistantMessage: "Done",
      stopHookActive: true,
      recordedAt: now,
    });
  });

  it("normalizes Claude events into the provider-neutral model", () => {
    expect(
      claudeHarness.normalizeLifecycleEvent(
        {
          hook_event_name: "Stop",
          session_id: "claude-session",
          last_assistant_message: "Ready",
          stop_hook_active: false,
        },
        now,
      ),
    ).toEqual({
      version: 1,
      kind: "turn_finished",
      provider: "claude",
      providerSessionId: "claude-session",
      lastAssistantMessage: "Ready",
      stopHookActive: false,
      recordedAt: now,
    });
  });

  it("rejects malformed and oversized payloads deterministically", () => {
    expect(codexHarness.normalizeLifecycleEvent(null, now)).toBeUndefined();
    expect(
      codexHarness.normalizeLifecycleEvent(
        { hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "x".repeat(70_000) },
        now,
      ),
    ).toBeUndefined();
    expect(
      claudeHarness.normalizeLifecycleEvent(
        { hook_event_name: "Stop", session_id: "s", stop_hook_active: "yes" },
        now,
      ),
    ).toBeUndefined();
  });

  it("keeps durable hooks out of auxiliary invocations", () => {
    const task = { agent: "codex" } as const;
    const durable = codexHarness.durableSessionArguments(task as never, "/workspace", {
      lifecycleRecorderPath: "/git/boxers/bin/record-lifecycle",
    });
    const auxiliary = codexHarness.commitMetadataInvocation(task as never);
    expect(durable).toContain("--dangerously-bypass-hook-trust");
    expect(auxiliary.args).toContain("--ephemeral");
    expect(auxiliary.args).not.toContain("--dangerously-bypass-hook-trust");
  });

  it("passes Codex lifecycle hooks as TOML arrays of inline tables", () => {
    const recorder = "/git/boxers/bin/record-lifecycle";
    const args = codexHarness.durableSessionArguments({ agent: "codex" } as never, "/workspace", {
      lifecycleRecorderPath: recorder,
    });

    expect(args).toContain(
      'hooks.UserPromptSubmit=[{ hooks = [{ type = "command", command = "\\\"/git/boxers/bin/record-lifecycle\\\" codex user_prompt", timeout = 5 }] }]',
    );
    expect(args).toContain(
      'hooks.Stop=[{ hooks = [{ type = "command", command = "\\\"/git/boxers/bin/record-lifecycle\\\" codex turn_finished", timeout = 5 }] }]',
    );
  });

  it("isolates lifecycle configuration while preserving native resume arguments", () => {
    const task = { agent: "claude" } as const;
    const recorder = "/git/boxers/bin/record-lifecycle";
    const claude = claudeHarness.durableSessionArguments(task as never, "/workspace", {
      lifecycleRecorderPath: recorder,
      resume: true,
    });
    expect(claude).toEqual(
      expect.arrayContaining(["--settings", `${recorder}.claude-settings.json`, "--continue"]),
    );
    expect(claudeHarness.commitMetadataInvocation(task as never).args).not.toContain("--settings");

    const codex = codexHarness.durableSessionArguments({ agent: "codex" } as never, "/workspace", {
      lifecycleRecorderPath: recorder,
      resume: true,
    });
    expect(codex).toContain("--dangerously-bypass-hook-trust");
    expect(codex).toEqual(expect.arrayContaining(["resume", "--last"]));
  });
});
