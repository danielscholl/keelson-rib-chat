---
title: Workflows
description: The chat-swarm workflow the rib contributes to the catalog.
sidebar:
  order: 3
---

The rib ships one workflow. It does not mutate a checkout.

## `chat-swarm`

Starts a swarm on a task, holds until it ends, and reports the outcome.

| | |
|---|---|
| Input | `ARGUMENTS`: the task text |
| Tags | `chat`, `swarm` |
| Mutates checkout | no |

| Node | Tools allowed | Does |
|---|---|---|
| `start` | `chat_swarm_start` | Starts the swarm with `ARGUMENTS` as `task`, and outputs the swarm id. |
| `wait` | `chat_swarm_wait` | Waits with `timeout_s` 600, up to four times in a row. Outputs `ENDED` or `RUNNING`. |
| `report` | `chat_swarm_status` | Reports status, conclusion, agents and their roles, and turn cost. Says so plainly when the swarm did not end as `done`. |

Each node runs in a fresh context and must make its tool call. Each pins its own
model, `balanced`, or `mai-code-1.1-flash` on the `copilot` provider. The pin
covers these three steps only, not the swarm's agents.

Four waits of 600 seconds cover 40 minutes, which is past the swarm's 30 minute
wall clock, so `wait` ends on `ENDED` unless something is wrong.

The `start` node is prompted to pass only a task: no project, limits, provider,
or task context. Its swarms are meant to be chat only with default budgets. For
anything else,
call [`chat_swarm_start`](../tools-and-commands/) directly.

## Related

- [Run a swarm](../../guides/run-a-swarm/): the workflow and the tool side by
  side.
- [Tools and commands](../tools-and-commands/): the three tools the workflow
  calls.
