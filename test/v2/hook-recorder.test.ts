import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLifecycleBridgeToken, renderLifecycleRecorder } from "../../src/v2/hook-recorder.ts";

describe("lifecycle hook recorder", () => {
  it("renders a synchronous durable-before-wake recorder outside the worktree", () => {
    const script = renderLifecycleRecorder();
    expect(script).toContain("git rev-parse --absolute-git-dir");
    expect(script).toContain('mv "$event" "$ready/$sequence.json"');
    expect(script.indexOf('mv "$event" "$ready/$sequence.json"')).toBeLessThan(
      script.indexOf("> /dev/tty"),
    );
    expect(script.indexOf("flock -u 9")).toBeLessThan(
      script.indexOf('sync -f "$ready/$sequence.json"'),
    );
    expect(script).toContain("flock -w 2");
    expect(script).toContain("mutation.json");
    expect(script).not.toContain("git diff");
    expect(script).not.toContain("transcript_path");
  });

  it("creates private frame-safe bridge tokens", () => {
    const token = createLifecycleBridgeToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
  });

  it("allocates unique atomic event sequences across concurrent recorders", async () => {
    const repository = mkdtempSync(join(tmpdir(), "boxers-hook-concurrency-"));
    try {
      execFileSync("git", ["-C", repository, "init", "-q"]);
      const recorder = join(repository, "record-lifecycle");
      writeFileSync(recorder, renderLifecycleRecorder());
      chmodSync(recorder, 0o700);
      const bin = join(repository, "bin");
      mkdirSync(bin);
      const slowSync = join(bin, "sync");
      writeFileSync(slowSync, "#!/bin/sh\nsleep 0.3\n");
      chmodSync(slowSync, 0o700);
      const runs = Array.from(
        { length: 12 },
        (_, index) =>
          new Promise<void>((resolve, reject) => {
            const child = spawn(recorder, ["codex", "user_prompt"], {
              cwd: repository,
              env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
              stdio: ["pipe", "ignore", "ignore"],
            });
            child.once("error", reject);
            child.once("exit", (code) =>
              code === 0 ? resolve() : reject(new Error(`exit ${code}`)),
            );
            child.stdin.end(
              JSON.stringify({
                hook_event_name: "UserPromptSubmit",
                session_id: "session",
                turn_id: `turn-${index}`,
                prompt: `prompt ${index}`,
              }),
            );
          }),
      );
      await Promise.all(runs);
      const gitDir = execFileSync("git", ["-C", repository, "rev-parse", "--absolute-git-dir"], {
        encoding: "utf8",
      }).trim();
      const eventDir = join(gitDir, "boxers", "conversation", "events");
      expect(
        readdirSync(eventDir).sort((a, b) => Number(a.split(".")[0]) - Number(b.split(".")[0])),
      ).toEqual(Array.from({ length: 12 }, (_, index) => `${index + 1}.json`));
      for (let sequence = 1; sequence <= 12; sequence++)
        expect(JSON.parse(readFileSync(join(eventDir, `${sequence}.json`), "utf8"))).toMatchObject({
          version: 1,
          sequence,
          provider: "codex",
        });
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });
});
