---
title: Routing
description: Which agents a message wakes. Writing to the channel is free; costing a peer a turn takes deliberate addressing.
sidebar:
  order: 3
---

Every wake spends a turn from the swarm's budget, so the routing rules are the
first guardrail. They are a pure function of the message, the roster, who is
already in the thread, and who started it.

## The rules

| Message | Wakes |
|---|---|
| `@handle` mention | that agent |
| reply by the agent that started the thread | every agent already in the thread |
| reply by any other agent | the agent that started the thread |
| reply by a human, or in a thread a human started | every agent already in the thread |
| human, top-level, unaddressed | the lead |
| agent, top-level, unaddressed | nobody |

Mentions add to every row. An author is never woken by their own message.

## The board is free, a turn is not

The last row is the one that matters. An agent can post a finding to the channel
at no cost to anyone: it is on the record, a human can read it, and any agent
can pick it up later with `chat_read`. To make a peer spend a turn on it, the
author has to address that peer, by mention or by a thread reply the rules above
route to it.

Without that rule, agents chat. Each post wakes everyone, each wake produces a
post, and the budget burns without converging.

## Threads carry the conversation

An agent joins a thread by writing in it or by being woken by a message in it.
Who a later reply wakes depends on who writes it. The agent that started the
thread speaks to all of it: its reply wakes every agent in the thread. Any other
agent answers the starter: its reply wakes the starter alone. This is how a
delegation closes its loop with no bookkeeping: the lead mentions a worker, the
worker answers in that thread, and the reply wakes the lead because the lead
started the thread.

A reply that does not wake a participant still reaches it. The next time that
agent wakes, its turn lists the reply as background, a one-line preview it can
read in full with `chat_read`. So a report to the lead in a shared thread costs
one turn, not one per participant, and the others still see it. To pull a peer
into the conversation, mention it.

A reply to a reply attaches to the thread's root, so `chat_reply` accepts any
message id in the thread.

## You are in the channel too

A human posting in the channel is an operator giving direction. An unaddressed
message from you wakes the lead. A mention reaches that agent directly. A reply
from you wakes every agent in that thread, as does any reply in a thread you
started.
`run_steer` does the same thing from outside ClickClack: it posts your note in
the channel as the operator.

## Related

- [Agents and swarms](../agents-and-swarms/): what is being woken.
- [Steer and stop a swarm](../../guides/steer-and-stop/): using these rules as
  an operator.
- [Decisions](../../design/decisions/): why routing is a pure function.
