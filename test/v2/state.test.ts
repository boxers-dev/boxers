import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { status } from "../../src/v2/commands.ts";
import { captureStateProjection } from "../../src/v2/projection.ts";
import { taskManifestLockPath, taskStatePath } from "../../src/v2/paths.ts";
import { createTaskManifest, initProject, updateTask } from "../../src/v2/registry.ts";
import {
  ensureTaskState,
  readTaskState,
  recordCandidateCommitMessage,
  recordLifecycleEvent,
  recordTaskSnapshot,
  updateTaskState,
} from "../../src/v2/state.ts";

const cleanup: string[] = [];
const oldHome = process.env.BOXERS_HOME;

afterEach(() => {
  vi.restoreAllMocks();
  if (oldHome === undefined) delete process.env.BOXERS_HOME;
  else process.env.BOXERS_HOME = oldHome;
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "boxers-state-root-"));
  const home = mkdtempSync(join(tmpdir(), "boxers-state-home-"));
  cleanup.push(root, home);
  process.env.BOXERS_HOME = home;
  execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Test User"]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  writeFileSync(join(root, "tracked.txt"), "base\n");
  execFileSync("git", ["-C", root, "add", "tracked.txt"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "base"]);
  const project = initProject({ integration: "local" as const, base: "main", cwd: root });
  const task = createTaskManifest(project, "task", "codex");
  return { project, task };
}

describe("durable task state", () => {
  it("derives turn state and deduplicates provider lifecycle identity", () => {
    const { project, task } = fixture();
    const stop = {
      version: 1 as const,
      sequence: 1,
      event: {
        version: 1 as const,
        kind: "turn_finished" as const,
        provider: "codex" as const,
        providerSessionId: "session",
        providerTurnId: "turn-1",
        recordedAt: "2030-01-01T00:00:00.000Z",
      },
      source: { provider: "codex" as const, hookEvent: "Stop" as const, rawBytes: 100 },
    };
    expect(recordLifecycleEvent(project, task, stop)).toBe(true);
    expect(readTaskState(project, task)).toMatchObject({
      agentTurnState: "awaiting_input",
      conversationHighWaterSequence: 1,
      lifecycleDrainSequence: 1,
    });
    expect(recordLifecycleEvent(project, task, { ...stop, sequence: 2 })).toBe(false);
    expect(readTaskState(project, task)).toMatchObject({
      conversationHighWaterSequence: 1,
      lifecycleDrainSequence: 2,
    });
    expect(
      recordLifecycleEvent(project, task, {
        ...stop,
        sequence: 3,
        event: {
          version: 1,
          kind: "user_prompt",
          provider: "codex",
          providerSessionId: "session",
          providerTurnId: "turn-2",
          prompt: "Continue",
          recordedAt: "2030-01-01T00:00:01.000Z",
        },
        source: { provider: "codex", hookEvent: "UserPromptSubmit", rawBytes: 100 },
      }),
    ).toBe(true);
    expect(readTaskState(project, task).agentTurnState).toBe("working");
  });

  it("persists only the current event-derived state contract", () => {
    const { project, task } = fixture();
    const state = readTaskState(project, task);
    expect(state).toMatchObject({
      version: 3,
      taskId: task.id,
      agentTurnState: "not_started",
      conversationHighWaterSequence: 0,
      lifecycleDrainSequence: 0,
      hasUnmergedChanges: { value: false },
    });
    expect(state).not.toHaveProperty("agent");
    expect(state).not.toHaveProperty("runtime");
    expect(state).not.toHaveProperty("workspace");
    expect(state).not.toHaveProperty("operation");
  });

  it("publishes agent and Git observations independently", () => {
    const { project, task } = fixture();
    recordLifecycleEvent(project, task, {
      version: 1,
      sequence: 1,
      event: {
        version: 1,
        kind: "turn_finished",
        provider: "codex",
        providerSessionId: "session",
        recordedAt: "2030-01-01T00:00:00.000Z",
      },
      source: { provider: "codex", hookEvent: "Stop", rawBytes: 20 },
    });
    recordTaskSnapshot(project, task, task.lastSnapshot!, {
      source: "git",
      workspaceRelation: "not_on_base",
    });
    expect(readTaskState(project, task)).toMatchObject({
      hasUnmergedChanges: { value: true, source: "git" },
    });
  });

  it("does not refresh Git time when only agent attention changes", () => {
    const { project, task } = fixture();
    updateTaskState(project, task, { hasUnmergedChanges: true }, "git", "2030-01-01T00:00:00.000Z");
    updateTaskState(project, task, { failure: "attention" }, "daemon", "2030-01-01T00:01:00.000Z");
    const state = readTaskState(project, task);
    expect(state.hasUnmergedChanges.observedAt).toBe("2030-01-01T00:00:00.000Z");
    expect(state.updatedAt).toBe("2030-01-01T00:01:00.000Z");
  });

  it("rejects old or invalid state instead of migrating it", () => {
    const { project, task } = fixture();
    writeFileSync(taskStatePath(project.id, task.id), JSON.stringify({ version: 1 }));
    expect(() => readTaskState(project, task)).toThrow("discard and recreate");
    expect(() => ensureTaskState(project, task)).toThrow("discard and recreate");
  });

  it("rejects removed fields even when the state version is current", () => {
    const { project, task } = fixture();
    const path = taskStatePath(project.id, task.id);
    const state = readTaskState(project, task);
    writeFileSync(path, JSON.stringify({ ...state, operation: { kind: "review" } }));
    expect(() => readTaskState(project, task)).toThrow("discard and recreate");
  });

  it("does not reconstruct missing state from manifest snapshot fields", () => {
    const { project, task } = fixture();
    updateTask(project, task, {
      ...task.lastSnapshot!,
      phase: "needs_input",
      targetOid: "old-target",
      candidateTreeOid: "old-candidate",
      failure: "old failure",
    });
    unlinkSync(taskStatePath(project.id, task.id));
    expect(ensureTaskState(project, task)).toMatchObject({
      hasUnmergedChanges: { value: "unknown", source: "initial" },
    });
    expect(readTaskState(project, task)).not.toMatchObject({
      baseOid: "old-target",
      candidateTreeOid: "old-candidate",
      failure: "old failure",
    });
  });

  it("recovers a state lock left by a dead writer", () => {
    const { project, task } = fixture();
    const path = taskStatePath(project.id, task.id);
    writeFileSync(`${path}.lock`, "2147483647\n");
    updateTaskState(project, task, { failure: "attention" }, "daemon");
    expect(readTaskState(project, task).failure).toBe("attention");
  });

  it("records commit subjects only for the current exact candidate", () => {
    const { project, task } = fixture();
    updateTaskState(project, task, { baseOid: "base-a", candidateTreeOid: "tree-a" });
    expect(
      recordCandidateCommitMessage(project, task, {
        targetOid: "base-a",
        candidateTreeOid: "tree-a",
        conversationHighWaterSequence: 0,
        subject: "Describe candidate A",
        note: "Candidate A uses the narrow implementation because its scope is small.",
      }),
    ).toBe(true);
    expect(readTaskState(project, task).commitMessage).toMatchObject({
      subject: "Describe candidate A",
      note: "Candidate A uses the narrow implementation because its scope is small.",
    });

    updateTaskState(project, task, { candidateTreeOid: "tree-b" });
    expect(readTaskState(project, task).commitMessage).toBeUndefined();
    expect(
      recordCandidateCommitMessage(project, task, {
        targetOid: "base-a",
        candidateTreeOid: "tree-a",
        conversationHighWaterSequence: 0,
        subject: "Late candidate A result",
      }),
    ).toBe(false);
    expect(readTaskState(project, task).commitMessage).toBeUndefined();
    expect(
      recordCandidateCommitMessage(project, task, {
        targetOid: "base-a",
        candidateTreeOid: "tree-b",
        conversationHighWaterSequence: 0,
        subject: "Describe candidate B",
      }),
    ).toBe(true);
    expect(readTaskState(project, task).commitMessage?.subject).toBe("Describe candidate B");
  });

  it("merges stale manifest writers by owned snapshot dimension", () => {
    const { project, task } = fixture();
    const setup = {
      state: "passed" as const,
      command: "npm ci",
      startedAt: "2030-01-01T00:00:00.000Z",
      finishedAt: "2030-01-01T00:00:01.000Z",
      exitCode: 0,
      logPath: "/tmp/setup.log",
      jobId: "setup-job",
      configHash: "setup-config",
    };
    updateTask(project, task, { ...task.lastSnapshot!, setup }, undefined, "worker");
    updateTask(project, task, {
      ...task.lastSnapshot!,
      phase: "reviewed",
      candidateTreeOid: "candidate-tree",
    });
    const observed = updateTask(
      project,
      task,
      { ...task.lastSnapshot!, runtimeState: "running" },
      undefined,
      "daemon",
    );
    expect(observed.lastSnapshot).toMatchObject({
      phase: "reviewed",
      setup,
      candidateTreeOid: "candidate-tree",
      runtimeState: "running",
    });
    expect(readTaskState(project, observed)).toMatchObject({
      setup,
    });
  });

  it("projects and renders the same five facts", async () => {
    const { project, task } = fixture();
    updateTaskState(project, task, { hasUnmergedChanges: true }, "git");
    expect(captureStateProjection().tasks[0]).toMatchObject({
      view: { agent: { label: "Not started" }, changes: { state: "unmerged" } },
    });
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await expect(status(task.name, false)).resolves.toBe(0);
    const output = String(stdout.mock.calls.at(-1)?.[0]);
    expect(output).toContain("Agent: Not started");
    expect(output).toContain("Changes: Unmerged changes can be promoted");
  });

  it("projects provider turns and check outcomes as distinct phases", () => {
    const { project, task } = fixture();
    recordLifecycleEvent(project, task, {
      version: 1,
      sequence: 1,
      event: {
        version: 1,
        kind: "turn_finished",
        provider: "codex",
        providerSessionId: "session",
        recordedAt: "2030-01-01T00:00:00.000Z",
      },
      source: { provider: "codex", hookEvent: "Stop", rawBytes: 20 },
    });
    expect(captureStateProjection().tasks[0]).toMatchObject({
      view: { agent: { state: "awaiting_input", label: "Ready for input" } },
      internal: { phase: "awaiting_input" },
    });
    updateTaskState(project, task, {
      check: {
        status: "failed",
        targetOid: "base",
        candidateTreeOid: "tree",
        configHash: "config",
        results: [],
      },
    });
    expect(captureStateProjection().tasks[0]?.internal?.phase).toBe("check_failed");
    recordLifecycleEvent(project, task, {
      version: 1,
      sequence: 2,
      event: {
        version: 1,
        kind: "user_prompt",
        provider: "codex",
        providerSessionId: "session",
        prompt: "Continue",
        recordedAt: "2030-01-01T00:00:04.000Z",
      },
      source: { provider: "codex", hookEvent: "UserPromptSubmit", rawBytes: 20 },
    });
    expect(captureStateProjection().tasks[0]).toMatchObject({
      view: { agent: { state: "working", label: "Generating" } },
      internal: { phase: "working" },
    });
  });

  it("labels a recorded clean delivery as a point-in-time observation", async () => {
    const { project, task } = fixture();
    recordTaskSnapshot(project, task, task.lastSnapshot!, {
      source: "git",
      workspaceRelation: "on_base",
      lastDelivery: { ref: "main", oid: "abc123", subject: "Deliver the task" },
    });
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await expect(status(task.name, false)).resolves.toBe(0);
    expect(String(stdout.mock.calls.at(-1)?.[0])).toContain(
      'Delivery: Promoted to main as abc123 "Deliver the task"',
    );
  });

  it("recovers a task-manifest lock left by a dead writer", () => {
    const { project, task } = fixture();
    writeFileSync(taskManifestLockPath(project.id, task.id), "2147483647\n");
    expect(
      updateTask(project, task, { phase: "idle", agent: task.agent }).lastSnapshot?.phase,
    ).toBe("idle");
  });
});
