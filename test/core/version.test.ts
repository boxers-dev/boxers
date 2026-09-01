import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readPackageName, readVersion } from "../../src/core/version.ts";

describe("readVersion", () => {
  it("returns the version recorded in package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(readVersion()).toBe(pkg.version);
    expect(readPackageName()).toBe(pkg.name);
  });

  it("returns a non-empty version string", () => {
    expect(readVersion()).toMatch(/\S/);
  });
});
