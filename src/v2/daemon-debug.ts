/** Write one concise, timestamped entry to the daemon's combined debug stream. */
export function writeDaemonDebug(message: string): void {
  process.stderr.write(`${new Date().toISOString()} [daemon] ${message}\n`);
}

/** Quote names and reasons so an unexpected newline cannot forge a log entry. */
export function debugValue(value: string): string {
  return JSON.stringify(value);
}
