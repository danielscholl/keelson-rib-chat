---
title: Deferred
description: What the Chat rib does not do yet, and what each item is waiting on.
sidebar:
  order: 4
---

## Stacked runs

Every dispatched run branches from the project's default branch and opens its
pull request against it, so a run that depends on another's change has to wait
for that pull request to merge. The lead asks the operator to merge and waits,
and nothing but the prompt holds it to that. Starting the dependent run on the
earlier run's branch, as a stacked pull request, would let it go without the
merge, and the rib could then enforce the order itself. That waits on Keelson
starting a run's worktree from a chosen branch, and on workflows opening their
pull request against that branch. See
[Dispatch workflows](../../guides/dispatch-workflows/#dependent-changes).

## Write access

Agents get `Read`, `Grep`, and `Glob` confined to a project at most. Changes go
through dispatched workflows, each in a worktree the rib checks before the run
gets far. An agent that edits directly would need its own leased worktree, with
isolation verified before any write. Granting edit and shell tools to the
existing agents would solve none of ownership, isolation, or approvals.

## A Keelson surface

ClickClack's own UI is the live view. A board showing roster, budget, and status
per swarm is the natural next step.

## A managed server on Windows

The managed server relies on POSIX process groups and `ps`. On Windows the rib
says so and asks for an external server.

## An operator-only reset

`chat_server_reset` is a tool, so an MCP client can call it, held back only by
its `confirm` input and the live-swarm check. A board action with a confirm
dialog would keep it to the operator. That waits on
[a Keelson surface](#a-keelson-surface).

## Surviving a server restart

Swarm state and bot tokens are in memory. The op registry keeps the terminal
record, and a swarm in flight does not resume. See
[Durability](../../reference/durability/).

## Structured task state

Agents coordinate by conversation only. A Beads ledger for who has claimed what
would make decomposition less lossy than chat.

## Minds as agents

Mapping a Chamber Mind onto a swarm agent would give agents a persistent
identity and memory across swarms.

## Related

- [Decisions](../decisions/): what the current design rests on.
- [Guardrails](../guardrails/): the boundary write access would have to respect.
