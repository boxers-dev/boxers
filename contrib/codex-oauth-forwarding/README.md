# Codex OAuth access-token forwarding PoC

Status: **source-validated prototype, live Sandbox model call still required**.
The development runner has Docker but no `/dev/kvm` and did not have `sbx`
installed, so it cannot run the final VM-backed probe. The v0.39.0 release
binary was downloaded to a temporary directory and its CLI flags were checked.

This experiment deliberately does not copy `auth.json`, an OAuth refresh token,
or any other durable Codex credential to the remote host.

## Finding

The exact three-line hypothesis does not work with an otherwise unmodified
Codex sandbox:

```text
OAuth access token -> sbx openai --command -> unmodified Codex
```

`--command` is an `apiKey` secret source. The built-in Codex kit therefore
supplies an `OPENAI_API_KEY` sentinel, and ordinary API-key mode selects
`https://api.openai.com/v1`. A ChatGPT OAuth access token is not an OpenAI
Platform API key, so sending it there is the wrong authentication mode and
endpoint.

The proxy half is capable of the desired forwarding. Docker's built-in
`openai` service covers `api.openai.com`, `openai.com`, `chatgpt.com`, and
`www.chatgpt.com`. Its bearer injection is opaque: the kit's `bearer` scheme
expands to `Authorization: Bearer %s`; Docker does not need to parse the value as
an API key or OAuth token.

Current Codex also has the missing client-side concept:
`chatgptAuthTokens`, intended for a host application that owns token refresh.
It selects `https://chatgpt.com/backend-api/codex`, sends the access token as a
Bearer token, sends `ChatGPT-Account-ID`, and does not require a refresh token.
The PoC writes a minimal auth scaffold containing only:

- `auth_mode: "chatgptAuthTokens"`;
- Docker's sandbox-visible OpenAI placeholder as `access_token`;
- the non-secret ChatGPT account/workspace ID;
- an empty refresh token and a synthetic metadata-only ID token.

The real access token still stays in the remote host's Docker credential proxy.
The scaffold is a compatibility shim, not a durable credential. OpenAI's
documented external-token contract is the app-server protocol, where a host app
supplies tokens in memory and answers refresh requests after a 401; direct
construction of this file representation is not a supported public interface.

## Current implementation evidence

Checked on 2026-09-02:

- [Docker credential documentation](https://docs.docker.com/ai/sandboxes/configuration/credentials/): host-side dynamic command resolution, 55-minute default cache, `on-demand`, placeholder behavior, and the built-in service domain table.
- [Docker Codex agent documentation](https://docs.docker.com/ai/sandboxes/agents/codex/): `sbx run codex` host preflight plus the supported Docker-managed `--oauth` and API-key modes.
- [Docker kit reference](https://docs.docker.com/ai/sandboxes/customize/kit-reference/#credentials): `scheme: bearer` is `Authorization: Bearer %s`; OAuth and API-key mechanisms are separate.
- [`sbx secret set` CLI reference](https://docs.docker.com/reference/cli/sbx/secret/set/): the v0.39.0 binary confirms `--command`, `--refresh`, `--sandbox`, and mutually separate `--oauth` behavior.
- [Docker issue #223](https://github.com/docker/sbx-releases/issues/223): the original fixed-TTL command-backed secret request. Fixed-interval dynamic secrets have since shipped.
- [Docker issue #300](https://github.com/docker/sbx-releases/issues/300): the expiry-aware JSON credential-provider proposal remains open. The proposed `{status:{token,expiresAt}}` protocol has not shipped.
- [OpenAI Codex authentication](https://developers.openai.com/codex/auth/): supported sign-in modes, file/keyring storage, and automatic managed-token refresh.
- [OpenAI Codex app-server](https://developers.openai.com/codex/app-server/): `account/read` with `refreshToken: true`, and the experimental externally managed `chatgptAuthTokens` mode.

The Codex source inspection used OpenAI commit
`501931b3995983c1eb888933bd79adfd18fccc1e` (2026-09-02), especially:

- `codex-rs/login/src/auth/manager.rs` and `token_data.rs`;
- `codex-rs/model-provider-info/src/lib.rs`;
- `codex-rs/model-provider/src/auth.rs` and `bearer_auth_provider.rs`;
- `codex-rs/protocol/src/auth.rs`.

Those files establish that API-key auth selects `api.openai.com`, ChatGPT auth
selects `chatgpt.com/backend-api/codex`, model requests attach both Bearer and
account headers, and an externally managed token does not need a refresh token.
The access token is treated as a JWT for expiry and metadata in managed flows;
the PoC avoids asking Codex to parse Docker's placeholder by putting a valid,
non-secret synthetic JWT in the `id_token` field.

`CODEX_ACCESS_TOKEN` is not a general ChatGPT OAuth-token override in current
Codex. `codex login --with-access-token` classifies `at-...` values as Codex
personal access tokens and other values as Agent Identity JWTs. `OPENAI_API_KEY`
selects Platform API-key behavior. Neither variable alone expresses externally
managed ChatGPT subscription auth.

## One-time laptop setup

The helper must read the local Codex file store, because Codex currently has no
CLI command that exports its current ChatGPT OAuth access token. Configure:

```toml
# ~/.codex/config.toml
cli_auth_credentials_store = "file"
```

Then sign in normally and install the helper somewhere owned by you:

```bash
install -m 0755 codex-current-access-token.mjs ~/.local/bin/codex-current-access-token
codex-current-access-token --account-id
```

The second command prints only the account ID. With no option, stdout contains
only the access token. Errors go to stderr and never include a credential. The
helper requires `auth.json` to be a non-symlink regular file with mode `0600`.

If the token has less than 50 minutes left, the helper uses Codex's documented
app-server `account/read {refreshToken:true}` operation. Codex itself refreshes
and atomically updates its local store; the helper never implements the OAuth
refresh grant and never emits the refresh token. It then rereads only the
access token. A local lock serializes refreshes from concurrent sandbox requests;
the lock contains only an owner marker and is removed afterward. This is more
stable than reproducing Codex's token endpoint and client details, but reading
the `auth.json` schema is still an unsupported integration point and must be
retested when Codex changes its credential schema. OS-keyring storage is not
supported by this PoC.

## Restricted SSH capability

Create a dedicated key on the remote host. Do not reuse an administrator or Git
key:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/codex-token -N '' -C codex-token-only
```

Append its public key to the laptop user's `~/.ssh/authorized_keys`, replacing
the paths and optionally adding a stable remote source-IP restriction:

```text
from="REMOTE_PUBLIC_IP",restrict,command="/home/me/.local/bin/codex-current-access-token" ssh-ed25519 AAAA... codex-token-only
```

`restrict` disables PTY allocation plus agent, X11, port, and socket forwarding.
The forced command ignores the command requested by the remote. Keep the
dedicated private key on the remote at mode `0600`.

On the remote, create a pinned SSH host alias:

```sshconfig
Host codex-token-source
  HostName laptop.example.net
  User me
  IdentityFile ~/.ssh/codex-token
  IdentitiesOnly yes
  StrictHostKeyChecking yes
  UserKnownHostsFile ~/.ssh/known_hosts
  RequestTTY no
  ClearAllForwardings yes
```

Verify that it prints one JWT-shaped line, but do not record the output:

```bash
ssh -T codex-token-source >/dev/null
```

## Remote setup and launch

Install `codex-sbx-remote` on the remote host and the `codex-sbx` wrapper beside
the laptop helper. Then:

```bash
codex-sbx my-remote-host /absolute/remote/project
```

The wrapper sends only the account ID to the remote. The remote launcher:

1. verifies `sbx`, Node, the project, and identifiers;
2. creates a named Codex sandbox if needed;
3. registers a sandbox-scoped dynamic OpenAI credential with a 45-minute cache;
4. writes the placeholder-only `chatgptAuthTokens` scaffold;
5. attaches with `sbx run codex --name ...`.

The exact credential registration is:

```bash
sbx secret set openai --sandbox "$name" \
  --command 'ssh -T -o BatchMode=yes -o ClearAllForwardings=yes codex-token-source' \
  --refresh 45m
```

Using sandbox scope avoids replacing an unrelated global OpenAI credential and
takes effect on an already-created sandbox immediately.

## Live probe and diagnostics

Run these checks on a v0.39.0-capable host with KVM. Never add `-D`, shell
tracing, or `--show-error` while a real token may be resolved.

1. `sbx secret set` must complete. Failure here means SSH, forced-command,
   helper, or Docker source verification failed.
2. The scaffold step must find `OPENAI_API_KEY`; otherwise the kit did not expose
   the proxy sentinel for the scoped secret.
3. `sbx exec NAME codex login status` should report ChatGPT login. If it reports
   API-key login, the scaffold was not loaded.
4. In Codex, make one minimal prompt such as `Reply with exactly OK.` A request
   to `api.openai.com` means Codex selected API-key mode. A request to
   `chatgpt.com/backend-api/codex` with 401 means the OAuth bearer was rejected
   or expired. A 401/403 mentioning account/workspace indicates the account ID
   or `ChatGPT-Account-ID` is wrong/missing.
5. Inspect only status codes, destinations, and Docker policy logs. Do not enable
   HTTP header/body logging.

This runner could validate steps 1-5 only through source, docs, v0.39.0 CLI
help, and synthetic helper tests. The final model request is intentionally not
reported as successful until it is run on a real Sandbox host.

## Lifetime and disconnect behavior

Codex access tokens carry a JWT `exp`; observed and Docker-issue guidance is
roughly one hour, but that is not a contractual lifetime. The helper uses the
actual `exp`. Docker `--command` accepts only a fixed duration or `on-demand`;
it does not accept the proposed expiry-aware JSON response. A 45-minute cache
paired with the helper's 50-minute minimum ensures each successful resolution
hands Docker a token intended to outlive its cache.

If the laptop disconnects, Docker can keep using the already cached access
token. At the next cache miss it cannot run SSH. Current public documentation
does not specify whether a failed refresh retains an old cache entry, so the
safe operational assumption is that credential injection fails. In either
case, once the cached token's JWT expiry passes, ChatGPT returns 401 and Codex
cannot refresh it: the sandbox scaffold has an empty refresh token. This is the
desired fail-closed behavior.

## Security boundaries

| Material/capability                    | Laptop  | Remote host                                              | Sandbox                          |
| -------------------------------------- | ------- | -------------------------------------------------------- | -------------------------------- |
| OAuth refresh token / full `auth.json` | Yes     | Never                                                    | Never                            |
| Short-lived OAuth access token         | Yes     | Temporarily in SSH receiver and Docker proxy/cache       | Never in normal operation        |
| Docker proxy placeholder               | No need | Docker manages it                                        | Yes, env plus minimal scaffold   |
| ChatGPT account/workspace ID           | Yes     | Yes                                                      | Yes                              |
| Ability to consume Codex entitlement   | Yes     | Yes while forced SSH capability works or token is cached | Yes through allowed proxy routes |

The remote host can invoke the forced command repeatedly and can use the token
outside Docker while it is valid; SSH restriction cannot prevent that. It does
prevent arbitrary laptop shell access and disclosure of the refresh token. A
malicious sandbox cannot read the real bearer, but while authorized it can ask
the Docker proxy to make arbitrary requests to the built-in OpenAI service
domains. Network policy and sandbox scope remain important.

Basic model inference should need only the valid access token plus correct
account ID. Features relying on email, plan metadata, ChatGPT user ID, managed
Agent Identity registration, connectors/apps, cloud tasks, or their own OAuth
flows may be unavailable or behave differently because the scaffold
intentionally omits that state. This PoC is scoped to core Codex model traffic.
