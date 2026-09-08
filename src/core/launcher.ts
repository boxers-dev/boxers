import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { activeManagedExecutable } from "../v2/release.ts";

/** Boxers releases are JavaScript; service PATH must never select their Node. */
export function boxersLaunch(executable: string, args: readonly string[]) {
  return { command: process.execPath, args: [executable, ...args] };
}

/** Published launchers hand ordinary commands to the selected managed build. */
export function managedInvocation(
  args: readonly string[],
  entry = process.argv[1],
  managed = activeManagedExecutable(),
): ReturnType<typeof boxersLaunch> | undefined {
  // Internal workers and version validation must run the specified artifact.
  // A source checkout is an explicit development invocation (including dist).
  if (!entry || !managed || args[0]?.startsWith("__") || args[0] === "--version") return undefined;
  const resolved = realpathSync(entry);
  if (resolved.endsWith(".ts") || existsSync(join(dirname(dirname(resolved)), "src", "index.ts")))
    return undefined;
  if (resolved === realpathSync(managed)) return undefined;
  return boxersLaunch(managed, args);
}
