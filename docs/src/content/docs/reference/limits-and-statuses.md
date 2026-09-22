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
| Turns per worker | 12 | `max_turns_per_agent`, 1 to 100 | The next message addressed to the worker caps it: announced in the channel, inbox cleared, later messages dropped. The lead is exempt. |
| Turns running at once | 3 | no | Further turns wait. |
| Wall clock | 30 minutes | `max_minutes`, 1 to 240 | The swarm ends as `exhausted`. |
| One turn | 5 minutes | `turn_timeout_s`, 30 to 1,800 seconds | The turn is aborted and counts as failed. |
| Failed turns in a row | 3 | no | A worker is retired as `failed`, announced in the channel. For the lead, the swarm ends as `error`. |
| Idle nudges to the lead | 2 | no | The swarm ends as `stalled`. |

A failed turn is one that timed out or errored. Its messages go back to the
front of the agent's inbox, and the agent's next turn says they are repeated.
A timed-out turn first waits up to 15 seconds for the provider to release the
agent's session, since the next turn resumes that same session.

## Sizes

| Value | Limit |
|---|---|
| `task`, message body, spawn brief | 8,000 characters each |
| Conclusion | 20,000 characters, posted to the channel in parts of at most 8,000 headed "Conclusion (1/2)", "Conclusion (2/2)" |
| Context items | 20 |
| One context body | 60,000 characters |
| All context bodies | 300,000 characters |
| One `chat_context` page | 20,000 characters |
| `chat_read` | 20 messages by default, 50 at most |
| `chat_swarm_wait` | 120 seconds by default, 600 at most |
| One `chat_swarm_transcript` page | 40,000 characters |

A value over its limit is refused with its actual length and how many
characters to cut. A refused conclusion is kept: a swarm that ends without a
conclusion carries the last one as `draftConclusion`.

## Swarm statuses

| Status | Meaning | `conclusion` | `error` |
|---|---|---|---|
| `running` | In flight. | set once the lead has called `chat_done` | unset |
| `done` | The lead concluded and the swarm settled. | the answer | unset |
| `stalled` | Idle, and the lead did not conclude after two nudges. | unset | the reason, naming the cause |
| `exhausted` | The turn budget or the wall clock ran out. | see below | the reason |
| `stopped` | `chat_swarm_stop`, `run_cancel`, or a Keelson shutdown. | see below | the reason |
| `error` | Failed to start, ClickClack revoked the owner session, or the lead's last three turns failed. | unset | the reason |

A stop or a limit that lands between `chat_done` and the swarm settling wins the
status, and `conclusion` still holds what the lead recorded. Read both fields.

A `stalled` reason names the cause it can see: ClickClack unreachable, a
conclusion refused as too long, the lead's last turn failing, or plain silence.
A conclusion is recorded before it is posted, so a failed post doesn't lose it.

The durable run completes, with the summary as its result, only when the swarm
concluded or was stopped. A swarm that ends `stalled`, `exhausted` with no
conclusion, or `error` fails the run with its status and reason, and the summary
is the run's last progress frame. `run_cancel` is the exception: the harness
settles the run as `cancelled` before the swarm finishes stopping, so that run
carries no summary. Read `chat_swarm_status` for it.

## Agent statuses

| Status | Meaning |
|---|---|
| `idle` | Waiting for a message addressed to it. |
| `busy` | Running a turn. |
| `capped` | A worker that was addressed again after spending its turns. It will not run again. |
| `failed` | A worker retired after three failed turns in a row. It will not run again. |

## Related

- [Budgets and stopping](../../concepts/budgets-and-stopping/): why each limit
  exists and how nudging works.
- [Tools and commands](../tools-and-commands/): where these fields are returned.
