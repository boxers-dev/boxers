import { describe, expect, it, vi } from "vitest";
import { builtInTemplates, listTemplates, resolveTemplate } from "../../src/v2/templates.ts";

describe("task templates", () => {
  it("uses one registry for built-in resolution", () => {
    expect(builtInTemplates.map((template) => template.name)).toEqual(["default", "bun", "tauri"]);
    expect(resolveTemplate("codex")).toBe("ghcr.io/boxers-dev/boxers-templates:codex-default");
    expect(resolveTemplate("claude", "tauri")).toBe(
      "ghcr.io/boxers-dev/boxers-templates:claude-tauri",
    );
    expect(resolveTemplate("codex", "registry.example/team/image:v1")).toBe(
      "registry.example/team/image:v1",
    );
  });

  it("prints human and machine-readable template catalogs", () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(listTemplates(false)).toBe(0);
    const text = write.mock.calls.flat().join("");
    expect(text).toContain("Built-in task templates");
    expect(text).toContain("default");
    expect(text).toContain("bun");
    expect(text).toContain("tauri");

    write.mockClear();
    expect(listTemplates(true)).toBe(0);
    const result = JSON.parse(String(write.mock.calls[0]?.[0])) as {
      templates: { name: string; images: Record<string, string> }[];
      customImagesSupported: boolean;
    };
    expect(result.customImagesSupported).toBe(true);
    expect(result.templates.find((template) => template.name === "bun")?.images.codex).toBe(
      "ghcr.io/boxers-dev/boxers-templates:codex-bun",
    );
  });
});
