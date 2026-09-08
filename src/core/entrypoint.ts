const DAEMON_BACKED_TASK_INTENTS = new Set([
  "review",
  "check",
  "setup",
  "promote",
  "sync",
  "preview",
  "discard",
]);

/** Decide whether an invocation must be handed to the durable task daemon. */
export function isDaemonBackedTaskInvocation(args: readonly string[]): boolean {
  const [task, command] = args;
  // Machine-qualified tasks must first pass through CLI routing so the typed
  // command reaches its owning host. That host then queues it locally.
  if (!task || task === "daemon" || task.includes("/")) return false;
  if (isTaskIntentCommand(command)) return true;
  return false;
}

export function isTaskIntentCommand(command: string | undefined): boolean {
  return DAEMON_BACKED_TASK_INTENTS.has(command ?? "");
}
