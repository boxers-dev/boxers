import { spawnSync } from "node:child_process";

function clipboardCommands(): Array<[string, string[]]> {
  if (process.platform === "darwin") return [["pbcopy", []]];
  if (process.platform === "win32") return [["clip", []]];
  return [
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
    ["xsel", ["--clipboard", "--input"]],
  ];
}

export function copyToClipboard(text: string): boolean {
  for (const [executable, args] of clipboardCommands()) {
    try {
      const result = spawnSync(executable, args, {
        input: text,
        stdio: ["pipe", "ignore", "ignore"],
      });
      if (!result.error && result.status === 0) return true;
    } catch {
      // Try the next platform clipboard tool.
    }
  }
  return false;
}
