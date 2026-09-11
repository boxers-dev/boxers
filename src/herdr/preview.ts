import { command, requireSuccess } from "./process.ts";
import { parseProjectConfig } from "./config.ts";
import { runSbx } from "./sandbox.ts";
import { pluginStateDir, readPluginState, updateTask } from "./state.ts";
import { taskForReview } from "./review.ts";

interface PortBinding {
  host: string;
  hostPort: number;
  sandboxPort?: number;
}

function collectBindings(value: unknown, result: PortBinding[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectBindings(item, result);
    return;
  }
  if (!value || typeof value !== "object") return;
  const row = value as Record<string, unknown>;
  const hostPort = Number(row.host_port ?? row.hostPort ?? row.HostPort);
  if (Number.isInteger(hostPort) && hostPort > 0 && hostPort <= 65_535) {
    const sandboxPort = Number(
      row.sandbox_port ?? row.sandboxPort ?? row.container_port ?? row.containerPort ?? row.port,
    );
    result.push({
      host:
        (typeof (row.host_ip ?? row.hostIp ?? row.host) === "string"
          ? String(row.host_ip ?? row.hostIp ?? row.host)
          : "localhost") || "localhost",
      hostPort,
      ...(Number.isInteger(sandboxPort) ? { sandboxPort } : {}),
    });
    return;
  }
  for (const nested of Object.values(row)) collectBindings(nested, result);
}

function readBindings(sandboxId: string): PortBinding[] {
  const listing = runSbx(["ports", sandboxId, "--json"]);
  if (listing.status !== 0) return [];
  const bindings: PortBinding[] = [];
  try {
    collectBindings(JSON.parse(listing.stdout), bindings);
  } catch {
    for (const line of listing.stdout.split("\n")) {
      const match = /(\d{1,5}).*?(127\.0\.0\.1|localhost|\[::1\])[^\d]+(\d{1,5})/.exec(line);
      if (match)
        bindings.push({
          sandboxPort: Number(match[1]),
          host: match[2]!,
          hostPort: Number(match[3]),
        });
    }
  }
  return bindings;
}

function publishedUrls(sandboxId: string, ports: readonly number[]): string[] {
  const before = readBindings(sandboxId);
  const identified = new Set(
    before.flatMap((binding) => (binding.sandboxPort ? [binding.sandboxPort] : [])),
  );
  for (const port of ports) {
    if (identified.has(port)) continue;
    requireSuccess(
      runSbx(["ports", sandboxId, "--publish", String(port)]),
      `Could not publish preview port ${port}`,
    );
  }
  const bindings = readBindings(sandboxId);
  return [
    ...new Set(
      bindings
        .filter(
          (binding) =>
            (binding.sandboxPort !== undefined && ports.includes(binding.sandboxPort)) ||
            (binding.sandboxPort === undefined && bindings.length === 1 && ports.length === 1),
        )
        .map((binding) => `http://localhost:${binding.hostPort}`),
    ),
  ];
}

function livePreviewConfig(
  taskId?: string,
  reviewedConfig?: ReturnType<typeof parseProjectConfig>,
) {
  const task = taskForReview(taskId);
  const result = reviewedConfig
    ? undefined
    : command("git", ["-C", task.mirrorPath, "show", "HEAD:.boxers/config.yml"]);
  const config =
    reviewedConfig ?? parseProjectConfig(result?.status === 0 ? result.stdout : "version: 1\n");
  if (!config.preview) throw new Error("No preview is configured in .boxers/config.yml.");
  return { task, config, preview: config.preview };
}

export function startLivePreview(
  taskId?: string,
  reviewedConfig?: ReturnType<typeof parseProjectConfig>,
): string[] {
  const { task, config, preview } = livePreviewConfig(taskId, reviewedConfig);
  const script = String.raw`
set -euo pipefail
directory=$HOME/.boxers/plugin-preview
mkdir -p "$directory"
for pid_file in "$directory/pid" "$HOME/.boxers/review-previews/jobs"/*/pid; do
  test -f "$pid_file" || continue
  old=$(cat "$pid_file")
  case "$old" in *[!0-9]*|'') old=;; esac
  if test -n "$old" && kill -0 "$old" 2>/dev/null; then kill "$old" 2>/dev/null || true; fi
  rm -f "$pid_file"
done
: > "$directory/live.log"
printf '%s\n' "$$" > "$directory/pid"
if test -n "$2"; then
  timeout --signal=TERM --kill-after=5s "$3" bash -lc "$2" >> "$directory/live.log" 2>&1
fi
exec bash -lc "$1" >> "$directory/live.log" 2>&1
`;
  requireSuccess(
    runSbx([
      "exec",
      "-d",
      task.sandboxId,
      "bash",
      "-lc",
      script,
      "boxers-preview",
      preview.run,
      config.setup?.run ?? "",
      `${Math.max(1, config.setup?.timeoutMs ?? 900_000) / 1000}s`,
    ]),
    `Could not start preview in ${task.sandboxId}`,
  );
  const urls = publishedUrls(task.sandboxId, preview.ports);
  updateTask(pluginStateDir(), task.id, (current) => ({
    ...current,
    preview: { mode: "live", state: "running", urls },
    ...(current.review?.preview
      ? {
          review: {
            ...current.review,
            preview: { ...current.review.preview, state: "stopped" },
          },
        }
      : {}),
  }));
  return urls;
}

export function startReviewedPreview(taskId?: string): string[] {
  const task = taskForReview(taskId);
  if (!task.review) throw new Error("Capture a review before starting its preview.");
  const source = command("git", [
    "-C",
    task.mirrorPath,
    "show",
    `${task.review.candidateTreeOid}:.boxers/config.yml`,
  ]);
  const config = parseProjectConfig(source.status === 0 ? source.stdout : "version: 1\n");
  if (!config.preview) throw new Error("No preview is configured in the reviewed tree.");
  if (config.preview.reviewMode === "live") {
    const urls = startLivePreview(task.id, config);
    updateTask(pluginStateDir(), task.id, (current) => ({
      ...current,
      review: {
        ...current.review!,
        preview: { mode: "live", state: "running", urls },
      },
    }));
    return urls;
  }
  const tree = task.review.candidateTreeOid;
  const worktree = `/home/agent/.boxers/review-previews/worktrees/${tree}`;
  const job = `/home/agent/.boxers/review-previews/jobs/${tree}`;
  const script = String.raw`
set -euo pipefail
worktree=$1
job=$2
commit=$3
setup=$4
setup_timeout=$5
run=$6
case "$worktree" in /home/agent/.boxers/review-previews/worktrees/*) ;; *) exit 64;; esac
case "$job" in /home/agent/.boxers/review-previews/jobs/*) ;; *) exit 64;; esac
for pid_file in "$HOME/.boxers/plugin-preview/pid" "$HOME/.boxers/review-previews/jobs"/*/pid; do
  test -f "$pid_file" || continue
  old=$(cat "$pid_file")
  case "$old" in *[!0-9]*|'') continue;; esac
  kill "$old" 2>/dev/null || true
  rm -f "$pid_file"
done
git worktree remove --force "$worktree" >/dev/null 2>&1 || true
rm -rf "$worktree"
mkdir -p "$(dirname "$worktree")" "$job"
git worktree add --quiet --detach "$worktree" "$commit"
cd "$worktree"
: >"$job/log"
if test -n "$setup"; then
  timeout --signal=TERM --kill-after=5s "$setup_timeout" bash -lc "$setup" >>"$job/log" 2>&1
fi
printf '%s\n' "$$" >"$job/pid"
exec bash -lc "$run" >>"$job/log" 2>&1
`;
  requireSuccess(
    runSbx([
      "exec",
      "-d",
      task.sandboxId,
      "bash",
      "-lc",
      script,
      "boxers-reviewed-preview",
      worktree,
      job,
      task.review.transportCommitOid,
      config.preview.setup ?? config.setup?.run ?? "",
      `${Math.max(1, config.setup?.timeoutMs ?? 900_000) / 1000}s`,
      config.preview.run,
    ]),
    "Could not start the reviewed preview",
  );
  const urls = publishedUrls(task.sandboxId, config.preview.ports);
  updateTask(pluginStateDir(), task.id, (current) => ({
    ...current,
    preview: {
      mode: "snapshot",
      state: "running",
      urls,
      candidateTreeOid: tree,
    },
    review: {
      ...current.review!,
      preview: { mode: "snapshot", state: "running", urls },
    },
  }));
  return urls;
}

export function stopLivePreview(taskId?: string): void {
  const task = taskForReview(taskId);
  const script = String.raw`
set -u
for pid_file in "$HOME/.boxers/plugin-preview/pid" "$HOME/.boxers/review-previews/jobs"/*/pid; do
  test -f "$pid_file" || continue
  pid=$(cat "$pid_file")
  case "$pid" in *[!0-9]*|'') continue;; esac
  kill "$pid" 2>/dev/null || true
  rm -f "$pid_file"
done
`;
  requireSuccess(
    runSbx(["exec", task.sandboxId, "bash", "-lc", script]),
    `Could not stop preview in ${task.sandboxId}`,
  );
  updateTask(pluginStateDir(), task.id, (current) => ({
    ...current,
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
}

export function livePreviewLogs(taskId?: string): string {
  const task = taskForReview(taskId);
  return requireSuccess(
    runSbx([
      "exec",
      task.sandboxId,
      "bash",
      "-lc",
      'test ! -f "$HOME/.boxers/plugin-preview/live.log" || cat "$HOME/.boxers/plugin-preview/live.log"',
    ]),
    `Could not read preview logs from ${task.sandboxId}`,
  );
}

export function reviewedPreviewLogs(taskId?: string): string {
  const task = taskForReview(taskId);
  const tree = task.review?.candidateTreeOid;
  if (!tree) throw new Error("Capture a review before reading reviewed preview logs.");
  return requireSuccess(
    runSbx([
      "exec",
      task.sandboxId,
      "bash",
      "-lc",
      'test ! -f "$1" || cat "$1"',
      "boxers-reviewed-preview-logs",
      `/home/agent/.boxers/review-previews/jobs/${tree}/log`,
    ]),
    `Could not read reviewed preview logs from ${task.sandboxId}`,
  );
}

export function reconcilePreviewJobs(): void {
  const stateDir = pluginStateDir();
  // Runtime state is reconciled first. Only probe jobs in running sandboxes.
  for (const task of readPluginState(stateDir).tasks) {
    if (task.runtimeState !== "running" || !task.preview) continue;
    const pidPath =
      task.preview.mode === "snapshot" && task.preview.candidateTreeOid
        ? `/home/agent/.boxers/review-previews/jobs/${task.preview.candidateTreeOid}/pid`
        : "/home/agent/.boxers/plugin-preview/pid";
    const probe = runSbx([
      "exec",
      task.sandboxId,
      "bash",
      "-lc",
      `test -f "$1" && pid=$(cat "$1") && case "$pid" in *[!0-9]*|'') exit 1;; esac && kill -0 "$pid" 2>/dev/null`,
      "boxers-preview-probe",
      pidPath,
    ]);
    const state = probe.status === 0 ? "running" : "stopped";
    updateTask(stateDir, task.id, (current) => ({
      ...current,
      ...(current.preview ? { preview: { ...current.preview, state } } : {}),
      ...(current.review?.preview &&
      (current.review.preview.mode === "live" ||
        current.preview?.candidateTreeOid === current.review.candidateTreeOid)
        ? { review: { ...current.review, preview: { ...current.review.preview, state } } }
        : {}),
    }));
  }
}
