---
title: Configuration
description: The three ClickClack variables the Chat rib reads, and the credential fallback.
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

## Reachability

Before it starts a swarm, and whenever it reports auth status, the rib asks the
server's unauthenticated `/readyz` and waits up to two seconds. A refused
connection, a timeout, or a store that is unavailable all fail the same way:
`ClickClack is not reachable at <url>`. The check runs before the run is
registered, so a server that is down leaves no run behind.

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

## Workspace resolution

1. `CLICKCLACK_WORKSPACE`, when set.
2. Otherwise the session's only workspace.
3. With none, the start fails. With several, the start fails and the error lists
   each workspace id and name.

## Harness settings that matter

These belong to Keelson, not to the rib:

- `KEELSON_RIBS` selects which ribs activate. Chat's id is `chat`.
- The default provider and model run every agent turn unless
  `chat_swarm_start` is given `provider` and `model`.
- A registered project is what `project` resolves against.

## Related

- [Install the rib](../../guides/install/): these settings in order.
- [Durability](../durability/): what happens to bot tokens on a restart.
