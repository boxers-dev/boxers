import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { commandStreaming, commandWithTreeTimeout } from "../../src/v2/process.ts";

describe("bounded synchronous commands", () => {
  it("retains output, exit status and discrete argument boundaries", () => {
    expect(
      commandWithTreeTimeout(
        process.execPath,
        [
          "-e",
          "console.log(process.argv[1]); console.error('failure'); process.exitCode=7;",
          "a $literal; value",
        ],
        1_000,
      ),
    ).toEqual({ status: 7, stdout: "a $literal; value\n", stderr: "failure\n" });
  });

  it.skipIf(process.platform === "win32")(
    "stops timeout descendants before they can keep writing",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "boxers-tree-timeout-"));
      const marker = join(root, "late-write");
      try {
        const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe'), 900);`;
        const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'inherit' }); console.log('started'); setInterval(() => {}, 1000);`;
        const started = Date.now();
        const result = commandWithTreeTimeout(process.execPath, ["-e", parent], 300);
        expect(result).toMatchObject({ status: 124, stdout: "started\n" });
        expect(result.stderr).toContain("ETIMEDOUT");
        expect(Date.now() - started).toBeLessThan(1_500);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe("streaming commands", () => {
  it("streams binary input without changing bytes", async () => {
    const input = Buffer.from([0, 255, 10, 13, 128]);
    const result = await commandStreaming(
      process.execPath,
      [
        "-e",
        "const fs=require('node:fs'); process.stdout.write(fs.readFileSync(0).toString('hex'));",
      ],
      { input },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(input.toString("hex"));
  });

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
