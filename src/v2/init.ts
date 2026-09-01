import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import type { ProjectConfig } from "./types.ts";

export interface InitCheck {
  name: string;
  run: string;
}

export interface InitSettings {
  setup?: string;
  checks: InitCheck[];
  preview?: { run: string; ports: number[] };
}

interface PackageJson {
  packageManager?: unknown;
  scripts?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
}

function file(root: string, name: string): boolean {
  return existsSync(join(root, name));
}

function text(root: string, name: string): string | undefined {
  try {
    return readFileSync(join(root, name), "utf8");
  } catch {
    return undefined;
  }
}

function packageManager(root: string, manifest: PackageJson): "npm" | "pnpm" | "yarn" | "bun" {
  const configured =
    typeof manifest.packageManager === "string" ? manifest.packageManager.split("@")[0] : undefined;
  if (
    configured === "npm" ||
    configured === "pnpm" ||
    configured === "yarn" ||
    configured === "bun"
  )
    return configured;
  if (file(root, "pnpm-lock.yaml")) return "pnpm";
  if (file(root, "yarn.lock")) return "yarn";
  if (file(root, "bun.lock") || file(root, "bun.lockb")) return "bun";
  return "npm";
}

function packageSetup(root: string, manager: "npm" | "pnpm" | "yarn" | "bun"): string {
  if (manager === "pnpm")
    return file(root, "pnpm-lock.yaml") ? "pnpm install --frozen-lockfile" : "pnpm install";
  if (manager === "yarn")
    return file(root, "yarn.lock") ? "yarn install --frozen-lockfile" : "yarn install";
  if (manager === "bun")
    return file(root, "bun.lock") || file(root, "bun.lockb")
      ? "bun install --frozen-lockfile"
      : "bun install";
  return file(root, "package-lock.json") || file(root, "npm-shrinkwrap.json")
    ? "npm ci"
    : "npm install";
}

function packageRun(manager: "npm" | "pnpm" | "yarn" | "bun", script: string): string {
  return `${manager} run ${script}`;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function dependencies(manifest: PackageJson): Set<string> {
  return new Set([
    ...Object.keys(stringRecord(manifest.dependencies)),
    ...Object.keys(stringRecord(manifest.devDependencies)),
  ]);
}

function detectPackage(root: string): InitSettings | undefined {
  const raw = text(root, "package.json");
  if (!raw) return undefined;
  let manifest: PackageJson;
  try {
    manifest = JSON.parse(raw) as PackageJson;
  } catch {
    return undefined;
  }
  const manager = packageManager(root, manifest);
  const scripts = stringRecord(manifest.scripts);
  const run = (name: string) => packageRun(manager, name);
  const firstScript = (names: readonly string[]): string | undefined =>
    names.find((name) => scripts[name] !== undefined);
  const checks: InitCheck[] = [];
  for (const [name, candidates] of [
    ["check", ["check"]],
    ["lint", ["lint", "lint:check"]],
    ["typecheck", ["typecheck", "type-check", "types"]],
    ["test", ["test:run", "test:ci", "test"]],
  ] as const) {
    const script = firstScript(candidates);
    if (!script) continue;
    if (name === "test" && /no test specified/i.test(scripts[script] ?? "")) continue;
    checks.push({ name, run: run(script) });
  }

  const deps = dependencies(manifest);
  const previewScript = firstScript(["dev", "start"]);
  let preview: InitSettings["preview"];
  if (previewScript && deps.has("vite"))
    preview = { run: `${run(previewScript)} -- --host 0.0.0.0`, ports: [5173] };
  else if (previewScript && deps.has("next"))
    preview = { run: `${run(previewScript)} -- --hostname 0.0.0.0`, ports: [3000] };
  else if (previewScript && deps.has("react-scripts"))
    preview = { run: `HOST=0.0.0.0 ${run(previewScript)}`, ports: [3000] };
  else if (
    previewScript &&
    /(?:--host|--hostname)\s+(?:0\.0\.0\.0|::)/.test(scripts[previewScript] ?? "")
  )
    preview = { run: run(previewScript), ports: [3000] };

  return {
    setup: packageSetup(root, manager),
    checks,
    ...(preview ? { preview } : {}),
  };
}

function detectPython(root: string): InitSettings | undefined {
  const pyproject = text(root, "pyproject.toml") ?? "";
  const hasPython = Boolean(pyproject || file(root, "requirements.txt") || file(root, "setup.py"));
  if (!hasPython) return undefined;
  const setup = file(root, "uv.lock")
    ? "uv sync --frozen"
    : file(root, "poetry.lock")
      ? "poetry install --no-interaction"
      : file(root, "requirements.txt")
        ? "python -m pip install -r requirements.txt"
        : "python -m pip install -e .";
  const hasRuff = /(?:^|[\s"'])ruff(?:[\s"'<>=,]|$)|\[tool\.ruff/m.test(pyproject);
  const checks: InitCheck[] = [];
  if (hasRuff) checks.push({ name: "lint", run: "ruff check ." });
  if (/pytest|\[tool\.pytest/m.test(pyproject) || file(root, "pytest.ini") || file(root, "tests"))
    checks.push({ name: "test", run: "pytest" });
  if (/mypy|\[tool\.mypy/m.test(pyproject)) checks.push({ name: "typecheck", run: "mypy ." });
  return { setup, checks };
}

function detectLanguage(root: string): InitSettings {
  const packageSettings = detectPackage(root);
  if (packageSettings) return packageSettings;
  const pythonSettings = detectPython(root);
  if (pythonSettings) return pythonSettings;
  if (file(root, "Cargo.toml"))
    return {
      setup: "cargo fetch",
      checks: [
        { name: "lint", run: "cargo clippy --all-targets --all-features -- -D warnings" },
        { name: "test", run: "cargo test --all-features" },
      ],
    };
  if (file(root, "go.mod"))
    return {
      setup: "go mod download",
      checks: [
        { name: "check", run: "go vet ./..." },
        { name: "test", run: "go test ./..." },
      ],
    };
  if (file(root, "Gemfile")) {
    const gemfile = text(root, "Gemfile") ?? "";
    return {
      setup: "bundle install",
      checks: [
        ...(/rubocop/i.test(gemfile) ? [{ name: "lint", run: "bundle exec rubocop" }] : []),
        ...(/rspec/i.test(gemfile)
          ? [{ name: "test", run: "bundle exec rspec" }]
          : file(root, "Rakefile")
            ? [{ name: "test", run: "bundle exec rake test" }]
            : []),
      ],
    };
  }
  return { checks: [] };
}

function makeTargets(root: string): Set<string> {
  const makefile = text(root, "Makefile");
  if (!makefile) return new Set();
  return new Set(
    [...makefile.matchAll(/^([A-Za-z0-9][A-Za-z0-9._-]*):(?:\s|$)/gm)].map(
      (match) => match[1] as string,
    ),
  );
}

export function detectInitSettings(root: string): InitSettings {
  const result = detectLanguage(root);
  const targets = makeTargets(root);
  const firstTarget = (names: readonly string[]) => names.find((name) => targets.has(name));
  const setup = firstTarget(["setup", "install"]);
  if (setup) result.setup = `make ${setup}`;
  for (const name of ["check", "lint", "test"] as const) {
    if (!targets.has(name)) continue;
    const existing = result.checks.find((check) => check.name === name);
    if (existing) existing.run = `make ${name}`;
    else result.checks.push({ name, run: `make ${name}` });
  }
  return result;
}

export function emptyProjectConfig(): ProjectConfig {
  return { version: 3 };
}

export function enableDetectedChecks(config: ProjectConfig, settings: InitSettings): void {
  if (settings.setup && !config.setup) config.setup = { run: settings.setup, timeoutMs: 900_000 };
  if (!settings.checks.length) return;
  config.check = {
    commands: settings.checks.map((command) => ({
      ...command,
      timeoutMs: command.name === "test" ? 1_800_000 : 900_000,
    })),
  };
}

function duration(value: number): string {
  if (value % 3_600_000 === 0) return `${value / 3_600_000}h`;
  if (value % 60_000 === 0) return `${value / 60_000}m`;
  if (value % 1_000 === 0) return `${value / 1_000}s`;
  return `${value}ms`;
}

export function renderConfig(config: ProjectConfig): string {
  const commands = Object.fromEntries(
    (config.check?.commands ?? []).map((definition) => [
      definition.name,
      definition.timeoutMs === 900_000
        ? definition.run
        : { run: definition.run, timeout: duration(definition.timeoutMs) },
    ]),
  );
  return stringify(
    {
      version: 3,
      ...(config.integration ? { integration: config.integration } : {}),
      ...(config.setup
        ? {
            setup: {
              run: config.setup.run,
              ...(config.setup.timeoutMs === 900_000
                ? {}
                : { timeout: duration(config.setup.timeoutMs) }),
            },
          }
        : {}),
      ...(config.check?.commands.length
        ? {
            check: {
              commands,
            },
          }
        : {}),
      ...(config.preview ? { preview: config.preview } : {}),
      ...(config.defaults ? { defaults: config.defaults } : {}),
    },
    { lineWidth: 0 },
  );
}
