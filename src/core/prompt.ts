const CTRL_C = "\u0003";

export async function readKey(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return "";
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  try {
    const key = await new Promise<string>((resolve) => {
      process.stdin.once("data", (data: Buffer) => resolve(data.toString("utf8")));
    });
    process.stdout.write("\n");
    if (key === CTRL_C) process.exitCode = 130;
    return key;
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}
