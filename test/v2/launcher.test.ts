import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { managedInvocation } from "../../src/core/launcher.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "boxers-launcher-"));
  directories.push(root);
  const old = join(root, "old", "dist", "index.mjs");
  const current = join(root, "current.mjs");
  const stable = join(root, "boxers");
  mkdirSync(join(root, "old", "dist"), { recursive: true });
  writeFileSync(old, "// old");
  writeFileSync(current, "// managed");
  symlinkSync(current, stable);
  return { root, old, current, stable };
}

describe("canonical Boxers launcher", () => {
  it("delegates package-manager invocations with unchanged argument boundaries", () => {
    const { old, stable } = fixture();
    const args = ["task", "promote", "--message", "literal $value; text"];
    expect(managedInvocation(args, old, stable)).toEqual({
      command: process.execPath,
      args: [stable, ...args],
    });
  });

  it("does not loop or redirect artifact validation and pinned internal workers", () => {
    const { old, stable, current } = fixture();
    expect(managedInvocation(["list"], current, stable)).toBeUndefined();
    expect(managedInvocation(["--version"], old, stable)).toBeUndefined();
    expect(managedInvocation(["__activate-release"], old, stable)).toBeUndefined();
    expect(managedInvocation(["__daemon-run"], old, stable)).toBeUndefined();
  });

  it("keeps explicit development checkouts available for build distribution", () => {
    const { root, old, stable } = fixture();
    mkdirSync(join(root, "old", "src"));
    writeFileSync(join(root, "old", "src", "index.ts"), "// development");
    expect(managedInvocation(["update"], old, stable)).toBeUndefined();
  });
});
