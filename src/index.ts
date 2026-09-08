import { spawnSync } from "node:child_process";
import { managedInvocation } from "./core/launcher.ts";
import { dispatch, UsageError } from "./cli.ts";
import { error as printError } from "./core/ui.ts";
import { isDaemonBackedTaskInvocation } from "./core/entrypoint.ts";
import { runDaemonIntent } from "./v2/daemon-client.ts";

try {
  const args = process.argv.slice(2);
  const managed = managedInvocation(args);
  process.exitCode = managed
    ? (spawnSync(managed.command, managed.args, { stdio: "inherit" }).status ?? 1)
    : isDaemonBackedTaskInvocation(args)
      ? await runDaemonIntent(args)
      : await dispatch(args);
} catch (err) {
  if (err instanceof UsageError) {
    printError(err.message);
    process.exitCode = 2;
  } else if (
    err instanceof Error &&
    (err as NodeJS.ErrnoException).code === "ENOENT" &&
    typeof (err as NodeJS.ErrnoException).path === "string"
  ) {
    const cmd = (err as NodeJS.ErrnoException).path;
    printError(`\`${cmd}\` is not installed or not on your PATH.`);
    process.exitCode = 1;
  } else {
    printError(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
