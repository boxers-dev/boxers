import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createReleaseCapsule } from "../../src/v2/release.ts";
import { releaseBootstrapScript } from "../../src/v2/release-bootstrap.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("release bootstrap without an installed Boxers protocol", () => {
  it("executes the supplied build and passes the exact capsule to shared activation", () => {
    const root = mkdtempSync(join(tmpdir(), "boxers-bootstrap-test-"));
    directories.push(root);
    const pkg = join(root, "package");
    const bin = join(root, "bin");
    const log = join(root, "npm.log");
    mkdirSync(join(pkg, "dist"), { recursive: true });
    mkdirSync(bin);
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "@boxers-dev/boxers", version: "0.0.5", type: "module" }),
    );
    writeFileSync(
      join(pkg, "dist/index.mjs"),
      `import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
if (process.argv[2] !== "__activate-release") throw Error("Unexpected command");
console.log(JSON.stringify({ build: "development", capsule: createHash("sha256").update(readFileSync(0)).digest("hex") }));
`,
    );
    const npm = join(bin, "npm");
    writeFileSync(npm, '#!/bin/sh\nprintf "%s\\n" "$*" > "$FAKE_NPM_LOG"\n');
    chmodSync(npm, 0o755);
    const capsule = createReleaseCapsule(pkg);
    const result = spawnSync(process.execPath, ["-e", releaseBootstrapScript()], {
      input: capsule,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_NPM_LOG: log },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      build: "development",
      capsule: createHash("sha256").update(capsule).digest("hex"),
    });
    expect(readFileSync(log, "utf8")).not.toContain("@boxers-dev/boxers");
  });

  it("rejects invalid release bytes before staging code", () => {
    const result = spawnSync(process.execPath, ["-e", releaseBootstrapScript()], {
      input: Buffer.from("invalid"),
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Invalid Boxers release capsule");
  });
});
