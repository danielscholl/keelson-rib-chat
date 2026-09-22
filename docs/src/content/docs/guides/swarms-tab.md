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

**Open the report** opens the swarm's report: a designed page the lead
publishes with `chat_report` before it concludes, with the answer first and the
evidence behind it, and tables, charts, or diagrams where they help. The lead
reads Keelson's canvas design guide first, and the page follows the same rules
as Keelson's canvas artifacts, so it matches the app's theme in light and dark.
A card shows **Report** once the page exists, even while the swarm is still
running, and an ended row marks it with ◧. The lead skips the report when the
whole answer fits in a sentence or two.

**Read in full** and **Read the gate** open the reading pane. It shows the
conclusion, a refused draft, or an open gate's prompt, with formatting.

## Starting a swarm

The **Start a swarm** header above the index has three tabs:

| Tab | Starts |
|---|---|
| **Discuss** | A swarm whose agents talk the task through in its channel and conclude. |
| **Dispatch** | A swarm whose lead may start the workflows you name, in isolated worktrees. It needs a registered project, and each workflow still needs the chat rib's `ribWorkflowGrants` entry. |
| **In chat** | A chat that gathers the issue or PR context, picks a size, and calls `chat_swarm_start`. Use it when the swarm needs evidence it can't fetch. |

The Discuss and Dispatch forms take the task, the project, whether agents may
read the project, the size, and the model. The header's byline lists each
size's agents and wall clock, and hovering **Start swarm** spells out every
limit. Leave the model empty for the provider's default.

**Start swarm** returns at once. The card shows the swarm as starting while it
boots, and a start that fails after that becomes an ended row with the reason.
A start the rib refuses outright, such as an unknown project or a provider that
can't run agents, shows its reason on the form instead.

The Discuss form is open while no swarm is live, and folds to its tabs once one
is.

A swarm started any other way, over MCP or from the `chat-swarm` workflow, gets
a card too.

## Running a swarm again

An ended swarm's drawer offers **Run again**. It starts a new swarm with the
same task, project, workflows, and context, and a form seeded with the old
swarm's size and model. Changing the model there sets it for every agent. The
rib keeps each launch in its data directory next to the history, and a server
reset forgets them with it.

## The ClickClack footer

The footer at the bottom of the tab is folded by default. Open it to see the
server the rib uses:

- its address, and whether the rib manages it
- for a managed server: the process, when it started, the binary, and the data
  directory
- the workflows whose gates the host keeps for you

For a managed server it has **Start** or **Stop**, **Reset…**, and **Log**.
Start, Stop, and Reset run in the background, and the footer shows the result.
A stop can take several seconds, and a reset up to 30. Stop and Reset wait
until no swarm is live. Reset asks you to type `reset`, because it deletes
every channel, transcript, bot, and session, and the ended swarms on the tab.
**Log** opens the last 200 lines of the server log.

An external server shows its address only; the rib doesn't start, stop, or
reset it.
