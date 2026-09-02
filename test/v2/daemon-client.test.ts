import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  assertDaemonVersion,
  detachKeyIndex,
  parseDaemonIntent,
  releaseTerminalInput,
  TerminalOutputPump,
} from "../../src/v2/daemon-client.ts";
import { readVersion } from "../../src/core/version.ts";

describe("interactive daemon client input", () => {
  it("parses setup recovery as a typed intent", () => {
    expect(parseDaemonIntent(["task", "setup"])).toEqual({
      task: "task",
      intent: { kind: "setup" },
    });
    expect(() => parseDaemonIntent(["task", "setup", "extra"])).toThrow(
      "setup does not accept arguments",
    );
  });

  it("includes the invoking terminal's color preference in review intents", () => {
    const previousForceColor = process.env["FORCE_COLOR"];
    const previousNoColor = process.env["NO_COLOR"];
    delete process.env["NO_COLOR"];
    try {
      process.env["FORCE_COLOR"] = "1";
      expect(parseDaemonIntent(["task", "review"]).intent).toEqual({
        kind: "review",
        color: true,
      });
      process.env["FORCE_COLOR"] = "0";
      expect(parseDaemonIntent(["task", "review"]).intent).toEqual({
        kind: "review",
        color: false,
      });
    } finally {
      if (previousForceColor === undefined) delete process.env["FORCE_COLOR"];
      else process.env["FORCE_COLOR"] = previousForceColor;
      if (previousNoColor === undefined) delete process.env["NO_COLOR"];
      else process.env["NO_COLOR"] = previousNoColor;
    }
  });

  it("recognizes Ctrl-C as a detach key", () => {
    expect(detachKeyIndex(Buffer.from([0x03]))).toBe(0);
  });

  it("returns the first detach key after ordinary input", () => {
    expect(detachKeyIndex(Buffer.from([0x61, 0x1d, 0x03]))).toBe(2);
  });

  it("does not detach for ordinary input", () => {
    expect(detachKeyIndex(Buffer.from("hello"))).toBe(-1);
  });

  it("releases terminal input after detaching even if it was initially flowing", () => {
    const input = {
      isTTY: true,
      rawModes: [] as boolean[],
      pauses: 0,
      setRawMode(mode: boolean) {
        this.rawModes.push(mode);
      },
      pause() {
        this.pauses++;
      },
    };

    releaseTerminalInput(input, false);

    expect(input.rawModes).toEqual([false]);
    expect(input.pauses).toBe(1);
  });

  it("makes an installed CLI/daemon handoff mismatch explicit", () => {
    expect(() => assertDaemonVersion(readVersion())).not.toThrow();
    expect(() => assertDaemonVersion("0.0.0-stale")).toThrow(
      /daemon 0\.0\.0-stale does not match CLI/,
    );
  });

  it("pauses daemon output until the real terminal drains", () => {
    const source = {
      paused: 0,
      resumed: 0,
      pause() {
        this.paused++;
      },
      resume() {
        this.resumed++;
      },
    };
    class Output extends EventEmitter {
      writes: string[] = [];
      blocked = true;

      write(chunk: Buffer): boolean {
        this.writes.push(chunk.toString());
        if (!this.blocked) return true;
        this.blocked = false;
        return false;
      }
    }
    const output = new Output();
    const pump = new TerminalOutputPump(source, output);
    pump.write(Buffer.from("first"));
    pump.write(Buffer.from("second"));
    expect(source.paused).toBe(1);
    expect(output.writes).toEqual(["first"]);
    output.emit("drain");
    expect(output.writes).toEqual(["first", "second"]);
    expect(source.resumed).toBe(1);
    pump.close();
  });
});
