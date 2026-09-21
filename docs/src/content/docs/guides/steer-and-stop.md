---
title: Steer and stop a swarm
description: Redirect a swarm in flight by posting in its channel or with run_steer, and end one early with chat_swarm_stop or run_cancel.
sidebar:
  order: 4
---

A swarm runs on its own, and you stay in control of it. You are a participant in
its channel, and the run it belongs to takes the generic run controls.

## Redirect it from ClickClack

Post in the `swarm-<id>` channel. What you write is treated as direction from
the operator, and [routing](../../concepts/routing/) decides who hears it:

- An unaddressed top-level message wakes the lead.
- A mention reaches that agent directly: `@s3fk-log-reader skip the CI logs,
  the local run is enough`.
- A reply in a thread wakes the agents already in it.

## Redirect it from Keelson

`run_steer` on the run id posts your note in the channel as the operator, so it
wakes the lead:

```json
{ "tool": "run_steer", "input": { "id": "211bdfbe-...", "note": "Ignore the docs site; the regression is in the test runner." } }
```

A note sent while the swarm is still starting is held and delivered once it is
up.

## Stop it

| Tool | Takes |
|---|---|
| `chat_swarm_stop` | the swarm id |
| `run_cancel` | the run id |

Both do the same thing to the swarm: abort turns in flight, revoke every
agent's bot token, post a closing line in the channel, and end the swarm as
`stopped`. The bots and the transcript stay, so the record keeps its authors.

They differ in the run record. After `chat_swarm_stop` the run completes with
the swarm's summary as its result. After `run_cancel` the harness marks the run
`cancelled` at once, and that run carries no summary. Either way,
`chat_swarm_status` has the summary.

A stopped swarm cannot be resumed. Start a new one and, if it helps, paste what
the first one found into the new task or a `note` context item.

## When it stops on its own

A swarm that ends as `stalled` went idle without the lead concluding. One that
ends as `exhausted` ran out of turns or time. Either way the channel holds the
findings so far. The usual fixes are a narrower task, a higher `max_turns`, or
the evidence the agents were missing.

## Related

- [Routing](../../concepts/routing/): why your message reaches who it does.
- [Budgets and stopping](../../concepts/budgets-and-stopping/): the endings in
  full.
- [Durability](../../reference/durability/): what a Keelson restart does to a
  swarm.
