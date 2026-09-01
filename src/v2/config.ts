import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { CheckDefinition, ProjectConfig } from "./types.ts";

export const DEFAULT_PROJECT_CONFIG = `version: 3
`;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a mapping.`);
  }
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${label} contains unknown key ${unknown}.`);
}

function duration(value: unknown, label: string, fallback = 900_000): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new Error(`${label} must be a duration such as 15m.`);
  const match = /^(\d+)(ms|s|m|h)$/.exec(value);
  if (!match) throw new Error(`${label} must use ms, s, m, or h.`);
  const amount = Number(match[1]);
  const unit = match[2];
  return amount * (unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1);
}

function checkCommands(value: unknown): CheckDefinition[] {
  if (value === undefined) return [];
  const commands = object(value, "check.commands");
  return Object.entries(commands).map(([name, raw]) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name))
      throw new Error(
        `check.commands contains invalid name ${name}; use letters, numbers, dots, underscores, or hyphens.`,
      );
    if (typeof raw === "string") {
      if (!raw.trim()) throw new Error(`check.commands.${name} must not be empty.`);
      return { name, run: raw, timeoutMs: 900_000 };
    }
    const command = object(raw, `check.commands.${name}`);
    keys(command, ["run", "timeout"], `check.commands.${name}`);
    if (typeof command.run !== "string" || !command.run.trim())
      throw new Error(`check.commands.${name}.run is required.`);
    return {
      name,
      run: command.run,
      timeoutMs: duration(command.timeout, `check.commands.${name}.timeout`),
    };
  });
}

function configRoot(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (error) {
    throw new Error(
      `Invalid .boxers/config.yml: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const root = object(parsed, ".boxers/config.yml");
  if (root.version !== 3) throw new Error(".boxers/config.yml version must be 3.");
  return root;
}

function parseIntegration(root: Record<string, unknown>): ProjectConfig["integration"] {
  if (root.integration === undefined) return undefined;
  const integration = object(root.integration, "integration");
  keys(integration, ["mode", "base", "remote"], "integration");
  if (integration.mode !== "local" && integration.mode !== "remote")
    throw new Error("integration.mode must be local or remote.");
  if (typeof integration.base !== "string" || !integration.base.trim())
    throw new Error("integration.base is required.");
  if (integration.mode === "local") {
    if (integration.remote !== undefined)
      throw new Error("integration.remote applies only to remote integration.");
    return { mode: "local", base: integration.base };
  }
  if (typeof integration.remote !== "string" || !integration.remote.trim())
    throw new Error("Remote integration requires integration.remote.");
  return { mode: "remote", base: integration.base, remote: integration.remote };
}

function parseCheck(root: Record<string, unknown>): ProjectConfig["check"] {
  if (root.check === undefined) return undefined;
  {
    const check = object(root.check, "check");
    keys(check, ["setup", "commands"], "check");
    if (check.setup !== undefined && (typeof check.setup !== "string" || !check.setup.trim()))
      throw new Error("check.setup must be a non-empty command.");
    const commands = checkCommands(check.commands);
    if (check.setup !== undefined || commands.length)
      return {
        ...(typeof check.setup === "string" ? { setup: check.setup } : {}),
        commands,
      };
  }
  return undefined;
}

function parseSetup(root: Record<string, unknown>): ProjectConfig["setup"] {
  if (root.setup === undefined) return undefined;
  const setup = object(root.setup, "setup");
  keys(setup, ["run", "timeout"], "setup");
  if (typeof setup.run !== "string" || !setup.run.trim())
    throw new Error("setup.run must be a non-empty command.");
  return { run: setup.run, timeoutMs: duration(setup.timeout, "setup.timeout") };
}

function parsePreview(root: Record<string, unknown>): ProjectConfig["preview"] {
  if (root.preview !== undefined) {
    const preview = object(root.preview, "preview");
    keys(preview, ["run", "ports"], "preview");
    if (typeof preview.run !== "string" || !preview.run.trim())
      throw new Error("preview.run must be a non-empty command.");
    if (
      !Array.isArray(preview.ports) ||
      preview.ports.length === 0 ||
      preview.ports.some(
        (port) => !Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535,
      )
    ) {
      throw new Error("preview.ports must be a non-empty list of ports from 1 to 65535.");
    }
    return { run: preview.run, ports: preview.ports as number[] };
  }
  return undefined;
}

function parseDefaults(root: Record<string, unknown>): ProjectConfig["defaults"] {
  if (root.defaults === undefined) return undefined;
  const defaults = object(root.defaults, "defaults");
  keys(defaults, ["agent", "model", "effort", "fast"], "defaults");
  if (defaults.agent !== undefined && defaults.agent !== "codex" && defaults.agent !== "claude")
    throw new Error("defaults.agent must be codex or claude.");
  for (const name of ["model", "effort"] as const)
    if (
      defaults[name] !== undefined &&
      (typeof defaults[name] !== "string" || !defaults[name].trim())
    )
      throw new Error(`defaults.${name} must be a non-empty string.`);
  if (defaults.fast !== undefined && typeof defaults.fast !== "boolean")
    throw new Error("defaults.fast must be true or false.");
  if (!Object.keys(defaults).length) return undefined;
  return defaults as ProjectConfig["defaults"];
}

export function parseProjectCheck(text: string): ProjectConfig["check"] {
  const root = configRoot(text);
  keys(
    root,
    ["version", "integration", "setup", "check", "preview", "defaults"],
    ".boxers/config.yml",
  );
  return parseCheck(root);
}

export function parseProjectPreview(text: string): ProjectConfig["preview"] {
  const root = configRoot(text);
  keys(
    root,
    ["version", "integration", "setup", "check", "preview", "defaults"],
    ".boxers/config.yml",
  );
  return parsePreview(root);
}

export function parseProjectSetup(text: string): ProjectConfig["setup"] {
  const root = configRoot(text);
  keys(
    root,
    ["version", "integration", "setup", "check", "preview", "defaults"],
    ".boxers/config.yml",
  );
  return parseSetup(root);
}

export function parseProjectConfig(text: string): ProjectConfig {
  const root = configRoot(text);
  keys(
    root,
    ["version", "integration", "setup", "check", "preview", "defaults"],
    ".boxers/config.yml",
  );
  const integration = parseIntegration(root);
  const setup = parseSetup(root);
  const check = parseCheck(root);
  const preview = parsePreview(root);
  const defaults = parseDefaults(root);
  const result: ProjectConfig = {
    version: 3,
    ...(integration ? { integration } : {}),
    ...(setup ? { setup } : {}),
    ...(check ? { check } : {}),
    ...(preview ? { preview } : {}),
    ...(defaults ? { defaults } : {}),
  };
  return result;
}

export function readProjectConfig(path: string): ProjectConfig {
  return parseProjectConfig(readFileSync(path, "utf8"));
}
