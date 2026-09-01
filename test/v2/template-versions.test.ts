import { describe, expect, it } from "vitest";
import { nodeLtsVersion, rustVersion } from "../../templates/resolve-versions.mjs";

describe("template version resolution", () => {
  it("selects the newest release marked as Node.js LTS", () => {
    expect(
      nodeLtsVersion([
        { version: "v26.7.0", lts: false },
        { version: "v24.19.0", lts: "Krypton" },
        { version: "v22.23.2", lts: "Jod" },
      ]),
    ).toBe("24.19.0");
  });

  it("rejects release metadata without a valid Node.js LTS", () => {
    expect(() => nodeLtsVersion([{ version: "v26.7.0", lts: false }])).toThrow(
      /Node\.js LTS version/,
    );
  });

  it("reads Rust rather than Cargo from the stable channel manifest", () => {
    expect(
      rustVersion(`manifest-version = "2"
[pkg.cargo]
version = "0.98.0 (cargo)"
[pkg.rust]
version = "1.97.1 (rust)"
[pkg.rust.target.x86_64-unknown-linux-gnu]
available = true
`),
    ).toBe("1.97.1");
  });

  it("rejects a manifest without the Rust package section", () => {
    expect(() => rustVersion('[pkg.cargo]\nversion = "0.98.0 (cargo)"\n')).toThrow(
      /stable Rust version/,
    );
  });
});
