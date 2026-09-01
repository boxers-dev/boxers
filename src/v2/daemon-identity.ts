import { readFileSync } from "node:fs";
import { command } from "./process.ts";

export function daemonProcessCommandLine(pid: number): string | undefined {
  if (process.platform === "linux") {
    try {
      return readFileSync(`/proc/${pid}/cmdline`).toString("utf8").replaceAll("\0", " ").trim();
    } catch {
      // Fall through to ps for restricted /proc mounts.
    }
  }
  const result = command("ps", ["-p", String(pid), "-o", "command="]);
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
}

export function isBoxersDaemonCommand(commandLine: string): boolean {
  const args = commandLine
    .replaceAll("\0", " ")
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);
  const daemonRun = args.some(
    (value, index) =>
      value === "__daemon-run" || (value === "debug" && args[index + 1] === "daemon"),
  );
  const boxersEntry = args.some((value) => value.toLowerCase().includes("boxers"));
  return daemonRun && boxersEntry;
}

export function processIsBoxersDaemon(pid: number): boolean {
  const commandLine = daemonProcessCommandLine(pid);
  return commandLine !== undefined && isBoxersDaemonCommand(commandLine);
}
