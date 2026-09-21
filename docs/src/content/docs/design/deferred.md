---
title: Deferred
description: What the Chat rib does not do yet, and what each item is waiting on.
sidebar:
  order: 4
---

## Governed workflow dispatch

A lead cannot hand work to Keelson's implementation workflows. It cannot start
`fix-issue`, keep the run id, or see an approval pause, so an outer orchestrator
starts every implementation run and carries findings between stages.

This is waiting on the harness. A rib has no seam that starts a catalog workflow
and returns its run id: the cross-rib tool call reaches only rib-owned tools,
and the workflow seams take a definition or return nothing. The request is
[keelson#904](https://github.com/danielscholl/keelson/issues/904), and the rib
side is tracked in
[#6](https://github.com/danielscholl/keelson-rib-chat/issues/6). When it lands,
dispatch will be opt-in, will never answer an approval on the operator's behalf,
and will not count a child's "done" as verified without PR and check evidence.

## Write access

Agents get `Read`, `Grep`, and `Glob` confined to a project at most. Mutating
work would need a leased worktree per agent, with isolation verified before any
write is authorized. Granting edit and shell tools to the existing agents would
solve none of ownership, isolation, or approvals.

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
