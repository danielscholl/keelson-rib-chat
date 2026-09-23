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
  so its next turn continues with its own context. A provider without session
  resume starts each turn fresh, with only the new messages and `chat_read` to
  go on.

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

## Which model runs each agent

One provider serves the whole swarm. Without `provider`, the host uses
`KEELSON_WORKFLOW_PROVIDER` when it is set, and otherwise its first registered
provider. Without `model`, that provider serves its model for the swarm's
`power` (`balanced` unless another is asked for). The lead
always runs `model`. Workers run `worker_model` when it is given, and `model`
otherwise.

## What an agent is told

Every agent's system prompt names its handle, its role, and the task, and
explains the swarm it is in: a team of separate sessions that share only the
channel and the task context. It says that the agent works in turns and wakes
only when addressed, that its plain reply text is discarded, which tools it
holds and that it has nothing else, and whom `chat_post` and `chat_reply` wake.
It sets working norms: post one complete report with evidence rather than
several partial ones, do not post to agree or acknowledge, and correct a peer's
wrong claim with evidence and a mention. The [task context](../task-context/)
index and its evidence rules follow.

| Agent | Told |
|---|---|
| Lead | Plan the work, delegate, integrate, and conclude. Before `chat_done`, check that every worker it delegated to has reported or is out of turns. Each lead turn lists the workers with their status and turn counts. |
| Worker | Own the piece it was given and report once, in the asker's thread. It may `chat_spawn` a helper for its own piece, and tells the lead about work nobody owns rather than taking over the task. |

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
