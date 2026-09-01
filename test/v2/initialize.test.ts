import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prompts = vi.hoisted(() => ({
  answers: [] as string[],
  question: vi.fn<(text: string) => Promise<string>>(),
  close: vi.fn(),
}));

vi.mock("node:readline/promises", () => ({
  createInterface: () => ({ question: prompts.question, close: prompts.close }),
}));

vi.mock("../../src/v2/auth.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/v2/auth.ts")>()),
  isInteractive: () => true,
}));

import { parseProjectConfig } from "../../src/v2/config.ts";
import { initialize, requireOrRegisterProject } from "../../src/v2/commands.ts";
import { listProjects } from "../../src/v2/registry.ts";

const cleanup: string[] = [];
const originalCwd = process.cwd();
const originalHome = process.env["BOXERS_HOME"];

beforeEach(() => {
  prompts.answers = [];
  prompts.question.mockReset();
  prompts.question.mockImplementation(async () => prompts.answers.shift() ?? "");
  prompts.close.mockReset();
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env["BOXERS_HOME"];
  else process.env["BOXERS_HOME"] = originalHome;
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args]);
}

describe("boxers project init", () => {
  it("refuses to register a project whose configured remote is unreachable", async () => {
    const root = mkdtempSync(join(tmpdir(), "boxers-initialize-unreachable-"));
    const state = mkdtempSync(join(tmpdir(), "boxers-state-unreachable-"));
    cleanup.push(root, state);
    process.env["BOXERS_HOME"] = state;
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.invalid");
    writeFileSync(join(root, "README.md"), "base\n");
    git(root, "add", "README.md");
    git(root, "commit", "-q", "-m", "base");
    git(root, "remote", "add", "origin", join(root, "missing-remote.git"));
    process.chdir(root);

    await expect(initialize({ yes: true })).rejects.toThrow("Git remote origin is not reachable");
    expect(existsSync(join(root, ".boxers", "config.yml"))).toBe(false);
    expect(listProjects()).toEqual([]);
  });

  it("offers checks as an optional feature and reruns safely", async () => {
    const root = mkdtempSync(join(tmpdir(), "boxers-initialize-"));
    const state = mkdtempSync(join(tmpdir(), "boxers-state-"));
    cleanup.push(root, state);
    process.env["BOXERS_HOME"] = state;
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.invalid");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint .", test: "vitest run" } }),
    );
    git(root, "add", "package.json");
    git(root, "commit", "-q", "-m", "base");
    process.chdir(root);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    prompts.answers = ["", "", "", "yes"];
    await expect(initialize()).resolves.toBe(0);

    const configPath = join(root, ".boxers", "config.yml");
    const firstText = readFileSync(configPath, "utf8");
    const firstConfig = parseProjectConfig(firstText);
    expect(firstConfig.integration).toEqual({ mode: "local", base: "main" });
    expect(firstConfig.setup).toEqual({ run: "npm install", timeoutMs: 900_000 });
    expect(firstConfig.check).toMatchObject({
      commands: [
        { name: "lint", run: "npm run lint" },
        { name: "test", run: "npm run test" },
      ],
    });
    expect(listProjects()).toHaveLength(1);

    prompts.answers = ["", "", "", "yes", "no", "yes"];
    await expect(initialize()).resolves.toBe(0);
    expect(stdout.mock.calls.flat().join("")).toContain(
      "Found existing .boxers/config.yml; re-running configuration.",
    );
    expect(parseProjectConfig(readFileSync(configPath, "utf8")).check?.commands).toEqual([
      { name: "test", run: "npm run test", timeoutMs: 1_800_000 },
    ]);

    git(root, "branch", "next");
    prompts.answers = ["local", "next", "", "no"];
    await expect(initialize()).resolves.toBe(0);
    expect(parseProjectConfig(readFileSync(configPath, "utf8")).integration).toEqual({
      mode: "local",
      base: "next",
    });
    expect(listProjects()[0]?.integration).toEqual({ mode: "local", base: "next" });
    expect(stdout.mock.calls.flat().join("")).toContain(
      "Existing task environments were not modified; future reconciliation, review, check, and promote operations use the current integration settings.",
    );
  });

  it("registers a new host directly from checked-in version 3 configuration", async () => {
    const root = mkdtempSync(join(tmpdir(), "boxers-hydrate-"));
    const state = mkdtempSync(join(tmpdir(), "boxers-state-"));
    cleanup.push(root, state);
    process.env["BOXERS_HOME"] = state;
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.invalid");
    writeFileSync(join(root, "tracked.txt"), "tracked\n");
    git(root, "add", "tracked.txt");
    git(root, "commit", "-q", "-m", "base");
    const configDir = join(root, ".boxers");
    mkdirSync(configDir);
    const configText = "version: 3\nintegration:\n  mode: local\n  base: main\n";
    writeFileSync(join(configDir, "config.yml"), configText);
    process.chdir(root);

    const project = await requireOrRegisterProject();
    expect(project.integration).toEqual({ mode: "local", base: "main" });
    expect(readFileSync(join(configDir, "config.yml"), "utf8")).toBe(configText);
    expect(await requireOrRegisterProject()).toEqual(project);
  });

  it("keeps checks disabled by default while enabling a detected preview", async () => {
    const root = mkdtempSync(join(tmpdir(), "boxers-initialize-defaults-"));
    const state = mkdtempSync(join(tmpdir(), "boxers-state-defaults-"));
    cleanup.push(root, state);
    process.env["BOXERS_HOME"] = state;
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.invalid");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        scripts: { test: "vitest run", dev: "vite" },
        devDependencies: { vite: "1" },
      }),
    );
    git(root, "add", "package.json");
    git(root, "commit", "-q", "-m", "base");
    process.chdir(root);
    vi.spyOn(process.stdout, "write").mockReturnValue(true);

    prompts.answers = ["", "", "", "", "", "codex", "gpt-example", "high", "yes"];
    await initialize();
    const config = parseProjectConfig(readFileSync(join(root, ".boxers", "config.yml"), "utf8"));
    expect(config.preview).toBeDefined();
    expect(config.check).toBeUndefined();
    expect(config.defaults).toEqual({
      agent: "codex",
      model: "gpt-example",
      effort: "high",
      fast: true,
    });
  });

  it("writes an explicit preview command and ports", async () => {
    const root = mkdtempSync(join(tmpdir(), "boxers-initialize-preview-"));
    const state = mkdtempSync(join(tmpdir(), "boxers-state-preview-"));
    cleanup.push(root, state);
    process.env["BOXERS_HOME"] = state;
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.invalid");
    writeFileSync(join(root, "README.md"), "preview fixture\n");
    git(root, "add", "README.md");
    git(root, "commit", "-q", "-m", "base");
    process.chdir(root);
    vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await initialize({
      previewCommand: "python -m http.server 8080 --bind 0.0.0.0",
      previewPorts: [8080],
      yes: true,
    });
    const config = parseProjectConfig(readFileSync(join(root, ".boxers", "config.yml"), "utf8"));
    expect(config.preview).toEqual({
      run: "python -m http.server 8080 --bind 0.0.0.0",
      ports: [8080],
    });
  });

  it("prompts for a custom preview command and container ports", async () => {
    const root = mkdtempSync(join(tmpdir(), "boxers-initialize-prompt-preview-"));
    const state = mkdtempSync(join(tmpdir(), "boxers-state-prompt-preview-"));
    cleanup.push(root, state);
    process.env["BOXERS_HOME"] = state;
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.invalid");
    writeFileSync(join(root, "README.md"), "preview fixture\n");
    git(root, "add", "README.md");
    git(root, "commit", "-q", "-m", "base");
    process.chdir(root);
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    prompts.answers = ["", "", "python -m http.server 8080 --bind 0.0.0.0", "8080, 8081"];

    await initialize();

    expect(
      parseProjectConfig(readFileSync(join(root, ".boxers", "config.yml"), "utf8")).preview,
    ).toEqual({
      run: "python -m http.server 8080 --bind 0.0.0.0",
      ports: [8080, 8081],
    });
    expect(prompts.question).toHaveBeenCalledWith("Preview container ports: ");
  });
});
