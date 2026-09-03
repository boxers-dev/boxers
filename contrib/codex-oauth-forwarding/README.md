# Codex OAuth access-token forwarding PoC

Status: **revised after the first remote probe; the custom-mixin model call still
requires validation**. The development runner has Docker but no `/dev/kvm`, so
it cannot run the VM-backed probe. The v0.39.0 release binary and its embedded
Codex kit were inspected and the replacement mixin validates with that CLI.

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

The first remote probe confirmed the failure mode. Codex attempted
`wss://api.openai.com/v1/responses`, fell back to HTTPS, and OpenAI returned 401
for the literal `proxy-managed` API key. This proves Codex was still in Platform
API-key mode and that the intended ChatGPT route was not active.

Docker's built-in service table lists `chatgpt.com`, but the v0.39.0 Codex kit's
`apiKey.inject` rules cover only `api.openai.com` and `openai.com`. Its separate
OAuth branch configures the ChatGPT route. A value supplied with `--command` is
the API-key branch, so the built-in kit cannot use it as a ChatGPT bearer merely
because the value happens to be an OAuth access token.

Bearer injection itself remains opaque: a custom kit's `scheme: bearer` expands
to `Authorization: Bearer <resolved-value>` without parsing the value as an API
key or OAuth token. The revised PoC therefore declares a narrowly scoped custom
service, `codex-chatgpt`, whose only injection target is `chatgpt.com`.

Current Codex also has `chatgptAuthTokens`, but OpenAI documents it as an
app-server protocol where a live host application owns refresh. Constructing its
internal ephemeral storage file was both unsupported and ineffective with the
Docker kit lifecycle, so the revised PoC no longer does that.

Instead, Codex receives an explicit model provider with:

- `base_url = "https://chatgpt.com/backend-api/codex"`;
- `experimental_bearer_token = "proxy-managed"`;
- `requires_openai_auth = false`;
- the non-secret `ChatGPT-Account-Id` header.

The custom mixin teaches Docker to replace that sentinel only for
`chatgpt.com`. There is no sandbox `auth.json`, access token, or refresh token.

## Current implementation evidence

Checked on 2026-09-03:

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
The access token is treated as a JWT for expiry and metadata in managed flows.
The revised provider path does not ask Codex to parse Docker's placeholder as a
JWT; it uses the placeholder only as an opaque provider bearer token.

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

Install `codex-sbx-remote` and the `codex-chatgpt-token-kit` directory together
on the remote host. Install the `codex-sbx` wrapper beside the laptop helper.
Then:

```bash
codex-sbx my-remote-host /absolute/remote/project
```

The wrapper sends only the account ID to the remote. The remote launcher:

1. verifies `sbx`, Node, the project, and identifiers;
2. creates a named Codex sandbox if needed;
3. adds the Codex-specific credential mixin if it is not already installed;
4. registers a sandbox-scoped `codex-chatgpt` dynamic credential with a
   45-minute cache;
5. writes a ChatGPT backend provider containing only a sentinel and account ID;
6. removes the obsolete `auth.json` shim and attaches to Codex.

The exact credential registration is:

```bash
sbx secret set codex-chatgpt --sandbox "$name" \
  --command 'ssh -T -o BatchMode=yes -o ClearAllForwardings=yes codex-token-source' \
  --refresh 45m
```

Using a dedicated service and sandbox scope avoids replacing an unrelated
global OpenAI credential or granting the token to other sandboxes.

## Live probe and diagnostics

Run these checks on a v0.39.0-capable host with KVM. Never add `-D`, shell
tracing, or `--show-error` while a real token may be resolved.

1. `sbx kit add` and `sbx secret set` must complete. Failure here means mixin
   installation, SSH, forced-command, helper, or Docker source verification
   failed.
2. The provider step must find `CODEX_CHATGPT_ACCESS_TOKEN=proxy-managed`;
   otherwise the custom credential policy was not applied.
3. `auth.json` should be absent. `codex login status` may report no login because
   this provider deliberately uses `requires_openai_auth = false`.
4. In Codex, make one minimal prompt such as `Reply with exactly OK.` A request
   to `api.openai.com` means Codex selected API-key mode. A request to
   `chatgpt.com/backend-api/codex` with 401 means the OAuth bearer was rejected
   or expired. A 401/403 mentioning account/workspace indicates the account ID
   or `ChatGPT-Account-ID` is wrong/missing.
5. Inspect only status codes, destinations, and Docker policy logs. Do not enable
   HTTP header/body logging.

The original probe reached `api.openai.com` and failed exactly as described
above. The revised mixin and launcher are source/CLI validated, but the final
custom-provider model request is intentionally not reported as successful until
it is rerun on the remote Sandbox host.

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
case, once the cached token's JWT expiry passes, ChatGPT returns 401. Codex has
no refresh token or refresh endpoint inside the sandbox, so this is the desired
fail-closed behavior.

## Security boundaries

| Material/capability                    | Laptop  | Remote host                                              | Sandbox                          |
| -------------------------------------- | ------- | -------------------------------------------------------- | -------------------------------- |
| OAuth refresh token / full `auth.json` | Yes     | Never                                                    | Never                            |
| Short-lived OAuth access token         | Yes     | Temporarily in SSH receiver and Docker proxy/cache       | Never in normal operation        |
| Docker proxy placeholder               | No need | Docker manages it                                        | Yes, env plus provider config    |
| ChatGPT account/workspace ID           | Yes     | Yes                                                      | Yes                              |
| Ability to consume Codex entitlement   | Yes     | Yes while forced SSH capability works or token is cached | Yes through allowed proxy routes |

The remote host can invoke the forced command repeatedly and can use the token
outside Docker while it is valid; SSH restriction cannot prevent that. It does
prevent arbitrary laptop shell access and disclosure of the refresh token. A
malicious sandbox cannot read the real bearer, but while authorized it can ask
the Docker proxy to make arbitrary requests to `chatgpt.com` using the custom
credential. Network policy and sandbox scope remain important.

Basic model inference should need only the valid access token plus correct
account ID. Features relying on Codex login state, email, plan metadata, ChatGPT
user ID, managed Agent Identity registration, connectors/apps, cloud tasks, or
their own OAuth flows may be unavailable because the provider deliberately has
no local login state. This PoC is scoped to core Codex model traffic.
