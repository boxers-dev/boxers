/** Docker's Codex kit owns ~/.codex/config.toml and auth.json. */
export const CODEX_TASK_HOME = "/home/agent/.boxers/codex";
export const CODEX_TASK_HOME_ENV = `CODEX_HOME=${CODEX_TASK_HOME}`;
export const CODEX_CHATGPT_CONFIG_ARGS = [
  "-c",
  'forced_login_method="chatgpt"',
  "-c",
  'model_provider="openai"',
  "-c",
  'cli_auth_credentials_store="file"',
] as const;

/** Runs inside the Sandbox only. Never copies credentials or history to the host. */
export const PREPARE_CODEX_HOME = `
const fs = require('node:fs');
const path = require('node:path');
const [source, target] = process.argv.slice(1);
fs.mkdirSync(target, { recursive: true, mode: 0o700 });
fs.chmodSync(target, 0o700);
// Share history in place, including SQLite sidecars, instead of copying a live
// database or moving files out from under an already-running agent.
for (const name of ['sessions', 'archived_sessions']) {
  fs.mkdirSync(path.join(source, name), { recursive: true });
}
for (const name of fs.readdirSync(source)) {
  if (name === 'auth.json') continue;
  try {
    fs.symlinkSync(path.join(source, name), path.join(target, name));
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}
const destination = path.join(target, 'auth.json');
if (!fs.existsSync(destination)) {
  let auth;
  try {
    auth = JSON.parse(fs.readFileSync(path.join(source, 'auth.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  // Do not import Docker's proxy placeholder or externally managed tokens.
  if (typeof auth?.tokens?.refresh_token === 'string' && auth.tokens.refresh_token) {
    try {
      fs.writeFileSync(destination, JSON.stringify(auth), { flag: 'wx', mode: 0o600 });
      process.stdout.write('imported\\n');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}
`;

/** Auxiliary Codex invocations must use the same auth as the interactive agent.
 * Resolve this inside the task, since merge/repair can run in a fresh host process.
 */
export function codexTaskExecArguments(args: readonly string[]): string[] {
  return [
    "sh",
    "-c",
    `if test -f "$1/auth.json"; then
  export CODEX_HOME="$1"
  unset OPENAI_API_KEY
  shift
  exec codex -c 'forced_login_method="chatgpt"' -c 'model_provider="openai"' -c 'cli_auth_credentials_store="file"' "$@"
fi
shift
exec codex "$@"`,
    "boxers-codex",
    CODEX_TASK_HOME,
    ...args,
  ];
}
