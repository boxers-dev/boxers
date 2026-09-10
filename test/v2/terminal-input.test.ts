import { describe, expect, it } from "vitest";
import { TerminalInputParser } from "../../src/v2/terminal-input.ts";

describe("terminal input reports", () => {
  it.each([
    "\x1b[I",
    "\x1b[O",
    "\x1b[12;80R",
    "\x1b[?12;80R",
    "\x1b[?1;2c",
    "\x1b[>0;276;0c",
    "\x1b[?31u",
    "\x1b[0n",
    "\x1b[?2026;2$y",
    "\x1b[8;24;80t",
    "\x1b]11;rgb:ffff/ffff/ffff\x07",
    "\x1b]10;rgb:00/00/00\x1b\\",
  ])("recognizes a report at every chunk boundary: %j", (report) => {
    for (let split = 0; split <= report.length; split++) {
      const parser = new TerminalInputParser();
      const chunks = [...parser.push(report.slice(0, split)), ...parser.push(report.slice(split))];
      expect(chunks.map((chunk) => chunk.data).join("")).toBe(report);
      expect(chunks.every((chunk) => !chunk.userInput)).toBe(true);
      expect(parser.pending).toBe(false);
    }
  });

  it.each(["hello\r", "\x03", "\x1b[A", "\x1b[13u", "\x1b[<0;1;1M"])(
    "keeps actual keyboard and mouse input guarded: %j",
    (input) => {
      expect(new TerminalInputParser().push(input)).toEqual([{ data: input, userInput: true }]);
    },
  );

  it("preserves mixed input and treats reports inside pasted text as input", () => {
    const parser = new TerminalInputParser();
    expect(parser.push("\x1b[Ihello\x1b[O")).toEqual([
      { data: "\x1b[I", userInput: false },
      { data: "hello", userInput: true },
      { data: "\x1b[O", userInput: false },
    ]);
    parser.push("\x1b[200~");
    expect(parser.push("\x1b[I")).toEqual([{ data: "\x1b[I", userInput: true }]);
    parser.push("\x1b[201~");
    expect(parser.push("\x1b[I")).toEqual([{ data: "\x1b[I", userInput: false }]);
  });

  it("flushes a lone Escape or incomplete sequence as user input", () => {
    const parser = new TerminalInputParser();
    expect(parser.push("\x1b")).toEqual([]);
    expect(parser.pending).toBe(true);
    expect(parser.flush()).toEqual([{ data: "\x1b", userInput: true }]);
    expect(parser.pending).toBe(false);
  });
});
