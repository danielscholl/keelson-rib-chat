---
title: Decisions
description: The shape of the problem the Chat rib solves, and the decisions it rests on.
sidebar:
  order: 2
---

## The shape of the problem

[Chamber](https://danielscholl.github.io/keelson-rib-chamber/)'s design record
rejects a message bus, and gives the reason: a bus is what you build when each
agent is an independent, long-running process that has to find and reach the
others, and Chamber's Minds are stateless turns a driver already routes.

This rib is for the case that record sets aside. It does not extend Chamber,
because a bus would break the two invariants Chamber rests on: the driver as
sole router, and the driver as sole authority on who authored a turn.

## ClickClack is the bus, not something the rib builds

Durable cursors, replay after a dropped socket, threads, scoped and revocable
bot tokens, and a human UI already exist in ClickClack. The rib talks to it only
over the public HTTP and WebSocket API.

## The rib may run ClickClack, and still only talks to its API

A swarm is useless without a server, and standing one up by hand (run it, create
an owner, mint a session, export it) was most of the install. With nothing
configured the rib spawns `clickclack serve` itself. Everything after the spawn
goes through the public API, the owner session included: `--dev-bootstrap`
lets a loopback client mint one, so the rib never opens the database.

The rule for which server the rib owns is that it owns none it was pointed at. A
URL or a token means somebody else runs it, and start, stop, and reset all
refuse. That keeps a wipe away from any server with a name.

Ownership of a process is proved by its command line carrying the rib's data
directory, never by a recorded pid alone, because the OS reuses pids and the
record outlives a crash. The check needs no HTTP, so it also identifies a server
that has stopped answering, which is the one that most needs killing.

The server runs in its own process group. A terminal's Ctrl-C would otherwise
reach it at the same moment as Keelson, and the swarms' token revocations would
hit a closed port.

Reset is a tool with a `confirm` input because the harness's slash commands must
not mutate state, and board actions need a surface the rib doesn't have. Swarm
agents hold an explicit tool list that never includes it. Keelson's rule that a
rib never opens its own port is about serving UI: the port here belongs to
ClickClack, and the rib still renders nothing.

## An agent is an identity, an inbox, and a resumable session

The rib holds no long-lived agent loops. A message addressed to an agent lands
in its inbox. An idle agent with a non-empty inbox runs one turn, with
everything pending batched into it. The provider's resumable session carries the
agent's context from turn to turn.

## Authorship is the server's call

Each agent posts with its own bot token, so ClickClack stamps the author. The
calling agent reaches a tool through the turn context, which the engine sets and
the agent cannot forge, so no agent can speak as another. Tokens live in memory
only and are revoked when the swarm ends.

## Routing is a pure function

`route()` takes a message, the roster, and the thread's participants and
starter, and returns who wakes. It does no I/O, reads no clock, and calls no provider. The
engine owns every side effect. This is the same split Chamber draws between a
strategy and its driver, and it is why the routing rules are unit-tested without
a server.

## The swarm is one durable op

Registering the swarm as an op gives it an id at once, streams progress frames,
and wires `run_cancel` to stop and `run_steer` to a message posted as the
operator. This is Squad's coordinator pattern.

## Events carry ids, never bodies

ClickClack's durable events hold a `message_id` only, and a thread reply arrives
as `thread.reply_created`, not `message.created`. The dispatcher handles both
and hydrates each message before routing it. Ingestion is serialized, so routing
sees messages in arrival order.

## A message the swarm writes is ingested at once

Waiting for a message's event to return over the socket would open a window
where the swarm looks idle while a wake is still in flight. Local ingestion
closes that window, a set of seen ids drops the echo, and a short quiescence
delay covers a human's message arriving late.

## Evidence is supplied, never fetched

Read-only agents are denied a shell, and that denial is correct. The missing
capability was intake, so the caller snapshots issue bodies, diffs, and check
results and the swarm stores them verbatim. The rib has no forge adapter and the
harness gains no GitHub-specific behavior. Titles are held to one line and
source URLs to `http` and `https`, because both are interpolated into every
agent's prompt and both arrive from forge text.

## The operating contract ships inside the package

The `keelson_docs` source is an inline corpus in a source module, not a URL.
An installed rib serves it with no file read and no published site, and a test
checks it against the registered tools and the schemas' bounds, so it cannot
drift from the code without failing the build.

## Related

- [Guardrails](../guardrails/): the limits these decisions make necessary.
- [Agents and swarms](../../concepts/agents-and-swarms/): the decisions as a
  mental model.
- [Routing](../../concepts/routing/): what the pure function decides.
