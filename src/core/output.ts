import { AsyncLocalStorage } from "node:async_hooks";

export interface OutputSink {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

const storage = new AsyncLocalStorage<OutputSink>();

export function withOutputSink<T>(sink: OutputSink, action: () => Promise<T>): Promise<T> {
  return storage.run(sink, action);
}

export function writeStdout(chunk: string): void {
  const sink = storage.getStore();
  if (sink) sink.stdout(chunk);
  else process.stdout.write(chunk);
}

export function writeStderr(chunk: string): void {
  const sink = storage.getStore();
  if (sink) sink.stderr(chunk);
  else process.stderr.write(chunk);
}
