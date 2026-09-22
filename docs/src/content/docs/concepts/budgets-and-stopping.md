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
| Turns per worker | 12 | `max_turns_per_agent` |
| Turns running at once | 3 | no |
| Wall clock | 30 minutes | `max_minutes` |
| One turn | 5 minutes | `turn_timeout_s` |
| Failed turns in a row | 3 | no |
| Idle nudges to the lead | 2 | no |

These are the `medium` size. A swarm can start `small` or `large` instead, and
the `max_*` inputs still set single limits on top of the size. See
[Limits and statuses](../../reference/limits-and-statuses/).

An agent sees the swarm budget, and a worker its own, at the foot of the
messages each turn delivers.

The lead is exempt from the per-worker cap. It integrates everyone's results,
and capping it would leave the swarm with no one able to conclude. Only the
swarm-wide budget bounds it.

A worker that has spent its turns is capped the next time a message addresses
it: the cap is announced in the channel, and that message and any later ones
are dropped.

## A failed turn is repeated, then retired

A turn that times out or errors may never have shown the agent its messages.
They go back to the front of its inbox, and its next turn says they are
repeated. After three failed turns in a row a worker is retired as `failed`,
and the channel is told. The same run of failures in the lead ends the swarm as
`error`, rather than spending a turn timeout on every wake. A timed-out turn
first waits up to 15 seconds for the provider to release the agent's session,
since the next turn resumes that same session.

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
| `error` | It failed to start, ClickClack revoked the owner session, or the lead's turns kept failing. |

The Keelson run completes only when the swarm concluded or was stopped. Every
other ending fails the run with the status and reason.

## Idle is not done

A swarm is **quiescent** when no turn is running, no event is being processed,
and every inbox is empty. If the lead has not concluded by then, something was
dropped: a worker reported to the board without addressing anyone, or the lead
ended a turn waiting on a reply that is not coming.

The swarm nudges the lead: it runs a lead turn with a note saying the swarm is
idle and asking it to delegate, do the work, or conclude. After two nudges
without a conclusion it ends as `stalled`. The transcript still holds whatever
was found.

The `stalled` reason names the cause it can see. If ClickClack was unreachable
when an agent last tried it, the reason says so. If the lead's conclusion was
refused for running over 20,000 characters, the reason says so, and the summary
keeps the last draft as `draftConclusion`. If the lead's last turn failed, the
reason carries that failure. Otherwise it is plain silence.

A conclusion is recorded before it is posted. If ClickClack cannot take the
post, the swarm still ends `done` with the conclusion in its summary and run,
and the lead is told the post failed.

## A stop can beat a conclusion

There is a short window between `chat_done` and the swarm settling. A stop, a
cancel, or the wall clock landing in that window wins: the status is not `done`,
and `conclusion` still holds what the lead recorded. Read both fields.

## Related

- [Limits and statuses](../../reference/limits-and-statuses/): the same facts as
  a lookup table.
- [Guardrails](../../design/guardrails/): why each limit exists.
- [Steer and stop a swarm](../../guides/steer-and-stop/): ending one yourself.
