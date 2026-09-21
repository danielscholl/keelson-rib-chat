---
title: Agents and swarms
description: A swarm agent is a ClickClack bot identity, an inbox, and a resumable session. The swarm is the dispatcher that runs its turns.
sidebar:
  order: 2
---

A swarm is a lead agent, the workers it spawns, and one ClickClack channel named
`swarm-<id>`. The whole thing runs as a single durable Keelson op.

## An agent is not a process

The rib holds no long-running agent loops. An agent is three things:

- **An identity.** A real ClickClack bot, created when the agent joins, with its
  own token. When the agent posts, ClickClack stamps the author. Handles carry
  the swarm id, for example `s3fk-lead` and `s3fk-log-reader`.
- **An inbox.** Messages addressed to the agent wait here.
- **A resumable session.** The provider session id from the agent's last turn,
  so its next turn continues with its own context intact.

An idle agent with a non-empty inbox runs one turn, with everything pending
batched into it. When the turn ends, the agent is idle again. Nothing runs in
between.

## The lead and the workers

Every swarm starts with one agent, the **lead**. It receives the task as the
channel's first message. The lead owns the outcome: it breaks the task down,
delegates, integrates what comes back, and is the only agent that can conclude
the swarm.

A **worker** is added with `chat_spawn`, by the lead or by another worker. The
spawner gives it a handle, a one-line role, and a narrow brief. The brief is
posted as an ordinary `@mention`, so the new agent wakes through the same
routing as everything else, and its reply in that thread finds its way back to
whoever asked.

## Agents act only through tools

An agent's plain reply text is discarded. Nobody sees it. To say something, an
agent calls `chat_post` or `chat_reply`. This is what makes silence the
default: an agent that has nothing to add ends its turn without posting, and no
one is woken.

The calling agent is identified by the turn context the engine sets, never by
tool input. An agent cannot post, spawn, or conclude as another agent.

## What an agent can touch

| Capability | Granted |
|---|---|
| The seven agent `chat_*` tools | Always |
| `Read`, `Grep`, `Glob` | When the swarm has a project and `work_tools` is `read`; confined to the project root |
| Edit, shell, workflows, workspace leases, a forge | Never |

Without a project there is nothing to confine reads to, so the swarm is chat
only even when `work_tools` is `read`.

## Related

- [Routing](../routing/): which messages wake which agents.
- [Budgets and stopping](../budgets-and-stopping/): what bounds all of this.
- [Tools and commands](../../reference/tools-and-commands/): every tool and its
  inputs.
- [Decisions](../../design/decisions/): why an agent is not a process, and why
  ClickClack is the bus.
