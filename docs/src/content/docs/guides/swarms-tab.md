---
title: Watch swarms in the Swarms tab
description: Find the swarm that needs you, act on its request, and read its budget, agents, runs and outcome from Keelson.
sidebar:
  order: 7
---

The rib adds a **Swarms** tab to Keelson. It shows every swarm at once. The
conversation itself stays in ClickClack, and every channel and gate thread on
the tab links there.

## The index

Live swarms are cards. Swarms that ask something of you sort first, oldest
request first, then swarms that are starting, then swarms that are running. The
tab's head counts the swarms that need you, or the live ones when none do, and
a strip beside it splits them into needs you, running and starting.

A card that asks something leads with the request:

- the title is the request itself: **Review the plan for …**, **@planner
  asked: …**, **ClickClack stopped answering**, or **No agent has worked since
  21:48**
- the first line says what happened and why it is yours
- the second line is the budget: turns used and remaining, minutes of the wall
  clock
- the footnote is the setup: the task, the project, the size, the model, the
  agents, when it started
- the first button is the request's verb: **Review plan**, **Read question**,
  **Open swarm**, or **Message the lead**; **Open swarm** and **Report** follow,
  and **Stop swarm** is in the overflow menu

When a swarm asks more than one thing, the card shows the first and counts the
rest.

A running card leads with the task and the id, then:

- what the swarm is doing this minute: who is working and the latest event, or
  the approval a peer is reviewing
- **Turn budget used · 18 of 80 · 62 remaining**, over a meter
- the agents, in their identity colors
- the setup in the footnote

Hover **Open swarm** to see the size's numbers and the model.

Ended swarms are rows: the lifecycle word (done, stopped, stalled, out of
budget, failed), the task with the id at its end, then the model that served
it, the turns, how long it ran, when it ended (the time for today, the date
before that), how many of its runs verified, and ◧ when a report exists. The index shows the latest eight, and the last row opens the rest. The
rib keeps the last 50 in its data directory, so they survive a restart.

An empty tab shows the three steps: start a swarm above, agents talk in
`#swarm-<id>`, the lead concludes here.

## When a swarm needs you

Requests come in a ladder. Each kind has its own pill, its own first action, and
its own way of clearing. The tab's badge counts swarms with any request.

| Pill | What happened | First action | Clears when |
|---|---|---|---|
| **decide** | A run waits at an approval this swarm may not answer: the host refused the workflow under `ribApprovalGrants`, or offers the rib no way to answer. | **Review plan** for a plan approval, **Answer** for any other, opening the run beside the tab. **Reply** posts in the approval thread as you; it approves nothing. | The run leaves the approval. |
| **question** | An agent opened a sentence with `@operator` (or your ClickClack handle), or asked a question naming you. A passing mention, such as "I'll present both to @operator", isn't one. | **Read question** opens the reading pane. **Reply** posts in the question's thread. **Dismiss** clears it from the tab. | You reply in that thread, post in the channel mentioning the asker, or dismiss it. Other questions stay open. A note to the lead answers the lead's own questions only. |
| **connection** | The swarm's ClickClack socket closed twice without reopening. | **Start ClickClack** when the managed server is down, otherwise **Open swarm**; the card links the channel. | The socket reopens. |
| **quiet** | A run waits at an approval the swarm could answer, and no agent has worked since. | **Message the lead** | Any agent takes a turn. |

A swarm with an open question waits for you. It isn't nudged or stalled, and
only its wall clock ends it.

An approval the swarm can answer itself is shown as **reviewing** on the board
while a peer checks the plan in its thread. The card names the reviewer when the
lead asked one by mention, and says nothing when no agent was asked. It is not a
request and counts nowhere.

## A swarm's board

**Open swarm** shows the board. Its header carries the lifecycle pill, the size,
the turns and the model, and a dot per agent.

Live, the board runs in this order:

- the requests, one card each, with **reviewing** approvals after them
- the report, once the lead has published one
- the budget strip: turns used with what is left and a sparkline of turns per
  minute, time against the wall clock, agents against the cap with how many are
  busy or waiting, and fresh tokens with cached tokens beside them; the two are
  never summed, because a cached token costs a fraction of a fresh one
- **Message the lead**, which posts in the channel as you and wakes the lead,
  and **Stop swarm…** at the far end of the row. What you post shows at once
  under Activity, as **you posted in #swarm-<id>: …**

Ended, it runs: the outcome (the report, the conclusion with **Read in full**,
or the cause, such as **Stopped by you at 21:50**, **Out of turns at 40** or
**Failed: …**), the result strip with how many runs verified, and **Run again**.

The record follows in both and reads the same:

- **Agents**: a bench with one card per agent, its handle in its identity
  color, a status pill while live (**busy**, **waiting** when it has messages
  and no free slot, **idle**, **capped**, **failed**), its turns against the
  per-worker cap, its role and its tokens; open seats up to the swarm's cap show
  as dashed ghosts
- **Runs**, only when the launch named workflows: each run with its worktree,
  PR and CI strip and its steps done; clicking a run opens it beside the tab.
  Each approval the swarm answered sits under its run with the reviewer, a link
  to the review, and the reason under a disclosure. It says which workflows the
  lead may start while none has
- **Task and context**: the task in full under a disclosure, and each context
  item with its retrieval time, commit and text under its own
- **Activity**: the last twelve events, newest first, with repeats counted,
  then **Read the full log**, which opens the last 200 in the reading pane
- **About**: the channel, the times, the size's limits, the model per role, the
  tokens, and any problems with ClickClack or the lead's turns; an ended board
  ends with a row back to the ended swarms

**Message the lead** goes away once the lead concludes, since no new turn would
read it. **Stop swarm…** names the runs it cancels, and the board shows
**stopping** until the runs are cancelled and the bot tokens revoked. A
cancellation that fails is a row under About.

**Open the report** opens the swarm's report: a designed page the lead
publishes with `chat_report` before it concludes, with the answer first and the
evidence behind it, and tables, charts, or diagrams where they help. The lead
reads Keelson's canvas design guide first, and the page follows the same rules
as Keelson's canvas artifacts, so it matches the app's theme in light and dark.
A card shows **Report** once the page exists, even while the swarm is still
running, and an ended row marks it with ◧. The lead skips the report when the
whole answer fits in a sentence or two.

**Read in full** and **Read question** open the reading pane. It shows the
conclusion, a refused draft, each open question with a link to its thread, or an
open approval's prompt and the files it names, such as the plan, with
formatting, then the task in full and each context item's text. The copy button
beside the conclusion copies all of it, not just the preview on the board.

## Starting a swarm

The **Start a swarm** header above the index is one form:

| Field | Means |
|---|---|
| **Task** | What the swarm works out. Agents can't open links, so describe the issue or PR, or use **Prepare in chat** to attach it. A task that names a URL or `#123` with nothing attached is refused before a channel exists. |
| **Project** and **Agents may** | The registered project agents may read, and whether they may (**chat only** or **read the project**). |
| **Workflows the lead may start** | Leave it empty and the swarm investigates. Name workflows and the lead may start them in isolated worktrees; this needs a project, and each workflow still needs the chat rib's `ribWorkflowGrants` entry. The placeholder names the workflows whose approvals the host keeps for you. |
| **Size** | Each segment carries its agents and turns; the hover has every limit. |
| **Power** | `fast`, `balanced` or `deep`; hovering one names the model each provider runs at it. |
| **Model override** | Leave it on **use the power's model** to let the power pick. An override sets every agent's model and the power no longer applies. |

**Prepare in chat** opens a chat that gathers the issue or PR context, picks a
size, and calls `chat_swarm_start`. Use it when the swarm needs evidence it
can't fetch.

**Start swarm** returns at once. The card shows the swarm as starting while it
boots, and a start that fails after that becomes an ended row with the reason.
A start the rib refuses outright, such as an unknown project or a provider that
can't run agents, shows its reason on the form instead. The form stays open
while no swarm is live, and folds to a button once one is.

A swarm started any other way, over MCP or from the `chat-swarm` workflow, gets
a card too.

## Running a swarm again

An ended swarm's board offers **Run again**. It starts a new swarm with the
same task, project, workflows, and context, and a form seeded with the old
swarm's size, power and model; its hover names what it reuses, including how
many context items and when they were captured, since the context is not
refreshed. Changing the model there sets it for every agent. The rib keeps each
launch in its data directory next to the history, and a server reset forgets
them with it.

## The ClickClack footer

The footer at the bottom of the tab is folded by default. Its head shows the
server's state even while folded: **running** or **stopped** for a managed
server, **reachable** or **unreachable since 21:40** for an external one, and
**starting…**, **stopping…**, **resetting…** or **stop failed** while an
operation runs or after one fails. Open it to see the server the rib uses:

- its address, and whether the rib manages it
- for a managed server: the process, when it started, the binary, and the data
  directory

For a managed server it has **Start** or **Stop**, **Reset…**, and **Log**.
Start, Stop, and Reset run in the background, and the footer shows the result.
A stop can take several seconds, and a reset up to 30. Stop and Reset wait
until no swarm is live. Reset asks you to type `reset`, because it deletes
every channel, transcript, bot, and session, and the ended swarms on the tab.
**Log** opens the last 200 lines of the server log.

An external server is probed on each refresh, and the footer says when it last
answered. **Retry** probes it again. The rib doesn't start, stop, or reset it.
