/**
 * Disable terminal input-reporting modes that a detached full-screen TUI may
 * leave enabled, and make the cursor visible again.
 */
export const RESET_INPUT_MODES =
  "\x1b[?1004l" + // focus reporting
  "\x1b[?2004l" + // bracketed paste
  "\x1b[?1000l" + // X10/normal mouse tracking
  "\x1b[?1002l" + // button-event mouse tracking
  "\x1b[?1003l" + // any-event mouse tracking
  "\x1b[?1006l" + // SGR mouse encoding
  "\x1b[?1015l" + // urxvt mouse encoding
  // Without mouse tracking, alternate scroll turns wheel events into cursor
  // keys. A detached Codex TUI can otherwise treat scrolling as prompt history.
  "\x1b[?1007l" + // alternate scroll mode
  "\x1b[?25h"; // show cursor

interface TerminalOutput {
  isTTY?: boolean;
  write(value: string): unknown;
}

export function colorEnabled(
  output: Pick<TerminalOutput, "isTTY"> = process.stdout,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  if (environment["NO_COLOR"] !== undefined) return false;
  const forced = environment["FORCE_COLOR"];
  if (forced !== undefined) return forced !== "0";
  return Boolean(output.isTTY);
}

export function ansi(code: number, value: string, enabled: boolean): string {
  return enabled ? `\x1b[${code}m${value}\x1b[0m` : value;
}

export function resetTerminalInputModes(output: TerminalOutput = process.stdout): void {
  if (output.isTTY) output.write(RESET_INPUT_MODES);
}
