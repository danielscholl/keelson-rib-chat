---
title: Durability
description: What the Chat rib keeps in ClickClack, in the Keelson op registry, and in memory, and what a restart does to a swarm in flight.
sidebar:
  order: 6
---

The rib keeps no swarm state on disk. State lives in three places, and a
[managed server](../configuration/#managed-server) adds a fourth.

| State | Lives in | Survives a Keelson restart |
|---|---|---|
| The channel and its full transcript | ClickClack | yes |
| Bot identities | ClickClack | yes |
| The run's terminal record | Keelson op registry | yes |
| Agents, inboxes, thread membership, turn counts | memory | no |
| Agent provider session ids | memory | no |
| Bot tokens | memory | no |
| Task context bodies | memory | no |
| Summaries of ended swarms (last 20) | memory | no |
| A managed server's database, log, and process record | the rib's data directory | yes |

## A restart ends a swarm in flight

A swarm does not resume. On a clean shutdown the rib stops every running swarm,
which revokes its bot tokens and ends it as `stopped`. On a crash, the tokens
are left unrevoked in ClickClack. They are held nowhere else, so nothing can use
them, and you can revoke them from ClickClack.

After a restart, `chat_swarm_status` no longer knows the swarm. Use `run_status`
with the run id for the terminal record, and the ClickClack channel for the
transcript.

## A dropped socket does not

The rib follows the channel over a WebSocket with a durable cursor. When the
socket drops, it reconnects after two seconds and ClickClack replays from the
cursor, so no message is lost. If ClickClack closes the socket because the owner
session was revoked, the swarm ends as `error`.

## When a swarm ends

The rib posts a closing line in the channel and revokes each agent's token. The
bots stay, so the transcript keeps its authors. Task context bodies are
released with the swarm; the item list, without bodies, stays in the summary.

## Related

- [Deferred](../../design/deferred/): surviving a restart is on the list.
- [Configuration](../configuration/): the owner session the tokens are minted
  with.

## A managed server

When the rib runs its own ClickClack, everything it writes is under
`<keelson home>/rib-chat/clickclack/`:

| Path | Holds |
|---|---|
| `data/` | ClickClack's database and uploads. The only thing `chat_server_reset` deletes. |
| `server.log`, `server.log.old` | The server's output, rotated once per start. |
| `state.json` | The pid and URL of the running server, and whether a person started it. |

On a clean shutdown the rib stops its swarms first, so they can revoke their
tokens, then stops the server, unless a person
[started it by hand](../configuration/#starting-it-by-hand). If Keelson is killed, or reloads in `bun dev`,
the server keeps running. The next start reads `state.json` and adopts the
process, but only when that pid is alive and its command line carries this
`data/` path. A pid alone proves nothing, since the OS reuses them. A record
that fails the check is dropped and its pid is never signalled.
