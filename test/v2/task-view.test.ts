import { describe, expect, it } from "vitest";
import { deriveTaskView, formatTaskView } from "../../src/v2/task-view.ts";
import type { TaskState } from "../../src/v2/types.ts";

const now = "2030-01-01T00:00:00.000Z";
const setupIdentity = { jobId: "setup-job", configHash: "setup-config" };

function state(overrides: Partial<TaskState> = {}): TaskState {
  return {
    version: 3,
    taskId: "task-id",
    revision: 1,
    updatedAt: now,
    agentTurnState: "awaiting_input",
    conversationHighWaterSequence: 4,
    lifecycleDrainSequence: 4,
    promotionConversationCheckpoint: 0,
    hasUnmergedChanges: { value: "unknown", observedAt: now, source: "initial" },
    ...overrides,
  };
}

describe("structured task view", () => {
  it.each([
    {
      name: "generation and setup are independent running facts",
      input: state({
        agentTurnState: "working",
        setup: {
          ...setupIdentity,
          state: "running",
          command: "npm ci",
          startedAt: now,
          logPath: "/setup.log",
          attempt: 1,
          maxAttempts: 2,
        },
      }),
      expected: {
        agent: "Generating",
        setup: "running",
        changes: "unknown",
        checks: "awaiting_setup",
        action: "attach",
      },
    },
    {
      name: "passing candidate is promotable",
      input: state({
        baseOid: "base",
        candidateTreeOid: "tree",
        setup: {
          ...setupIdentity,
          state: "passed",
          command: "npm ci",
          startedAt: now,
          finishedAt: now,
          logPath: "/setup.log",
        },
        hasUnmergedChanges: {
          value: true,
          observedAt: now,
          source: "git",
          conversationSequence: 4,
        },
        check: {
          status: "passed",
          targetOid: "base",
          candidateTreeOid: "tree",
          configHash: "hash",
          results: [],
        },
      }),
      expected: {
        agent: "Ready for input",
        setup: "passed",
        changes: "unmerged",
        checks: "passed",
        action: "review",
      },
    },
    {
      name: "failed checks ask the agent to fix them",
      input: state({
        baseOid: "base",
        candidateTreeOid: "tree",
        setup: {
          ...setupIdentity,
          state: "passed",
          command: "npm ci",
          startedAt: now,
          logPath: "/setup.log",
        },
        hasUnmergedChanges: {
          value: true,
          observedAt: now,
          source: "git",
          conversationSequence: 4,
        },
        check: {
          status: "failed",
          targetOid: "base",
          candidateTreeOid: "tree",
          configHash: "hash",
          results: [
            {
              name: "typecheck",
              command: "tsc",
              status: "failed",
              exitCode: 2,
              durationMs: 10,
              logPath: "/typecheck.log",
            },
          ],
        },
      }),
      expected: {
        agent: "Ready for input",
        setup: "passed",
        changes: "unmerged",
        checks: "failed",
        action: "fix_checks",
      },
    },
    {
      name: "failed setup has a precise retry",
      input: state({
        setup: {
          ...setupIdentity,
          state: "failed",
          command: "npm ci",
          startedAt: now,
          finishedAt: now,
          logPath: "/setup.log",
          attempt: 2,
          maxAttempts: 2,
        },
      }),
      expected: {
        agent: "Ready for input",
        setup: "failed",
        changes: "unknown",
        checks: "awaiting_setup",
        action: "retry_setup",
      },
    },
    {
      name: "conflicts belong to reconciliation",
      input: state({
        setup: {
          ...setupIdentity,
          state: "passed",
          command: "npm ci",
          startedAt: now,
          logPath: "/setup.log",
        },
        hasUnmergedChanges: {
          value: true,
          observedAt: now,
          source: "git",
          conversationSequence: 4,
        },
        failure: "Reconciliation conflicts: src/a.ts",
      }),
      expected: {
        agent: "Ready for input",
        setup: "passed",
        changes: "conflicted",
        checks: "awaiting_reconciliation",
        action: "resolve_conflicts",
      },
    },
    {
      name: "delivered clean work can be discarded",
      input: state({
        baseOid: "delivered",
        setup: {
          ...setupIdentity,
          state: "passed",
          command: "npm ci",
          startedAt: now,
          logPath: "/setup.log",
        },
        hasUnmergedChanges: {
          value: false,
          observedAt: now,
          source: "git",
          conversationSequence: 4,
        },
        lastDelivery: {
          value: {
            ref: "main",
            oid: "delivered",
            subject: "Deliver",
            deliveredAt: now,
            conversationSequence: 4,
            checks: "passed",
          },
          observedAt: now,
          source: "git",
        },
      }),
      expected: {
        agent: "Ready for input",
        setup: "passed",
        changes: "none",
        checks: "passed",
        action: "discard",
      },
    },
    {
      name: "an exited agent does not hide a candidate",
      input: state({
        agentTurnState: "exited",
        baseOid: "base",
        candidateTreeOid: "tree",
        hasUnmergedChanges: {
          value: true,
          observedAt: now,
          source: "git",
          conversationSequence: 4,
        },
      }),
      expected: {
        agent: "Session exited",
        setup: "not_configured",
        changes: "unmerged",
        checks: "not_run",
        action: "review",
      },
    },
    {
      name: "unknown workspace state offers verified discard",
      input: state({ agentTurnState: "unknown" }),
      expected: {
        agent: "Activity unknown",
        setup: "not_configured",
        changes: "unknown",
        checks: "awaiting_candidate",
        action: "discard",
      },
    },
  ])("$name", ({ input, expected }) => {
    const view = deriveTaskView({
      name: "task",
      state: input,
      setupConfigured: Boolean(input.setup),
      checksConfigured: true,
      checkConfigHash: "hash",
    });
    expect({
      agent: view.agent.label,
      setup: view.setup.state,
      changes: view.changes.state,
      checks: view.checks.state,
      action: view.actions[0]?.kind,
    }).toEqual(expected);
  });

  it("shows simultaneous issues and never turns ready-for-input into an issue", () => {
    const view = deriveTaskView({
      name: "task",
      state: state({
        setup: {
          ...setupIdentity,
          state: "failed",
          command: "npm ci",
          startedAt: now,
          logPath: "/setup.log",
        },
        check: {
          status: "failed",
          targetOid: "old",
          candidateTreeOid: "old",
          configHash: "hash",
          results: [{ name: "lint", command: "lint", status: "failed", durationMs: 1 }],
        },
      }),
      setupConfigured: true,
      checksConfigured: true,
      preview: { state: "failed", failure: "port unavailable" },
    });
    expect(view.issues.map((issue) => issue.code)).toEqual(["setup_failed", "preview_failed"]);
    expect(view.issues.every((issue) => !/ready for input/i.test(issue.message))).toBe(true);
  });

  it("invalidates a clean observation after a later conversation event", () => {
    const clean = state({
      baseOid: "base",
      hasUnmergedChanges: { value: false, observedAt: now, source: "git", conversationSequence: 4 },
    });
    expect(deriveTaskView({ name: "task", state: clean }).removal.state).toBe("safe");
    expect(
      deriveTaskView({
        name: "task",
        state: { ...clean, conversationHighWaterSequence: 5, lifecycleDrainSequence: 5 },
      }).removal.state,
    ).toBe("verification_required");
  });

  it("reports setup independently without letting it block discard", () => {
    const view = deriveTaskView({
      name: "task",
      state: state({
        agentTurnState: "not_started",
        baseOid: "base",
        setup: {
          ...setupIdentity,
          state: "running",
          command: "npm ci",
          startedAt: now,
          logPath: "/setup.log",
        },
        hasUnmergedChanges: {
          value: false,
          observedAt: now,
          source: "git",
          conversationSequence: 4,
        },
      }),
      setupConfigured: true,
    });

    expect(view.operations).toEqual([
      { kind: "setup", state: "running", startedAt: now, detail: "npm ci" },
    ]);
    expect(view.removal).toEqual({
      state: "safe",
      reason: "A current causal Git observation proves the workspace clean.",
    });
    expect(view.actions[0]?.kind).toBe("discard");
  });

  it("renders precise failed check details and commands", () => {
    const view = deriveTaskView({
      name: "parser",
      state: state({
        baseOid: "base",
        candidateTreeOid: "tree",
        hasUnmergedChanges: {
          value: true,
          observedAt: now,
          source: "git",
          conversationSequence: 4,
        },
        check: {
          status: "failed",
          targetOid: "base",
          candidateTreeOid: "tree",
          configHash: "hash",
          results: [
            {
              name: "typecheck",
              command: "tsc",
              status: "failed",
              exitCode: 2,
              durationMs: 1,
              logPath: "/checks/typecheck.log",
            },
          ],
        },
      }),
      checksConfigured: true,
      checkConfigHash: "hash",
    });
    expect(formatTaskView("parser", view)).toContain("Checks: Failed - 1 of 1 failed");
    expect(formatTaskView("parser", view)).toContain("Log: /checks/typecheck.log");
    expect(formatTaskView("parser", view)).toContain("boxers parser attach");
  });
});
