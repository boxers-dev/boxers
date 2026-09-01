import { describe, expect, it } from "vitest";
import {
  encodeLifecycleWakeFrame,
  MAX_PTY_CONTROL_FRAME_BYTES,
  PtyControlParser,
} from "../../src/v2/pty-control.ts";

const token = "0123456789abcdef0123456789abcdef";

describe("PTY lifecycle bridge", () => {
  it("recognizes a valid frame split at every possible boundary", () => {
    const frame = encodeLifecycleWakeFrame(token, 42);
    for (let split = 0; split <= frame.length; split++) {
      const parser = new PtyControlParser(token);
      const first = parser.push(`before${frame.slice(0, split)}`);
      const second = parser.push(`${frame.slice(split)}after`);
      expect(first.output + second.output, `split ${split}`).toBe("beforeafter");
      expect([...first.frames, ...second.frames], `split ${split}`).toEqual([
        { version: 1, token, sequence: 42 },
      ]);
    }
  });

  it("strips multiple valid frames while retaining ordinary OSC output", () => {
    const parser = new PtyControlParser(token);
    const title = "\u001b]0;ordinary title\u0007";
    const result = parser.push(
      `${title}a${encodeLifecycleWakeFrame(token, 1)}b${encodeLifecycleWakeFrame(token, 2)}c`,
    );
    expect(result.output).toBe(`${title}abc`);
    expect(result.frames.map((frame) => frame.sequence)).toEqual([1, 2]);
  });

  it("retains invalid token, version, and event identifiers as terminal data", () => {
    const parser = new PtyControlParser(token);
    const invalid = [
      encodeLifecycleWakeFrame("fedcba9876543210fedcba9876543210", 1),
      "\u001b]777;boxers;2;0123456789abcdef0123456789abcdef;2\u0007",
      "\u001b]777;boxers;1;0123456789abcdef0123456789abcdef;zero\u0007",
    ].join("");
    expect(parser.push(invalid)).toEqual({ output: invalid, frames: [] });
  });

  it("bounds incomplete frames and preserves their bytes", () => {
    const parser = new PtyControlParser(token);
    const incomplete = `\u001b]777;boxers;1;${"x".repeat(MAX_PTY_CONTROL_FRAME_BYTES * 2)}`;
    const result = parser.push(incomplete);
    expect(Buffer.byteLength(result.output + parser.finish(), "utf8")).toBe(
      Buffer.byteLength(incomplete, "utf8"),
    );
    expect(result.frames).toEqual([]);
  });
});
