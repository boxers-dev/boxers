import { describe, expect, it } from "vitest";
import { BOXER_NAMES, generateBoxerName } from "../../src/v2/boxer-name.ts";

describe("fictional boxer names", () => {
  it("picks a CLI-friendly ring name", () => {
    expect(BOXER_NAMES).toContain(generateBoxerName([]));
    expect(new Set(BOXER_NAMES).size).toBe(BOXER_NAMES.length);
    for (const name of BOXER_NAMES) expect(name).toMatch(/^[a-z][a-z0-9-]+$/);
  });

  it("uses the remaining name and treats existing names case-insensitively", () => {
    expect(generateBoxerName(BOXER_NAMES.slice(1).map((name) => name.toUpperCase()))).toBe(
      BOXER_NAMES[0],
    );
  });

  it("finds an available rematch suffix when all ring names are taken", () => {
    const taken = BOXER_NAMES.flatMap((name) => [name, `${name}-2`, `${name}-3`]);
    const generated = generateBoxerName(taken);
    expect(generated).toMatch(/-4$/);
    expect(taken).not.toContain(generated);
  });
});
