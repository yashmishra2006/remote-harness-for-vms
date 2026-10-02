# Security hardening: what changed and what to set

Written for the people who run a hub or a VM agent. It records behaviour that **differs from earlier releases**, so read the
"Upgrade notes" first.

## Upgrade notes (things that can break an existing setup)

| Change | Who is affected | What to do |
| --- | --- | --- |
| Hub refuses to start with a placeholder or short secret (`change-me`, < 24 chars). This now includes `HUB_ADMIN_TOKEN`. | Anyone still on example values | Generate real ones: `openssl rand -hex 32`. |
| `/ws?token=` (credential in the URL) is off by default. | Old Android/web builds | Update the app, or set `HUB_ALLOW_QUERY_TOKEN=1` temporarily. |
| New MCP servers start with `autoAllow: false`; updating a server keeps its existing headers and flags. A flag must be a real boolean (`"false"` is rejected). | Callers that relied on the old default of `true` | Send `autoAllow: true` explicitly. Escanor's backend already does. |
| Only a signed-in browser session can create API tokens; API tokens expire (default 1 year) and can be `scope: "mcp"`. | Scripts that minted tokens with a token | Mint from the app, or via the admin API for tenants. |
| MCP server names may not contain `__` or end in `_`. | Existing servers with such names | Rename them; they are skipped, not applied. |
| MCP URLs on loopback / private networks are refused; cloud-metadata addresses always. | Hubs that run next to their MCP server | Set `HUB_MCP_ALLOW_PRIVATE=1` (dev only). |
| Android app: no cleartext, no backup. | Self-hosters with an `http://` hub | Put the hub behind TLS. |
| Agent installer defaults the workspace to `$HOME/projects` (was `$HOME`) and the agent warns if the workspace is `/` or `$HOME`. | New installs | Pick a projects directory. |
| An agent that connects with the name of a VM that is currently connected is refused (it used to kick the first one off, in a loop, for cloned VMs). After an unclean crash the reconnect is accepted once the heartbeat drops the dead socket (about a minute). | Cloned VMs | Give each VM a unique `VM_NAME`. |

## Hub settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `HUB_ENCRYPTION_KEY` | `HUB_AGENT_TOKEN` | Encrypts stored MCP credentials (AES-GCM). Set it explicitly if you rotate `HUB_AGENT_TOKEN`; otherwise the saved credentials become unreadable (skipped, logged) and must be re-saved. |
| `TRUST_PROXY` | off | `1` only behind a proxy you control that sets `X-Forwarded-For`; the sign-in limiter then keys on the real client. Without it, all clients behind a proxy share one limiter bucket. |
| `HUB_LOGIN_MAX_FAILURES` | `10` | Failed sign-ins per address per 15 minutes before they are refused. (The Worker uses `CF-Connecting-IP`.) |
| `HUB_MCP_ALLOW_PRIVATE` | off | See above. |
| `HUB_ALLOW_QUERY_TOKEN` | off | See above. |
| `HUB_AGENT_PING_MS` / `HUB_AGENT_MAX_PAYLOAD_BYTES` | 30 s / 32 MiB | Heartbeat for half-open agents and the largest frame an agent may send. |

## Agent settings

| Variable | Purpose |
| --- | --- |
| `WORKSPACE_ROOT` | Required unless `HOME` is set; it never falls back to `/`. A new chat's working directory is resolved through symlinks and kept inside it. |
| `ESCANOR_FETCH_ALLOW` | Managed workers only. Comma-separated hosts (`docs.example.com`, `*.example.com`) the `WebFetch` tool may reach without a card. Empty = always ask. |

The Claude process the agent starts no longer inherits `HUB_TOKEN` / `HUB_URL`; `ANTHROPIC_API_KEY` is still passed, since it is that process's own credential.

## The managed-worker sandbox policy (`agent/src/sandboxPolicy.ts`)

In a managed worker the assistant does everyday work without a card. The container, its network policy and the git proxy remain the
security boundary; the policy decides *when a person is asked*, and since it removes the person from the loop it is built not to be
bypassed by a prompt injection:

* Shell commands are **parsed** (quoting, `;` `&&` `||` `|`, `$(...)`, backticks, redirections), not pattern-matched, and the
  command must be a known development tool; anything else asks. A plain `curl`/`wget` GET of a literal URL is fine; any body,
  form, upload, non-GET method, config file, `@file`, or shell expansion in its arguments asks (including bundled flags such as
  `-sd`, `-sXPOST`).
* Inline interpreters (`python -c`, `node -e`, `perl -e`, `bash -c`, `eval`), programs piped into a shell or interpreter, raw sockets
  (`nc`, `/dev/tcp`), and the `gh`/`aws`/`gcloud`/`az` CLIs always ask. `git push`, `send-pack`, `config`, and `-c` for anything
  that can run code ask.
* Every path is resolved **through symlinks**. Anything outside the workspace, in a credential location (`~/.ssh`, `~/.aws`,
  `~/.claude-profiles`, `.credentials.json`, ...), or in a file that executes later (shell rc files, `.git/hooks`, `.claude/`,
  `.mcp.json`, the agent's own code, data and `.env`) asks. Reading is restricted the same way.
* `WebFetch` is a network channel and needs an allow-listed host.

Residual risk, by design: scripts and test runners the assistant writes inside the workspace can still do network I/O. Keep the
container's egress policy tight; the policy is a second layer, not a replacement.

## MCP approval

* A tool is attributed to its server by parsing `mcp__<server>__<tool>` exactly; a server whose name could collide with another's
  namespace is not installed.
* Sessions load **only** the MCP servers the hub installed (`strictMcpConfig`): a repository's own `.mcp.json` cannot inherit the
  approvals meant for the real server of the same name.
* The "read-only" classifier now needs a leading read verb, refuses compound operations (`list_and_drop_tables`,
  `get_and_notify`), recognises more change verbs, and **inspects arguments**: a query tool carrying `DELETE`/`DROP`/`UPDATE` or a
  GraphQL `mutation` asks.

## Data at rest

MCP credentials are stored encrypted; transcripts and permission inputs are redacted for well-known secret formats (cloud keys, API
tokens, JWTs, bearer headers, private keys) before they are written; the data directory is `0700` and the database `0600`; SQLite
runs in WAL mode so the synchronous writes for every streamed message stay cheap (about 25x faster in a 3000-insert benchmark).
The Worker redacts transcripts too; its storage is encrypted by Cloudflare, so MCP credentials are not additionally sealed there.
Machine-readable limits: bodies are capped at 16 KB before authentication (20 MB after), browser sockets at 16 KB, agent frames at
32 MiB.

## Known gaps

* The Worker hub is single-tenant: it has no tenant admin API or machine credentials (the Node hub does).
* On the Worker, a second connection with the name of a live VM replaces the first (there is no heartbeat to tell a dead socket from
  a live one in a hibernating Durable Object).
* `NoNewPrivileges` is not set in the agent's systemd unit because agent-run commands may legitimately need `sudo`.
* Plaintext transcripts remain in the database (redacted for known secret formats only). Retention is an operator decision.
