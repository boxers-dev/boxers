import { spawnSync, type SpawnOptions } from "node:child_process";

const MAX_BUFFER = 512 * 1024 * 1024;

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export function command(
  executable: string,
  args: readonly string[],
  options: SpawnOptions = {},
): CommandResult {
  const result = spawnSync(executable, [...args], {
    ...options,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT")
      return { status: 127, stdout: "", stderr: result.error.message };
    throw result.error;
  }
  return {
    status: result.status ?? 1,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

export function requireSuccess(result: CommandResult, description: string): string {
  if (result.status !== 0)
    throw new Error(
      `${description}: ${(result.stderr || result.stdout).trim() || `exit ${result.status}`}`,
    );
  return result.stdout;
}
