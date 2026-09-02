import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installDaemonService, resolveBoxersExecutable } from "../../src/v2/service.ts";

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

  it("keeps a stable launcher in the service instead of pinning its current symlink target", () => {
    if (process.platform !== "linux") return;
    const root = mkdtempSync(join(tmpdir(), "boxers-stable-service-"));
    const previous = {
      home: process.env.HOME,
      state: process.env.BOXERS_HOME,
      path: process.env.PATH,
    };
    try {
      const target = join(root, "managed", "release", "dist", "index.mjs");
      const stable = join(root, ".local", "bin", "boxers");
      const bin = join(root, "bin");
      mkdirSync(join(root, "managed", "release", "dist"), { recursive: true });
      mkdirSync(join(root, ".local", "bin"), { recursive: true });
      mkdirSync(bin);
      writeFileSync(target, "#!/bin/sh\n");
      chmodSync(target, 0o755);
      symlinkSync(target, stable);
      writeFileSync(join(bin, "systemctl"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(bin, "systemctl"), 0o755);
      process.env.HOME = root;
      process.env.BOXERS_HOME = join(root, "state");
      process.env.PATH = `${bin}:${previous.path ?? ""}`;

      installDaemonService(stable);

      const unit = readFileSync(join(root, ".config", "systemd", "user", "boxers.service"), "utf8");
      expect(unit).toContain(`ExecStart="${stable}" __daemon-run`);
      expect(unit).not.toContain(target);
    } finally {
      if (previous.home === undefined) delete process.env.HOME;
      else process.env.HOME = previous.home;
      if (previous.state === undefined) delete process.env.BOXERS_HOME;
      else process.env.BOXERS_HOME = previous.state;
      if (previous.path === undefined) delete process.env.PATH;
      else process.env.PATH = previous.path;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
