import { describe, expect, it } from "vitest";
import { commandStreaming } from "../../src/v2/process.ts";

describe("streaming commands", () => {
  it("delivers output while the child is still running", async () => {
    let finished = false;
    let streamedBeforeFinish = false;
    const chunks: string[] = [];
    const pending = commandStreaming(
      process.execPath,
      [
        "-e",
        "process.stdout.write('started\\n'); setTimeout(() => process.stdout.write('finished\\n'), 75)",
      ],
      {
        onStdout(chunk) {
          chunks.push(chunk);
          if (!finished) streamedBeforeFinish = true;
        },
      },
    );
    const result = await pending;
    finished = true;
    expect(streamedBeforeFinish).toBe(true);
    expect(chunks.join("")).toBe("started\nfinished\n");
    expect(result).toMatchObject({ status: 0, timedOut: false });
  });

  it("terminates commands at their timeout", async () => {
    const result = await commandStreaming(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      timeout: 25,
    });
    expect(result.timedOut).toBe(true);
    expect(result.status).not.toBe(0);
  });

  it.skipIf(process.platform === "win32")("cancels the exact streaming process group", async () => {
    const abort = new AbortController();
    let output = "";
    let descendantPid: number | undefined;
    const pending = commandStreaming(
      process.execPath,
      [
        "-e",
        "const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)']); console.log(child.pid); setInterval(()=>{},1000)",
      ],
      {
        signal: abort.signal,
        onStdout(chunk) {
          output += chunk;
          const parsed = Number.parseInt(output, 10);
          if (Number.isSafeInteger(parsed) && parsed > 0) {
            descendantPid = parsed;
            abort.abort();
          }
        },
      },
    );
    await expect(pending).resolves.toMatchObject({ cancelled: true, timedOut: false });
    expect(descendantPid).toEqual(expect.any(Number));
    let alive = true;
    for (let attempt = 0; attempt < 50 && alive; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      try {
        process.kill(descendantPid!, 0);
      } catch {
        alive = false;
      }
    }
    if (alive) process.kill(descendantPid!, "SIGKILL");
    expect(alive).toBe(false);
  });
});
