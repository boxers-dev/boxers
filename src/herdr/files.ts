import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export function atomicWriteJson(path: string, value: unknown): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let file: number | undefined;
  try {
    file = openSync(temporary, "wx", 0o600);
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(file);
    closeSync(file);
    file = undefined;
    renameSync(temporary, path);
    const directoryHandle = openSync(directory, "r");
    try {
      fsyncSync(directoryHandle);
    } finally {
      closeSync(directoryHandle);
    }
  } catch (error) {
    if (file !== undefined) closeSync(file);
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
