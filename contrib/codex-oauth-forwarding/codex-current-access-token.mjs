#!/usr/bin/env node

import { spawn } from "node:child_process";
import { lstat, open, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_MIN_VALIDITY_SECONDS = 50 * 60;
const APP_SERVER_TIMEOUT_MS = 30_000;
const REFRESH_LOCK_TIMEOUT_MS = 65_000;
const REFRESH_LOCK_STALE_MS = 60_000;

function fail(message) {
  throw new Error(message);
}

export function decodeJwtPayload(jwt) {
  const parts = jwt.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0))
    fail("access token is not a JWT");
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    fail("access token has an invalid JWT payload");
  }
}

export function tokenExpirySeconds(token) {
  const payload = decodeJwtPayload(token);
  if (!Number.isSafeInteger(payload.exp) || payload.exp <= 0)
    fail("access token JWT has no valid exp claim");
  return payload.exp;
}

export function authDetails(auth) {
  if (auth?.auth_mode !== undefined && auth.auth_mode !== "chatgpt")
    fail("Codex is not using managed ChatGPT authentication");
  const tokens = auth?.tokens;
  if (!tokens || typeof tokens !== "object")
    fail("Codex auth store does not contain ChatGPT tokens");
  if (typeof tokens.access_token !== "string" || tokens.access_token.length === 0)
    fail("Codex auth store has no access token");
  const accountId =
    typeof tokens.account_id === "string" && tokens.account_id.length > 0
      ? tokens.account_id
      : decodeJwtPayload(typeof tokens.id_token === "string" ? tokens.id_token : "")[
          "https://api.openai.com/auth"
        ]?.chatgpt_account_id;
  if (typeof accountId !== "string" || accountId.length === 0)
    fail("Codex auth store has no ChatGPT account/workspace ID");
  return { accessToken: tokens.access_token, accountId };
}

async function readFileAuth(authPath) {
  const stat = await lstat(authPath).catch((error) => {
    if (error?.code === "ENOENT")
      fail(
        `Codex file credential store not found at ${authPath}; configure cli_auth_credentials_store = "file"`,
      );
    throw error;
  });
  if (!stat.isFile() || stat.isSymbolicLink())
    fail("Codex auth path must be a regular, non-symlink file");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
    fail("Codex auth file is accessible by group or other users; expected mode 0600");
  let parsed;
  try {
    parsed = JSON.parse(await readFile(authPath, "utf8"));
  } catch {
    fail("Codex auth file is not valid JSON");
  }
  return authDetails(parsed);
}

export async function withRefreshLock(authPath, callback) {
  const lockPath = `${authPath}.refresh.lock`;
  const owner = `${process.pid}:${Date.now()}`;
  const deadline = Date.now() + REFRESH_LOCK_TIMEOUT_MS;

  for (;;) {
    let handle;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    if (handle) {
      try {
        await handle.writeFile(`${owner}\n`);
        return await callback();
      } finally {
        await handle.close().catch(() => {});
        const contents = await readFile(lockPath, "utf8").catch(() => "");
        if (contents.trim() === owner) await unlink(lockPath).catch(() => {});
      }
    }

    const observedOwner = await readFile(lockPath, "utf8").catch(() => undefined);
    const lock = await lstat(lockPath).catch(() => undefined);
    if (lock && Date.now() - lock.mtimeMs > REFRESH_LOCK_STALE_MS) {
      const currentOwner = await readFile(lockPath, "utf8").catch(() => undefined);
      if (currentOwner === observedOwner) await unlink(lockPath).catch(() => {});
      continue;
    }
    if (Date.now() >= deadline) fail("timed out waiting for another Codex token refresh");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
}

export async function forceManagedRefresh(codexCommand = process.env.CODEX_COMMAND || "codex") {
  const childEnv = { ...process.env };
  delete childEnv.CODEX_ACCESS_TOKEN;
  delete childEnv.OPENAI_API_KEY;
  const child = spawn(codexCommand, ["app-server"], {
    env: childEnv,
    stdio: ["pipe", "pipe", "ignore"],
  });

  return await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let buffered = "";
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.killed) child.kill("SIGTERM");
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    const timer = setTimeout(
      () => finish(new Error("Codex app-server token refresh timed out")),
      APP_SERVER_TIMEOUT_MS,
    );
    child.on("error", () => finish(new Error("could not start Codex app-server")));
    child.on("close", () => {
      if (!settled) finish(new Error("Codex app-server exited before refreshing authentication"));
    });
    child.stdout.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message?.id !== 1) continue;
        if (message.error)
          finish(new Error("Codex refused to refresh managed ChatGPT authentication"));
        else finish();
      }
    });

    const messages = [
      {
        method: "initialize",
        id: 0,
        params: {
          clientInfo: {
            name: "codex_oauth_forwarding_poc",
            title: "Codex OAuth forwarding PoC",
            version: "0.1.0",
          },
        },
      },
      { method: "initialized", params: {} },
      { method: "account/read", id: 1, params: { refreshToken: true } },
    ];
    child.stdin.end(`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`);
  });
}

export async function currentCredential({
  authPath = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json"),
  minValiditySeconds = Number(
    process.env.CODEX_TOKEN_MIN_VALIDITY_SECONDS || DEFAULT_MIN_VALIDITY_SECONDS,
  ),
  nowSeconds = Math.floor(Date.now() / 1000),
} = {}) {
  if (!Number.isFinite(minValiditySeconds) || minValiditySeconds < 300)
    fail("minimum token validity must be at least 300 seconds");
  let details = await readFileAuth(authPath);
  if (tokenExpirySeconds(details.accessToken) - nowSeconds < minValiditySeconds) {
    details = await withRefreshLock(authPath, async () => {
      const latest = await readFileAuth(authPath);
      if (
        tokenExpirySeconds(latest.accessToken) - Math.floor(Date.now() / 1000) <
        minValiditySeconds
      )
        await forceManagedRefresh();
      return await readFileAuth(authPath);
    });
  }
  if (tokenExpirySeconds(details.accessToken) - Math.floor(Date.now() / 1000) < minValiditySeconds)
    fail("Codex did not provide an access token with enough remaining lifetime");
  return details;
}

async function main() {
  const [option] = process.argv.slice(2);
  if (process.argv.length > 3 || (option && option !== "--account-id"))
    fail("usage: codex-current-access-token [--account-id]");
  const details = await currentCredential();
  process.stdout.write(`${option === "--account-id" ? details.accountId : details.accessToken}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`codex-current-access-token: ${error.message}\n`);
    process.exitCode = 1;
  });
}
