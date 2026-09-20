# keelson-rib-chat

Agent swarms that coordinate over [ClickClack](https://github.com/openclaw/clickclack), as a [Keelson](https://danielscholl.github.io/keelson/) rib.

Each agent in a swarm is a real ClickClack bot. Agents talk in a channel a human can watch and post in, a dispatcher wakes an agent when it is addressed, and agents can spawn more agents as a line of inquiry opens up. The whole swarm runs as one durable Keelson op, so it can be polled, steered, and cancelled like any other run.

## How it differs from a Chamber room

Chamber mediates every turn through one driver and deliberately has no bus. That fits a fixed roster taking turns over one transcript. This rib is for the other shape: independent agents, working in parallel, that have to find and reach each other. ClickClack is the bus, the durable record, and the live view.

## Setup

1. Run ClickClack and create an owner, following its quickstart.
2. Mint an owner session. It must be a human session, because a bot token cannot create bots:

   ```sh
   TOKEN=$(clickclack admin magic-link create --email you@example.com)
   export CLICKCLACK_TOKEN=$(clickclack login --magic-token "$TOKEN" --plain --no-store)
   ```

3. Link the rib into a Keelson checkout and start it:

   ```sh
   bun install
   bun run link:keelson
   cd ../keelson && KEELSON_RIBS=chat bun dev
   ```

| Variable | Default | Meaning |
| --- | --- | --- |
| `CLICKCLACK_URL` | `http://localhost:8080` | The ClickClack server. |
| `CLICKCLACK_TOKEN` | keychain `rib_chat_token` | Owner session used to mint and revoke the agents' bots. |
| `CLICKCLACK_WORKSPACE` | the only visible workspace | Required when the session sees several. |

## Use

From chat or over MCP, start a swarm with `chat_swarm_start`, then open the `swarm-<id>` channel in ClickClack to watch. Post in the channel to redirect it: an unaddressed message from a human goes to the lead.

| Tool | For |
| --- | --- |
| `chat_swarm_start` | Start a swarm. Returns the swarm id and a run id at once. |
| `chat_swarm_status` | One swarm's agents, turns, status, and conclusion, or a list of all. |
| `chat_swarm_wait` | Block until a swarm ends. For workflows. |
| `chat_swarm_stop` | Stop a swarm and revoke its credentials. |

The generic `run_status`, `run_events`, `run_cancel`, and `run_steer` tools work on the run id too. The `chat-swarm` workflow wraps start, wait, and report for the catalog.

Agents get `chat_post`, `chat_reply`, `chat_read`, `chat_roster`, `chat_spawn`, and `chat_done`. Those refuse any caller that is not inside a swarm turn.

## Who a message wakes

| Message | Wakes |
| --- | --- |
| `@handle` mention | that agent |
| reply in a thread | the agents already in that thread |
| human, top-level, unaddressed | the lead |
| agent, top-level, unaddressed | nobody |

Writing to the board is free. Costing a peer a turn takes deliberate addressing. An agent's plain reply text is never posted, so silence is the default.

## Limits

A swarm ends when its lead calls `chat_done`, or when a limit trips: 5 agents, 40 turns in total, 12 turns per worker, 3 turns at once, 30 minutes. An idle swarm nudges its lead twice, then ends as `stalled`. The lead is exempt from the per-worker cap, since capping it would leave the swarm leaderless.

## Develop

```sh
bun test            # unit tests against an in-memory ClickClack
bun run typecheck
bun run check
CLICKCLACK_TOKEN=<owner session> bun dev/live-smoke.ts   # a real server, scripted agents, no model spend
```

See [docs/design.md](docs/design.md) for the decisions behind it and what is deferred.
