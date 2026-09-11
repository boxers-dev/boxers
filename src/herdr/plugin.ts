import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { command, requireSuccess } from "./process.ts";
import type { Agent } from "./types.ts";
import { refreshProjectMirror, resolveProjectTarget } from "./mirror.ts";
import {
  parseInvocationContext,
  pluginStateDir,
  readPluginState,
  selectedRoot,
  updateTask,
  withStateLock,
  writePluginState,
} from "./state.ts";
import { createPluginSandbox, openAgentPane, reconcilePluginPanes, runSbx } from "./sandbox.ts";
import {
  captureReview,
  currentWorkspaceTree,
  promoteReview,
  reviewDiff,
  reviewMatchesCurrentTarget,
  runReviewChecks,
  taskForReview,
} from "./review.ts";
import {
  livePreviewLogs,
  reconcilePreviewJobs,
  reviewedPreviewLogs,
  startLivePreview,
  startReviewedPreview,
  stopLivePreview,
} from "./preview.ts";
import type { HerdrTask } from "./types.ts";
import { parseProjectConfig } from "./config.ts";

function agent(value: string | undefined): Agent {
  if (value !== "codex" && value !== "claude") throw new Error("Agent must be codex or claude.");
  return value;
}

function herdr(args: readonly string[]): string {
  return requireSuccess(
    command(process.env.HERDR_BIN_PATH ?? "herdr", args),
    "Could not invoke Herdr",
  );
}

export function launchSandboxedAgent(requestedAgent?: Agent): HerdrTask {
  const stateDir = pluginStateDir();
  const context = parseInvocationContext(process.env.HERDR_PLUGIN_CONTEXT_JSON);
  const target = resolveProjectTarget(selectedRoot(context));
  const selectedAgent = requestedAgent ?? target.config.agent?.default ?? "codex";
  const project = refreshProjectMirror(stateDir, target);
  const sandboxId = createPluginSandbox(
    project.id,
    project.mirrorPath,
    selectedAgent,
    target.config,
  );
  const task: HerdrTask = {
    version: 1,
    id: randomUUID(),
    projectId: project.id,
    sandboxId,
    agent: selectedAgent,
    ...(target.config.agent?.model ? { agentModel: target.config.agent.model } : {}),
    ...(target.config.agent?.effort ? { agentEffort: target.config.agent.effort } : {}),
    projectRoot: project.root,
    mirrorPath: project.mirrorPath,
    ...(context.workspace_id ? { workspaceId: context.workspace_id } : {}),
    ...(context.focused_pane_id ? { sourcePaneId: context.focused_pane_id } : {}),
    createdAt: new Date().toISOString(),
  };
  withStateLock(stateDir, () => {
    const state = readPluginState(stateDir);
    const projectIndex = state.projects.findIndex((candidate) => candidate.id === project.id);
    if (projectIndex < 0) state.projects.push(project);
    else state.projects[projectIndex] = project;
    state.tasks.push(task);
    writePluginState(state, stateDir);
  });
  openAgentPane(task);
  return task;
}

export function openReview(): void {
  const task = taskForReview();
  const args = [
    "plugin",
    "pane",
    "open",
    "--plugin",
    process.env.HERDR_PLUGIN_ID ?? "boxers.sandboxes",
    "--entrypoint",
    "review",
    "--placement",
    "zoomed",
    "--cwd",
    task.projectRoot,
    "--env",
    `BOXERS_TASK_ID=${task.id}`,
    ...(task.paneId ? ["--target-pane", task.paneId] : []),
    "--focus",
  ];
  herdr(args);
}

export function openPreview(action: "start" | "restart" | "show" | "logs" = "start"): void {
  const task = taskForReview();
  herdr([
    "plugin",
    "pane",
    "open",
    "--plugin",
    process.env.HERDR_PLUGIN_ID ?? "boxers.sandboxes",
    "--entrypoint",
    "preview",
    "--placement",
    "zoomed",
    "--cwd",
    task.projectRoot,
    "--env",
    `BOXERS_TASK_ID=${task.id}`,
    "--env",
    `BOXERS_PREVIEW_ACTION=${action}`,
    ...(task.paneId ? ["--target-pane", task.paneId] : []),
    "--focus",
  ]);
}

function previewPane(): number {
  const taskId = process.env.BOXERS_TASK_ID;
  if (!taskId) throw new Error("The preview pane is missing its task mapping.");
  const action = process.env.BOXERS_PREVIEW_ACTION ?? "start";
  if (action === "restart") stopLivePreview(taskId);
  if (action === "start" || action === "restart") startLivePreview(taskId);
  const task = taskForReview(taskId);
  const preview = task.preview;
  if (!preview) throw new Error("No preview has been started for this sandbox.");
  const urls = preview.urls;
  output.write(`\n${preview.mode === "snapshot" ? "Reviewed" : "Live"} sandbox preview\n\n`);
  for (const url of urls) output.write(`  \u001b]8;;${url}\u0007${url}\u001b]8;;\u0007\n`);
  output.write(
    "\nStreaming preview logs. Press Ctrl-C to close this pane; the preview keeps running.\n\n",
  );
  const logPath =
    preview.mode === "snapshot" && preview.candidateTreeOid
      ? `/home/agent/.boxers/review-previews/jobs/${preview.candidateTreeOid}/log`
      : "/home/agent/.boxers/plugin-preview/live.log";
  const result = runSbx(["exec", task.sandboxId, "tail", "-n", "+1", "-f", logPath], true);
  return result.status;
}

function line(label: string, value: string): void {
  output.write(`${label}: ${value}\n`);
}

async function confirmPromotion(task: HerdrTask): Promise<void> {
  const review = task.review!;
  const currentTree = currentWorkspaceTree(task);
  const reader = createInterface({ input, output });
  try {
    if (currentTree !== review.candidateTreeOid) {
      output.write("\nThe sandbox has newer unreviewed changes.\n");
      const choice = (
        await reader.question("Type 'latest' to review them, or 'snapshot' to keep this review: ")
      ).trim();
      if (choice === "latest") {
        captureReview(task.id);
        output.write("Captured the latest workspace. Inspect it before promoting.\n");
        return;
      }
      if (choice !== "snapshot") return;
    }
    const configured = command("git", [
      "-C",
      task.mirrorPath,
      "show",
      `${review.candidateTreeOid}:.boxers/config.yml`,
    ]);
    const reviewConfig = parseProjectConfig(
      configured.status === 0 ? configured.stdout : "version: 1\n",
    );
    const hasChecks = Boolean(reviewConfig.setup || reviewConfig.checks.length);
    const checksPassed =
      (!reviewConfig.setup || review.setup?.passed === true) &&
      review.checks.length === reviewConfig.checks.length &&
      review.checks.every((check) => check.passed);
    if (hasChecks && !checksPassed) {
      const skip = (
        await reader.question("Checks have not passed. Type 'skip checks' to continue: ")
      ).trim();
      if (skip !== "skip checks") return;
      updateTask(pluginStateDir(), task.id, (current) => ({
        ...current,
        review: { ...review, checksSkipped: true },
      }));
    }
    const message =
      (await reader.question("Commit message: ")).trim() || "Promote reviewed changes";
    const confirmation = (
      await reader.question("Type 'promote' to publish this exact tree: ")
    ).trim();
    if (confirmation !== "promote") return;
    const delivery = promoteReview(task.id, message);
    output.write(`Published ${delivery.commitOid} to ${review.targetBranch}.\n`);
  } finally {
    reader.close();
  }
}

export async function reviewPane(): Promise<number> {
  const taskId = process.env.BOXERS_TASK_ID;
  if (!taskId) throw new Error("The review pane is missing its task mapping.");
  const initial = taskForReview(taskId);
  let review =
    initial.review &&
    (initial.delivery?.state === "pending" ||
      initial.delivery?.state === "accepted" ||
      reviewMatchesCurrentTarget(initial, initial.review))
      ? initial.review
      : captureReview(taskId);
  while (true) {
    const task = taskForReview(taskId);
    review = task.review ?? review;
    const current = currentWorkspaceTree(task);
    output.write(`\nBoxers review: ${task.sandboxId}\n`);
    line("Sandbox", `${task.agent === "codex" ? "Codex" : "Claude"} (sandboxed)`);
    line("Base", `${review.targetBranch} @ ${review.targetOid.slice(0, 12)}`);
    line("Candidate", `tree ${review.candidateTreeOid.slice(0, 12)}`);
    line(
      "Workspace",
      current === review.candidateTreeOid ? "matches review" : "newer unreviewed changes",
    );
    const displayedPreview =
      review.preview ?? (task.preview?.mode === "live" ? task.preview : undefined);
    if (displayedPreview?.urls.length)
      line(
        "Preview",
        `${displayedPreview.mode} ${displayedPreview.state} ${displayedPreview.urls.join(" ")}`,
      );
    if (review.setup)
      line("Setup", `${review.setup.passed ? "passed" : "failed"} (${review.setup.exitCode})`);
    line(
      "Checks",
      review.checksSkipped
        ? "skipped by user"
        : review.checks.length
          ? review.checks
              .map((check) => `${check.passed ? "passed" : "failed"} ${check.name}`)
              .join(", ")
          : "not run",
    );
    const diff = reviewDiff(task, review);
    const summary = diff.split("\n").find((row) => /files? changed/.test(row));
    line("Changes", summary?.trim() ?? "no changes");
    const reader = createInterface({ input, output });
    const choice = (
      await reader.question(
        "\n[d]iff [c]hecks re[v]iewed preview [r]eview latest [p]romote [q]close > ",
      )
    ).trim();
    reader.close();
    try {
      if (choice === "d") output.write(`\n${diff}\n`);
      else if (choice === "c") review = await runReviewChecks(taskId);
      else if (choice === "v") {
        const urls = startReviewedPreview(taskId);
        output.write(`${urls.join("\n")}\n`);
      } else if (choice === "r") review = captureReview(taskId);
      else if (choice === "p") await confirmPromotion(taskForReview(taskId));
      else if (choice === "q" || !choice) return 0;
    } catch (error) {
      output.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}

function sandboxAction(action: string): void {
  const task = taskForReview();
  if (action === "start") {
    requireSuccess(runSbx(["start", task.sandboxId]), `Could not start ${task.sandboxId}`);
    updateTask(pluginStateDir(), task.id, (current) => ({
      ...current,
      runtimeState: "running",
    }));
    openAgentPane(task);
    return;
  }
  if (action === "stop") {
    requireSuccess(runSbx(["stop", task.sandboxId]), `Could not stop ${task.sandboxId}`);
    updateTask(pluginStateDir(), task.id, (current) => ({
      ...current,
      runtimeState: "stopped",
      ...(current.preview ? { preview: { ...current.preview, state: "stopped" } } : {}),
      ...(current.review?.preview
        ? {
            review: {
              ...current.review,
              preview: { ...current.review.preview, state: "stopped" },
            },
          }
        : {}),
    }));
    return;
  }
  if (action !== "discard") throw new Error(`Unknown sandbox action ${action}.`);
  const current = currentWorkspaceTree(task);
  if (
    !task.delivery ||
    task.delivery.state !== "reconciled" ||
    current !== task.delivery.candidateTreeOid
  )
    throw new Error(
      "Discard refused: this sandbox contains work that is not a reconciled delivery.",
    );
  requireSuccess(runSbx(["stop", task.sandboxId]), `Could not stop ${task.sandboxId}`);
  requireSuccess(runSbx(["rm", task.sandboxId]), `Could not remove ${task.sandboxId}`);
  const stateDir = pluginStateDir();
  withStateLock(stateDir, () => {
    const state = readPluginState(stateDir);
    state.tasks = state.tasks.filter((candidate) => candidate.id !== task.id);
    writePluginState(state, stateDir);
  });
}

export async function dispatchHerdrPlugin(args: string[]): Promise<number> {
  const [commandName, value] = args;
  if (commandName === "launch") {
    launchSandboxedAgent(value === "default" ? undefined : agent(value));
    return 0;
  }
  if (commandName === "startup") {
    reconcilePluginPanes();
    reconcilePreviewJobs();
    return 0;
  }
  if (commandName === "open-review") {
    openReview();
    return 0;
  }
  if (commandName === "open-preview") {
    openPreview(value === "logs" || value === "show" || value === "restart" ? value : "start");
    return 0;
  }
  if (commandName === "preview-pane") return previewPane();
  if (commandName === "review-pane") return reviewPane();
  if (commandName === "preview") {
    if (value === "start" || value === "restart") {
      const urls = startLivePreview();
      output.write(`${urls.join("\n")}\n`);
    } else if (value === "stop") stopLivePreview();
    else if (value === "logs") {
      const task = taskForReview();
      output.write(
        task.preview?.mode === "snapshot" ? reviewedPreviewLogs(task.id) : livePreviewLogs(task.id),
      );
    } else throw new Error("Preview action must be start, restart, stop, or logs.");
    return 0;
  }
  if (commandName === "sandbox") {
    sandboxAction(value ?? "");
    return 0;
  }
  throw new Error("Unknown Herdr plugin command.");
}
