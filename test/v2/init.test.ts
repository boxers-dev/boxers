import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseProjectConfig } from "../../src/v2/config.ts";
import {
  detectInitSettings,
  emptyProjectConfig,
  enableDetectedChecks,
  renderConfig,
} from "../../src/v2/init.ts";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "boxers-init-"));
  cleanup.push(root);
  return root;
}

describe("project init detection", () => {
  it("detects package-manager setup, checks, and a Vite preview", () => {
    const root = project();
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        packageManager: "pnpm@10.0.0",
        scripts: {
          format: "prettier --write .",
          check: "tsc --noEmit",
          lint: "eslint .",
          test: "vitest run",
          "test:run": "vitest run --coverage=false",
          dev: "vite",
        },
        devDependencies: { vite: "latest" },
      }),
    );

    const settings = detectInitSettings(root);
    expect(settings).toEqual({
      setup: "pnpm install --frozen-lockfile",
      checks: [
        { name: "check", run: "pnpm run check" },
        { name: "lint", run: "pnpm run lint" },
        { name: "test", run: "pnpm run test:run" },
      ],
      preview: { run: "pnpm run dev -- --host 0.0.0.0", ports: [5173] },
    });
    const generated = emptyProjectConfig();
    enableDetectedChecks(generated, settings);
    if (settings.preview) generated.preview = settings.preview;
    const config = parseProjectConfig(renderConfig(generated));
    expect(config.check?.commands.map((check) => check.name)).toEqual(["check", "lint", "test"]);
    expect(config.check?.commands[2]?.timeoutMs).toBe(1_800_000);
  });

  it("uses explicit Make targets as the repository contract", () => {
    const root = project();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { format: "prettier -w .", test: "vitest" } }),
    );
    writeFileSync(
      join(root, "Makefile"),
      "setup:\n\ttrue\nformat:\n\ttrue\nlint:\n\ttrue\ntest:\n\ttrue\n",
    );
    expect(detectInitSettings(root)).toMatchObject({
      setup: "make setup",
      checks: expect.arrayContaining([
        { name: "lint", run: "make lint" },
        { name: "test", run: "make test" },
      ]),
    });
  });

  it("generates a valid minimal config when no features are known", () => {
    expect(parseProjectConfig(renderConfig(emptyProjectConfig()))).toEqual({
      version: 3,
    });
  });

  it("renders task launch defaults", () => {
    const config = emptyProjectConfig();
    config.defaults = { agent: "codex", model: "gpt-example", effort: "high", fast: true };
    expect(parseProjectConfig(renderConfig(config)).defaults).toEqual(config.defaults);
  });

  it("enables detected checks only when requested and renders concise commands", () => {
    const config = emptyProjectConfig();
    enableDetectedChecks(config, {
      setup: "npm ci",
      checks: [
        { name: "lint", run: "npm run lint" },
        { name: "test", run: "npm test" },
      ],
    });
    const text = renderConfig(config);
    expect(text).toContain("lint: npm run lint");
    expect(parseProjectConfig(text).setup).toEqual({ run: "npm ci", timeoutMs: 900_000 });
    expect(parseProjectConfig(text).check).toEqual({
      commands: [
        { name: "lint", run: "npm run lint", timeoutMs: 900_000 },
        { name: "test", run: "npm test", timeoutMs: 1_800_000 },
      ],
    });
  });
});
