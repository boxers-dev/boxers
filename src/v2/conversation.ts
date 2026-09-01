import type { Agent } from "./types.ts";
import type { ProviderLifecycleEvent } from "./providers/types.ts";
import { harnessForAgent } from "./providers/registry.ts";

export const CONVERSATION_EVENT_VERSION = 1;
export const MAX_CONVERSATION_CONTEXT_BYTES = 48 * 1024;

export interface ConversationEventRecord {
  version: 1;
  sequence: number;
  event: ProviderLifecycleEvent;
  source: {
    provider: Agent;
    hookEvent: "UserPromptSubmit" | "Stop";
    rawBytes: number;
  };
}

export interface ConversationGenerationEnvelope {
  version: 1;
  candidate: {
    targetOid: string;
    candidateTreeOid: string;
    diff: string;
  };
  conversation: {
    afterPromotionSequence: number;
    throughSequence: number;
    events: ProviderLifecycleEvent[];
    truncated: boolean;
  };
}

export interface RecordedLifecycleEnvelope {
  version: 1;
  sequence: number;
  provider: Agent;
  recordedAt: string;
  raw: unknown;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  return Object.keys(value).every((key) => required.includes(key));
}

export function isProviderLifecycleEvent(value: unknown): value is ProviderLifecycleEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  const common = [
    "version",
    "kind",
    "provider",
    "providerSessionId",
    "providerTurnId",
    "recordedAt",
  ];
  if (
    event["version"] !== 1 ||
    (event["provider"] !== "codex" && event["provider"] !== "claude") ||
    typeof event["providerSessionId"] !== "string" ||
    !event["providerSessionId"] ||
    event["providerSessionId"].length > 256 ||
    (event["providerTurnId"] !== undefined &&
      (typeof event["providerTurnId"] !== "string" || event["providerTurnId"].length > 256)) ||
    typeof event["recordedAt"] !== "string" ||
    !Number.isFinite(Date.parse(event["recordedAt"]))
  )
    return false;
  if (event["kind"] === "user_prompt")
    return (
      exactKeys(event, [...common, "prompt"]) &&
      typeof event["prompt"] === "string" &&
      event["prompt"].length > 0 &&
      event["prompt"].length <= 32 * 1024
    );
  return (
    event["kind"] === "turn_finished" &&
    exactKeys(event, [...common, "lastAssistantMessage", "stopHookActive"]) &&
    (event["lastAssistantMessage"] === undefined ||
      (typeof event["lastAssistantMessage"] === "string" &&
        event["lastAssistantMessage"].length <= 32 * 1024)) &&
    (event["stopHookActive"] === undefined || typeof event["stopHookActive"] === "boolean")
  );
}

export function conversationEventIdentity(event: ProviderLifecycleEvent): string {
  return [event.provider, event.providerSessionId, event.providerTurnId ?? "", event.kind].join(
    "\u0000",
  );
}

export function normalizeRecordedLifecycleEnvelope(
  value: unknown,
): ConversationEventRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const envelope = value as Record<string, unknown>;
  if (
    !exactKeys(envelope, ["version", "sequence", "provider", "recordedAt", "raw"]) ||
    envelope["version"] !== 1 ||
    !Number.isSafeInteger(envelope["sequence"]) ||
    Number(envelope["sequence"]) < 1 ||
    (envelope["provider"] !== "codex" && envelope["provider"] !== "claude") ||
    typeof envelope["recordedAt"] !== "string" ||
    !Number.isFinite(Date.parse(envelope["recordedAt"]))
  )
    return undefined;
  let rawBytes: number;
  try {
    rawBytes = Buffer.byteLength(JSON.stringify(envelope["raw"]), "utf8");
  } catch {
    return undefined;
  }
  if (rawBytes < 1 || rawBytes > 64 * 1024) return undefined;
  const provider = envelope["provider"];
  const event = harnessForAgent(provider).normalizeLifecycleEvent(
    envelope["raw"],
    envelope["recordedAt"],
  );
  if (!event) return undefined;
  return {
    version: 1,
    sequence: Number(envelope["sequence"]),
    event,
    source: {
      provider,
      hookEvent: event.kind === "user_prompt" ? "UserPromptSubmit" : "Stop",
      rawBytes,
    },
  };
}

export function isConversationEventRecord(value: unknown): value is ConversationEventRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const source = record["source"] as Record<string, unknown> | undefined;
  return (
    exactKeys(record, ["version", "sequence", "event", "source"]) &&
    record["version"] === CONVERSATION_EVENT_VERSION &&
    Number.isSafeInteger(record["sequence"]) &&
    Number(record["sequence"]) > 0 &&
    isProviderLifecycleEvent(record["event"]) &&
    Boolean(source) &&
    exactKeys(source as Record<string, unknown>, ["provider", "hookEvent", "rawBytes"]) &&
    (source?.["provider"] === "codex" || source?.["provider"] === "claude") &&
    (source?.["hookEvent"] === "UserPromptSubmit" || source?.["hookEvent"] === "Stop") &&
    Number.isSafeInteger(source?.["rawBytes"]) &&
    Number(source?.["rawBytes"]) > 0
  );
}

/** Accept strictly increasing records and deterministically discard duplicates and stale files. */
export function acceptedConversationEvents(
  records: readonly ConversationEventRecord[],
  afterSequence = 0,
): ConversationEventRecord[] {
  const accepted: ConversationEventRecord[] = [];
  const identities = new Set<string>();
  let highWater = afterSequence;
  for (const record of [...records].sort((left, right) => left.sequence - right.sequence)) {
    if (record.sequence <= highWater) continue;
    const identity = conversationEventIdentity(record.event);
    if (identities.has(identity)) continue;
    identities.add(identity);
    highWater = record.sequence;
    accepted.push(record);
  }
  return accepted;
}

export function conversationWindow(
  records: readonly ConversationEventRecord[],
  afterPromotionSequence: number,
  throughSequence: number,
  maximumBytes = MAX_CONVERSATION_CONTEXT_BYTES,
): { events: ProviderLifecycleEvent[]; truncated: boolean } {
  const eligible = records.filter(
    (record) => record.sequence > afterPromotionSequence && record.sequence <= throughSequence,
  );
  const selected: ProviderLifecycleEvent[] = [];
  let bytes = 0;
  let truncated = false;
  for (let index = eligible.length - 1; index >= 0; index--) {
    const event = eligible[index]?.event;
    if (!event) continue;
    const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    if (selected.length && bytes + eventBytes > maximumBytes) {
      truncated = true;
      break;
    }
    selected.unshift(event);
    bytes += eventBytes;
  }
  return { events: selected, truncated };
}

export function buildConversationGenerationEnvelope(
  targetOid: string,
  candidateTreeOid: string,
  diff: string,
  records: readonly ConversationEventRecord[],
  afterPromotionSequence: number,
  throughSequence: number,
): ConversationGenerationEnvelope {
  if (afterPromotionSequence < 0 || throughSequence < afterPromotionSequence)
    throw new Error("Invalid conversation checkpoint range.");
  const window = conversationWindow(records, afterPromotionSequence, throughSequence);
  return {
    version: 1,
    candidate: { targetOid, candidateTreeOid, diff },
    conversation: {
      afterPromotionSequence,
      throughSequence,
      events: window.events,
      truncated: window.truncated,
    },
  };
}
