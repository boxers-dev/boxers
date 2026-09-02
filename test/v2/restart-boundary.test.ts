import { describe, expect, it } from "vitest";
import { restartBoundary } from "../../src/v2/restart-boundary.ts";
import type { TaskState } from "../../src/v2/types.ts";

const initial = (): TaskState => ({
  version: 3,
  taskId: "task-id",
  revision: 1,
  updatedAt: "2026-09-02T00:00:00.000Z",
  agentTurnState: "not_started",
  conversationHighWaterSequence: 0,
  lifecycleDrainSequence: 0,
  promotionConversationCheckpoint: 0,
  hasUnmergedChanges: {
    value: "unknown",
    observedAt: "2026-09-02T00:00:00.000Z",
    source: "initial",
  },
});

describe("daemon restart boundaries", () => {
  it("accepts a fresh task with no observed provider turn", () => {
    expect(
      restartBoundary("fresh", initial(), { state: "running", uncommittedInput: false }),
    ).toEqual({ safe: true, reason: "not_started" });
  });

  it("accepts a fully drained provider-completed turn", () => {
    expect(
      restartBoundary(
        "ready",
        {
          ...initial(),
          agentTurnState: "awaiting_input",
          conversationHighWaterSequence: 2,
          lifecycleDrainSequence: 2,
          lastLifecycleEventKind: "turn_finished",
        },
        { state: "running", uncommittedInput: false },
      ),
    ).toEqual({ safe: true, reason: "turn_finished" });
  });

  it("accepts a provider process that has exited", () => {
    expect(
      restartBoundary("done", initial(), { state: "exited", uncommittedInput: false }),
    ).toEqual({ safe: true, reason: "exited" });
  });

  it("blocks active turns and unconfirmed terminal input", () => {
    expect(
      restartBoundary(
        "working",
        {
          ...initial(),
          agentTurnState: "working",
          conversationHighWaterSequence: 1,
          lifecycleDrainSequence: 1,
          lastLifecycleEventKind: "user_prompt",
        },
        { state: "running", uncommittedInput: false },
      ),
    ).toMatchObject({ safe: false, blocker: { kind: "working" } });
    expect(
      restartBoundary("draft", initial(), { state: "running", uncommittedInput: true }),
    ).toMatchObject({ safe: false, blocker: { kind: "uncommitted_input" } });
  });
});
