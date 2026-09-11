import { dispatchHerdrPlugin } from "./herdr/plugin.ts";
import { printDiagnostics } from "./herdr/doctor.ts";
import { attachPane } from "./herdr/sandbox.ts";
import { pluginStateDir, readPluginState } from "./herdr/state.ts";

const VERSION = "0.1.0";

const USAGE = `boxers — Docker Sandboxes runtime and Git promotion plugin for Herdr

Install
  npm run build
  herdr plugin link <boxers-checkout>

Diagnostics
  boxers doctor [--json]

Host wrapper
  HERDR_AGENT=codex boxers attach <sandbox-id>
  HERDR_AGENT=claude boxers attach <sandbox-id>

Human-facing lifecycle, preview, review, and promotion commands are exposed as
Herdr plugin actions. Promotion is available only from the interactive review pane.
`;

function attachBySandboxId(sandboxId: string | undefined): number {
  if (!sandboxId) throw new Error("attach requires a sandbox ID.");
  const task = readPluginState(pluginStateDir()).tasks.find((item) => item.sandboxId === sandboxId);
  if (!task) throw new Error(`No Boxers mapping exists for sandbox ${sandboxId}.`);
  process.env.BOXERS_TASK_ID = task.id;
  process.env.BOXERS_SANDBOX_ID = task.sandboxId;
  return attachPane(task.agent);
}

async function main(args: string[]): Promise<number> {
  if (args[0] === "herdr-plugin") return dispatchHerdrPlugin(args.slice(1));
  if (args[0] === "doctor") {
    if (args.some((arg) => arg !== "doctor" && arg !== "--json"))
      throw new Error("doctor accepts only --json.");
    return printDiagnostics(args.includes("--json"));
  }
  if (args[0] === "attach") return attachBySandboxId(args[1] ?? process.env.BOXERS_SANDBOX_ID);
  if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args[0] === "--version" || args[0] === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  throw new Error(`Unknown command ${args[0]}. Run boxers --help.`);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
