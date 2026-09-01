import { describe, expect, it } from "vitest";
import { humanTimestamp } from "../../src/core/time.ts";

const NOW = new Date("2026-08-27T12:00:00.000Z");

describe("humanTimestamp", () => {
  it("renders recent timestamps as relative time", () => {
    expect(humanTimestamp("2026-08-27T11:58:00.000Z", NOW, "en")).toBe("2 minutes ago");
    expect(humanTimestamp("2026-08-27T12:00:00.000Z", NOW, "en")).toBe("now");
    expect(humanTimestamp("2026-08-27T15:00:00.000Z", NOW, "en")).toBe("in 3 hours");
  });

  it("uses the requested locale", () => {
    expect(humanTimestamp("2026-08-27T11:58:00.000Z", NOW, "nl")).toBe("2 minuten geleden");
  });

  it("scales to useful units and preserves invalid input", () => {
    expect(humanTimestamp("2026-08-17T12:00:00.000Z", NOW, "en")).toBe("last week");
    expect(humanTimestamp("not-a-date", NOW, "en")).toBe("not-a-date");
  });
});
