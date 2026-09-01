import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import { runtimeForTask } from "./runtime/registry.ts";
import type { TaskManifest } from "./types.ts";
import { harnessForAgent } from "./providers/registry.ts";

export const LIFECYCLE_RECORDER_VERSION = 1;

export function createLifecycleBridgeToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * A dependency-free synchronous recorder. It writes the event before waking
 * the daemon and deliberately emits no provider-visible output.
 */
export function renderLifecycleRecorder(): string {
  return String.raw`#!/bin/sh
set -u
umask 077

provider="${"$"}{1:-}"
case "$provider" in codex|claude) ;; *) exit 0 ;; esac
event_kind="${"$"}{2:-}"
case "$event_kind" in user_prompt|turn_finished) ;; *) exit 0 ;; esac

git_dir=$(git rev-parse --absolute-git-dir 2>/dev/null) || exit 0
root="$git_dir/boxers/conversation"
ready="$root/events"
mkdir -p "$ready" "$root/tmp" || exit 0

raw="$root/tmp/raw.$$"
trap 'rm -f "$raw" "$root/tmp/event.$$" "$root/tmp/sequence.$$"' EXIT HUP INT TERM
dd of="$raw" bs=65537 count=1 2>/dev/null || exit 0
bytes=$(wc -c < "$raw" | tr -d ' ')
[ "$bytes" -gt 0 ] && [ "$bytes" -le 65536 ] || exit 0

exec 9>"$root/sequence.lock" || exit 0
flock -w 2 9 || exit 0
sequence=0
[ ! -f "$root/sequence" ] || read -r sequence < "$root/sequence"
case "$sequence" in ''|*[!0-9]*) exit 0 ;; esac
sequence=$((sequence + 1))
printf '%s\n' "$sequence" > "$root/tmp/sequence.$$" || exit 0
mv "$root/tmp/sequence.$$" "$root/sequence" || exit 0

recorded_at=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)
event="$root/tmp/event.$$"
printf '{"version":1,"sequence":%s,"provider":"%s","recordedAt":"%s","raw":' "$sequence" "$provider" "$recorded_at" > "$event" || exit 0
cat "$raw" >> "$event" || exit 0
printf '}\n' >> "$event" || exit 0
rm -f "$raw"
mv "$event" "$ready/$sequence.json" || exit 0
flock -u 9 || true
sync -f "$ready/$sequence.json" 2>/dev/null || true

token=''
[ ! -f "$git_dir/boxers/bridge-token" ] || read -r token < "$git_dir/boxers/bridge-token"
case "$token" in *[!A-Za-z0-9_-]*|'') exit 0 ;; esac
printf '\033]777;boxers;1;%s;%s\007' "$token" "$sequence" > /dev/tty 2>/dev/null || true

if [ "$event_kind" = user_prompt ]; then
  attempts=0
  while [ -e "$git_dir/boxers/mutation.json" ] && [ "$attempts" -lt 200 ]; do
    sleep 0.025
    attempts=$((attempts + 1))
  done
fi
exit 0
`;
}

export interface InstalledLifecycleRecorder {
  recorderPath: string;
  bridgeToken: string;
}

export function installLifecycleRecorder(
  task: TaskManifest,
  bridgeToken = task.lifecycleBridgeToken,
): InstalledLifecycleRecorder {
  const runtime = runtimeForTask(task);
  const workspace = runtime.workspacePath(task);
  const gitDirResult = runtime.execute(task, [
    "git",
    "-C",
    workspace,
    "rev-parse",
    "--absolute-git-dir",
  ]);
  if (gitDirResult.status !== 0)
    throw new Error(
      `Could not locate task Git metadata: ${(gitDirResult.stderr || gitDirResult.stdout).trim()}`,
    );
  const gitDir = gitDirResult.stdout.trim();
  if (!gitDir.startsWith("/")) throw new Error("Task Git metadata path is not absolute.");
  const recorderPath = posix.join(gitDir, "boxers", "bin", "record-lifecycle");
  const script = renderLifecycleRecorder();
  const install = runtime.executeWithInput(
    task,
    [
      "sh",
      "-c",
      'set -eu; mkdir -p "$(dirname "$1")"; umask 077; temp="$1.$$"; cat > "$temp"; chmod 700 "$temp"; mv "$temp" "$1"; printf "%s\\n" "$2" > "$3"; chmod 600 "$3"',
      "boxers-hook-install",
      recorderPath,
      bridgeToken,
      posix.join(gitDir, "boxers", "bridge-token"),
    ],
    script,
  );
  if (install.status !== 0)
    throw new Error(
      `Could not install task lifecycle recorder: ${(install.stderr || install.stdout).trim()}`,
    );
  if (task.agent === "claude") {
    const hooks = harnessForAgent(task.agent).lifecycleHookConfiguration(recorderPath);
    const settings = JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command: hooks.userPromptSubmit.command,
                timeout: hooks.userPromptSubmit.timeoutSeconds,
              },
            ],
          },
        ],
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: hooks.turnFinished.command,
                timeout: hooks.turnFinished.timeoutSeconds,
              },
            ],
          },
        ],
      },
    });
    const settingsInstall = runtime.executeWithInput(
      task,
      [
        "sh",
        "-c",
        'set -eu; umask 077; temp="$1.$$"; cat > "$temp"; chmod 600 "$temp"; mv "$temp" "$1"',
        "boxers-claude-settings-install",
        `${recorderPath}.claude-settings.json`,
      ],
      settings,
    );
    if (settingsInstall.status !== 0)
      throw new Error(
        `Could not install Claude lifecycle settings: ${(settingsInstall.stderr || settingsInstall.stdout).trim()}`,
      );
  }
  return { recorderPath, bridgeToken };
}
