import { describe, expect, it } from "vitest";
import {
  acceptedConversationEvents,
  buildConversationGenerationEnvelope,
  conversationWindow,
  isConversationEventRecord,
  normalizeRecordedLifecycleEnvelope,
  type ConversationEventRecord,
} from "../../src/v2/conversation.ts";

const at = "2026-08-29T00:00:00.000Z";

function record(sequence: number, kind: "user_prompt" | "turn_finished"): ConversationEventRecord {
  const event =
    kind === "user_prompt"
      ? {
          version: 1 as const,
          kind,
          provider: "codex" as const,
          providerSessionId: "session",
          providerTurnId: `turn-${sequence}`,
          prompt: `prompt ${sequence}`,
          recordedAt: at,
        }
      : {
          version: 1 as const,
          kind,
          provider: "codex" as const,
          providerSessionId: "session",
          providerTurnId: `turn-${sequence}`,
          lastAssistantMessage: `answer ${sequence}`,
          recordedAt: at,
        };
  return {
    version: 1,
    sequence,
    event,
    source: {
      provider: "codex",
      hookEvent: kind === "user_prompt" ? "UserPromptSubmit" : "Stop",
      rawBytes: 100,
    },
  };
}

describe("durable conversation records", () => {
  it("accepts strict current records and rejects extra transcript fields", () => {
    expect(isConversationEventRecord(record(1, "user_prompt"))).toBe(true);
    expect(
      isConversationEventRecord({
        ...record(1, "user_prompt"),
        event: { ...record(1, "user_prompt").event, transcript_path: "/private" },
      }),
    ).toBe(false);
  });

  it("normalizes a recorder envelope without exposing private transcript data", () => {
    expect(
      normalizeRecordedLifecycleEnvelope({
        version: 1,
        sequence: 7,
        provider: "codex",
        recordedAt: at,
        raw: {
          hook_event_name: "UserPromptSubmit",
          session_id: "session",
          turn_id: "turn",
          prompt: "Continue",
          transcript_path: "/private/unstable.jsonl",
        },
      }),
    ).toMatchObject({
      sequence: 7,
      event: { kind: "user_prompt", prompt: "Continue" },
      source: { hookEvent: "UserPromptSubmit" },
    });
  });

  it("sorts records and ignores stale and duplicate lifecycle identities", () => {
    const duplicate = record(4, "user_prompt");
    duplicate.event.providerTurnId = "turn-3";
    expect(
      acceptedConversationEvents(
        [record(3, "user_prompt"), record(2, "turn_finished"), record(1, "user_prompt"), duplicate],
        1,
      ).map((item) => item.sequence),
    ).toEqual([2, 3]);
  });

  it("selects exactly after promotion and through the requested high-water", () => {
    const records = [1, 2, 3, 4, 5].map((sequence) => record(sequence, "user_prompt"));
    expect(conversationWindow(records, 2, 4).events.map((event) => event.providerTurnId)).toEqual([
      "turn-3",
      "turn-4",
    ]);
    const envelope = buildConversationGenerationEnvelope("base", "tree", "diff", records, 2, 4);
    expect(envelope).toMatchObject({
      candidate: { targetOid: "base", candidateTreeOid: "tree", diff: "diff" },
      conversation: { afterPromotionSequence: 2, throughSequence: 4 },
    });
  });

  it("keeps the newest complete events in a bounded context window", () => {
    const records = [1, 2, 3].map((sequence) => record(sequence, "user_prompt"));
    const oneEventBytes = Buffer.byteLength(JSON.stringify(records[2]?.event), "utf8");
    const window = conversationWindow(records, 0, 3, oneEventBytes + 1);
    expect(window.truncated).toBe(true);
    expect(window.events.map((event) => event.providerTurnId)).toEqual(["turn-3"]);
  });
});
