import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { Agent, CheckDefinition, ProjectConfig } from "./types.ts";

export const DEFAULT_CONFIG = "version: 1\n";

function mapping(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be a mapping.`);
  return value as Record<string, unknown>;
}

function only(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const invalid = Object.keys(value).find((key) => !allowed.includes(key));
  if (invalid) throw new Error(`${label} contains unknown key ${invalid}.`);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be non-empty.`);
  return value;
}

function duration(value: unknown, label: string, fallback = 900_000): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new Error(`${label} must be a duration such as 15m.`);
  const match = /^(\d+)(ms|s|m|h)$/.exec(value);
  if (!match) throw new Error(`${label} must use ms, s, m, or h.`);
  const amount = Number(match[1]);
  return (
    amount *
    (match[2] === "h" ? 3_600_000 : match[2] === "m" ? 60_000 : match[2] === "s" ? 1_000 : 1)
  );
}

function parseChecks(value: unknown): CheckDefinition[] {
  if (value === undefined) return [];
  const checks = mapping(value, "checks");
  return Object.entries(checks).map(([name, raw]) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error(`Invalid check name ${name}.`);
    if (typeof raw === "string")
      return { name, run: text(raw, `checks.${name}`), timeoutMs: 900_000 };
    const entry = mapping(raw, `checks.${name}`);
    only(entry, ["run", "timeout"], `checks.${name}`);
    return {
      name,
      run: text(entry.run, `checks.${name}.run`),
      timeoutMs: duration(entry.timeout, `checks.${name}.timeout`),
    };
  });
}

export function parseProjectConfig(source: string): ProjectConfig {
  let raw: unknown;
  try {
    raw = parse(source);
  } catch (error) {
    throw new Error(
      `Invalid .boxers/config.yml: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const root = mapping(raw, ".boxers/config.yml");
  if (root.version !== 1) throw new Error(".boxers/config.yml version must be 1.");
  only(
    root,
    ["version", "integration", "agent", "sandbox", "setup", "checks", "preview"],
    ".boxers/config.yml",
  );

  let integration: ProjectConfig["integration"];
  if (root.integration !== undefined) {
    const value = mapping(root.integration, "integration");
    only(value, ["remote", "branch"], "integration");
    integration = {
      ...(value.remote === undefined ? {} : { remote: text(value.remote, "integration.remote") }),
      ...(value.branch === undefined ? {} : { branch: text(value.branch, "integration.branch") }),
    };
  }

  let agent: ProjectConfig["agent"];
  if (root.agent !== undefined) {
    const value = mapping(root.agent, "agent");
    only(value, ["default", "model", "effort"], "agent");
    if (value.default !== undefined && value.default !== "codex" && value.default !== "claude")
      throw new Error("agent.default must be codex or claude.");
    agent = {
      ...(value.default ? { default: value.default as Agent } : {}),
      ...(value.model !== undefined ? { model: text(value.model, "agent.model") } : {}),
      ...(value.effort !== undefined ? { effort: text(value.effort, "agent.effort") } : {}),
    };
  }

  let sandbox: ProjectConfig["sandbox"];
  if (root.sandbox !== undefined) {
    const value = mapping(root.sandbox, "sandbox");
    only(value, ["template"], "sandbox");
    sandbox =
      value.template === undefined ? {} : { template: text(value.template, "sandbox.template") };
  }

  let setup: ProjectConfig["setup"];
  if (root.setup !== undefined) {
    const value = mapping(root.setup, "setup");
    only(value, ["run", "timeout"], "setup");
    setup = {
      run: text(value.run, "setup.run"),
      timeoutMs: duration(value.timeout, "setup.timeout"),
    };
  }

  let preview: ProjectConfig["preview"];
  if (root.preview !== undefined) {
    const value = mapping(root.preview, "preview");
    only(value, ["run", "ports", "review", "setup"], "preview");
    if (
      !Array.isArray(value.ports) ||
      value.ports.length === 0 ||
      value.ports.some(
        (port) => !Number.isInteger(port) || (port as number) < 1 || (port as number) > 65_535,
      )
    )
      throw new Error("preview.ports must contain ports from 1 to 65535.");
    if (value.review !== undefined && value.review !== "snapshot" && value.review !== "live")
      throw new Error("preview.review must be snapshot or live.");
    preview = {
      run: text(value.run, "preview.run"),
      ports: value.ports as number[],
      reviewMode: (value.review as "snapshot" | "live" | undefined) ?? "snapshot",
      ...(value.setup !== undefined ? { setup: text(value.setup, "preview.setup") } : {}),
    };
  }

  return {
    version: 1,
    ...(integration ? { integration } : {}),
    ...(agent && Object.keys(agent).length ? { agent } : {}),
    ...(sandbox && Object.keys(sandbox).length ? { sandbox } : {}),
    ...(setup ? { setup } : {}),
    checks: parseChecks(root.checks),
    ...(preview ? { preview } : {}),
  };
}

export function readProjectConfig(path: string): ProjectConfig {
  return parseProjectConfig(readFileSync(path, "utf8"));
}
