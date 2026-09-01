import type { Agent, TaskManifest } from "../types.ts";

export const MAX_PROVIDER_EVENT_BYTES = 64 * 1024;

export type ProviderLifecycleEvent =
  | {
      version: 1;
      kind: "user_prompt";
      provider: Agent;
      providerSessionId: string;
      providerTurnId?: string;
      prompt: string;
      recordedAt: string;
    }
  | {
      version: 1;
      kind: "turn_finished";
      provider: Agent;
      providerSessionId: string;
      providerTurnId?: string;
      lastAssistantMessage?: string;
      stopHookActive?: boolean;
      recordedAt: string;
    };

export interface AgentSessionOptions {
  prompt?: string;
  resume?: boolean;
  model?: string;
  effort?: string;
  fast?: boolean;
  developerInstructions?: string;
  lifecycleRecorderPath?: string;
}

export interface ProviderInvocation {
  command: string;
  args: string[];
  inputFormat: "json";
}

export interface LifecycleHookDefinition {
  command: string;
  timeoutSeconds: number;
  synchronous: true;
}

export interface LifecycleHookConfiguration {
  userPromptSubmit: LifecycleHookDefinition;
  turnFinished: LifecycleHookDefinition;
}

export interface AgentHarness {
  readonly id: Agent;
  lifecycleCapabilities(): { userPromptSubmit: true; turnFinished: true };
  lifecycleHookConfiguration(recorderPath: string): LifecycleHookConfiguration;
  durableSessionArguments(
    task: TaskManifest,
    workspace: string,
    options: AgentSessionOptions,
  ): string[];
  normalizeLifecycleEvent(raw: unknown, recordedAt?: string): ProviderLifecycleEvent | undefined;
  commitMetadataInvocation(task: TaskManifest): ProviderInvocation;
}

export function safeProviderString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string" || !value || value.length > maximum) return undefined;
  return value;
}

export function plausibleRawProviderEvent(raw: unknown): raw is Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  try {
    return Buffer.byteLength(JSON.stringify(raw), "utf8") <= MAX_PROVIDER_EVENT_BYTES;
  } catch {
    return false;
  }
}
