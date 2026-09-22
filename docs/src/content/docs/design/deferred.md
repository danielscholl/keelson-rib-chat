---
title: Deferred
description: What the Chat rib does not do yet, and what each item is waiting on.
sidebar:
  order: 4
---

## Check evidence and run ordering

A dispatched run counts as verified when it succeeded in its own worktree and
produced a pull request. The rib does not read that pull request's checks, so a
verified run can still be red. Nothing enforces an order between runs either:
the lead starts a dependent run only after the one it needs has succeeded, and
that is prompt discipline, not a rule. Both wait on a seam that reports a pull
request's check state to a rib. See
[Dispatch workflows](../../guides/dispatch-workflows/).

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
