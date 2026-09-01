import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function readPackageField(field: "name" | "version"): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  // Bounded walk up to the filesystem root looking for our package.json.
  for (let prev = ""; dir !== prev; prev = dir, dir = dirname(dir)) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (typeof pkg[field] === "string") return pkg[field];
    } catch {
      // No package.json here (or unreadable); keep walking up.
    }
  }
  return undefined;
}

/**
 * Read package metadata from the nearest `package.json`.
 *
 * The publish workflow (`.github/workflows/publish-npm.yml`) writes the git tag
 * into `package.json` via `npm version` before building, so `package.json` is
 * the source of truth for published metadata. We resolve it by walking up from
 * this module's location, which works both from source (run with `tsx`) and
 * from the bundled binary (`dist/index.mjs`), regardless of nesting depth.
 */
export function readVersion(): string {
  return readPackageField("version") ?? "unknown";
}

export function readPackageName(): string {
  const name = readPackageField("name");
  if (name) return name;
  throw new Error("Could not determine the Boxers npm package name.");
}
