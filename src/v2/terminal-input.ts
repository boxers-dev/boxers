/* eslint-disable no-control-regex -- Terminal protocol parsing requires literal control bytes. */
export interface TerminalInputChunk {
  data: string;
  userInput: boolean;
}

/** Separate terminal reports from keystrokes without changing the forwarded bytes. */
export class TerminalInputParser {
  #pending = "";
  #pasting = false;

  get pending(): boolean {
    return this.#pending.length > 0;
  }

  push(chunk: string): TerminalInputChunk[] {
    let input = this.#pending + chunk;
    this.#pending = "";
    const result: TerminalInputChunk[] = [];
    while (input) {
      const escape = input.indexOf("\x1b");
      if (escape !== 0) {
        const length = escape < 0 ? input.length : escape;
        result.push({ data: input.slice(0, length), userInput: true });
        input = input.slice(length);
        continue;
      }
      const sequence = /^(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/.exec(
        input,
      )?.[0];
      if (!sequence) {
        // Buffer split reports, but let the caller flush a lone Escape key
        // after a short timeout. Malformed/oversized input remains user input.
        if (
          input.length <= 4096 &&
          /^(?:\x1b|\x1b\[[0-?]*[ -/]*|\x1b\][^\x07\x1b]*\x1b?)$/.test(input)
        ) {
          this.#pending = input;
          break;
        }
        result.push({ data: input[0]!, userInput: true });
        input = input.slice(1);
        continue;
      }
      const report =
        /^\x1b\[(?:[IO]|\??\d+;\d+R|[?>][\d;]*c|0n|\?\d+u|\?\d+;\d+\$y|(?:4|6|8);\d+;\d+t)$/.test(
          sequence,
        ) || /^\x1b\](?:10|11|12);rgb:[\da-fA-F/]+(?:\x07|\x1b\\)$/.test(sequence);
      result.push({ data: sequence, userInput: this.#pasting || !report });
      if (sequence === "\x1b[200~") this.#pasting = true;
      if (sequence === "\x1b[201~") this.#pasting = false;
      input = input.slice(sequence.length);
    }
    return result;
  }

  flush(): TerminalInputChunk[] {
    const data = this.#pending;
    this.#pending = "";
    return data ? [{ data, userInput: true }] : [];
  }
}
