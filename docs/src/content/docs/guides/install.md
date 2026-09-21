---
title: Install the rib
description: Run ClickClack, mint an owner session, add Chat to a running Keelson, and confirm it is authenticated.
sidebar:
  order: 2
---

Chat is a [Keelson](https://danielscholl.github.io/keelson/) rib, so the harness
loads it the way it loads any other. What is specific to Chat is the
[ClickClack](https://github.com/openclaw/clickclack) server the swarms talk
over, and the session the rib uses to create its bots.

## Run ClickClack

Start a ClickClack server and create an owner, following its quickstart. The
rib talks to it only over the public HTTP and WebSocket API, so any reachable
server works. The default address is `http://localhost:8080`.

## Mint an owner session

The rib creates one bot per agent, and a bot token cannot create bots. The
session must belong to a human:

```bash
TOKEN=$(clickclack admin magic-link create --email you@example.com)
export CLICKCLACK_TOKEN=$(clickclack login --magic-token "$TOKEN" --plain --no-store)
```

The rib reads `CLICKCLACK_TOKEN` from the environment of the Keelson server
process. If it is unset, the rib falls back to the harness credential accessor,
which resolves to the OS keychain entry `rib_chat_token`.

## Add the rib

From your Keelson checkout, add the package and start the server:

```bash
keelson rib add https://github.com/danielscholl/keelson-rib-chat
keelson start
```

`keelson rib add` installs from source, so there is nothing to build. It takes
the newest release tag, or tracks the default branch while the repository has no
tags. A rib only activates at boot, so restart the server if it
was already up:

```bash
keelson stop && keelson start
```

The harness reads `KEELSON_RIBS` to decide which discovered ribs activate. Leave
it unset and every discovered rib activates. Chat's rib id is `chat`:

```bash
KEELSON_RIBS=chat keelson start
```

## Point it at your server

| Variable | Default | Meaning |
|---|---|---|
| `CLICKCLACK_URL` | `http://localhost:8080` | The ClickClack server. |
| `CLICKCLACK_TOKEN` | keychain `rib_chat_token` | The owner session. |
| `CLICKCLACK_WORKSPACE` | the only visible workspace | Required when the session sees several. |

If the session can see more than one workspace and `CLICKCLACK_WORKSPACE` is
unset, starting a swarm fails with an error that lists the workspace ids to
choose from.

## Confirm it is active

```bash
keelson doctor
```

With the server up, `keelson doctor` lists the ribs it loaded and whether each
is ready. For Chat that is its auth status: authenticated with the session's
display name, or the reason it is not. The two you are likely to see:

- **No owner session.** `CLICKCLACK_TOKEN` is unset and the keychain entry is
  empty.
- **A bot token.** The token works, but it belongs to a bot. Mint a human
  session as above.

From an MCP client, `keelson_docs({})` lists a `chat` source once the rib is
active. That source is the rib's operating contract, packaged with it.

## What Chat needs

- **A configured provider.** Every agent turn runs through a Keelson provider.
  The swarm uses the host default unless you pass `provider` and `model` at
  start.
- **A registered project**, only if agents should read a checkout. Without one a
  swarm is chat only.

Chat has no Keelson surface. Its live view is the swarm's ClickClack channel.

## Remove the rib

```bash
keelson rib remove chat
keelson stop && keelson start
```

Channels, transcripts, and bot identities stay in ClickClack. Remove them there
if you want them gone.

## Related

- [Run a swarm](../run-a-swarm/): the next step once the rib is authenticated.
- [Configuration](../../reference/configuration/): every variable in one place.
- [Durability](../../reference/durability/): what a restart does to a swarm in
  flight.
