const PREFIX = "\u001b]777;boxers;";
const BEL = "\u0007";
const ST = "\u001b\\";

export const PTY_CONTROL_VERSION = 1;
export const MAX_PTY_CONTROL_FRAME_BYTES = 512;

export interface LifecycleWakeFrame {
  version: 1;
  token: string;
  sequence: number;
}

export interface PtyControlChunk {
  output: string;
  frames: LifecycleWakeFrame[];
}

function validToken(token: string): boolean {
  return token.length >= 16 && token.length <= 128 && /^[A-Za-z0-9_-]+$/.test(token);
}

export function encodeLifecycleWakeFrame(token: string, sequence: number): string {
  if (!validToken(token)) throw new Error("Invalid lifecycle bridge token.");
  if (!Number.isSafeInteger(sequence) || sequence < 1)
    throw new Error("Invalid lifecycle event sequence.");
  return `${PREFIX}${PTY_CONTROL_VERSION};${token};${sequence}${BEL}`;
}

function retainedPrefixSuffix(value: string): number {
  const maximum = Math.min(value.length, PREFIX.length - 1);
  for (let length = maximum; length > 0; length--)
    if (PREFIX.startsWith(value.slice(-length))) return length;
  return 0;
}

/** Removes authenticated private frames while preserving all ordinary terminal bytes. */
export class PtyControlParser {
  #pending = "";

  constructor(private readonly expectedToken: string) {
    if (!validToken(expectedToken)) throw new Error("Invalid lifecycle bridge token.");
  }

  push(chunk: string): PtyControlChunk {
    let input = this.#pending + chunk;
    this.#pending = "";
    let output = "";
    const frames: LifecycleWakeFrame[] = [];
    for (;;) {
      const start = input.indexOf(PREFIX);
      if (start < 0) {
        const retained = retainedPrefixSuffix(input);
        output += input.slice(0, input.length - retained);
        this.#pending = retained ? input.slice(-retained) : "";
        break;
      }
      output += input.slice(0, start);
      input = input.slice(start);
      const bel = input.indexOf(BEL, PREFIX.length);
      const st = input.indexOf(ST, PREFIX.length);
      const end = bel < 0 ? st : st < 0 ? bel : Math.min(bel, st);
      const terminatorLength = end === st ? ST.length : BEL.length;
      if (end < 0) {
        if (Buffer.byteLength(input, "utf8") <= MAX_PTY_CONTROL_FRAME_BYTES) {
          this.#pending = input;
          break;
        }
        output += input[0];
        input = input.slice(1);
        continue;
      }
      const complete = input.slice(0, end + terminatorLength);
      const body = input.slice(PREFIX.length, end);
      const match = /^(\d+);([A-Za-z0-9_-]{16,128});([1-9]\d*)$/.exec(body);
      const sequence = match ? Number(match[3]) : Number.NaN;
      if (
        match &&
        Number(match[1]) === PTY_CONTROL_VERSION &&
        match[2] === this.expectedToken &&
        Number.isSafeInteger(sequence)
      )
        frames.push({ version: 1, token: match[2], sequence });
      else output += complete;
      input = input.slice(complete.length);
    }
    return { output, frames };
  }

  /** Preserve an incomplete would-be control sequence when the PTY exits. */
  finish(): string {
    const pending = this.#pending;
    this.#pending = "";
    return pending;
  }
}
