import { colorEnabled } from "./ansi.ts";
import { UsageError } from "./usage.ts";
import type { TaskIntent } from "../v2/daemon-protocol.ts";

export function parseTaskIntent(args: readonly string[]): { task: string; intent: TaskIntent } {
  const task = args[0];
  const command = args[1];
  if (!task || !command) throw new UsageError("A daemon intent requires a task and command.");
  const rest = args.slice(2);
  switch (command) {
    case "sync":
    case "check":
    case "setup":
      if (rest.length) throw new UsageError(`${command} does not accept arguments.`);
      return { task, intent: { kind: command } };
    case "review":
      if (rest.length) throw new UsageError(`${command} does not accept arguments.`);
      return { task, intent: { kind: command, color: colorEnabled() } };
    case "promote": {
      let message: string | undefined;
      let skipChecks = false;
      for (let index = 0; index < rest.length; index++) {
        const argument = rest[index];
        if (argument === "--skip-checks") skipChecks = true;
        else if (argument === "--message" || argument?.startsWith("--message=")) {
          if (message !== undefined) throw new UsageError("--message may only be specified once.");
          message = argument === "--message" ? rest[++index] : argument.slice(10);
          if (message === undefined || (argument === "--message" && message.startsWith("-")))
            throw new UsageError("--message requires a value.");
        } else throw new UsageError(`Unexpected argument for promote: ${argument}`);
      }
      return {
        task,
        intent: {
          kind: "promote",
          ...(message ? { message } : {}),
          skipChecks,
        },
      };
    }
    case "preview": {
      const action = rest[0] ?? "show";
      if (
        rest.length > 1 ||
        (action !== "show" &&
          action !== "start" &&
          action !== "stop" &&
          action !== "restart" &&
          action !== "logs")
      )
        throw new UsageError("preview accepts start, stop, restart, or logs.");
      return { task, intent: { kind: "preview", action } };
    }
    case "discard":
      if (rest.some((argument) => argument !== "--force") || rest.length > 1)
        throw new UsageError("discard accepts only --force.");
      return { task, intent: { kind: "discard", force: rest.includes("--force") } };
    default:
      throw new UsageError(`Unsupported daemon intent ${command}.`);
  }
}
