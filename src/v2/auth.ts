import { createInterface } from "node:readline/promises";
import type { Agent, TaskManifest } from "./types.ts";
import { defaultRuntime, runtimeForTask } from "./runtime/registry.ts";
import { taskRuntimeId } from "./runtime/task.ts";
import { harnessForAgent } from "./providers/registry.ts";

export type Provider = "openai" | "anthropic";
export type CodexAuthMode = "oauth" | "api-key";

const KNOWN_SERVICES = [
  "openai",
  "anthropic",
  "github",
  "gitlab",
  "docker",
  "aws",
  "gcp",
  "azure",
  "npm",
  "pypi",
  "registry",
] as const;

export function providerForAgent(agent: Agent): Provider {
  return harnessForAgent(agent).authentication.service as Provider;
}

export function servicesFromSecretOutput(output: string): string[] {
  const lower = output.toLowerCase();
  return KNOWN_SERVICES.filter((service) =>
    new RegExp(`(^|[^a-z0-9_-])${service}([^a-z0-9_-]|$)`, "m").test(lower),
  );
}

export function globalServices(): string[] {
  return defaultRuntime().globalCredentialServices();
}

export function hasGlobalCredential(agent: Agent): boolean {
  return globalServices().includes(providerForAgent(agent));
}

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function isSshSession(): boolean {
  return Boolean(
    process.env["SSH_CONNECTION"] || process.env["SSH_CLIENT"] || process.env["SSH_TTY"],
  );
}

export function remediationFor(agent: Agent): string {
  return agent === "codex"
    ? 'Run "boxers auth codex" locally, or create a Codex task interactively over SSH to sign in with a device code.'
    : 'Run "boxers auth claude" to store an Anthropic API key, or create a task with "boxers <task> new" in an interactive terminal to sign in with a Claude subscription.';
}

export async function confirmAuthentication(agent: Agent): Promise<boolean> {
  const description =
    agent === "codex"
      ? isSshSession()
        ? "Codex needs authentication. Sign in with your ChatGPT subscription using a device code now?"
        : "Codex needs an OpenAI credential in the task runtime. Authenticate with ChatGPT now?"
      : "Claude needs authentication. Sign in with your Claude subscription now?";
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await readline.question(`${description} [Y/n] `)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    readline.close();
  }
}

export function authenticateAgent(
  agent: Agent,
  options: { mode?: CodexAuthMode; allowSshOAuth?: boolean } = {},
): number {
  const mode = options.mode ?? "oauth";
  if (agent === "codex" && mode === "oauth" && isSshSession() && !options.allowSshOAuth)
    throw new Error(
      "ChatGPT OAuth cannot return its localhost callback through a normal SSH session. Use `boxers auth codex --api-key`, or reconnect with `ssh -L 1455:localhost:1455 ...` and run `boxers auth codex --oauth`.",
    );
  if (defaultRuntime().authenticateGlobal(agent, mode) !== 0)
    throw new Error(`${agent} authentication was not completed.`);
  if (!hasGlobalCredential(agent))
    throw new Error(`The task runtime did not report the ${providerForAgent(agent)} credential.`);
  process.stdout.write(
    `${agent === "codex" ? "OpenAI" : "Anthropic"} credential saved for future task runtimes.\n`,
  );
  return 0;
}

export function authenticateCodexSubscription(task: TaskManifest | string): void {
  process.stdout.write(
    "Codex will display a device code. Open the shown URL on any device and enter the code to use your ChatGPT subscription.\n",
  );
  const runtime = typeof task === "string" ? defaultRuntime() : runtimeForTask(task);
  runtime.authenticateSubscription(typeof task === "string" ? task : taskRuntimeId(task), "codex");
}

export function authenticateClaudeSubscription(task: TaskManifest | string): void {
  process.stdout.write(
    "Claude will open its subscription authentication flow. Finish the browser sign-in to continue.\n",
  );
  const runtime = typeof task === "string" ? defaultRuntime() : runtimeForTask(task);
  runtime.authenticateSubscription(typeof task === "string" ? task : taskRuntimeId(task), "claude");
}

export async function ensureTaskAuthentication(task: TaskManifest): Promise<void> {
  const runtime = runtimeForTask(task);
  const before = runtime.agentAuthenticationStatus(task);
  if (before.state === "configured") return;
  if (before.state === "unknown")
    throw new Error(
      `Could not verify ${task.agent} authentication for task ${task.name}: ${before.detail}`,
    );
  if (!isInteractive())
    throw new Error(
      `${task.agent} authentication is required for task ${task.name}. Attach from an interactive terminal to sign in.`,
    );
  if (!(await confirmAuthentication(task.agent)))
    throw new Error(`${task.agent} authentication is required for task ${task.name}.`);
  if (task.agent === "codex") authenticateCodexSubscription(task);
  else authenticateClaudeSubscription(task);
  const after = runtime.agentAuthenticationStatus(task);
  if (after.state !== "configured")
    throw new Error(
      after.state === "unknown"
        ? `Could not verify ${task.agent} authentication after sign-in: ${after.detail}`
        : `${task.agent} did not report an authenticated session after sign-in.`,
    );
  process.stdout.write(`${task.agent} authentication is ready for task ${task.name}.\n`);
}
