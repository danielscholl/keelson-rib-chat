---
title: Limits and statuses
description: Every budget that bounds a swarm, and the six statuses a swarm can report.
sidebar:
  order: 4
---

## Limits

| Limit | Default | Set at start | On reaching it |
|---|---|---|---|
| Agents, lead included | 5 | `max_agents`, 1 to 12 | `chat_spawn` fails with a message to reuse an agent. |
| Turns across the swarm | 40 | `max_turns`, 1 to 200 | The swarm ends as `exhausted`. |
| Turns per worker | 12 | no | The worker is capped: announced in the channel, inbox cleared, later messages dropped. The lead is exempt. |
| Turns running at once | 3 | no | Further turns wait. |
| Wall clock | 30 minutes | no | The swarm ends as `exhausted`. |
| One turn | 5 minutes | no | The turn is aborted. The messages it was handed are not redelivered. |
| Idle nudges to the lead | 2 | no | The swarm ends as `stalled`. |

## Sizes

| Value | Limit |
|---|---|
| `task`, message body, spawn brief, conclusion | 8,000 characters each |
| Context items | 20 |
| One context body | 60,000 characters |
| All context bodies | 300,000 characters |
| One `chat_context` page | 20,000 characters |
| `chat_read` | 20 messages by default, 50 at most |
| `chat_swarm_wait` | 120 seconds by default, 600 at most |

## Swarm statuses

| Status | Meaning | `conclusion` | `error` |
|---|---|---|---|
| `running` | In flight. | set once the lead has called `chat_done` | unset |
| `done` | The lead concluded and the swarm settled. | the answer | unset |
| `stalled` | Idle, and the lead did not conclude after two nudges. | unset | the reason |
| `exhausted` | The turn budget or the wall clock ran out. | see below | the reason |
| `stopped` | `chat_swarm_stop`, `run_cancel`, or a Keelson shutdown. | see below | the reason |
| `error` | Failed to start, or ClickClack revoked the owner session. | unset | the reason |

A stop or a limit that lands between `chat_done` and the swarm settling wins the
status, and `conclusion` still holds what the lead recorded. Read both fields.

The durable op mirrors this: a swarm that ends as `error` fails the run, and
every other ending completes it with the summary as its result.

## Agent statuses

| Status | Meaning |
|---|---|
| `idle` | Waiting for a message addressed to it. |
| `busy` | Running a turn. |
| `capped` | A worker that has spent its turns. It will not run again. |

## Related

- [Budgets and stopping](../../concepts/budgets-and-stopping/): why each limit
  exists and how nudging works.
- [Tools and commands](../tools-and-commands/): where these fields are returned.
