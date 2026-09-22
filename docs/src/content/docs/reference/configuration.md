---
title: Configuration
description: The ClickClack variables the Chat rib reads, the credential fallback, and the server it runs when none are set.
sidebar:
  order: 5
---

The rib reads its configuration from the environment of the Keelson server
process, each time a swarm starts. It has no config file.

| Variable | Default | Meaning |
|---|---|---|
| `CLICKCLACK_URL` | `http://localhost:8080` | The ClickClack server. |
| `CLICKCLACK_TOKEN` | keychain `rib_chat_token` | The owner session used to create and revoke the agents' bots. |
| `CLICKCLACK_WORKSPACE` | the only visible workspace | The workspace swarms run in. Required when the session sees several. |

With `CLICKCLACK_URL` unset and no owner session in `CLICKCLACK_TOKEN` or the
keychain, the rib runs [a server of its own](#managed-server). Setting either
one makes the server external, and the rib then only connects to it.

## Reachability

Before it starts a swarm, and whenever it reports auth status, the rib asks the
server's unauthenticated `/readyz` and waits up to five seconds. A refused
connection, a timeout, or a store that is unavailable all fail as
`ClickClack is not reachable at <url>`, followed by the reason in parentheses,
such as `/readyz -> 503`. The check runs before the swarm's run is registered,
so a server that is down leaves no swarm run behind.

## The owner session

The token must be a **human** session. A bot token cannot create bots, and the
rib's auth status says so when it sees one. Mint it with the ClickClack CLI:

```bash
TOKEN=$(clickclack admin magic-link create --email you@example.com)
clickclack login --magic-token "$TOKEN" --plain --no-store
```

When `CLICKCLACK_TOKEN` is unset, the rib asks the harness credential accessor
for `token`, which resolves to the OS keychain entry `rib_chat_token`.

Agents never see this token. Each agent posts with its own bot token, which the
rib holds in memory and revokes when the swarm ends.

## Managed server

| Variable | Default | Meaning |
|---|---|---|
| `CLICKCLACK_BIN` | `clickclack` on `PATH` | The binary the rib runs. |
| `CLICKCLACK_PORT` | `18080` | The loopback port it listens on. |

The rib starts `clickclack serve --addr 127.0.0.1:<port> --data <rib data dir>/clickclack/data --dev-bootstrap=true`
with the first swarm, or on `chat_server_start`, and stops it when Keelson shuts
down. `--dev-bootstrap` creates a `Local Captain` user who owns the one
workspace, and lets a loopback client mint a session for that user. The rib
mints one per swarm, so a managed server needs no token. None of the rib's
`CLICKCLACK_` variables are passed to the server process.

### Starting it by hand

```bash
bun dev/server.ts start    # prints the URL and the web UI address
bun dev/server.ts status
bun dev/server.ts stop
```

Run from the rib's checkout, this starts the same server the rib would: same
data directory, same port, same record. A running Keelson adopts it with the
next swarm. A server started this way is yours: Keelson leaves it running at
shutdown, and it ends with `bun dev/server.ts stop`, `chat_server_stop`, or
`chat_server_reset`. Set `KEELSON_HOME` when your Keelson doesn't use the
default home, since the data directory is resolved from it.

The port is fixed because ClickClack doesn't report an ephemeral one. If
something the rib didn't start already listens there, the start fails and names
the port. Set `CLICKCLACK_PORT` to a free one.

Build the binary from a ClickClack checkout. The web UI is embedded, so this is
the whole install:

```bash
go build -o ~/bin/clickclack ./apps/api/cmd/clickclack
```

A managed server is not supported on Windows, and needs a Keelson that gives
ribs a data directory. See [Durability](../durability/#a-managed-server) for
what it writes and how a server left running is adopted.

## Workspace resolution

1. `CLICKCLACK_WORKSPACE`, when set.
2. Otherwise the session's only workspace.
3. With none, the start fails. With several, the start fails and the error lists
   each workspace id and name.

## Harness settings that matter

These belong to Keelson, not to the rib:

- `KEELSON_RIBS` selects which ribs activate. Chat's id is `chat`.
- `KEELSON_WORKFLOW_PROVIDER`, or else the first registered provider, serves
  every agent turn unless `chat_swarm_start` is given `provider`. That
  provider's default model runs unless it is given `model` or `worker_model`.
- A registered project is what `project` resolves against.

## Related

- [Install the rib](../../guides/install/): these settings in order.
- [Durability](../durability/): what happens to bot tokens on a restart.
