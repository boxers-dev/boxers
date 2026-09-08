import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activateHostRelease } from "../../src/v2/host-release.ts";
import { createReleaseCapsule, decodeReleaseCapsule } from "../../src/v2/release.ts";
import * as service from "../../src/v2/service.ts";
import { DAEMON_PROTOCOL_VERSION } from "../../src/v2/daemon-protocol.ts";

const original = { ...process.env };
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ["HOME", "XDG_DATA_HOME", "BOXERS_HOME", "FAKE_REPLACEMENT", "PATH"]) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "boxers-host-release-"));
  directories.push(root);
  process.env.HOME = join(root, "home");
  process.env.XDG_DATA_HOME = join(root, "data");
  process.env.BOXERS_HOME = join(root, "state");
  const marker = join(root, "replacement");
  process.env.FAKE_REPLACEMENT = marker;
  const pkg = join(root, "package");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: "@boxers-dev/boxers", version: "1.2.3", type: "module" }),
  );
  writeFileSync(
    join(pkg, "dist/index.mjs"),
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
if (process.argv[2] === "--version") console.log("1.2.3");
if (process.argv[2] === "__daemon-replace") writeFileSync(process.env.FAKE_REPLACEMENT, process.argv[3]);
`,
  );
  const capsule = createReleaseCapsule(pkg);
  const manifest = decodeReleaseCapsule(capsule).manifest;
  const status: service.DaemonServiceStatus = {
    supported: true,
    installed: true,
    enabled: true,
    active: true,
    platform: "test",
    detail: "test",
    boxersVersion: manifest.packageVersion,
    boxersBuildId: manifest.buildId,
    protocolVersion: DAEMON_PROTOCOL_VERSION,
  };
  return { capsule, manifest, marker, status };
}

describe("shared host release activation", () => {
  it.each(["inactive", "version", "build", "protocol"])(
    "replaces a daemon with mismatched %s",
    async (mismatch) => {
      const { capsule, status, marker } = fixture();
      if (mismatch === "inactive") status.active = false;
      if (mismatch === "version") status.boxersVersion = "0.0.1";
      if (mismatch === "build") status.boxersBuildId = "b".repeat(64);
      if (mismatch === "protocol") status.protocolVersion = DAEMON_PROTOCOL_VERSION - 1;
      const install = vi.spyOn(service, "installDaemonService").mockReturnValue(status);
      const result = await activateHostRelease(capsule);
      expect(result.daemonReplacementRequired).toBe(true);
      expect(existsSync(marker)).toBe(true);
      expect(install).toHaveBeenCalledWith(result.stableExecutable);
    },
  );

  it("validates and starts the release without node on PATH", async () => {
    const { capsule, status, marker } = fixture();
    status.active = false;
    process.env.PATH = "/nonexistent-boxers-test-path";
    vi.spyOn(service, "installDaemonService").mockReturnValue(status);
    await expect(activateHostRelease(capsule)).resolves.toMatchObject({
      daemonReplacementRequired: true,
    });
    expect(existsSync(marker)).toBe(true);
  });

  it("repairs service configuration without replacing an already matching daemon", async () => {
    const { capsule, status, marker } = fixture();
    const install = vi.spyOn(service, "installDaemonService").mockReturnValue(status);
    expect((await activateHostRelease(capsule)).daemonReplacementRequired).toBe(false);
    expect(install).toHaveBeenCalledOnce();
    expect(existsSync(marker)).toBe(false);
  });

  it("does not report activation success when service installation fails", async () => {
    const { capsule, marker } = fixture();
    vi.spyOn(service, "installDaemonService").mockImplementation(() => {
      throw new Error("service unavailable");
    });
    await expect(activateHostRelease(capsule)).rejects.toThrow("service unavailable");
    expect(existsSync(marker)).toBe(false);
  });
});
