import { command } from "./process.ts";
import { strictSandboxEnvironment } from "./sandbox.ts";

export interface Diagnostic {
  component: string;
  status: "ok" | "failed";
  detail: string;
}

function probe(executable: string, args: readonly string[], component: string): Diagnostic {
  const result = command(executable, args, {
    env: executable === "sbx" ? strictSandboxEnvironment() : process.env,
  });
  return {
    component,
    status: result.status === 0 ? "ok" : "failed",
    detail:
      (result.stdout || result.stderr).trim().split("\n")[0] ||
      `${executable} exited with status ${result.status}`,
  };
}

function probeMinimum(
  executable: string,
  component: string,
  minimum: readonly [number, number, number],
): Diagnostic {
  const result = probe(executable, ["--version"], component);
  if (result.status === "failed") return result;
  const match = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(result.detail);
  if (!match) return { component, status: "failed", detail: "could not parse version" };
  const actual = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let index = 0; index < minimum.length; index++) {
    if (actual[index]! > minimum[index]!) return result;
    if (actual[index]! < minimum[index]!)
      return {
        component,
        status: "failed",
        detail: `${result.detail}; requires ${minimum.join(".")} or newer`,
      };
  }
  return result;
}

export function diagnostics(): Diagnostic[] {
  return [
    probe("git", ["--version"], "git"),
    probeMinimum("sbx", "docker-sandboxes", [0, 37, 0]),
    probe("sbx", ["ls", "--json"], "docker-sandboxes-runtime"),
    probeMinimum(process.env.HERDR_BIN_PATH ?? "herdr", "herdr", [0, 9, 0]),
  ];
}

export function printDiagnostics(json: boolean): number {
  const results = diagnostics();
  if (json) process.stdout.write(`${JSON.stringify({ diagnostics: results }, null, 2)}\n`);
  else
    for (const result of results)
      process.stdout.write(
        `${result.status === "ok" ? "ok" : "failed"} ${result.component}: ${result.detail}\n`,
      );
  return results.every((result) => result.status === "ok") ? 0 : 1;
}
