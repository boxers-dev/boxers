import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBoxersExecutable } from "../../src/v2/service.ts";

describe("daemon service executable resolution", () => {
  it("resolves a real Boxers executable from PATH instead of accepting command text", () => {
    const root = mkdtempSync(join(tmpdir(), "boxers-service-"));
    const target = join(root, "boxers-real");
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(target, "#!/bin/sh\n");
    chmodSync(target, 0o755);
    symlinkSync(target, join(bin, "boxers"));

    expect(resolveBoxersExecutable("boxers --verbose", bin)).toBe(target);
  });

  it("rejects aliases and other command text when no executable file exists", () => {
    expect(() => resolveBoxersExecutable("boxers --verbose", "")).toThrow(
      "absolute executable file",
    );
  });
});
