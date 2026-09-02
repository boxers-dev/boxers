import type { TaskManifest } from "../types.ts";
import type {
  AgentHarness,
  AgentSessionOptions,
  LifecycleHookConfiguration,
  ProviderInvocation,
  ProviderLifecycleEvent,
} from "./types.ts";
import { plausibleRawProviderEvent, safeProviderString } from "./types.ts";

function trustOverride(workspace: string): string {
  return `projects.${JSON.stringify(workspace)}.trust_level="trusted"`;
}

function hookOverride(command: string, timeoutSeconds: number): string {
  return `[{ hooks = [{ type = "command", command = ${JSON.stringify(command)}, timeout = ${timeoutSeconds} }] }]`;
}

function hookConfiguration(recorderPath: string): LifecycleHookConfiguration {
  return {
    userPromptSubmit: {
      command: `${JSON.stringify(recorderPath)} codex user_prompt`,
      timeoutSeconds: 5,
      synchronous: true,
    },
    turnFinished: {
      command: `${JSON.stringify(recorderPath)} codex turn_finished`,
      timeoutSeconds: 5,
      synchronous: true,
    },
  };
}

export const codexHarness: AgentHarness = {
  id: "codex",

  lifecycleCapabilities: () => ({ userPromptSubmit: true, turnFinished: true }),

  lifecycleHookConfiguration: hookConfiguration,

  durableSessionArguments(
    task: TaskManifest,
    workspace: string,
    options: AgentSessionOptions,
  ): string[] {
    const lifecycle = options.lifecycleRecorderPath
      ? hookConfiguration(options.lifecycleRecorderPath)
      : undefined;
    return [
      ...(options.model === undefined ? [] : ["--model", options.model]),
      ...(options.effort === undefined
        ? []
        : ["-c", `model_reasoning_effort=${JSON.stringify(options.effort)}`]),
      ...(options.fast ? ["-c", 'service_tier="fast"'] : []),
      ...(lifecycle
        ? [
            "--dangerously-bypass-hook-trust",
            "-c",
            `hooks.UserPromptSubmit=${hookOverride(lifecycle.userPromptSubmit.command, lifecycle.userPromptSubmit.timeoutSeconds)}`,
            "-c",
            `hooks.Stop=${hookOverride(lifecycle.turnFinished.command, lifecycle.turnFinished.timeoutSeconds)}`,
          ]
        : []),
      "-c",
      trustOverride(workspace),
      "-c",
      'tui.resume_cwd="session"',
      "-c",
      "tui.terminal_title=[]",
      ...(options.developerInstructions === undefined
        ? []
        : ["-c", `developer_instructions=${JSON.stringify(options.developerInstructions)}`]),
      ...(options.resume ? ["resume", "--last"] : []),
      ...(options.prompt === undefined ? [] : [options.prompt]),
    ];
  },

  normalizeLifecycleEvent(raw: unknown, recordedAt = new Date().toISOString()) {
    if (!plausibleRawProviderEvent(raw)) return undefined;
    const session = safeProviderString(raw["session_id"], 256);
    const turn = safeProviderString(raw["turn_id"], 256);
    const event = raw["hook_event_name"];
    if (!session || !Number.isFinite(Date.parse(recordedAt))) return undefined;
    if (event === "UserPromptSubmit") {
      const prompt = safeProviderString(raw["prompt"], 32 * 1024);
      if (!prompt) return undefined;
      return {
        version: 1,
        kind: "user_prompt",
        provider: "codex",
        providerSessionId: session,
        ...(turn ? { providerTurnId: turn } : {}),
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
      provider: "codex",
      providerSessionId: session,
      ...(turn ? { providerTurnId: turn } : {}),
      ...(last ? { lastAssistantMessage: last } : {}),
      ...(typeof raw["stop_hook_active"] === "boolean"
        ? { stopHookActive: raw["stop_hook_active"] }
        : {}),
      recordedAt,
    } satisfies ProviderLifecycleEvent;
  },

  commitMetadataInvocation(_task: TaskManifest): ProviderInvocation {
    return {
      command: "codex",
      args: ["exec", "--ephemeral", "--sandbox", "read-only", "--json"],
      inputFormat: "json",
    };
  },
};
