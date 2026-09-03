import assert from "node:assert/strict";
import { access, chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  authDetails,
  currentCredential,
  decodeJwtPayload,
  forceManagedRefresh,
  tokenExpirySeconds,
  withRefreshLock,
} from "./codex-current-access-token.mjs";

function jwt(payload) {
  return [
    Buffer.from("{}").toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "sig",
  ].join(".");
}

test("parses access-token expiry without exposing the token", () => {
  const token = jwt({ exp: 2_000_000_000 });
  assert.equal(decodeJwtPayload(token).exp, 2_000_000_000);
  assert.equal(tokenExpirySeconds(token), 2_000_000_000);
});

test("extracts account ID from the stored token record", () => {
  assert.deepEqual(
    authDetails({ tokens: { access_token: jwt({ exp: 2_000_000_000 }), account_id: "account-1" } }),
    { accessToken: jwt({ exp: 2_000_000_000 }), accountId: "account-1" },
  );
});

test("returns a sufficiently fresh file-store credential without invoking Codex", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-token-helper-"));
  const authPath = join(dir, "auth.json");
  const accessToken = jwt({ exp: 2_000_000_000 });
  await writeFile(
    authPath,
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: accessToken, account_id: "account-2" },
    }),
  );
  await chmod(authPath, 0o600);
  assert.deepEqual(await currentCredential({ authPath, nowSeconds: 1_999_990_000 }), {
    accessToken,
    accountId: "account-2",
  });
});

test("rejects a stale token record left behind by API-key auth", () => {
  assert.throws(
    () =>
      authDetails({
        auth_mode: "apikey",
        tokens: { access_token: jwt({ exp: 2_000_000_000 }), account_id: "account-3" },
      }),
    /not using managed ChatGPT authentication/,
  );
});

test("asks Codex app-server to perform the managed refresh", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-app-server-"));
  const fakeCodex = join(dir, "codex");
  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node
let input = "";
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  const messages = input.trim().split("\\n").map(JSON.parse);
  const refresh = messages.find((message) => message.id === 1);
  if (process.argv[2] !== "app-server" || refresh?.method !== "account/read" || refresh?.params?.refreshToken !== true)
    process.exit(2);
  process.stdout.write(JSON.stringify({ id: 1, result: { account: { type: "chatgpt" } } }) + "\\n");
});
`,
  );
  await chmod(fakeCodex, 0o700);
  await forceManagedRefresh(fakeCodex);
});

test("serializes concurrent local refresh operations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-refresh-lock-"));
  const authPath = join(dir, "auth.json");
  let active = 0;
  let maximumActive = 0;
  const operation = () =>
    withRefreshLock(authPath, async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
    });

  await Promise.all([operation(), operation(), operation()]);
  assert.equal(maximumActive, 1);
  await assert.rejects(access(`${authPath}.refresh.lock`), { code: "ENOENT" });
});
