import { describe, expect, it } from "vitest";
import {
  encodeMessage,
  LineDecoder,
  parseClientMessage,
  parseServerMessage,
} from "../../src/v2/daemon-protocol.ts";

describe("daemon wire protocol", () => {
  it("round-trips a client message through encode and parse", () => {
    const encoded = encodeMessage({
      type: "attach",
      sessionId: "task-a",
      command: "sbx",
      args: ["run"],
      cols: 80,
      rows: 24,
    });
    expect(encoded.endsWith("\n")).toBe(true);
    expect(parseClientMessage(encoded.trim())).toMatchObject({
      type: "attach",
      sessionId: "task-a",
    });
  });

  it("preserves and validates review color capability", () => {
    const encoded = encodeMessage({
      type: "run_intent",
      intentId: "review-1",
      task: "task-a",
      intent: { kind: "review", color: true },
    });
    expect(parseClientMessage(encoded.trim())).toMatchObject({
      intent: { kind: "review", color: true },
    });
    expect(
      parseClientMessage(
        JSON.stringify({
          type: "run_intent",
          intentId: "review-1",
          task: "task-a",
          intent: { kind: "review", color: "yes" },
        }),
      ),
    ).toBeUndefined();
  });

  it("rejects malformed or unrecognized lines instead of throwing", () => {
    expect(parseClientMessage("not json")).toBeUndefined();
    expect(parseClientMessage(JSON.stringify({ type: "unknown" }))).toBeUndefined();
    expect(parseServerMessage("")).toBeUndefined();
    expect(parseClientMessage(JSON.stringify(["array", "not", "object"]))).toBeUndefined();
  });

  it("splits chunks arriving split mid-line and reassembles complete lines", () => {
    const decoder = new LineDecoder();
    expect(decoder.push('{"type":"lis')).toEqual([]);
    expect(decoder.push('t"}\n{"type":"stop","sessionId":"x"}\n')).toEqual([
      '{"type":"list"}',
      '{"type":"stop","sessionId":"x"}',
    ]);
  });
});
