import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROJECT_CONFIG,
  parseProjectCheck,
  parseProjectConfig,
  parseProjectPreview,
} from "../../src/v2/config.ts";

describe("project configuration", () => {
  it("accepts a project with no optional features", () => {
    expect(parseProjectConfig(DEFAULT_PROJECT_CONFIG)).toEqual({ version: 3 });
    expect(parseProjectConfig("version: 3\ncheck: {}\n")).toEqual({ version: 3 });
  });

  it("parses portable version 3 integration settings", () => {
    expect(
      parseProjectConfig(`version: 3
integration:
  mode: remote
  base: main
  remote: origin
`),
    ).toEqual({
      version: 3,
      integration: { mode: "remote", base: "main", remote: "origin" },
    });
    expect(parseProjectConfig("version: 3\n")).toEqual({ version: 3 });
    expect(() =>
      parseProjectConfig("version: 3\nintegration: { mode: local, base: main, remote: origin }\n"),
    ).toThrow("applies only to remote");
  });

  it("parses task launch defaults", () => {
    expect(
      parseProjectConfig(`version: 3
defaults:
  agent: codex
  model: gpt-example
  effort: high
  fast: true
`),
    ).toEqual({
      version: 3,
      defaults: { agent: "codex", model: "gpt-example", effort: "high", fast: true },
    });
    expect(() => parseProjectConfig("version: 3\ndefaults: { agent: vibe }\n")).toThrow(
      /codex or claude/,
    );
  });

  it("parses concise and advanced check commands", () => {
    const config = parseProjectConfig(`version: 3
check:
  setup: npm ci
  commands:
    quality: npm run check
    test:
      run: npm test
      timeout: 30m
`);
    expect(config.check).toEqual({
      setup: "npm ci",
      commands: [
        { name: "quality", run: "npm run check", timeoutMs: 900_000 },
        { name: "test", run: "npm test", timeoutMs: 1_800_000 },
      ],
    });
  });

  it("parses task setup independently from checks", () => {
    expect(
      parseProjectConfig(`version: 3
setup:
  run: npm ci
  timeout: 20m
`),
    ).toEqual({ version: 3, setup: { run: "npm ci", timeoutMs: 1_200_000 } });
  });

  it("fails on malformed configured features while allowing their omission", () => {
    expect(() => parseProjectConfig("version: 1\n")).toThrow(/version must be 3/);
    expect(() =>
      parseProjectConfig(
        "version: 3\ncheck:\n  commands:\n    test:\n      run: npm test\n      timeout: soon\n",
      ),
    ).toThrow(/must use ms, s, m, or h/);
    expect(() =>
      parseProjectConfig("version: 3\npreview:\n  run: npm start\n  ports: [70000]\n"),
    ).toThrow(/ports/);
    expect(() => parseProjectConfig("version: 3\nunknown: true\n")).toThrow(/unknown key/);
    expect(() => parseProjectConfig("version: 3\nsetup: { timeout: 15m }\n")).toThrow(/setup.run/);
    expect(() => parseProjectConfig("version: 3\ngates: {}\n")).toThrow(/unknown key/);
  });

  it("validates only the feature an operational command uses", () => {
    expect(
      parseProjectPreview(`version: 3
check: broken
preview:
  run: npm start
  ports: [3000]
`),
    ).toEqual({ run: "npm start", ports: [3000] });
    expect(
      parseProjectCheck(`version: 3
check:
  commands:
    test: npm test
preview: broken
`),
    ).toMatchObject({ commands: [{ name: "test", run: "npm test" }] });
  });
});
