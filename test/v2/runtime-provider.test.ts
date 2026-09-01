import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("task runtime provider boundary", () => {
  it("keeps provider command construction out of core orchestration modules", () => {
    const modules = ["commands.ts", "setup.ts", "session.ts", "auth.ts"];
    for (const module of modules) {
      const source = readFileSync(join(process.cwd(), "src", "v2", module), "utf8");
      expect(source, module).not.toMatch(/\bcommand(?:WithInput|Async|Streaming)?\(\s*["']sbx["']/);
      expect(source, module).not.toMatch(/\bsbx\s*\(\s*\[/);
    }
  });

  it("keeps blocking task work out of the daemon PTY reactor", () => {
    const daemon = readFileSync(join(process.cwd(), "src", "v2", "daemon.ts"), "utf8");
    const worker = readFileSync(join(process.cwd(), "src", "v2", "daemon-worker.ts"), "utf8");
    expect(daemon).not.toMatch(/\bexecuteTaskIntent\b|\bwithOutputSink\b|\bspawnSync\b/);
    expect(daemon).toContain("executeIntentInWorker");
    expect(worker).toContain("executeTaskIntent");
    expect(worker).toContain('stdio: ["ignore", "ignore", "ignore", "ipc"]');

    const inputCase = daemon.slice(daemon.indexOf('case "input"'), daemon.indexOf('case "resize"'));
    expect(inputCase).not.toMatch(
      /taskMutationBarrierActive\(|recordSessionActivity\(|updateTask\(|writeFileSync\(/,
    );
    expect(inputCase).toContain("settlements.cancel");
    expect(inputCase).toContain("writeSessionInput");
  });
});
