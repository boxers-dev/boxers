import type { TaskManifest } from "../types.ts";
import type {
  AgentHarness,
  AgentSessionOptions,
  LifecycleHookConfiguration,
  ProviderInvocation,
  ProviderLifecycleEvent,
} from "./types.ts";
import { plausibleRawProviderEvent, safeProviderString } from "./types.ts";

function hookConfiguration(recorderPath: string): LifecycleHookConfiguration {
  return {
    userPromptSubmit: {
      command: `${JSON.stringify(recorderPath)} claude user_prompt`,
      timeoutSeconds: 5,
      synchronous: true,
    },
    turnFinished: {
      command: `${JSON.stringify(recorderPath)} claude turn_finished`,
      timeoutSeconds: 5,
      synchronous: true,
    },
  };
}

export const claudeHarness: AgentHarness = {
  id: "claude",

  lifecycleCapabilities: () => ({ userPromptSubmit: true, turnFinished: true }),

  lifecycleHookConfiguration: hookConfiguration,

  durableSessionArguments(
    _task: TaskManifest,
    _workspace: string,
    options: AgentSessionOptions,
  ): string[] {
    return [
      "--dangerously-skip-permissions",
      ...(options.lifecycleRecorderPath === undefined
        ? []
        : ["--settings", `${options.lifecycleRecorderPath}.claude-settings.json`]),
      ...(options.developerInstructions === undefined
        ? []
        : ["--append-system-prompt", options.developerInstructions]),
      ...(options.model === undefined ? [] : ["--model", options.model]),
      ...(options.effort === undefined ? [] : ["--effort", options.effort]),
      ...(options.resume ? ["--continue"] : []),
      ...(options.prompt === undefined ? [] : [options.prompt]),
    ];
  },

  normalizeLifecycleEvent(raw: unknown, recordedAt = new Date().toISOString()) {
    if (!plausibleRawProviderEvent(raw)) return undefined;
    const session = safeProviderString(raw["session_id"], 256);
    const event = raw["hook_event_name"];
    if (!session || !Number.isFinite(Date.parse(recordedAt))) return undefined;
    if (event === "UserPromptSubmit") {
      const prompt = safeProviderString(raw["prompt"], 32 * 1024);
      if (!prompt) return undefined;
      return {
        version: 1,
        kind: "user_prompt",
        provider: "claude",
        providerSessionId: session,
        prompt,
        recordedAt,
      } satisfies ProviderLifecycleEvent;
    }
    if (event !== "Stop") return undefined;
    const last = safeProviderString(raw["last_assistant_message"], 32 * 1024);
    if (
      raw["last_assistant_message"] !== undefined &&
      raw["last_assistant_message"] !== null &&
      !last
    )
      return undefined;
    if (raw["stop_hook_active"] !== undefined && typeof raw["stop_hook_active"] !== "boolean")
      return undefined;
    return {
      version: 1,
      kind: "turn_finished",
      provider: "claude",
      providerSessionId: session,
      ...(last ? { lastAssistantMessage: last } : {}),
      ...(typeof raw["stop_hook_active"] === "boolean"
        ? { stopHookActive: raw["stop_hook_active"] }
        : {}),
      recordedAt,
    } satisfies ProviderLifecycleEvent;
  },

  commitMetadataInvocation(_task: TaskManifest): ProviderInvocation {
    return {
      command: "claude",
      args: ["--print", "--output-format", "json", "--no-session-persistence", "--tools", ""],
      inputFormat: "json",
    };
  },
};
