import { resetTerminalInputModes } from "../core/ansi.ts";
import { attachInteractive, ensureDaemonReady, startViewerlessSession } from "./daemon-client.ts";
import type { Agent, TaskManifest } from "./types.ts";
import { runtimeForTask } from "./runtime/registry.ts";
import { taskRuntimeId } from "./runtime/task.ts";
import type { CommandResult } from "./process.ts";
import { harnessForAgent } from "./providers/registry.ts";
import { installLifecycleRecorder } from "./hook-recorder.ts";

export interface AgentSessionOptions {
  prompt?: string;
  resume?: boolean;
  model?: string;
  effort?: string;
  fast?: boolean;
  developerInstructions?: string;
}

export function sandboxWorkspace(task: TaskManifest): string {
  return runtimeForTask(task).workspacePath(task);
}

function codexTrustOverride(workspace: string): string {
  return `projects.${JSON.stringify(workspace)}.trust_level="trusted"`;
}

export function agentArguments(
  agent: Agent,
  workspace: string,
  options: AgentSessionOptions,
): string[] {
  const task = { agent } as TaskManifest;
  return harnessForAgent(agent).durableSessionArguments(task, workspace, options);
}

/** A fresh, non-interactive provider turn used only for bounded workspace repair. */
export function repairAgentArguments(
  task: TaskManifest,
  workspace: string,
  prompt: string,
): string[] {
  if (task.agent === "codex") {
    return [
      ...(task.model === undefined ? [] : ["--model", task.model]),
      ...(task.effort === undefined
        ? []
        : ["-c", `model_reasoning_effort=${JSON.stringify(task.effort)}`]),
      ...(task.fast ? ["-c", 'service_tier="fast"'] : []),
      "-c",
      codexTrustOverride(workspace),
      "exec",
      "--ephemeral",
      "--sandbox",
      "danger-full-access",
      prompt,
    ];
  }
  return [
    "--print",
    "--dangerously-skip-permissions",
    "--no-session-persistence",
    ...(task.model === undefined ? [] : ["--model", task.model]),
    ...(task.effort === undefined ? [] : ["--effort", task.effort]),
    prompt,
  ];
}

export function runRepairAgent(task: TaskManifest, prompt: string): CommandResult {
  const workspace = sandboxWorkspace(task);
  // Keep the provider subprocess bounded even though the surrounding daemon
  // post-turn worker deliberately serializes workspace access for the task.
  return runtimeForTask(task).execute(task, [
    "timeout",
    "--signal=TERM",
    "--kill-after=10s",
    "10m",
    task.agent,
    ...repairAgentArguments(task, workspace, prompt),
  ]);
}

export function terminalTitleSequence(title: string): string {
  return `\u001b]0;${title.replaceAll("\u0007", "").replaceAll("\u001b", "")}\u0007`;
}

export function setTerminalTitle(title: string): void {
  if (process.stdout.isTTY) process.stdout.write(terminalTitleSequence(title));
}

function buildRunSpec(task: TaskManifest, options: AgentSessionOptions) {
  const workspace = sandboxWorkspace(task);
  const lifecycle = installLifecycleRecorder(task);
  const launchOptions = {
    ...(!options.resume && task.model !== undefined ? { model: task.model } : {}),
    ...(!options.resume && task.effort !== undefined ? { effort: task.effort } : {}),
    ...(!options.resume && task.fast !== undefined ? { fast: task.fast } : {}),
    ...options,
    lifecycleRecorderPath: lifecycle.recorderPath,
  };
  return runtimeForTask(task).agentLaunchSpec(
    task,
    agentArguments(task.agent, workspace, launchOptions),
  );
}

export { ensureDaemonReady };

/**
 * Same launch as `runAgentSession`, but the pty lives in the boxers
 * daemon instead of this process. Losing this terminal (SSH drop, closed
 * window) only loses the view; the daemon keeps the provider launch process
 * attached, so runtime auto-stop-on-disconnect never sees a disconnect.
 */
export async function runAgentSessionInteractive(
  task: TaskManifest,
  options: AgentSessionOptions = {},
): Promise<number> {
  const spec = buildRunSpec(task, options);
  if (task.agent === "codex") setTerminalTitle(taskRuntimeId(task));
  try {
    if (!task.lifecycleBridgeToken) throw new Error("Task has no lifecycle bridge token.");
    return await attachInteractive(taskRuntimeId(task), spec.command, spec.args, {
      taskName: task.name,
      bridgeToken: task.lifecycleBridgeToken,
    });
  } finally {
    resetTerminalInputModes();
  }
}

export async function runAgentSessionDetached(
  task: TaskManifest,
  options: AgentSessionOptions = {},
): Promise<void> {
  if (!task.lifecycleBridgeToken) throw new Error("Task has no lifecycle bridge token.");
  const spec = buildRunSpec(task, options);
  await startViewerlessSession(
    taskRuntimeId(task),
    task.name,
    task.lifecycleBridgeToken,
    spec.command,
    spec.args,
  );
}

const COMMIT_MESSAGE_PROMPT = `Read the structured JSON envelope supplied on standard input. It contains the exact target-to-candidate diff and normalized conversation events through an explicit high-water sequence. Write a Git commit message with a concise development note grounded in both the code and conversation.

The subject must use imperative mood and contain at most 72 characters.

Focus the note on the most important motivation, decisions, constraints, non-obvious behavior, trade-offs, and follow-up work. Adapt the detail to the size of the change. Do not enumerate changed files, mechanically retell the diff, or invent context unsupported by the envelope. Write plain text suitable for a Git commit body and wrap prose at roughly 72 characters.

Return only a JSON object with exactly this shape: {"subject":"...","note":"..."}.`;

const COMMIT_MESSAGE_SUMMARY_PROMPT = `The JSON supplied on standard input contains a Git commit subject and an overlong development note. Keep the subject unchanged and summarize the note once so it fits comfortably in a Git commit body. Preserve only the most important change, motivation, implementation decisions, constraints, and trade-offs. Remove repetition and low-value detail. Return only a JSON object with exactly the same {"subject":"...","note":"..."} shape, with the note under 8,000 characters.`;

function commitMessageSchema(maxNoteLength?: number): string {
  return JSON.stringify({
    type: "object",
    properties: {
      subject: { type: "string", maxLength: 72 },
      note: {
        type: "string",
        minLength: 1,
        ...(maxNoteLength === undefined ? {} : { maxLength: maxNoteLength }),
      },
    },
    required: ["subject", "note"],
    additionalProperties: false,
  });
}

const COMMIT_MESSAGE_SCHEMA = commitMessageSchema();
const COMMIT_MESSAGE_SUMMARY_SCHEMA = commitMessageSchema(8_000);

export interface GeneratedCommitMessage {
  subject: string;
  note: string;
}

type GeneratedCommitMessageResult =
  | { status: "valid"; message: GeneratedCommitMessage }
  | { status: "too_long"; message: GeneratedCommitMessage }
  | { status: "invalid" };

const INVALID_GENERATED_COMMIT_MESSAGE = { status: "invalid" } as const;

function classifyGeneratedCommitMessage(
  message: GeneratedCommitMessage | undefined,
): GeneratedCommitMessageResult {
  if (!message) return INVALID_GENERATED_COMMIT_MESSAGE;
  return message.note.length <= 8_000
    ? { status: "valid", message }
    : { status: "too_long", message };
}

function validSubject(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const subject = value.trim();
  if (
    !subject ||
    subject.length > 72 ||
    [...subject].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  )
    return undefined;
  return subject;
}

function validNote(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const note = value.replaceAll("\r\n", "\n").trim();
  if (
    !note ||
    [...note].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (code < 32 && code !== 9 && code !== 10) || code === 127;
    })
  )
    return undefined;
  return note;
}

function messageFromRecord(record: Record<string, unknown>): GeneratedCommitMessage | undefined {
  if (Object.keys(record).some((key) => key !== "subject" && key !== "note")) return undefined;
  const subject = validSubject(record["subject"]);
  const note = validNote(record["note"]);
  return subject && note ? { subject, note } : undefined;
}

function messageFromJson(value: string): GeneratedCommitMessage | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return messageFromRecord(parsed as Record<string, unknown>);
  } catch {
    return undefined;
  }
}

function parseGeneratedCommitMessageResult(
  agent: Agent,
  output: string,
): GeneratedCommitMessageResult {
  if (agent === "claude") {
    try {
      const envelope = JSON.parse(output) as Record<string, unknown>;
      const structured = envelope["structured_output"];
      if (structured && typeof structured === "object" && !Array.isArray(structured))
        return classifyGeneratedCommitMessage(
          messageFromRecord(structured as Record<string, unknown>),
        );
      return classifyGeneratedCommitMessage(
        typeof envelope["result"] === "string" ? messageFromJson(envelope["result"]) : undefined,
      );
    } catch {
      return INVALID_GENERATED_COMMIT_MESSAGE;
    }
  }
  let finalMessage: string | undefined;
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const item = event["item"] as Record<string, unknown> | undefined;
      if (
        event["type"] === "item.completed" &&
        item?.["type"] === "agent_message" &&
        typeof item["text"] === "string"
      )
        finalMessage = item["text"];
    } catch {
      return INVALID_GENERATED_COMMIT_MESSAGE;
    }
  }
  return classifyGeneratedCommitMessage(
    finalMessage === undefined ? undefined : messageFromJson(finalMessage),
  );
}

export function parseGeneratedCommitMessage(
  agent: Agent,
  output: string,
): GeneratedCommitMessage | undefined {
  const result = parseGeneratedCommitMessageResult(agent, output);
  return result.status === "valid" ? result.message : undefined;
}

/** Ask the task's authenticated agent for a message without touching its durable session. */
export function generateCommitMessage(
  task: TaskManifest,
  diff: string,
): GeneratedCommitMessage | undefined {
  const preferredModel = task.agent === "codex" ? "gpt-5.6-luna" : "haiku";
  const run = (
    prompt: string,
    input: string,
    schema: string,
    model?: string,
  ): GeneratedCommitMessageResult => {
    const modelArgs = model ? ["--model", model] : [];
    const agentArgs =
      task.agent === "codex"
        ? ["codex", "exec", "--ephemeral", "--sandbox", "read-only", "--json", ...modelArgs, prompt]
        : [
            "claude",
            "-p",
            prompt,
            "--output-format",
            "json",
            "--json-schema",
            schema,
            "--no-session-persistence",
            "--tools",
            "",
            ...modelArgs,
          ];
    const result = runtimeForTask(task).executeWithInput(task, agentArgs, input);
    if (result.status !== 0) return INVALID_GENERATED_COMMIT_MESSAGE;
    return parseGeneratedCommitMessageResult(task.agent, result.stdout);
  };
  const generated = run(COMMIT_MESSAGE_PROMPT, diff, COMMIT_MESSAGE_SCHEMA, preferredModel);
  if (generated.status === "valid") return generated.message;
  if (generated.status === "invalid") return undefined;
  const summarized = run(
    COMMIT_MESSAGE_SUMMARY_PROMPT,
    JSON.stringify(generated.message),
    COMMIT_MESSAGE_SUMMARY_SCHEMA,
    preferredModel,
  );
  return summarized.status === "valid" ? summarized.message : undefined;
}
