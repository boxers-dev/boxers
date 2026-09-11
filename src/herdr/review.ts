import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { command, requireSuccess } from "./process.ts";
import { parseProjectConfig } from "./config.ts";
import type { CheckDefinition, ProjectConfig } from "./types.ts";
import { withPidFileLock } from "./lock.ts";
import { runSbx, strictSandboxEnvironment } from "./sandbox.ts";
import {
  pluginStateDir,
  readPluginState,
  updateTask,
  withStateLock,
  writePluginState,
} from "./state.ts";
import type { HerdrCheckResult, HerdrDelivery, HerdrReview, HerdrTask } from "./types.ts";
import { refreshProjectMirror, resolveProjectTarget } from "./mirror.ts";

const CAPTURE_SCRIPT = String.raw`
set -euo pipefail
target=$1
review_id=$2
git cat-file -e "$target^{commit}"
capture_tree() {
  temporary_index=$(mktemp)
  index=$(git rev-parse --git-path index)
  if test -f "$index"; then cp "$index" "$temporary_index"; else GIT_INDEX_FILE="$temporary_index" git read-tree HEAD; fi
  GIT_INDEX_FILE="$temporary_index" git add -A -- .
  GIT_INDEX_FILE="$temporary_index" git write-tree
  rm -f "$temporary_index"
}
first=$(capture_tree)
second=$(capture_tree)
if test "$first" != "$second"; then
  printf 'Workspace changed while Boxers captured it; review again.\n' >&2
  exit 75
fi
commit=$(printf 'Boxers immutable review %s\n' "$review_id" |
  GIT_AUTHOR_NAME=Boxers GIT_AUTHOR_EMAIL=review@boxers.invalid \
  GIT_COMMITTER_NAME=Boxers GIT_COMMITTER_EMAIL=review@boxers.invalid \
  git commit-tree "$first" -p "$target")
git update-ref "refs/boxers/reviews/$review_id" "$commit"
printf '%s\n%s\n' "$first" "$commit"
`;

function git(cwd: string, args: readonly string[], description: string): string {
  return requireSuccess(command("git", ["-C", cwd, ...args]), description).trim();
}

function findTask(taskId?: string): HerdrTask {
  const state = readPluginState();
  const explicit = taskId ?? process.env.BOXERS_TASK_ID;
  if (explicit) {
    const task = state.tasks.find((candidate) => candidate.id === explicit);
    if (!task) throw new Error(`Unknown Boxers task ${explicit}.`);
    return task;
  }
  const context = process.env.HERDR_PLUGIN_CONTEXT_JSON
    ? (JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON) as Record<string, unknown>)
    : {};
  const workspaceId = process.env.HERDR_WORKSPACE_ID ?? context.workspace_id;
  const paneId = process.env.HERDR_PANE_ID ?? context.focused_pane_id;
  const matches = state.tasks.filter(
    (task) => task.paneId === paneId || (workspaceId && task.workspaceId === workspaceId),
  );
  const task = matches.sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  if (!task) throw new Error("No Boxers sandbox is associated with the selected Herdr context.");
  return task;
}

function candidateConfig(
  task: HerdrTask,
  treeOid: string,
): { config: ProjectConfig; hash: string } {
  const result = command("git", ["-C", task.mirrorPath, "show", `${treeOid}:.boxers/config.yml`]);
  const text = result.status === 0 ? result.stdout : "version: 1\n";
  return {
    config: parseProjectConfig(text),
    hash: createHash("sha256").update(text).digest("hex"),
  };
}

interface CapturedWorkspace {
  candidateTreeOid: string;
  transportCommitOid: string;
  reviewId: string;
}

function captureWorkspace(task: HerdrTask, targetOid: string): CapturedWorkspace {
  const reviewId = randomUUID();
  const capture = runSbx([
    "exec",
    task.sandboxId,
    "bash",
    "-lc",
    CAPTURE_SCRIPT,
    "boxers-review",
    targetOid,
    reviewId,
  ]);
  const output = requireSuccess(capture, `Could not capture ${task.sandboxId}`).trim().split("\n");
  const [candidateTreeOid, transportCommitOid] = output.slice(-2);
  if (!candidateTreeOid || !transportCommitOid)
    throw new Error("Sandbox review capture returned incomplete Git identities.");
  git(
    task.mirrorPath,
    [
      "fetch",
      "--no-tags",
      `sandbox-${task.sandboxId}`,
      `+refs/boxers/reviews/${reviewId}:refs/boxers/reviews/${reviewId}`,
    ],
    "Could not fetch the immutable candidate into the project mirror",
  );
  const fetchedTree = git(
    task.mirrorPath,
    ["rev-parse", `${transportCommitOid}^{tree}`],
    "Could not verify the fetched candidate tree",
  );
  if (fetchedTree !== candidateTreeOid)
    throw new Error("Fetched review object does not match the captured candidate tree.");
  return { candidateTreeOid, transportCommitOid, reviewId };
}

function reconcileWorkspace(
  task: HerdrTask,
  oldTargetOid: string,
  newTargetOid: string,
  checkpoint: CapturedWorkspace,
): string[] {
  const script = String.raw`
set -euo pipefail
old_target=$1
new_target=$2
candidate_ref=$3
target_ref=refs/boxers/reconcile/target
work_ref=refs/boxers/reconcile/work
git fetch --no-tags -q origin \
  "+refs/boxers/target:$target_ref" \
  "+$candidate_ref:$work_ref"
test "$(git rev-parse "$target_ref^{commit}")" = "$new_target"
git cat-file -e "$old_target^{commit}"
git reset --hard -q "$target_ref"
git clean -fdq
set +e
git -c user.name=Boxers -c user.email=boxers@localhost \
  merge --squash --no-commit "$work_ref" >/tmp/boxers-reconcile.log 2>&1
status=$?
set -e
if test "$status" = 0; then
  git reset -q
  printf 'clean\n'
  exit 0
fi
conflicts=$(git diff --name-only --diff-filter=U)
if test -n "$conflicts"; then
  printf 'conflicted\n%s\n' "$conflicts"
  exit 0
fi
git reset --hard -q "$work_ref"
git reset -q "$old_target"
cat /tmp/boxers-reconcile.log >&2
exit "$status"
`;
  const result = runSbx([
    "exec",
    task.sandboxId,
    "bash",
    "-lc",
    script,
    "boxers-reconcile",
    oldTargetOid,
    newTargetOid,
    `refs/boxers/reviews/${checkpoint.reviewId}`,
  ]);
  const lines = requireSuccess(result, `Could not reconcile ${task.sandboxId}`).trim().split("\n");
  if (lines[0] === "clean") return [];
  if (lines[0] === "conflicted") return lines.slice(1).filter(Boolean);
  throw new Error("Sandbox reconciliation returned an invalid result.");
}

export function captureReview(taskId?: string): HerdrReview {
  let task = findTask(taskId);
  if (task.delivery?.state === "pending" || task.delivery?.state === "accepted")
    throw new Error(
      "This sandbox has an unresolved delivery; recover it before capturing another review.",
    );
  const stateDir = pluginStateDir();
  const state = readPluginState(stateDir);
  let project = state.projects.find((candidate) => candidate.id === task.projectId);
  if (!project) throw new Error(`Missing project mapping for ${task.sandboxId}.`);
  const resolved = resolveProjectTarget(project.root);
  const refreshed = refreshProjectMirror(stateDir, resolved, project.id);
  if (refreshed.targetOid !== project.targetOid) {
    const checkpoint = captureWorkspace(task, project.targetOid);
    const conflicts = reconcileWorkspace(task, project.targetOid, refreshed.targetOid, checkpoint);
    project = refreshed;
    withStateLock(stateDir, () => {
      const current = readPluginState(stateDir);
      const projectIndex = current.projects.findIndex((item) => item.id === project!.id);
      current.projects[projectIndex] = project!;
      const taskIndex = current.tasks.findIndex((item) => item.id === task.id);
      current.tasks[taskIndex] = { ...current.tasks[taskIndex]!, conflicts };
      writePluginState(current, stateDir);
    });
    task = { ...task, conflicts };
    if (conflicts.length)
      throw new Error(
        `Upstream reconciliation has conflicts: ${conflicts.join(", ")}. Resolve them in the sandbox, then review again.`,
      );
  } else if (
    refreshed.targetUrl !== project.targetUrl ||
    refreshed.targetBranch !== project.targetBranch ||
    refreshed.configHash !== project.configHash
  ) {
    project = refreshed;
  }
  withStateLock(stateDir, () => {
    const current = readPluginState(stateDir);
    const projectIndex = current.projects.findIndex((item) => item.id === project!.id);
    current.projects[projectIndex] = project!;
    const taskIndex = current.tasks.findIndex((item) => item.id === task.id);
    current.tasks[taskIndex] = { ...current.tasks[taskIndex]!, conflicts: [] };
    writePluginState(current, stateDir);
  });
  const captured = captureWorkspace(task, project.targetOid);
  const config = candidateConfig(task, captured.candidateTreeOid);
  const configHash = createHash("sha256")
    .update(`${project.configHash}\0${config.hash}`)
    .digest("hex");
  const review: HerdrReview = {
    version: 1,
    id: captured.reviewId,
    projectId: task.projectId,
    sandboxId: task.sandboxId,
    agent: task.agent,
    ...(task.paneId ? { paneId: task.paneId } : {}),
    targetUrl: project.targetUrl,
    targetBranch: project.targetBranch,
    targetOid: project.targetOid,
    candidateTreeOid: captured.candidateTreeOid,
    transportCommitOid: captured.transportCommitOid,
    configHash,
    capturedAt: new Date().toISOString(),
    checks: [],
  };
  updateTask(pluginStateDir(), task.id, (current) => {
    const next = { ...current, review };
    delete next.delivery;
    return next;
  });
  return review;
}

export function reviewDiff(task: HerdrTask, review: HerdrReview): string {
  return requireSuccess(
    command("git", [
      "-C",
      task.mirrorPath,
      "diff",
      "--stat",
      "--patch",
      "--find-renames",
      review.targetOid,
      review.candidateTreeOid,
    ]),
    "Could not render the immutable review diff",
  );
}

export function currentWorkspaceTree(task: HerdrTask): string {
  const script = String.raw`
set -euo pipefail
temporary_index=$(mktemp)
trap 'rm -f "$temporary_index"' EXIT
index=$(git rev-parse --git-path index)
if test -f "$index"; then cp "$index" "$temporary_index"; else GIT_INDEX_FILE="$temporary_index" git read-tree HEAD; fi
GIT_INDEX_FILE="$temporary_index" git add -A -- .
GIT_INDEX_FILE="$temporary_index" git write-tree
`;
  return requireSuccess(
    runSbx(["exec", task.sandboxId, "bash", "-lc", script]),
    "Could not inspect current sandbox changes",
  ).trim();
}

export function reviewMatchesCurrentTarget(task: HerdrTask, review: HerdrReview): boolean {
  const resolved = resolveProjectTarget(task.projectRoot);
  const candidate = candidateConfig(task, review.candidateTreeOid);
  const configHash = createHash("sha256")
    .update(`${resolved.configHash}\0${candidate.hash}`)
    .digest("hex");
  return (
    resolved.url === review.targetUrl &&
    resolved.branch === review.targetBranch &&
    resolved.oid === review.targetOid &&
    configHash === review.configHash
  );
}

function checkWorkspacePath(review: HerdrReview): string {
  return `/home/agent/.boxers/checks/${review.candidateTreeOid}`;
}

function materializeCheckWorkspace(task: HerdrTask, review: HerdrReview): string {
  const directory = checkWorkspacePath(review);
  const script = String.raw`
set -euo pipefail
directory=$1
commit=$2
case "$directory" in /home/agent/.boxers/checks/*) ;; *) exit 64;; esac
git worktree remove --force "$directory" >/dev/null 2>&1 || true
rm -rf "$directory"
mkdir -p "$(dirname "$directory")"
git worktree add --quiet --detach "$directory" "$commit"
`;
  requireSuccess(
    runSbx([
      "exec",
      task.sandboxId,
      "bash",
      "-lc",
      script,
      "boxers-check-workspace",
      directory,
      review.transportCommitOid,
    ]),
    "Could not materialize the reviewed check workspace",
  );
  return directory;
}

function runStreamingCheck(
  task: HerdrTask,
  review: HerdrReview,
  check: CheckDefinition,
  directory: string,
  logPath: string,
): Promise<HerdrCheckResult> {
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
  const log = openSync(logPath, "w", 0o600);
  const startedAt = new Date().toISOString();
  const run = String.raw`
set -euo pipefail
directory=$1
timeout_value=$2
command=$3
cd "$directory"
exec timeout --signal=TERM --kill-after=5s "$timeout_value" bash -lc "$command" 2>&1
`;
  const timeout = `${Math.max(1, check.timeoutMs) / 1000}s`;
  return new Promise((resolve, reject) => {
    const child = spawn(
      "sbx",
      ["exec", task.sandboxId, "bash", "-lc", run, "boxers-check", directory, timeout, check.run],
      { env: strictSandboxEnvironment(), stdio: ["ignore", "pipe", "pipe"] },
    );
    const relay = (chunk: Buffer): void => {
      process.stdout.write(chunk);
      writeFileSync(log, chunk);
    };
    child.stdout.on("data", relay);
    child.stderr.on("data", relay);
    const timer = setTimeout(() => child.kill("SIGKILL"), check.timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      closeSync(log);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      closeSync(log);
      resolve({
        name: check.name,
        passed: code === 0,
        exitCode: code ?? 1,
        targetOid: review.targetOid,
        candidateTreeOid: review.candidateTreeOid,
        configHash: review.configHash,
        startedAt,
        finishedAt: new Date().toISOString(),
        logPath,
      });
    });
  });
}

export async function runReviewChecks(taskId?: string): Promise<HerdrReview> {
  const task = findTask(taskId);
  if (!task.review) throw new Error("Capture a review before running checks.");
  const config = candidateConfig(task, task.review.candidateTreeOid).config;
  const directory = materializeCheckWorkspace(task, task.review);
  let setup: HerdrCheckResult | undefined;
  const checks: HerdrCheckResult[] = [];
  if (config.setup) {
    const definition: CheckDefinition = {
      name: "setup",
      run: config.setup.run,
      timeoutMs: config.setup.timeoutMs,
    };
    setup = await runStreamingCheck(
      task,
      task.review,
      definition,
      directory,
      join(pluginStateDir(), "logs", task.id, task.review.id, "setup.log"),
    );
  }
  if (setup && !setup.passed) {
    const review = { ...task.review, setup, checks };
    updateTask(pluginStateDir(), task.id, (current) => ({ ...current, review }));
    return review;
  }
  for (const check of config.checks) {
    const logPath = join(pluginStateDir(), "logs", task.id, task.review.id, `${check.name}.log`);
    const result = await runStreamingCheck(task, task.review, check, directory, logPath);
    checks.push(result);
    if (!result.passed) break;
  }
  const review = { ...task.review, ...(setup ? { setup } : {}), checks };
  updateTask(pluginStateDir(), task.id, (current) => ({ ...current, review }));
  return review;
}

function withPromotionLock<T>(projectId: string, work: () => T): T {
  const path = join(pluginStateDir(), "projects", projectId, "promotion.lock");
  return withPidFileLock(path, work);
}

function refreshTarget(task: HerdrTask, review: HerdrReview): string {
  git(
    task.mirrorPath,
    [
      "fetch",
      "--no-tags",
      "--force",
      review.targetUrl,
      `+refs/heads/${review.targetBranch}:refs/boxers/promotion-target`,
    ],
    "Could not refresh the promotion target",
  );
  return git(
    task.mirrorPath,
    ["rev-parse", "refs/boxers/promotion-target^{commit}"],
    "Could not read the promotion target",
  );
}

function acceptedByTarget(task: HerdrTask, delivery: HerdrDelivery): boolean {
  const target = refreshTarget(task, task.review!);
  return (
    command("git", [
      "-C",
      task.mirrorPath,
      "merge-base",
      "--is-ancestor",
      delivery.commitOid,
      target,
    ]).status === 0
  );
}

function isDefinitivePushRejection(output: string): boolean {
  return /\[rejected\]|non-fast-forward|fetch first|stale info|remote rejected|pre-receive hook declined/i.test(
    output,
  );
}

export function promoteReview(taskId: string | undefined, message: string): HerdrDelivery {
  const initial = findTask(taskId);
  if (!initial.review) throw new Error("Capture a review before promotion.");
  return withPromotionLock(initial.projectId, () => {
    let task = findTask(initial.id);
    const review = task.review!;
    let delivery = task.delivery;
    if (delivery && delivery.reviewId !== review.id)
      throw new Error("A delivery for another review must be reconciled first.");
    if (delivery?.state === "reconciled") return delivery;
    if (delivery?.state === "rejected")
      throw new Error(
        "The previous push was rejected; capture a new review against the current target.",
      );

    if (!delivery) {
      const resolved = resolveProjectTarget(task.projectRoot);
      const candidate = candidateConfig(task, review.candidateTreeOid);
      const currentConfigHash = createHash("sha256")
        .update(`${resolved.configHash}\0${candidate.hash}`)
        .digest("hex");
      if (
        resolved.url !== review.targetUrl ||
        resolved.branch !== review.targetBranch ||
        resolved.oid !== review.targetOid ||
        currentConfigHash !== review.configHash
      )
        throw new Error(
          "The target or promotion configuration changed; capture and inspect a new review.",
        );
      const currentTarget = refreshTarget(task, review);
      if (currentTarget !== review.targetOid)
        throw new Error("The upstream target advanced; capture and inspect a new review.");
      git(
        task.mirrorPath,
        ["cat-file", "-e", `${review.candidateTreeOid}^{tree}`],
        "The reviewed candidate is missing from the project mirror",
      );
      const config = candidateConfig(task, review.candidateTreeOid).config;
      const required = config.checks;
      const setupPassed =
        !config.setup ||
        (review.setup?.passed === true &&
          review.setup.targetOid === review.targetOid &&
          review.setup.candidateTreeOid === review.candidateTreeOid &&
          review.setup.configHash === review.configHash);
      if (
        (!setupPassed ||
          (required.length > 0 &&
            (review.checks.length !== required.length ||
              review.checks.some(
                (result) =>
                  !result.passed ||
                  result.targetOid !== review.targetOid ||
                  result.candidateTreeOid !== review.candidateTreeOid ||
                  result.configHash !== review.configHash,
              )))) &&
        !review.checksSkipped
      )
        throw new Error("Required checks have not passed for this exact review.");
      const ref = `refs/boxers/deliveries/${review.id}`;
      const commitOid = requireSuccess(
        command(
          "git",
          [
            "-C",
            task.mirrorPath,
            "commit-tree",
            review.candidateTreeOid,
            "-p",
            review.targetOid,
            "-m",
            message,
          ],
          {
            env: {
              ...process.env,
              GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "Boxers",
              GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "boxers@localhost",
              GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "Boxers",
              GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "boxers@localhost",
            },
          },
        ),
        "Could not create the host-authored delivery commit",
      ).trim();
      git(task.mirrorPath, ["update-ref", ref, commitOid], "Could not retain the delivery commit");
      delivery = {
        version: 1,
        reviewId: review.id,
        targetOid: review.targetOid,
        candidateTreeOid: review.candidateTreeOid,
        commitOid,
        state: "pending",
        message,
        createdAt: new Date().toISOString(),
      };
      task = updateTask(pluginStateDir(), task.id, (current) => ({
        ...current,
        delivery: delivery!,
      }));
    }

    if (delivery.state === "pending") {
      const deliveryRef = `refs/boxers/deliveries/${review.id}`;
      const push = command("git", [
        "-C",
        task.mirrorPath,
        "push",
        "--porcelain",
        review.targetUrl,
        `${deliveryRef}:refs/heads/${review.targetBranch}`,
      ]);
      if (push.status !== 0 && !acceptedByTarget(task, delivery)) {
        const detail = (push.stderr || push.stdout).trim();
        if (isDefinitivePushRejection(detail)) {
          delivery = { ...delivery, state: "rejected" };
          const rejected = delivery;
          updateTask(pluginStateDir(), task.id, (current) => ({ ...current, delivery: rejected }));
          throw new Error(`Target push was rejected: ${detail}`);
        }
        throw new Error(
          `Target push outcome is unresolved; retry promotion to deliver the same commit: ${detail}`,
        );
      }
      delivery = { ...delivery, state: "accepted", acceptedAt: new Date().toISOString() };
      const accepted = delivery;
      task = updateTask(pluginStateDir(), task.id, (current) => ({
        ...current,
        delivery: accepted,
      }));
    }

    const advance = runSbx([
      "exec",
      task.sandboxId,
      "bash",
      "-lc",
      'git fetch --no-tags -q origin "$1" && git reset --mixed -q "$1"',
      "boxers-advance",
      delivery.commitOid,
    ]);
    if (advance.status !== 0) {
      delivery = {
        ...delivery,
        reconciliationError:
          (advance.stderr || advance.stdout).trim() || "Sandbox advancement failed",
      };
      updateTask(pluginStateDir(), task.id, (current) => ({
        ...current,
        delivery: delivery!,
      }));
      return delivery;
    }
    delivery = { ...delivery, state: "reconciled", reconciledAt: new Date().toISOString() };
    updateTask(pluginStateDir(), task.id, (current) => ({
      ...current,
      delivery: delivery!,
    }));
    return delivery;
  });
}

export function taskForReview(taskId?: string): HerdrTask {
  return findTask(taskId);
}
