#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function npmVersion(name) {
  return execFileSync("npm", ["view", `${name}@latest`, "version"], {
    encoding: "utf8",
  }).trim();
}

export function nodeLtsVersion(releases) {
  if (!Array.isArray(releases)) throw new Error("Node.js release metadata must be an array.");
  const version = releases.find(
    (release) => typeof release?.version === "string" && release.lts,
  )?.version;
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(version ?? ""))
    throw new Error("Could not resolve the current Node.js LTS version.");
  return version.slice(1);
}

export function rustVersion(text) {
  const header = "[pkg.rust]\n";
  const start = text.indexOf(header);
  const remainder = start < 0 ? "" : text.slice(start + header.length);
  const nextSection = remainder.search(/^\[/m);
  const section = nextSection < 0 ? remainder : remainder.slice(0, nextSection);
  const version = /^version = "([0-9]+\.[0-9]+\.[0-9]+) /m.exec(section ?? "")?.[1];
  if (!version) throw new Error("Could not resolve the stable Rust version.");
  return version;
}

async function latestRust() {
  const response = await fetch("https://static.rust-lang.org/dist/channel-rust-stable.toml");
  if (!response.ok) throw new Error(`Rust release metadata: HTTP ${response.status}`);
  return rustVersion(await response.text());
}

async function latestNodeLts() {
  const response = await fetch("https://nodejs.org/dist/index.json");
  if (!response.ok) throw new Error(`Node.js release metadata: HTTP ${response.status}`);
  return nodeLtsVersion(await response.json());
}

async function main() {
  const versions = {
    CODEX_VERSION: npmVersion("@openai/codex"),
    CLAUDE_VERSION: npmVersion("@anthropic-ai/claude-code"),
    NODE_VERSION: await latestNodeLts(),
    COREPACK_VERSION: npmVersion("corepack"),
    GET_PNPM_VERSION: npmVersion("get-pnpm"),
    PNPM_VERSION: npmVersion("pnpm"),
    YARN_VERSION: npmVersion("@yarnpkg/cli-dist"),
    BUN_VERSION: npmVersion("bun"),
    RUST_VERSION: await latestRust(),
  };
  for (const [name, version] of Object.entries(versions)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(version))
      throw new Error(`Invalid ${name}: ${JSON.stringify(version)}`);
    console.log(`${name.toLowerCase()}=${version}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
