import { createHash } from "node:crypto";
import {
  command,
  commandAsync,
  commandStreaming,
  requireSuccess,
  type CommandResult,
  type StreamingCommandOptions,
  type StreamingCommandResult,
} from "./process.ts";
import type { TaskManifest } from "./types.ts";
import type {
  RuntimeJobLogs,
  RuntimeJobRequest,
  RuntimeJobState,
  RuntimeJobStatus,
  RuntimePreviewHandle,
} from "./runtime/types.ts";
import { note } from "../core/ui.ts";

export interface SandboxInfo {
  name: string;
  status: string;
  agent?: string;
  ports?: unknown;
}

export interface NativeGitStatus {
  targetOid: string;
  headOid: string;
  uncommitted: boolean;
  committedAhead: number;
  committedBehind: number;
}

export function sbx(args: readonly string[]): CommandResult {
  return command("sbx", args);
}

export function sbxAsync(args: readonly string[]): Promise<CommandResult> {
  return commandAsync("sbx", args);
}

export function parseSandboxList(value: unknown): SandboxInfo[] {
  const raw = Array.isArray(value)
    ? value
    : value &&
        typeof value === "object" &&
        Array.isArray((value as Record<string, unknown>).sandboxes)
      ? ((value as Record<string, unknown>).sandboxes as unknown[])
      : [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const name = row.name ?? row.Name;
    const status = row.status ?? row.Status ?? row.state ?? row.State;
    if (typeof name !== "string" || typeof status !== "string") return [];
    return [
      {
        name,
        status,
        ...(typeof (row.agent ?? row.Agent) === "string"
          ? { agent: (row.agent ?? row.Agent) as string }
          : {}),
        ...((row.ports ?? row.Ports) !== undefined ? { ports: row.ports ?? row.Ports } : {}),
      },
    ];
  });
}

export function listSandboxes(): SandboxInfo[] {
  const output = requireSuccess(sbx(["ls", "--json"]), "Could not list Docker Sandboxes");
  return parseSandboxListOutput(output);
}

export async function listSandboxesAsync(): Promise<SandboxInfo[]> {
  const output = requireSuccess(
    await sbxAsync(["ls", "--json"]),
    "Could not list Docker Sandboxes",
  );
  return parseSandboxListOutput(output);
}

function parseSandboxListOutput(output: string): SandboxInfo[] {
  try {
    return parseSandboxList(JSON.parse(output));
  } catch (error) {
    throw new Error(
      `sbx ls returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function isRunning(info: SandboxInfo | undefined): boolean {
  return Boolean(info && /running|ready|active/i.test(info.status));
}

export function createSandbox(task: TaskManifest, seedPath: string): void {
  note(
    `Creating Sandbox ${task.runtime.id}${task.template ? ` from ${task.template}` : ""}. The first use may download its template...`,
  );
  const created = command(
    "sbx",
    [
      "create",
      "--clone",
      "--no-share-skills",
      "--name",
      task.runtime.id,
      ...(task.template ? ["--template", task.template] : []),
      task.agent,
      seedPath,
    ],
    { stdio: "inherit" },
  );
  requireSuccess(created, `Could not create Sandbox ${task.runtime.id}`);
}

export function nativeWorkspacePatch(task: TaskManifest, targetOid: string): string {
  const script = `
set -euo pipefail
target="$1"
git cat-file -e "$target^{commit}"
if ! git merge-base --is-ancestor "$target" HEAD; then
  printf 'Workspace history does not match its recorded target %s; refusing to capture a false task diff.\n' "$target" >&2
  exit 1
fi
git diff --binary --full-index --no-ext-diff "$target" --
while IFS= read -r -d '' path; do
  git diff --binary --full-index --no-ext-diff --no-index -- /dev/null "$path" || test "$?" = 1
done < <(git ls-files --others --exclude-standard -z)
`;
  const result = sbx(["exec", task.runtime.id, "bash", "-lc", script, "boxers", targetOid]);
  if (result.status !== 0)
    throw new Error(
      `Could not snapshot native workspace ${task.name}: ${(result.stderr || result.stdout).trim()}`,
    );
  return result.stdout;
}

/**
 * Read a compact, current Git comparison without changing the task workspace.
 * The target ref lives under refs/boxers so fetching it cannot move the
 * task's branch, index, or working tree.
 */
export async function nativeGitStatus(
  task: TaskManifest,
  base: string,
  expectedTargetOid: string,
): Promise<NativeGitStatus> {
  const script = `
set -euo pipefail
base="$1"
target_ref=refs/boxers/status/target
git fetch --no-tags -q origin "+refs/heads/$base:$target_ref"
target=$(git rev-parse "$target_ref^{commit}")
if test "$target" != "$2"; then
  printf 'fetched %s, expected %s\\n' "$target" "$2" >&2
  exit 1
fi
head=$(git rev-parse HEAD^{commit})
set -- $(git rev-list --left-right --count "$target...$head")
if test -n "$(git status --porcelain=v1 --untracked-files=all)"; then
  uncommitted=true
else
  uncommitted=false
fi
printf '%s\\n%s\\n%s\\n%s\\n%s\\n' "$target" "$head" "$uncommitted" "$2" "$1"
`;
  const result = await commandAsync("sbx", [
    "exec",
    task.runtime.id,
    "bash",
    "-lc",
    script,
    "boxers",
    base,
    expectedTargetOid,
  ]);
  if (result.status !== 0)
    throw new Error(
      `Could not inspect Git status for ${task.name}: ${(result.stderr || result.stdout).trim()}`,
    );
  const [targetOid, headOid, uncommitted, ahead, behind] = result.stdout.trim().split("\n");
  if (
    !targetOid ||
    !headOid ||
    (uncommitted !== "true" && uncommitted !== "false") ||
    !/^\d+$/.test(ahead ?? "") ||
    !/^\d+$/.test(behind ?? "")
  )
    throw new Error(`Sandbox returned an invalid Git status for ${task.name}.`);
  return {
    targetOid,
    headOid,
    uncommitted: uncommitted === "true",
    committedAhead: Number(ahead),
    committedBehind: Number(behind),
  };
}

export interface NativeReconciliationResult {
  status: "clean" | "conflicted";
  conflicts: string[];
}

export function nativeConflictPaths(task: TaskManifest): string[] {
  const result = sbx(["exec", task.runtime.id, "git", "diff", "--name-only", "--diff-filter=U"]);
  if (result.status !== 0)
    throw new Error(
      `Could not inspect native workspace ${task.name}: ${(result.stderr || result.stdout).trim()}`,
    );
  return result.stdout
    .split("\n")
    .map((path) => path.trim())
    .filter(Boolean);
}

export function reconcileNativeWorkspace(
  task: TaskManifest,
  base: string,
  oldTargetOid: string,
  targetOid: string,
  candidateRef: string,
): NativeReconciliationResult {
  const script = `
set -euo pipefail
base="$1"
old_target="$2"
target="$3"
candidate_ref="$4"
state=.git/boxers
work_ref=refs/boxers/reconcile/work
target_ref=refs/boxers/reconcile/target
mkdir -p "$state"

git fetch --no-tags -q origin \
  "+refs/heads/$base:$target_ref" \
  "+$candidate_ref:$work_ref"
actual=$(git rev-parse "$target_ref^{commit}")
if test "$actual" != "$target"; then
  printf 'fetched %s, expected %s\n' "$actual" "$target" >&2
  exit 1
fi
git cat-file -e "$old_target^{commit}"
git cat-file -e "$work_ref^{commit}"

# The work ref is an immutable exact-tree checkpoint, so the original task can
# always be recovered even though reconciliation replaces the visible base.
git reset --hard -q "$target_ref"
git clean -fdq
set +e
git -c user.name=Boxers -c user.email=boxers@localhost \
  merge --squash --no-commit "$work_ref" >"$state/reconcile.log" 2>&1
merge_status=$?
set -e
if test "$merge_status" = 0; then
  # Reconciliation is a workspace operation. Leave the resulting task changes
  # unstaged so we do not impose a new index state on the native agent session.
  git reset -q
  printf 'clean\n'
  exit 0
fi

conflicts=$(git diff --name-only --diff-filter=U)
if test -n "$conflicts"; then
  printf 'conflicted\n%s\n' "$conflicts"
  exit 0
fi

# An unexpected merge failure must not strand the task on a destructive reset.
# Restore the exact checkpoint on its original base before reporting the error.
git reset --hard -q "$work_ref"
git reset -q "$old_target"
cat "$state/reconcile.log" >&2
exit "$merge_status"
`;
  const result = sbx([
    "exec",
    task.runtime.id,
    "bash",
    "-lc",
    script,
    "boxers",
    base,
    oldTargetOid,
    targetOid,
    candidateRef,
  ]);
  if (result.status !== 0)
    throw new Error(
      `Could not reconcile native workspace ${task.name}: ${(result.stderr || result.stdout).trim()}`,
    );
  const [status, ...paths] = result.stdout.trim().split("\n");
  if (status !== "clean" && status !== "conflicted")
    throw new Error(`Native reconciliation returned an invalid status for ${task.name}.`);
  return {
    status,
    conflicts: paths.map((path) => path.trim()).filter(Boolean),
  };
}

export function runSandboxShell(
  task: TaskManifest,
  script: string,
  timeout?: number,
): CommandResult {
  return command(
    "sbx",
    ["exec", task.runtime.id, "bash", "-lc", script],
    timeout === undefined ? {} : { timeout, killSignal: "SIGKILL" },
  );
}

export function runSandboxShellStreaming(
  task: TaskManifest,
  script: string,
  options: StreamingCommandOptions = {},
): Promise<StreamingCommandResult> {
  return commandStreaming("sbx", ["exec", task.runtime.id, "bash", "-lc", script], options);
}

export function runSandboxShellStreamingAt(
  task: TaskManifest,
  directory: string,
  script: string,
  options: StreamingCommandOptions = {},
): Promise<StreamingCommandResult> {
  const wrapper = `set -eu\ncd -- "$1"\nexec bash -lc "$2"`;
  return commandStreaming(
    "sbx",
    ["exec", task.runtime.id, "bash", "-lc", wrapper, "boxers-check", directory, script],
    options,
  );
}

export function nativeWorkspaceTreeAt(task: TaskManifest, directory: string): string {
  const script = String.raw`
set -euo pipefail
cd -- "$1"
index=$(mktemp)
trap 'rm -f "$index"' EXIT
GIT_INDEX_FILE="$index" git read-tree HEAD
GIT_INDEX_FILE="$index" git add -A -- .
GIT_INDEX_FILE="$index" git write-tree
`;
  const result = sbx([
    "exec",
    task.runtime.id,
    "bash",
    "-lc",
    script,
    "boxers-check-tree",
    directory,
  ]);
  const tree = result.stdout.trim();
  if (result.status !== 0 || !/^[0-9a-f]{40,64}$/.test(tree))
    throw new Error(
      `Could not inspect isolated check workspace for ${task.name}: ${(result.stderr || result.stdout).trim()}`,
    );
  return tree;
}

/** Streams setup while retaining the same combined output inside the workspace for the agent. */
export function runSandboxSetupStreaming(
  task: TaskManifest,
  run: string,
  options: StreamingCommandOptions = {},
): Promise<StreamingCommandResult> {
  const wrapper = `
set -o pipefail
mkdir -p .git/boxers
bash -lc "$1" 2>&1 | tee .git/boxers/setup.log
`;
  return commandStreaming(
    "sbx",
    ["exec", task.runtime.id, "bash", "-lc", wrapper, "boxers", run],
    options,
  );
}

const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const JOB_STATES = new Set<RuntimeJobState>([
  "queued",
  "running",
  "passed",
  "failed",
  "timed_out",
  "stale",
  "interrupted",
]);

function assertJobIdentifier(value: string, label: string): void {
  if (!JOB_ID_PATTERN.test(value)) throw new Error(`Invalid Sandbox job ${label}.`);
}

function parseRuntimeJobStatus(value: string, expectedJobId: string): RuntimeJobStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Sandbox job ${expectedJobId} returned invalid JSON.`);
  }
  if (!parsed || typeof parsed !== "object")
    throw new Error(`Sandbox job ${expectedJobId} returned an invalid status.`);
  const record = parsed as Record<string, unknown>;
  if (
    record.version !== 1 ||
    record.jobId !== expectedJobId ||
    typeof record.state !== "string" ||
    !JOB_STATES.has(record.state as RuntimeJobState) ||
    typeof record.updatedAt !== "string"
  )
    throw new Error(`Sandbox job ${expectedJobId} returned an invalid status.`);
  for (const field of ["startedAt", "finishedAt"])
    if (record[field] !== undefined && typeof record[field] !== "string")
      throw new Error(`Sandbox job ${expectedJobId} returned an invalid status.`);
  for (const field of ["pid", "exitCode"])
    if (record[field] !== undefined && !Number.isInteger(record[field]))
      throw new Error(`Sandbox job ${expectedJobId} returned an invalid status.`);
  return record as unknown as RuntimeJobStatus;
}

/**
 * Submit a detached job whose durable record lives outside the Git workspace.
 * The Sandbox home is agent-writable, so this record is operational evidence,
 * not by itself an authoritative promotion certificate.
 */
export function startSandboxJob(task: TaskManifest, request: RuntimeJobRequest): void {
  assertJobIdentifier(request.taskId, "task id");
  assertJobIdentifier(request.jobId, "id");
  assertJobIdentifier(request.semanticKey, "semantic key");
  if (request.taskId !== task.id) throw new Error("Sandbox job task identity does not match.");
  if (!Number.isSafeInteger(request.conversationSequence) || request.conversationSequence < 0)
    throw new Error("Invalid Sandbox job conversation sequence.");
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 0)
    throw new Error("Invalid Sandbox job timeout.");

  const wrapper = String.raw`
set -u
task_id="$1"
job_id="$2"
semantic_key="$3"
request_json="$4"
directory="$5"
job_command="$6"
timeout_ms="$7"
root="$HOME/.boxers/jobs/$task_id"
job="$root/$job_id"
umask 077
mkdir -p "$root"

if test -d "$job"; then
  if ! test -f "$job/identity" || test "$(cat "$job/identity")" != "$semantic_key"; then
    exit 65
  fi
  if test -f "$job/result.json" && grep -q '"state":"passed"' "$job/result.json"; then
    exit 0
  fi
  if test -f "$job/status.json" && grep -Eq '"state":"(queued|running)"' "$job/status.json"; then
    exit 0
  fi
else
  mkdir "$job"
fi

printf '%s\n' "$semantic_key" > "$job/identity.tmp.$$"
mv -f "$job/identity.tmp.$$" "$job/identity"
printf '%s\n' "$request_json" > "$job/request.json.tmp.$$"
mv -f "$job/request.json.tmp.$$" "$job/request.json"
rm -f "$job/result.json" "$job/cancel-requested"
: > "$job/stdout.log"
: > "$job/stderr.log"
printf '%s\n' "$$" > "$job/supervisor.pid"

timestamp() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }
write_status() {
  state="$1"
  now="$2"
  extra="$3"
  printf '{"version":1,"jobId":"%s","state":"%s","updatedAt":"%s"%s}\n' \
    "$job_id" "$state" "$now" "$extra" > "$job/status.json.tmp.$$"
  mv -f "$job/status.json.tmp.$$" "$job/status.json"
}

queued_at=$(timestamp)
write_status queued "$queued_at" ''
started_at=$(timestamp)

if test "$timeout_ms" -gt 0; then
  timeout_value=$(printf '%d.%03ds' "$((timeout_ms / 1000))" "$((timeout_ms % 1000))")
  setsid timeout --signal=TERM --kill-after=5s "$timeout_value" \
    bash -lc 'cd -- "$1" && exec bash -lc "$2"' boxers-job "$directory" "$job_command" \
    > "$job/stdout.log" 2> "$job/stderr.log" &
else
  setsid bash -lc 'cd -- "$1" && exec bash -lc "$2"' boxers-job "$directory" "$job_command" \
    > "$job/stdout.log" 2> "$job/stderr.log" &
fi
runner=$!
printf '%s\n' "$runner" > "$job/pid.tmp.$$"
mv -f "$job/pid.tmp.$$" "$job/pid"
write_status running "$started_at" ",\"startedAt\":\"$started_at\",\"pid\":$runner"

set +e
wait "$runner"
exit_code=$?
set -e
finished_at=$(timestamp)
if test -f "$job/cancel-requested"; then
  terminal=interrupted
elif test "$timeout_ms" -gt 0 && test "$exit_code" -eq 124; then
  terminal=timed_out
elif test "$exit_code" -eq 0; then
  terminal=passed
else
  terminal=failed
fi
extra=",\"startedAt\":\"$started_at\",\"finishedAt\":\"$finished_at\",\"pid\":$runner,\"exitCode\":$exit_code"
printf '{"version":1,"jobId":"%s","state":"%s","updatedAt":"%s"%s}\n' \
  "$job_id" "$terminal" "$finished_at" "$extra" > "$job/result.json.tmp.$$"
mv -f "$job/result.json.tmp.$$" "$job/result.json"
write_status "$terminal" "$finished_at" "$extra"
rm -f "$job/supervisor.pid"
`;
  const result = sbx([
    "exec",
    "-d",
    task.runtime.id,
    "bash",
    "-lc",
    wrapper,
    "boxers-job",
    request.taskId,
    request.jobId,
    request.semanticKey,
    JSON.stringify(request),
    request.directory,
    request.command,
    String(request.timeoutMs),
  ]);
  requireSuccess(result, `Could not start Sandbox job ${request.jobId} for ${task.name}`);
}

export function inspectSandboxJob(task: TaskManifest, jobId: string): RuntimeJobStatus | undefined {
  assertJobIdentifier(task.id, "task id");
  assertJobIdentifier(jobId, "id");
  const script = String.raw`
set -u
job="$HOME/.boxers/jobs/$1/$2"
if test -f "$job/result.json"; then cat "$job/result.json"; exit 0; fi
if ! test -f "$job/status.json"; then exit 44; fi
if grep -Eq '"state":"(queued|running)"' "$job/status.json"; then
  pidfile="$job/supervisor.pid"
  status_age=$(( $(date +%s) - $(stat -c %Y "$job/status.json") ))
  if test "$status_age" -ge 5 && { ! test -f "$pidfile" || ! kill -0 "$(cat "$pidfile")" 2>/dev/null; }; then
    now=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
    printf '{"version":1,"jobId":"%s","state":"interrupted","updatedAt":"%s","finishedAt":"%s"}\n' \
      "$2" "$now" "$now" > "$job/result.json.tmp.$$"
    mv -f "$job/result.json.tmp.$$" "$job/result.json"
    cp "$job/result.json" "$job/status.json.tmp.$$"
    mv -f "$job/status.json.tmp.$$" "$job/status.json"
  fi
fi
if test -f "$job/result.json"; then cat "$job/result.json"; else cat "$job/status.json"; fi
`;
  const result = sbx([
    "exec",
    task.runtime.id,
    "bash",
    "-lc",
    script,
    "boxers-job-inspect",
    task.id,
    jobId,
  ]);
  if (result.status === 44) return undefined;
  return parseRuntimeJobStatus(
    requireSuccess(result, `Could not inspect Sandbox job ${jobId} for ${task.name}`),
    jobId,
  );
}

export function sandboxJobLogs(task: TaskManifest, jobId: string): RuntimeJobLogs | undefined {
  assertJobIdentifier(task.id, "task id");
  assertJobIdentifier(jobId, "id");
  const script = String.raw`
set -u
job="$HOME/.boxers/jobs/$1/$2"
if ! test -d "$job"; then exit 44; fi
printf '%s\n' "$(base64 -w0 "$job/stdout.log" 2>/dev/null || true)"
printf '%s\n' "$(base64 -w0 "$job/stderr.log" 2>/dev/null || true)"
`;
  const result = sbx([
    "exec",
    task.runtime.id,
    "bash",
    "-lc",
    script,
    "boxers-job-logs",
    task.id,
    jobId,
  ]);
  if (result.status === 44) return undefined;
  const output = requireSuccess(
    result,
    `Could not read Sandbox job ${jobId} logs for ${task.name}`,
  );
  const [stdout = "", stderr = ""] = output.split("\n");
  try {
    return {
      stdout: Buffer.from(stdout, "base64").toString("utf8"),
      stderr: Buffer.from(stderr, "base64").toString("utf8"),
    };
  } catch {
    throw new Error(`Sandbox job ${jobId} returned invalid logs.`);
  }
}

export function cancelSandboxJob(task: TaskManifest, jobId: string): boolean {
  assertJobIdentifier(task.id, "task id");
  assertJobIdentifier(jobId, "id");
  const script = String.raw`
set -u
job="$HOME/.boxers/jobs/$1/$2"
if test -f "$job/result.json" || ! test -f "$job/pid"; then printf 'not-running\n'; exit 0; fi
pid=$(cat "$job/pid")
case "$pid" in *[!0-9]*|'') exit 65;; esac
if ! kill -0 "$pid" 2>/dev/null; then printf 'not-running\n'; exit 0; fi
: > "$job/cancel-requested"
kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
count=0
while kill -0 "$pid" 2>/dev/null && test "$count" -lt 50; do
  sleep 0.1
  count=$((count + 1))
done
if kill -0 "$pid" 2>/dev/null; then
  kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
fi
printf 'cancelled\n'
`;
  const result = sbx([
    "exec",
    task.runtime.id,
    "bash",
    "-lc",
    script,
    "boxers-job-cancel",
    task.id,
    jobId,
  ]);
  const output = requireSuccess(result, `Could not cancel Sandbox job ${jobId} for ${task.name}`);
  return output.trim() === "cancelled";
}

export function startNativePreview(task: TaskManifest, run: string): RuntimePreviewHandle {
  const configHash = createHash("sha256").update(run).digest("hex");
  const jobId = `preview-${configHash.slice(0, 24)}`;
  const directory = requireSuccess(
    sbx(["exec", task.runtime.id, "pwd", "-P"]),
    `Could not resolve the workspace for ${task.name}`,
  ).trim();
  startSandboxJob(task, {
    version: 1,
    jobId,
    taskId: task.id,
    kind: "preview-action",
    semanticKey: configHash,
    conversationSequence: 0,
    targetOid: task.lastSnapshot?.targetOid ?? "unknown",
    workspaceTreeOid: task.lastSnapshot?.candidateTreeOid ?? "unknown",
    configHash,
    command: run,
    directory,
    timeoutMs: 0,
    createdAt: new Date().toISOString(),
  });
  return { jobId, configHash };
}

export function stopNativePreview(task: TaskManifest, jobId: string): boolean {
  return cancelSandboxJob(task, jobId);
}

export function nativePreviewLogs(task: TaskManifest, jobId: string): RuntimeJobLogs | undefined {
  return sandboxJobLogs(task, jobId);
}

export function advanceNativeWorkspace(
  task: TaskManifest,
  base: string,
  targetOid: string,
): boolean {
  const script = `
set -eu
fetch_error=$(mktemp)
trap 'rm -f "$fetch_error"' EXIT
if ! git fetch --no-tags -q origin "refs/heads/$1" 2>"$fetch_error"; then
  if grep -q "commit graph file but not in the object database" "$fetch_error"; then
    git fetch --refetch --no-tags -q origin "refs/heads/$1"
  else
    cat "$fetch_error" >&2
    exit 1
  fi
fi
rm -f "$fetch_error"
trap - EXIT
actual=$(git rev-parse FETCH_HEAD^{commit})
if test "$actual" != "$2"; then
  printf 'fetched %s, expected %s\n' "$actual" "$2" >&2
  exit 1
fi
git reset --mixed -q "$actual"
git status --porcelain=v1 --untracked-files=all
`;
  const status = requireSuccess(
    sbx(["exec", task.runtime.id, "bash", "-lc", script, "boxers", base, targetOid]),
    `Could not advance native workspace ${task.name}`,
  );
  return Boolean(status.trim());
}

export function publishPorts(task: TaskManifest, ports: readonly number[]): string[] {
  const existing = publishedPortBindings(task);
  const mappedSandboxPorts = new Set(
    existing.flatMap((binding) => (binding.sandboxPort === undefined ? [] : [binding.sandboxPort])),
  );
  const canReuseUnidentifiedBindings =
    mappedSandboxPorts.size === 0 && existing.length >= ports.length;
  for (const port of ports) {
    if (mappedSandboxPorts.has(port) || canReuseUnidentifiedBindings) continue;
    requireSuccess(
      sbx(["ports", task.runtime.id, "--publish", String(port)]),
      `Could not publish preview port ${port}`,
    );
  }
  const published = publishedPortBindings(task);
  const identified = published.filter(
    (binding) => binding.sandboxPort !== undefined && ports.includes(binding.sandboxPort),
  );
  return bindingsToUrls(identified.length ? identified : published);
}

interface PublishedPortBinding {
  host: string;
  hostPort: number;
  sandboxPort?: number;
}

function numericField(
  record: Record<string, unknown>,
  names: readonly string[],
): number | undefined {
  for (const name of names) {
    const value = record[name];
    if (Number.isInteger(Number(value))) return Number(value);
  }
  return undefined;
}

function stringField(
  record: Record<string, unknown>,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function collectPortBindings(value: unknown, bindings: PublishedPortBinding[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectPortBindings(item, bindings);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const hostPort = numericField(record, ["host_port", "hostPort", "HostPort"]);
  if (hostPort !== undefined) {
    const sandboxPort = numericField(record, [
      "sandbox_port",
      "sandboxPort",
      "container_port",
      "containerPort",
      "guest_port",
      "guestPort",
      "port",
    ]);
    bindings.push({
      host:
        stringField(record, ["host_ip", "hostIp", "hostIP", "host_address", "hostAddress"]) ??
        "localhost",
      hostPort,
      ...(sandboxPort === undefined ? {} : { sandboxPort }),
    });
    return;
  }
  for (const item of Object.values(record)) collectPortBindings(item, bindings);
}

function publishedPortBindings(task: TaskManifest): PublishedPortBinding[] {
  const listing = sbx(["ports", task.runtime.id, "--json"]);
  if (listing.status !== 0) return [];
  const bindings: PublishedPortBinding[] = [];
  try {
    collectPortBindings(JSON.parse(listing.stdout), bindings);
  } catch {
    for (const match of listing.stdout.matchAll(/(127\.0\.0\.1|localhost|\[::1\])[^\d]+(\d{2,5})/g))
      bindings.push({ host: match[1]!, hostPort: Number(match[2]) });
  }
  return bindings.filter((binding) => binding.hostPort > 0 && binding.hostPort <= 65535);
}

function bindingsToUrls(bindings: readonly PublishedPortBinding[]): string[] {
  return [
    ...new Set(
      bindings.map((binding) => {
        const normalized = binding.host.replace(/^\[|\]$/g, "");
        const host =
          normalized === "127.0.0.1" || normalized === "::1" || normalized === "0.0.0.0"
            ? "localhost"
            : normalized.includes(":")
              ? `[${normalized}]`
              : normalized;
        return `http://${host}:${binding.hostPort}`;
      }),
    ),
  ];
}

export function publishedUrls(task: TaskManifest): string[] {
  return bindingsToUrls(publishedPortBindings(task));
}

export function stopSandbox(task: TaskManifest): void {
  requireSuccess(sbx(["stop", task.runtime.id]), `Could not stop ${task.name}`);
}

export function removeSandbox(task: TaskManifest): void {
  requireSuccess(sbx(["rm", "--force", task.runtime.id]), `Could not remove ${task.name}`);
}

export function shellSandbox(task: TaskManifest): number {
  return command("sbx", ["exec", "-it", task.runtime.id, "bash"], { stdio: "inherit" }).status;
}
