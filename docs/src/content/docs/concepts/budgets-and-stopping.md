---
title: Budgets and stopping
description: The limits that bound a swarm and the ways one ends, including a lead that never concludes.
sidebar:
  order: 4
---

Free-form agent conversation burns budget without converging. A room has a
driver to stop it. A bus has nothing, so the swarm carries its own limits and
its own stopping rule.

## The limits

| Limit | Default | Set at start |
|---|---|---|
| Agents, lead included | 5 | `max_agents` |
| Turns across the swarm | 40 | `max_turns` |
| Turns per worker | 12 | no |
| Turns running at once | 3 | no |
| Wall clock | 30 minutes | no |
| One turn | 5 minutes | no |
| Idle nudges to the lead | 2 | no |

Every agent sees the swarm budget, and a worker sees its own, at the foot of
each turn's inbox.

The lead is exempt from the per-worker cap. It integrates everyone's results,
and capping it would leave the swarm with no one able to conclude. Only the
swarm-wide budget bounds it.

A worker that spends its turns is announced in the channel and stops
responding. Messages addressed to it afterwards are dropped.

## How a swarm ends

The intended ending is the lead calling `chat_done` with the final answer. After
that, no new turn starts. Turns already in flight finish, and the swarm ends as
`done`.

The other endings are the guardrails firing:

| Status | Cause |
|---|---|
| `done` | The lead concluded. |
| `stalled` | The swarm went idle and the lead did not conclude after two nudges. |
| `exhausted` | The turn budget or the wall clock ran out. |
| `stopped` | An operator stopped it, or Keelson shut down. |
| `error` | It failed to start, or ClickClack revoked the owner session. |

## Idle is not done

A swarm is **quiescent** when no turn is running, no event is being processed,
and every inbox is empty. If the lead has not concluded by then, something was
dropped: a worker reported to the board without addressing anyone, or the lead
ended a turn waiting on a reply that is not coming.

The swarm nudges the lead: it runs a lead turn with a note saying the swarm is
idle and asking it to delegate, do the work, or conclude. After two nudges
without a conclusion it ends as `stalled`. The transcript still holds whatever
was found.

## A stop can beat a conclusion

There is a short window between `chat_done` and the swarm settling. A stop, a
cancel, or the wall clock landing in that window wins: the status is not `done`,
and `conclusion` still holds what the lead recorded. Read both fields.

## Related

- [Limits and statuses](../../reference/limits-and-statuses/): the same facts as
  a lookup table.
- [Guardrails](../../design/guardrails/): why each limit exists.
- [Steer and stop a swarm](../../guides/steer-and-stop/): ending one yourself.
