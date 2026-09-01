import { spawn, spawnSync, type SpawnOptions } from "node:child_process";

const MAX_BUFFER = 512 * 1024 * 1024;

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface StreamingCommandOptions {
  timeout?: number;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface StreamingCommandResult extends CommandResult {
  timedOut: boolean;
  cancelled: boolean;
}

export function command(
  cmd: string,
  args: readonly string[],
  options: SpawnOptions = {},
): CommandResult {
  const result = spawnSync(cmd, [...args], {
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

export function commandWithInput(
  cmd: string,
  args: readonly string[],
  input: string,
  options: SpawnOptions = {},
): CommandResult {
  const result = spawnSync(cmd, [...args], {
    ...options,
    input,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT")
      return { status: 127, stdout: "", stderr: result.error.message };
    throw result.error;
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export function commandAsync(cmd: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ status: code ?? 1, stdout, stderr }));
  });
}

export function commandStreaming(
  cmd: string,
  args: readonly string[],
  options: StreamingCommandOptions = {},
): Promise<StreamingCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const signalTree = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, signal);
      } catch {
        // The exact process group may already have exited.
      }
      // Also signal the direct child in case process-group creation raced an
      // immediate abort. This remains scoped to the exact spawned command.
      try {
        child.kill(signal);
      } catch {
        // It may have exited after the group signal.
      }
    };
    const terminate = (): void => {
      signalTree("SIGTERM");
      if (!killTimer) {
        killTimer = setTimeout(() => signalTree("SIGKILL"), 2_000);
        killTimer.unref();
      }
    };
    const onAbort = (): void => {
      cancelled = true;
      terminate();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      options.onStdout?.(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      options.onStderr?.(chunk);
    });
    const cleanup = (): void => {
      options.signal?.removeEventListener("abort", onAbort);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
    };
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ status: code ?? 1, stdout, stderr, timedOut, cancelled });
    };
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    const timeoutTimer =
      options.timeout === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            terminate();
          }, options.timeout);
    child.on("exit", (code) => {
      if (timedOut || cancelled) finish(code);
    });
    child.on("close", finish);
  });
}

export function requireSuccess(result: CommandResult, description: string): string {
  if (result.status !== 0)
    throw new Error(
      `${description}: ${(result.stderr || result.stdout).trim() || `exit ${result.status}`}`,
    );
  return result.stdout.trim();
}
