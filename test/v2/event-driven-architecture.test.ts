import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(process.cwd(), "src", "v2");

function source(file: string): string {
  return readFileSync(join(root, file), "utf8");
}

describe("disposable post-turn architecture", () => {
  it("has no polling-era coordinator modules or worker lanes", () => {
    for (const file of ["observer.ts", "quiescence.ts", "scheduler.ts", "check-coordinator.ts"])
      expect(existsSync(join(root, file)), file).toBe(false);
    const daemon = source("daemon.ts");
    const worker = source("daemon-worker.ts");
    expect(`${daemon}\n${worker}`).not.toMatch(
      /BackgroundWorkerPool|automaticCheckPool|automaticMessagePool|__daemon-(?:observe|check|message|activity)-worker/,
    );
  });

  it("contains no provider activity probe or transcript parser", () => {
    const runtime = [
      source("runtime/types.ts"),
      source("runtime/docker-sandboxes.ts"),
      source("runtime/task.ts"),
      source("sandbox.ts"),
    ].join("\n");
    expect(runtime).not.toMatch(
      /["']\/proc\/|wchan|clock ticks|sleep 0\.5|probeAgentActivity|probeTaskAgent/,
    );
    const lifecycle = [
      source("conversation.ts"),
      source("lifecycle-ingestion.ts"),
      source("providers/codex.ts"),
      source("providers/claude.ts"),
    ].join("\n");
    expect(lifecycle).not.toContain("transcript_path");
  });

  it("keeps detached durable provider launches under daemon PTY ownership", () => {
    const session = source("session.ts");
    expect(session).toContain("startViewerlessSession");
    expect(session).not.toMatch(/runDetached|executeDetached|\[\s*["']run["'][^\]]*["']-d["']/s);
  });

  it("does not turn a viewer-only attach into a post-turn-cancelling intent", () => {
    expect(source("commands.ts")).not.toContain("prepare_attach");
    expect(source("daemon-protocol.ts")).not.toContain('kind: "prepare_attach"');
  });
});
