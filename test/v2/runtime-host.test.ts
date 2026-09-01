import { describe, expect, it } from "vitest";
import { linuxHostSupported } from "../../src/v2/runtime/docker-sandboxes.ts";

describe("Docker Sandboxes Linux host support", () => {
  it("accepts KVM-capable 64-bit Linux independently of distribution", () => {
    expect(linuxHostSupported("x64", true)).toBe(true);
    expect(linuxHostSupported("arm64", true)).toBe(true);
  });

  it("rejects missing KVM and unsupported architectures", () => {
    expect(linuxHostSupported("x64", false)).toBe(false);
    expect(linuxHostSupported("ia32", true)).toBe(false);
  });
});
