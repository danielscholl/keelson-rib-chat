---
title: Guardrails
description: What a message bus does not give you for free, and the limits the Chat rib adds in its place.
sidebar:
  order: 3
---

Free-form agent chat burns budget without converging. That is why Chamber has a
turn budget, an end vote, and an anti-monopoly cap, all enforced by its driver.
A bus has no driver, so it has none of those for free. This rib adds its own.

| Guardrail | Against |
|---|---|
| Spawn cap | A lead that answers every sub-question with a new agent. |
| Swarm-wide turn budget | Unbounded spend. This is the ceiling everything else sits under. |
| Per-worker turn cap | Two workers trading messages until the budget is gone. |
| Concurrency limit | A burst of wakes becoming a burst of provider calls. |
| Wall clock | A swarm that is cheap per turn and never ends. |
| Turn timeout | One hung provider call holding a slot. |
| Stopping rule | A swarm that goes quiet without an answer. |

## The routing table is a guardrail

An unaddressed post from an agent wakes nobody. This one rule does more than any
numeric limit: it makes writing free and attention expensive, so agents can put
everything on the record without costing each other turns.

## The lead is exempt from the worker cap

The lead integrates everyone's results, and it is the only agent that can
conclude. Capping it would leave a swarm that can neither finish nor be finished
from inside. The swarm-wide budget bounds it instead.

## The stopping rule

The lead concludes, or the swarm stalls. When the swarm goes quiet with no
conclusion, the lead is nudged with a turn that says so. Two nudges without a
conclusion end the swarm as `stalled`. The nudge exists for a lead that dropped
a thread and can still finish. Two is enough for that, and a lead that cannot
finish does not get an unbounded number of tries.

## The boundary is not a prompt

An agent's tools are the list the engine grants for the turn: the seven agent
`chat_*` tools, plus `Read`, `Grep`, and `Glob` when a project is set. A lead in
a swarm started with `workflows` also gets the workflow tools, and can
start only the workflows both the swarm and Keelson's `ribWorkflowGrants` name. Nothing an
agent or an operator writes in the channel changes that list. The read tools are
confined to the project root as the turn's only allowed directory.

## A gate answer rests on another agent's review

When a run pauses at an approval gate, the lead answers it for the operator. The
lead wrote the run's brief, so its own reading of the plan would check nothing.
`chat_workflow_respond` takes the id of a review, and the rib refuses one the
lead wrote, one from outside the swarm's channel, and one written before the gate
opened. A worker or the operator has to have read the plan first. Which
workflows a swarm may answer for stays with the operator, in Keelson's
`ribApprovalGrants`.

## Related

- [Budgets and stopping](../../concepts/budgets-and-stopping/): the same limits
  from an operator's side.
- [Limits and statuses](../../reference/limits-and-statuses/): the numbers.
- [Deferred](../deferred/): write access, and why it is not a bigger tool list.
