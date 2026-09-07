import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { PREPARE_CODEX_HOME } from "../../src/v2/runtime/codex-home.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "boxers-codex-home-"));
  directories.push(root);
  const source = join(root, "docker-codex");
  const target = join(root, "boxers-codex");
  mkdirSync(source);
  return {
    source,
    target,
    prepare: () => execFileSync(process.execPath, ["-e", PREPARE_CODEX_HOME, source, target]),
  };
}

it("preserves credentials across Docker auth rewrites without forking session history", () => {
  const { source, target, prepare } = fixture();
  const auth = JSON.stringify({ tokens: { refresh_token: "original-refresh" } });
  writeFileSync(join(source, "auth.json"), auth);
  writeFileSync(join(source, "state_5.sqlite"), "existing database");
  mkdirSync(join(source, "sessions"));
  writeFileSync(join(source, "sessions", "conversation.jsonl"), "existing conversation");
  expect(prepare().toString()).toBe("imported\n");
  expect(readFileSync(join(target, "auth.json"), "utf8")).toBe(auth);
  expect(statSync(target).mode & 0o777).toBe(0o700);
  expect(statSync(join(target, "auth.json")).mode & 0o777).toBe(0o600);
  expect(statSync(join(target, "state_5.sqlite")).ino).toBe(
    statSync(join(source, "state_5.sqlite")).ino,
  );

  // The agent renews its own tokens, then Docker reseeds its managed auth file.
  writeFileSync(join(target, "auth.json"), "renewed credentials");
  writeFileSync(join(source, "auth.json"), '{"OPENAI_API_KEY":"proxy-managed"}');
  writeFileSync(join(source, "sessions", "conversation.jsonl"), "continued conversation");
  prepare();
  expect(readFileSync(join(target, "auth.json"), "utf8")).toBe("renewed credentials");
  expect(readFileSync(join(target, "sessions", "conversation.jsonl"), "utf8")).toBe(
    "continued conversation",
  );
  rmSync(join(source, "auth.json"));
  prepare();
  expect(readFileSync(join(target, "auth.json"), "utf8")).toBe("renewed credentials");
});

it.each([undefined, '{"OPENAI_API_KEY":"proxy-managed"}', "invalid json"])(
  "does not import missing, proxy, or malformed credentials: %s",
  (auth) => {
    const { source, target, prepare } = fixture();
    if (auth !== undefined) writeFileSync(join(source, "auth.json"), auth);
    prepare();
    expect(existsSync(join(target, "auth.json"))).toBe(false);
    writeFileSync(join(target, "sessions", "new.jsonl"), "new session");
    expect(readFileSync(join(source, "sessions", "new.jsonl"), "utf8")).toBe("new session");
  },
);
