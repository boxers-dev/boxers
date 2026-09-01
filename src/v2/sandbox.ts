import {
  command,
  commandAsync,
  commandWithInput,
  commandStreaming,
  requireSuccess,
  type CommandResult,
  type StreamingCommandOptions,
  type StreamingCommandResult,
} from "./process.ts";
import type { TaskManifest } from "./types.ts";
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

/**
 * Materialize the host-recorded candidate patch over its exact base and reset
 * a persistent check worktree to that immutable commit. The live task workspace
 * is deliberately not read here: it may already contain newer agent edits.
 */
export function prepareNativeCheckWorkspace(
  task: TaskManifest,
  base: string,
  expectedTargetOid: string,
  expectedCandidateTreeOid: string,
  candidatePatch: string,
): { path: string; candidateTreeOid: string } {
  const script = String.raw`
set -euo pipefail
base="$1"
expected="$2"
expected_tree="$3"
task_id="$4"
target_ref=refs/boxers/check/target
candidate_ref=refs/boxers/check/candidate
git fetch --no-tags -q origin "+refs/heads/$base:$target_ref"
target=$(git rev-parse "$target_ref^{commit}")
test "$target" = "$expected"

index=$(mktemp)
patch=$(mktemp)
trap 'rm -f "$index" "$patch"' EXIT
cat >"$patch"
GIT_INDEX_FILE="$index" git read-tree "$target"
if test -s "$patch"; then
  GIT_INDEX_FILE="$index" git apply --cached --binary --whitespace=nowarn "$patch"
fi
tree=$(GIT_INDEX_FILE="$index" git write-tree)
test "$tree" = "$expected_tree"
commit=$(printf 'boxers check candidate\n' | git commit-tree "$tree" -p "$target")
git update-ref "$candidate_ref" "$commit"

check_root="$HOME/.boxers/check-worktrees/$task_id"
mkdir -p "$(dirname "$check_root")"
git worktree prune
if test -e "$check_root/.git"; then
  git -C "$check_root" reset --hard -q "$commit"
else
  git worktree add --force --detach "$check_root" "$commit" >/dev/null
fi
git -C "$check_root" clean -fdq
printf '%s\n%s\n' "$check_root" "$tree"
`;
  const result = commandWithInput(
    "sbx",
    [
      "exec",
      task.runtime.id,
      "bash",
      "-lc",
      script,
      "boxers-check",
      base,
      expectedTargetOid,
      expectedCandidateTreeOid,
      task.id,
    ],
    candidatePatch,
  );
  if (result.status !== 0)
    throw new Error(
      `Could not prepare isolated check workspace for ${task.name}: ${(result.stderr || result.stdout).trim()}`,
    );
  const lines = result.stdout.trim().split("\n");
  const path = lines.at(-2);
  const candidateTreeOid = lines.at(-1);
  if (!path || !candidateTreeOid || !/^[0-9a-f]{40,64}$/.test(candidateTreeOid))
    throw new Error(`Sandbox returned an invalid check workspace for ${task.name}.`);
  return { path, candidateTreeOid };
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

export function startNativePreview(task: TaskManifest, run: string): void {
  const script = `
set -eu
state=.git/boxers
log="$state/preview.log"
pidfile="$state/preview.pid"
mkdir -p "$state"
if test -f "$pidfile" && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
  exit 0
fi
rm -f "$pidfile"
: > "$log"
nohup setsid bash -lc "$1" >> "$log" 2>&1 </dev/null &
pid=$!
printf '%s\n' "$pid" > "$pidfile"
sleep 0.1
kill -0 "$pid"
`;
  requireSuccess(
    sbx(["exec", task.runtime.id, "bash", "-lc", script, "boxers", run]),
    `Could not start preview for ${task.name}`,
  );
}

export function stopNativePreview(task: TaskManifest): void {
  const script = `
set -eu
pidfile=.git/boxers/preview.pid
if ! test -f "$pidfile"; then exit 0; fi
pid=$(cat "$pidfile")
if kill -0 "$pid" 2>/dev/null; then
  kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
  count=0
  while kill -0 "$pid" 2>/dev/null && test "$count" -lt 50; do
    sleep 0.1
    count=$((count + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  fi
fi
rm -f "$pidfile"
`;
  requireSuccess(
    sbx(["exec", task.runtime.id, "bash", "-lc", script]),
    `Could not stop preview for ${task.name}`,
  );
}

export function nativePreviewLogs(task: TaskManifest): CommandResult {
  return sbx([
    "exec",
    task.runtime.id,
    "bash",
    "-lc",
    "test -f .git/boxers/preview.log && tail -n 200 .git/boxers/preview.log",
  ]);
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
