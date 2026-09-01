import { writeStderr, writeStdout } from "./output.ts";

/** Print a primary result line to stdout. */
export function info(message: string): void {
  writeStdout(`${message}\n`);
}

/** Print a progress / secondary line to stderr (keeps stdout clean for piping). */
export function note(message: string): void {
  writeStderr(`${message}\n`);
}

/** Print an error line to stderr. */
export function error(message: string): void {
  writeStderr(`${message}\n`);
}
