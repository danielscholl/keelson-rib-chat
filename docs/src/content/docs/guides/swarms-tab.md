---
title: Watch swarms in the Swarms tab
description: Answer cross-swarm requests and watch one live swarm's cockpit, with shared selection, agent states and budget.
sidebar:
  order: 8
---

The rib adds a **Swarms** tab to Keelson. It shows every swarm at once. The
conversation stays in ClickClack, and the cockpit shows its newest eight
lines. About links its transcript, and the reading pane links question and
approval threads.

## The index

The tab's head counts the swarms that need you, or the live ones when none do.
A strip beside it splits them into needs you, running and starting.

### Needs you

**Needs you** is one list across every live swarm, with one card per request,
oldest first. When more than 12 requests are open, it shows the oldest 12 and
names the total in its heading. Each card leads with the request:

- the title is the request itself: **Review the plan for …**, **@planner
  asked: …**, **ClickClack stopped answering**, or **No agent has worked since
  21:48**
- the first line says what happened and why it is yours, then how long it has
  waited (**opened 4 min ago**, **asked 2 min ago**), kept current by a live
  clock
- the footnote names the task and swarm id
- the first button is the request's verb: **Review plan**, **Read question**,
  **Open swarm**, or **Message the lead**; replies and dismissal appear when
  they apply, and **Open swarm** expands the swarm on the page

Each card has a colored edge in the request's tone. The swarm's budget,
roster and stop control live in its cockpit, not in its request cards.

### The live swarm

One live swarm expands on the page as a cockpit. It runs in this order:

1. The task and id, a lifecycle or **needs you** pill, and people dots.
2. The state line, described below.
3. Once the lead has concluded, the **Outcome** card: the conclusion, with
   **Open the report** and **Read the conclusion**.
4. An agent strip: **busy**, **waiting**, **idle**, **capped**, **failed**,
   omitting zero counts. Open seats are hatched.
5. Three **Budget** tiles: **Turns** used with a sparkline and a forecast
   delta, with **pace over the last 5 min** in the sub; **Time** as a ticking
   time-left clock; and fresh **Tokens** with cached tokens in the sub.
   Before a turn, Tokens says **none yet**; after turns without usage, it
   says **the provider reported none**.
6. **Map** beside **Conversation**: the agents and runs as a graph, and the
   eight newest channel messages, then the count and **transcript ↗** link.
7. **Message the lead**, expanded directly under Conversation for a running
   swarm that has not concluded.
8. Spend, Produced so far, Task and context, Activity, and About.
9. **Open the report** when one exists; **Open the record**; and
   **Stop swarm…** last.

### Map

Map is a native graph with columns **You, Lead, Workers, Runs** at ranks
**0, 1, 2, 3**. Grandchildren remain in Workers. Agent tones show identity;
run tones show status: running/info, paused/caution, succeeded/ok,
failed/error, cancelled/neutral.

You shows genuine human posts, counted independently of the recent buffer.
`operatorMessageCount` excludes kickoff and rib notices. Zero is measured
zero; old records say **posts not recorded**. The lead shows turns and status,
workers show turns against their cap and status, and runs show status and
steps done. Lead turns have no worker cap.

Solid spawn edges fold the parent's wakes into **×n**, including **×0** when
none were recorded. Other wake edges count one wake per source per turn.
Questions to you are dashed **asked ×n** edges, including retained repeats.
Each individual run links to the lead with **updates**, not a fabricated
per-run wake count. The aggregate `runs` source is never a map node.
You is informational; run nodes open the run; agent nodes select the agent.

Map keeps at most **48 nodes and 200 edges**. It retains You, the lead and
the selected agent before optional nodes, removes dangling edges, and names
actual shown/total counts in the heading for each clipped dimension.
Spawn and run **updates** edges are kept first, then wakes, then questions.
Map and Conversation stack on narrow screens.

### Inspect or message an agent

Select an agent to open its freshly composed inspector at the side.
Selection is shared by every viewer, separately from the expanded swarm
choice; another agent replaces the side drawer. One inspector key per swarm
keeps it bounded. Inspectors outside the retained swarm keys are released on
the next tracking pass unless their swarm is live or starting.
The single-column board is designed for the 520 px inspector.

The identity card shows status, role and a turns meter. The lead's meter is
the swarm budget, explicitly not a worker cap. Facts show the current or last
turn, times, outcome, took, and wake sources: peers, you, kickoff/rib notices,
run updates and idle nudges. Fresh tokens and cached tokens stay separate.
The model/provider is the one actually served. Missing evidence says
**not reported** or **not recorded**, never the requested model as served.
Provenance names the parent and join time. Writers show worktree, branch,
draft PR and observed CI, with an **Open PR** link.

**Said** is this agent's recent messages only, newest first, each linked to
its thread. **Turns** shows its newest 40 recorded spans first and names the
total when older turns are hidden. **Open the record** shows every recorded
turn on the timeline. The quiet
**its messages · transcript ↗** link opens the channel, not a complete
agent-only message history.

**Message @agent** posts as you with the roster's full handle mentioned,
through the unchanged router. It wakes the selected agent and spends a turn;
additional mentions in your note follow normal routing. The activity names
the recipient. The 8,000-character body limit includes the operator prefix
and mention. Capped/failed workers and exhausted budgets disable messaging
with a reason.

Stopping, concluded and ended inspectors are read-only with no composer.
Ended inspectors have no live clock, even when an old span has no recorded end.

### The budget forecast

The Turns delta projects when the remaining turns run out against the wall
clock. It counts turn start timestamps over the last five minutes, or since
the start when the swarm is younger, with at least one minute as the rate's
denominator. Older records without spans use the last five pace buckets
over their covered time, accounting for the partial last minute. Without
buckets, those records use turns so far.
Fewer than one turn in the window reads **no pace**, not infinite time.

| Reading | Delta text | Direction | Tone |
|---|---|---|---|
| runs-out-first | N left · at R a minute they run out about hh:mm, before the clock | down | warn |
| clock-first | N left · at this pace about M unused when the clock ends at hh:mm | flat | caution |
| fits | N left · pace fits the clock | flat | none |
| no-pace | N left · no turn in 5 min | flat | none |
| out-of-turns | none left · agents finish their turns | down | warn |

N is turns left, R is turns a minute and M is projected unused turns. The
rate shows one decimal without a trailing `.0`; times use the local clock.
The host supplies the directional glyph, not the delta text.

With positive pace, running out before the clock reads **runs-out-first**.
Otherwise the forecast rounds the projected unused turns. It reads
**clock-first** when at least a tenth of the total turn budget, rounded up,
would be unused: 2 turns for small, 4 for medium, 8 for large. Less reads
**fits**. At zero turns left, **out-of-turns** takes precedence over pace.

The forecast is advisory. It is computed when the board composes, not
stored or periodically refreshed. It changes nothing the engine does:
no limits, nudges or stopping. An ended Turns tile has no forecast.

### Conversation

- **Conversation** shows at most eight rows, newest first. Each has the
  author's short handle in its identity color, or neutral **you** for an
  operator post; a reply starts with **↳**. Its **HH:MM** time sits at the
  end, and the row links to its thread. The final row reads **23 messages ·
  transcript ↗**, using the swarm's count and linking the channel.

The rib keeps only the newest 20 messages, oldest first, and the first
200 characters of each. A row shows its first line, at most 90 characters,
as plain field text: emphasis and code marks come off, but HTML and markdown
links stay literal. The status tools and the durable op record leave the
recent-message buffer out; `messageCount` counts every ingested message.
Read the full channel with `chat_swarm_transcript`.

The optional message kind is `ask` for an agent addressing `@operator` or
your handle, `run` for quiet run and gate bookkeeping posts, and `conclusion`
for the lead's Conclusion posts. `MessageKind` is
`"ask" | "run" | "conclusion"`. `report` is reserved for the lead's published
report and omitted because `chat_report` never posts to the channel.

The live board shows the same Conversation section before its controls.
With no recent messages it is absent. Ended boards keep Activity instead.

### The state line

The line joins these clauses in order. Stopping overrides the work clauses;
health warnings still append. Clause times use **HH:MM**, not relative
durations, so they do not go stale between frames.

| Clause | Reads |
|---|---|
| Stopping | **stopping: cancelling runs and revoking tokens** |
| A request | **waits on you: review the plan for … since 14:31**, with a count when more requests are open |
| Busy agents | **@lead is on turn 3 since 14:05**, using each agent's latest open turn; without a recorded span, **@lead is on a turn** |
| Waiting agents | **@w2 waits with 1 message** |
| A swarm-answerable pause not already shown as a request | **fix-issue r1a2b3c paused at approve-plan since 14:31, with @w1 reviewing** |
| A conclusion | **concluded at 14:32; turns in flight finish**, or **the lead concluded** when no time was recorded |
| Otherwise | The newest activity and its time, or **waiting for the lead's first turn** |
| Health, appended | Socket drops, a channel fault, the lead's last failed turn, or idle nudges; these mark the row as a warning |

Busy and waiting agents each show at most three clauses, then a remaining
count. The whole line is capped at 240 characters.

### More than one live swarm

With two or more live swarms, a selection strip above the cockpit picks the
expanded swarm. Its task and id name each choice, and the chosen one is marked.
This choice is **shared by every viewer**, not personal to your browser.
The pinned canvas contract reserves tabs for locally opened forms, so the
swarm picker uses a wrapping action strip instead.

Without a live selection, the first swarm needing you expands, sorted by its
oldest request. If none needs you, the earliest started running swarm expands.
A stale selection falls back the same way.

The others fold to one running card each under **Also live**: task and id,
the same state line, the **Turn budget used** meter, time left on a live clock,
people dots, and setup in the footnote. **Open swarm** expands that swarm;
hover it to see the size's numbers and the model. Starting swarms stay cards
under **Also live** and open their starting board.

### Ended swarms

Ended swarms are rows grouped under the day they ended: **Today**,
**Yesterday**, then the weekday and date. A row leads with what came of the
swarm, then **for:** and the task:

- the report's title, when the lead published one
- else the conclusion's first sentence
- else why it ended: **Stopped by you**, **Out of turns at 40**, **Failed: …**

A done row carries a check; stopped, stalled, out of budget and failed rows
carry a chip, so the ones that did not finish stand out. ↻ marks a swarm
started with **Run again**. The trailing names the model that served it, the
turns, how long it ran, when it ended, how many of its runs verified, and
**◧ report** when a report exists. The index shows the latest eight, and the
last row opens the rest in the same day groups. The rib keeps the last 50 in
its data directory, so they survive a restart.

An empty tab shows the three steps: **Start a swarm** above, **Agents work it
out** in `#swarm-<id>`, **The lead concludes here**. The server line stays below
them.

## When a swarm needs you

Requests come in a ladder. Each kind has its own pill, its own first action, and
its own way of clearing. The tab's badge counts swarms with any request.

| Pill | What happened | First action | Clears when |
|---|---|---|---|
| **decide** | A run waits at an approval this swarm may not answer: the host refused the workflow under `ribApprovalGrants`, or offers the rib no way to answer. | **Review plan** for a plan approval, **Answer** for any other, opening the run beside the tab. **Reply** posts in the approval thread as you; it approves nothing. | The run leaves the approval. |
| **question** | An agent opened a sentence with `@operator` (or your ClickClack handle), or asked a question naming you. A passing mention, such as "I'll present both to @operator", isn't one. | **Read question** opens the reading pane. **Reply** posts in the question's thread. **Dismiss** clears it from the tab. | You reply in that thread, post in the channel mentioning the asker, or dismiss it. Other questions stay open. A note to the lead answers the lead's own questions only. |
| **connection** | The swarm's ClickClack socket closed twice without reopening. | **Start ClickClack** when the managed server is down, otherwise **Open swarm** expands the swarm on the page; the card links the transcript. | The socket reopens. |
| **quiet** | A run waits at an approval the swarm could answer, and no agent has worked since. | **Message the lead** | Any agent takes a turn. |

A swarm with an open question waits for you. It isn't nudged or stalled, and
only its wall clock ends it.

An approval the swarm can answer itself appears in the cockpit's state line
while a peer checks the plan in its thread. It names the reviewer when the
lead asked one by mention. The per-swarm board shows it as **reviewing**.
It is not a request and counts nowhere.

## The board for ended swarms and MCP clients

An ended row opens its board in the drawer. The per-swarm board still composes
for MCP clients, live or ended. Its header carries the lifecycle pill, the
size, the turns and the model, and a dot per agent.

Live, the board runs in this order:

- the requests, one card each, with **reviewing** approvals after them
- the report, once the lead has published one
- the budget strip: turns used with a sparkline of turns per minute and the
  same forecast delta while live, with **pace over the last 5 min** in the
  sub; an ended board keeps the sparkline, spread over the whole run, with
  no delta and **of N** in the sub, where N is the total turn budget; time
  left on a live clock; agents against the cap with how many are busy or
  waiting; and fresh tokens with cached tokens beside them; the two are
  never summed, because a cached token costs a fraction of a fresh one
- **Map** beside **Conversation**, the same graph, newest eight messages
  and transcript link as the cockpit, with **Message the lead** under it
- **Open the record** and **Stop swarm…** at the far end of the row.
  The **Message the lead** form under Conversation posts in the channel as
  you and wakes the lead. Its placeholder reads **posts as you, wakes the
  lead**. The button reads **Sending…** until the note is posted, the toast
  says where it went, and the note shows at once under Activity as
  **you posted in #swarm-<id>: …**

Ended, it runs: the outcome, the result strip with how many runs verified, and
**Run again** beside **Open the record**.

The ended **Result** adds **Pull requests** when any exist. It counts distinct
URLs across runs and writers, with **M with CI passing** beneath the total.
A URL counts as passing only when every recorded owner explicitly reports
pass. A verified run is not a substitute for CI evidence. Live boards and
zero-PR boards omit this tile.

The outcome is one card. When the lead published a report, the card carries
its title, the conclusion with a copy button, **Open the report** and **Read
the conclusion**, and a footnote with who concluded,
when, the conclusion's length and the report's size. Without a report the card
is titled **Conclusion**. A swarm that did not conclude shows its cause
instead, such as **Stopped by you at 21:50**, **Out of turns at 40** or
**Failed: …**.

The remaining details follow in both and in the live cockpit. Live details
do not repeat an agent bench. Ended boards keep these agent cards:

- **Agents** (ended only): proportional identity-colored agent cards with
  turns, role, tokens and the last event. They select the same read-only
  inspector, without monospace/stacked cards or ghost seats.
- **Spend**, once two agents have spent: a bar per agent, its fresh tokens
  against the swarm's, with the count and share beside it
- **Produced so far**: reports, dispatched runs, writer draft PRs, and, once
  ended, kept worktrees, as described below
- **Task and context**: a bounded task disclosure, and each context item with
  its id, retrieval time, commit and text under its own. The cockpit shows at
  most 1,000 task characters to reserve map space; the per-swarm board keeps
  4,000 and the reading pane keeps the full task.
- **Activity**: the last twelve events, newest first, with repeats counted,
  then **Read the full log**, which opens the last 200 in the reading pane.
  Each row starts with who it is by: the agent's handle in its color, or
  **you**. A turn is one row, written when it ends: **turn 3 ok · 42 s · 2
  new**, or **nudged** or **run update** when no message woke it
- **About**: the times, the size's limits, the model per role, the tokens, any
  problems with ClickClack or the lead's turns, and the **transcript ↗** link;
  an ended board keeps its row back to the ended swarms after the transcript

### Produced so far

The cockpit and per-swarm board share one inventory. Artifacts appear in
landing order, oldest first: report publication time, run start time, and
PR opening time. Equal times keep report/run/writer order and ledger order.
Missing legacy times fall back to the swarm start. Run gate answers stay
immediately under their parent run. Kept worktrees follow the artifact rows
only after the swarm ends, never while running or stopping.

| Row | Shows |
|---|---|
| Report | Title, KB size, and **Open the report** |
| Dispatched run | Purpose, branch, every PR, elapsed time, status, the start of an error, and the worktree/PR/CI evidence strip; clicking it opens the run beside the tab |
| Gate answer | Reviewer, review link, decision, time, and reason under a disclosure, immediately under its run |
| Writer PR | The writer's short handle in its identity color, branch, draft PR link, and observed CI, with detail under a disclosure |
| Kept worktree | Recorded path and retention reason, with the writer's chip when available; not a claim about the current filesystem |

While empty, the section names permitted workflows and eligible writers.
Before its first writer, a write-enabled swarm says the lead may spawn
writers. Ended placeholders use past tense. An empty chat-only swarm without
workflows omits the section, but a published report still appears.

Writer CI comes from current-head checks read with `gh pr view` after opening
or pushing, then every 20 seconds, even without dispatched runs. A new pushed
head clears the old observation. Reads for a different head are discarded.
Each read has a 3-second timeout.

**Pass** requires a nonempty rollup with successful evidence and no failing,
running, or unrecognized checks. Neutral/skipped checks may accompany
success, but alone they are **unknown**. **Fail** means a terminal failure;
**running** means checks are queued or in progress. **Unknown** means
unfamiliar evidence or a read fault, shown with a detail and logged as a
fault. No checks means **not reported**, never pass. Missing evidence never
implies pass.

On ending, the rib makes one final read with the same timeout. A timeout
keeps the last observation. Ended CI is a saved observation, not a
continuously monitored guarantee. Only the operator merges pull requests,
and the board never removes worktrees. The engine still removes clean,
fully pushed worktrees at the end and records why it keeps the others.

**Message the lead** goes away once the lead concludes, since no new turn would
read it. **Stop swarm…** names the runs it cancels, and the board shows
**stopping** until the runs are cancelled and the bot tokens revoked. A
cancellation that fails is a row under About.

**Open the report** opens the swarm's report: a designed page the lead
publishes with `chat_report` before it concludes, with the answer first and the
evidence behind it, and tables, charts, or diagrams where they help. The lead
reads Keelson's canvas design guide first, and the page follows the same rules
as Keelson's canvas artifacts, so it matches the app's theme in light and dark.
The cockpit offers **Open the report** once the page exists, even while the
swarm is still running. A folded card offers **Report**, and an ended row marks
it with **◧ report**. The lead skips the report when the whole answer fits in a
sentence or two.

**Read the conclusion** and **Read question** open the reading pane. It shows
the conclusion, a refused draft, each open question with a link to its thread,
or an open approval's prompt and the files it names, such as the plan, with
formatting, then the task in full, each context item's text, and each run with
its pull requests, full error and CI detail. The copy button
beside the conclusion copies all of it, not just the preview on the board.

## A swarm's record

**Open the record** shows a page the rib draws for the swarm, live or ended. It
answers what happened, in what order, by whom, and at what cost:

- **Timeline**: a lane per agent in the order they first worked, yours above
  and one per run below. Each turn is a bar in the agent's color, from its
  start to its end, hatched when it timed out or failed and dashed while it
  runs. Marks show when an agent was spawned (○), asked you something (?), when
  you posted or answered (▲), the report (▪), the conclusion (●), a run's gate
  opening and being answered (◇ ◆), and a verified run (✓); hover any bar or
  mark for its detail. Live, a rule marks now and the right edge names when the
  swarm's clock runs out; ended, a rule marks when it ended.
- **Who woke whom**: the agents as nodes in their colors, you and the runs
  beside the lead, a straight arrow for each spawn and a curve for the turns
  one side started, counted
- **Spend by agent**: fresh tokens, then cached tokens in a lighter bar after
  them
- **Runs**: each run in full, with its branch, every pull request, its CI
  verdict and detail, its steps, how long it took, each gate it paused at, who
  answered it, and why
- **Evidence given**: each context item's id, kind, title, source, retrieval
  time and commit

The page has no buttons: the board keeps every verb. A live record redraws
when the swarm's course changes, at most every five seconds. Swarms that ended
before this page existed show their events and runs but no turn bars, since
their turns were not kept.

## Starting a swarm

The **Start a swarm** header above the index is one form. It is open on an
empty tab and folds to its head once the tab has a swarm, live or ended; after
that it stays as you leave it. The folded head names what **Start swarm** would
launch: **Start runs medium · 5 agents · 40 turns · 30 min · balanced power**.

| Field | Means |
|---|---|
| **Task** | What the swarm works out. Agents can't open links, so describe the issue or PR, or use **Prepare in chat** to attach it. A task that names a URL or `#123` with nothing attached is refused before a channel exists. |
| **Project** | The registered project agents work on. **Agents may** and **Workflows** appear once one is picked. |
| **Agents may** | Whether agents only talk (**chat only**), read the project (**read the project**), or read it while the lead spawns writers that change it in their own worktrees (**write the project**). See [Let agents write code](../let-agents-write/). |
| **Workflows the lead may start** | Leave it empty and the swarm investigates. Name workflows and the lead may start them in isolated worktrees; each still needs the chat rib's `ribWorkflowGrants` entry. The placeholder names the workflows whose approvals the host keeps for you. With no registered project the field stays visible and says it needs one. |
| **Setup** | **defaults · medium · balanced** launches on the defaults; **adjust** shows size, power and model override. A launch on defaults sends none of the three, so **Run again** later repeats what you chose, not what was filled in. Switching back to defaults keeps what you typed in the task. |
| **Size** | Each segment carries its agents and turns; the hover has every limit. |
| **Power** | `fast`, `balanced` or `deep`; hovering one names the model each provider runs at it. |
| **Model override** | Leave it on **use the power's model** to let the power pick. An override sets every agent's model and the power no longer applies. |

**Prepare in chat · attach an issue or PR** opens a chat that gathers the issue or PR context, picks a
size, and calls `chat_swarm_start`. Use it when the swarm needs evidence it
can't fetch.

**Start swarm** returns at once. The card shows the swarm as starting while it
boots, and a start that fails after that becomes an ended row with the reason.
A start the rib refuses outright, such as an unknown project or a provider that
can't run agents, shows its reason on the form instead.

A swarm started any other way, over MCP or from the `chat-swarm` workflow,
appears in the same live area.

## Running a swarm again

An ended swarm's board offers **Run again**. It starts a new swarm with the
same task, project, workflows, and context, and a form seeded with the old
swarm's size, power and model; its hover names what it reuses, including how
many context items and when they were captured, since the context is not
refreshed. Changing the model there sets it for every agent. The rib keeps each
launch in its data directory next to the history, and a server reset forgets
them with it.

## The server line

One muted server line ends the index, even on an empty tab. With a managed
server and one live swarm it reads:

**Server · ClickClack running on 127.0.0.1:18080 · managed · 1 swarm**

A managed server reads **running** or **stopped**; an external one reads
**reachable** or **unreachable since 21:40**. The swarm count includes starts
in progress and disappears when none is live.

**Manage ›** opens **ClickClack server**, the server inspector at the side.
Its boxed rows show **Address** and **Mode**. A managed server also shows
**Process**, **Started**, **Binary**, and **Data directory** when known; an
external one shows **Last probe**. A running server's address opens its web
UI. The inspector's head pill carries **starting…**, **stopping…**,
**resetting…** or **stop failed** while an operation runs or after one fails.

For a managed server it has **Start** or **Stop**, **Reset…**, and **Log**.
Start, Stop, and Reset run in the background, and the inspector shows the result.
A stop can take several seconds, and a reset up to 30. Stop and Reset wait
until no swarm is live. Reset asks you to type `reset`, because it deletes
every channel, transcript, bot, and session, and the ended swarms on the tab.
**Log** opens the last 200 lines of the server log.

An external server is probed on each refresh, and **Last probe** says when it
answered or failed to answer. **Retry** probes it again and updates the server
line. The rib doesn't start, stop, or reset it.
