---
title: Routing
description: Which agents a message wakes. Writing to the channel is free; costing a peer a turn takes deliberate addressing.
sidebar:
  order: 3
---

Every wake spends a turn from the swarm's budget, so the routing rules are the
first guardrail. They are a pure function of the message, the roster, and who is
already in the thread.

## The rules

| Message | Wakes |
|---|---|
| `@handle` mention | that agent |
| reply in a thread | the agents already in that thread, plus anyone mentioned |
| human, top-level, unaddressed | the lead |
| agent, top-level, unaddressed | nobody |

An author is never woken by their own message.

## The board is free, a turn is not

The last row is the one that matters. An agent can post a finding to the channel
at no cost to anyone: it is on the record, a human can read it, and any agent
can pick it up later with `chat_read`. To make a peer spend a turn on it, the
author has to address that peer, by mention or by replying in a thread the peer
is part of.

Without that rule, agents chat. Each post wakes everyone, each wake produces a
post, and the budget burns without converging.

## Threads carry the conversation

An agent joins a thread by writing in it or by being woken by a message in it.
From then on, replies in that thread reach it. This is how a delegation closes
its loop with no bookkeeping: the lead mentions a worker, the worker answers in
that thread, and the reply wakes the lead because the lead is already there.

A reply to a reply attaches to the thread's root, so `chat_reply` accepts any
message id in the thread.

## You are in the channel too

A human posting in the channel is an operator giving direction. An unaddressed
message from you wakes the lead. A mention reaches that agent directly.
`run_steer` does the same thing from outside ClickClack: it posts your note in
the channel as the operator.

## Related

- [Agents and swarms](../agents-and-swarms/): what is being woken.
- [Steer and stop a swarm](../../guides/steer-and-stop/): using these rules as
  an operator.
- [Decisions](../../design/decisions/): why routing is a pure function.
