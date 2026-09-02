import { chmodSync, mkdtempSync, mkdirSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cachedReleaseCapsule,
  createReleaseCapsule,
  decodeReleaseCapsule,
  installReleaseCapsule,
  releaseRuntimeIdentity,
  rollbackManagedRelease,
} from "../../src/v2/release.ts";

const previousHome = process.env.HOME;
const previousData = process.env.XDG_DATA_HOME;
const previousPath = process.env.PATH;
const previousBuildOutput = process.env.FAKE_BUILD_OUTPUT;

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousData === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousData;
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  if (previousBuildOutput === undefined) delete process.env.FAKE_BUILD_OUTPUT;
  else process.env.FAKE_BUILD_OUTPUT = previousBuildOutput;
});

function fixture(): { root: string; home: string; data: string } {
  const root = mkdtempSync(join(tmpdir(), "boxers-release-package-"));
  const home = mkdtempSync(join(tmpdir(), "boxers-release-home-"));
  const data = mkdtempSync(join(tmpdir(), "boxers-release-data-"));
  process.env.HOME = home;
  process.env.XDG_DATA_HOME = data;
  mkdirSync(join(root, "dist"));
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "@boxers-dev/boxers", version: "1.2.3", type: "module", dependencies: {} })}\n`,
  );
  writeFileSync(
    join(root, "dist", "index.mjs"),
    '#!/usr/bin/env node\nif (process.argv[2] === "--version") process.stdout.write("1.2.3\\n");\n',
  );
  return { root, home, data };
}

describe("managed Boxers releases", () => {
  it("creates deterministic, verified capsules", () => {
    const { root } = fixture();
    const first = createReleaseCapsule(root);
    const second = createReleaseCapsule(root);
    expect(first.equals(second)).toBe(true);
    const decoded = decodeReleaseCapsule(first);
    expect(decoded.manifest.packageVersion).toBe("1.2.3");
    expect(decoded.manifest.buildId).toMatch(/^[a-f0-9]{64}$/);
    expect(decoded.manifest.files.map((file) => file.path)).toEqual([
      "dist/index.mjs",
      "package.json",
    ]);
  });

  it("rebuilds a source checkout even when dist already exists", () => {
    const { root } = fixture();
    const bin = mkdtempSync(join(tmpdir(), "boxers-release-build-bin-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "index.ts"), "export {};\n");
    const npm = join(bin, "npm");
    writeFileSync(
      npm,
      `#!/bin/sh
printf '%s' '#!/usr/bin/env node
if (process.argv[2] === "--version") process.stdout.write("1.2.3\\n");
// rebuilt
' > "$FAKE_BUILD_OUTPUT"
`,
    );
    chmodSync(npm, 0o755);
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    process.env.FAKE_BUILD_OUTPUT = join(root, "dist", "index.mjs");

    const decoded = decodeReleaseCapsule(createReleaseCapsule(root));

    const bundled = Buffer.from(decoded.files["dist/index.mjs"]!, "base64").toString("utf8");
    expect(bundled).toContain("// rebuilt");
  });

  it("separates native runtimes by operating system, architecture, and Node ABI", () => {
    const manifest = decodeReleaseCapsule(createReleaseCapsule(fixture().root)).manifest;
    const linux = releaseRuntimeIdentity(manifest, {
      platform: "linux",
      architecture: "x64",
      nodeModulesAbi: "137",
    });
    expect(
      releaseRuntimeIdentity(manifest, {
        platform: "darwin",
        architecture: "arm64",
        nodeModulesAbi: "137",
      }),
    ).not.toBe(linux);
    expect(
      releaseRuntimeIdentity(manifest, {
        platform: "linux",
        architecture: "x64",
        nodeModulesAbi: "138",
      }),
    ).not.toBe(linux);
  });

  it("rejects modified capsules", () => {
    const { root } = fixture();
    const capsule = createReleaseCapsule(root);
    capsule[capsule.length - 1] = capsule[capsule.length - 1]! ^ 1;
    expect(() => decodeReleaseCapsule(capsule)).toThrow("Invalid Boxers release capsule");
  });

  it("installs, caches, validates, and atomically activates a release", () => {
    const { root, home, data } = fixture();
    const capsule = createReleaseCapsule(root);
    const installed = installReleaseCapsule(capsule);
    expect(installed.runtimeInstalled).toBe(true);
    expect(readlinkSync(join(home, ".local", "bin", "boxers"))).toBe(installed.executable);
    expect(cachedReleaseCapsule(installed.manifest.buildId).equals(capsule)).toBe(true);

    const repeated = installReleaseCapsule(capsule);
    expect(repeated.runtimeInstalled).toBe(false);

    writeFileSync(
      join(data, "boxers", "managed", "capsules", `${installed.manifest.buildId}.bxr`),
      "corrupt",
    );
    expect(() => cachedReleaseCapsule(installed.manifest.buildId)).toThrow("Invalid Boxers");
  });

  it("retains and can atomically restore the previous managed executable", () => {
    const first = fixture();
    const firstInstalled = installReleaseCapsule(createReleaseCapsule(first.root));
    writeFileSync(
      join(first.root, "package.json"),
      `${JSON.stringify({ name: "@boxers-dev/boxers", version: "1.2.4", type: "module", dependencies: {} })}\n`,
    );
    writeFileSync(
      join(first.root, "dist", "index.mjs"),
      '#!/usr/bin/env node\nif (process.argv[2] === "--version") process.stdout.write("1.2.4\\n");\n',
    );
    const secondInstalled = installReleaseCapsule(createReleaseCapsule(first.root));
    expect(readlinkSync(join(first.home, ".local", "bin", "boxers"))).toBe(
      secondInstalled.executable,
    );
    expect(rollbackManagedRelease(secondInstalled.manifest.buildId)).toBe(true);
    expect(readlinkSync(join(first.home, ".local", "bin", "boxers"))).toBe(
      firstInstalled.executable,
    );
  });
});
