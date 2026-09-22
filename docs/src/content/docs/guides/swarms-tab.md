---
title: Watch swarms in the Swarms tab
description: Find the swarm that needs you, open one to see its gate, runs, and agents, and steer or stop it from Keelson.
sidebar:
  order: 7
---

The rib adds a **Swarms** tab to Keelson. It shows every swarm at once. The
conversation itself stays in ClickClack, and every channel and gate thread on
the tab links there.

## The index

Live swarms are cards. Swarms that need you sort first, then swarms that are
starting, then swarms that are running. The tab's head counts the swarms that
need you, or the live ones when none do.

Each card shows:

- the channel and the agents
- the project, when the swarm has one
- its size and model
- when it started
- the first pull request its runs opened
- a turns bar against the swarm's turn budget
- one line on what the swarm is doing, or what it needs

Hover **Open** to see the size's numbers and the model for each role.

Ended swarms are rows, newest first. The index shows the latest eight, and the
last row opens the rest. The rib keeps the last 50 in its data directory, so
they survive a restart.

## When a swarm needs you

A card is marked **needs you** when the swarm can't make progress without you:

| Condition | What to do |
|---|---|
| ClickClack stopped answering: the swarm's socket closed twice without reopening | Check the server with `chat_server_status`. |
| A gate only you can answer: the host refused the swarm's answer under `ribApprovalGrants`, or offers the rib no way to answer | Answer the run in the Workflows tab, or grant the chat rib approvals for that workflow. |
| A gate nobody is working on: a run is paused and the swarm went idle | Reply in the gate thread, steer the lead, or answer the run in the Workflows tab. |

A gate the swarm can answer itself is shown as **in review** while a peer checks
the plan in the gate thread.

## A swarm's drawer

**Open** shows the swarm's board. It includes:

- the channel, times, size, and model
- any problems with ClickClack or the lead's turns
- the task context
- open gates
- the workflow runs, each with a worktree, PR, and CI strip
- the agents
- the outcome, once there is one

**Steer** posts a note in the channel as the operator, which wakes the lead.
**Stop swarm** ends the swarm and cancels any live runs after you confirm.
Steer goes away once the lead concludes, since no new turn would read the note.

**Read in full** and **Read the gate** open the reading pane. It shows the
conclusion, a refused draft, or an open gate's prompt, with formatting.

## Starting a swarm

**Start a swarm in Chat** opens a chat that gathers the issue or PR context,
picks a size, and calls `chat_swarm_start`. A swarm started any other way, over
MCP or from the `chat-swarm` workflow, gets a card too.
