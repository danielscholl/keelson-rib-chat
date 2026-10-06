---
title: Watch swarms in the Swarms tab
description: Answer cross-swarm requests and watch one live swarm's cockpit, with shared selection, agent states and budget.
sidebar:
  order: 8
---

The rib adds a **Swarms** tab to Keelson. It shows every swarm at once. The
conversation stays in ClickClack, and the cockpit shows its newest eight
lines. Details links the transcript. Questions and gates open side inspectors;
the reading pane keeps a refused draft and the full task.

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
2. **Task**: the prompt's first line, with the text you started it with one
   click away (its first 800 characters; **Details** has all of it). Then the
   state line, described below.
3. Once the lead has concluded, the **Outcome** card: the conclusion, with
   **Open the report** when one exists. While a peer reviews a
   gate, its reviewing card appears here instead.
4. An agent strip: **busy**, **waiting**, **idle**, **capped**, **failed**,
   omitting zero counts. Open seats are hatched.
5. Three **Budget** tiles: **Turns** used with a sparkline and a forecast
   delta, with **of N · pace over the last 5 min** in the sub; **Time** as a ticking
   time-left clock; and fresh **Tokens** with cached tokens in the sub.
   Before a turn, Tokens says **none yet**; after turns without usage, it
   says **the provider reported none**.
6. **Timeline**: turns and event marks on lanes over time.
7. **Map**: the agents and runs as a full-width graph.
8. **Conversation** follows Map when recent messages exist: the
   eight newest channel messages, then the count and **transcript ↗** link.
9. **Message the lead**, expanded directly under Conversation for a running
   swarm that has not concluded.
10. Spend, Produced so far, and Activity.
11. **Open the report** when one exists; **Timeline**; **Details**; and
   **Stop swarm…** last.

### Timeline

Timeline is a native section between Budget and Map, on the live cockpit only,
not the per-swarm drawer or ended board. It requires Keelson v0.120.0 or later.
The operator's lane comes first, then agents in first-worked order, then runs.
Turns use the agent's identity color, with hatching for timeouts or errors and
open endpoints for unfinished work. Run bars use status colors.
Marks show spawns (○), questions (?), operator posts and answers (▲), reports
(▪), conclusions (●), gates opened and answered (◇ ◆), and verified runs (✓).
Nudges, caps and retirements keep their existing marks.

The live window starts at `startedAt` and its clock ends at `startedAt + wallClockMs`.
When `endedAt` is recorded, the window is fixed at that end with no live clock.
The host uses a UTC axis and a shared 30-second clock without new frames.
On narrow sections, lane lists replace the plot.

Timeline keeps at most **12 lanes, 400 spans and 200 marks**. It keeps the operator,
then first-worked agents, then runs; it retains the newest eligible spans and
marks with stable timestamp sorts. Items on omitted lanes are removed.
The title names shown/total counts for each clipped dimension, including items
lost with omitted lanes. **Timeline** opens the record with additional lanes and events.
The record keeps the full retained timeline, with its own snapshot window and
drawing. Native clipping does not remove its lanes or events.

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
Map owns a full-width row on both live surfaces; Conversation and the eligible
composer follow.

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
total when older turns are hidden. **Timeline** opens the record with every recorded
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
Ended agent heads use the swarm lifecycle pill: **done**, **stopped**,
**stalled**, **out of budget** or **failed**, not the agent's last live status.
Live, unended heads retain the agent's actual status. A retained end time with
a still-live status suppresses the activity pill rather than inventing an
outcome.

### Read or answer a question

**Read question** opens the question inspector at the side, at
`rib:chat:ask:<swarm>`. **Question** shows the complete admitted question,
up to 8,000 characters, without its `@operator` addressing. It names the
asker, absolute asked time, and a live since clock while actionable.
**Thread** is a quiet link; **Actions** offers **Reply** and **Dismiss**.

Needs you cards, the index and the per-swarm board keep their bounded
question previews; only the question inspector shows the full body.
Legacy summaries cannot recover question text already truncated.
**Reply** posts as you in the thread and never approves. **Dismiss** clears
the question from the tab, not the channel.

### Read a gate

**Read gate** and a reviewing card's body open the gate inspector at
`rib:chat:gate:<swarm>`. Its sections are:

| Section | Shows |
|---|---|
| **Gate** | The full retained prompt as prose |
| **Files** | One prose card per named file, including empty files, read errors and truncation notices |
| **Review** | The reviewer and a quiet thread link, or explicit not-recorded states |
| **Actions** | **Reply** when the gate has an actionable thread; operator-only gates also offer **Open run** |

Peer gates have no approval control. **Reply** posts as you in the thread
and never approves. **Review plan** and **Answer** still open the run drawer,
where operator decisions belong.

### Inspect task, context and setup

**Details** opens at the side from the cockpit, live board or ended board,
at `rib:chat:details:<swarm>`. It is read-only with no composer.

| Section | Shows |
|---|---|
| **Task and context** | The full task in ordered disclosures of at most 4,000 characters; every retained context excerpt with its id, kind/title, source, retrieval time, head/base SHA and character count |
| **Setup** | The plan (**Plan: Scout**, or **Scout, adjusted** when limits moved off it), all effective limits, requested models per role/provider, recorded overrides and effort |
| **Health** | Recorded faults, disconnection and idle evidence |
| **Transcript** | One transcript row, or an explicit not-recorded state |

Excerpts are not complete source bodies. Missing legacy excerpts and
truncation are explicit. Actually served models stay separate from requested
settings; missing legacy evidence says **not recorded**.

A single-part task is labeled **Task**; longer tasks use numbered parts.
Details durations use exact whole minutes or seconds, including fractional
seconds: 1800000 ms becomes **30 min**, 300000 ms becomes **5 min**, 45000 ms
becomes **45 s**, and 90000 ms remains **90 s**.

Setup has one **Lead model** row and one **Worker model** row, requested
settings first. Without explicit settings, the request reads
"balanced power, host default". Workers inherit the lead setting unless a
worker role override is recorded. Each role's disclosure labels served model
and served provider per agent by short handle, with explicit per-agent request
overrides. Missing served evidence says **not reported**; missing role agents
are explicitly **not recorded**. **Model thinking** (the recorded reasoning
effort) and aggregate token usage remain visible.

Each inspector publishes before opening. Question and gate selection is
shared by every viewer, independently of expanded-swarm and agent selection,
with one key per swarm and kind. Open inspectors refresh from current
summaries. A resolved question or advanced gate stays explicitly read-only
without **Reply** or **Dismiss**, not silently switched to another target.
Stopping, concluded and ended question/gate inspectors have no live clock or
composer. Forgetting, retention trimming and disposal release inspector keys.

### The budget forecast

The live Turns tile has a numeric value and its sub reads
"of N · pace over the last 5 min". At 3 of 20 turns, its value is **3** and its
sub is **"of 20 · pace over the last 5 min"**.

The Turns delta projects when the remaining turns run out against the wall
clock. It counts turn start timestamps over the last five minutes, or since
the start when the swarm is younger, with at least one minute as the rate's
denominator. Older records without spans use the last five pace buckets
over their covered time, accounting for the partial last minute. Without
buckets, those records use turns so far.
Fewer than one turn in the window reads **no pace**, not infinite time.

| Reading | Delta text | Direction | Tone |
|---|---|---|---|
| runs-out-first | N left · out about hh:mm, before the clock | down | warn |
| clock-first | N left · about M unused at hh:mm | flat | caution |
| fits | N left · pace fits the clock | flat | none |
| no-pace | N left · no turn in 5 min | flat | none |
| out-of-turns | none left · agents finish their turns | down | warn |

N is turns left and M is projected unused turns. Delta text stays within 44
characters through the 200-turn bound. The rate is not displayed; times use
the local clock.
The host supplies the directional glyph, not the delta text.

With positive pace, running out before the clock reads **runs-out-first**.
Otherwise the forecast rounds the projected unused turns. It reads
**clock-first** when at least a tenth of the total turn budget, rounded up,
would be unused: 2 turns for small, 4 for medium, 8 for large. Less reads
**fits**. At zero turns left, **out-of-turns** takes precedence over pace.

The forecast is advisory. It is computed when the board composes, not
stored or periodically refreshed. It changes nothing the engine does:
no limits, nudges or stopping.
An ended Turns tile has no forecast and its sub stays "of N".
It retains the numeric used count and existing sparkline.

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
hover it to see the plan's numbers and the model. Starting swarms stay cards
under **Also live** and open their starting board.

### Ended swarms

Ended swarms are rows grouped under the day they ended: **Today**,
**Yesterday**, then the weekday and date. A row leads with the task, then
**·** and what came of the swarm:

- the report's title, when the lead published one
- else the conclusion's first sentence
- else why it ended: **Stopped by you**, **Out of turns at 40**, **Failed: …**

A done row carries a check; stopped, stalled, out of budget and failed rows
carry a chip, so the ones that did not finish stand out. ↻ marks a swarm
started with **Retry** or **Go deeper**. The trailing names the turns, how
long it ran, when it ended, how many of its runs verified, and
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
| **question** | An agent opened a sentence with `@operator` (or your ClickClack handle), or asked a question naming you. A passing mention, such as "I'll present both to @operator", isn't one. | **Read question** opens the question inspector. **Reply** posts in the question's thread. **Dismiss** clears it from the tab. | You reply in that thread, post in the channel mentioning the asker, or dismiss it. Other questions stay open. A note to the lead answers the lead's own questions only. |
| **connection** | The swarm's ClickClack socket closed twice without reopening. | **Start ClickClack** when the managed server is down, otherwise **Open swarm** expands the swarm on the page; the card links the transcript. | The socket reopens. |
| **quiet** | A run waits at an approval the swarm could answer, and no agent has worked since. | **Message the lead** | Any agent takes a turn. |

A swarm with an open question waits for you. It isn't nudged or stalled, and
only its wall clock ends it.

An approval the swarm can answer itself appears in the state line and a
**reviewing** card in the cockpit and per-swarm board while a peer checks the
plan. It names the reviewer when recorded. Select the card or **Read gate**
to read along. It is not a request and counts nowhere.
If that gate becomes quiet, its quiet request keeps **Read gate** while
**Message the lead** stays the primary action.

## The board for ended swarms and MCP clients

An ended row opens its board in the drawer. The per-swarm board still composes
for MCP clients, live or ended. Its header carries the lifecycle pill, the
plan (**Scout**, **Crew** or **Fleet**), the turns, and a
dot per agent. Sizes are named by plan everywhere; the ended header chip does
not name the model.

Live, the board runs in this order:

- the requests, one card each, with **reviewing** approvals after them
- the report, once the lead has published one
- the budget strip: turns used with a sparkline of turns per minute and the
  same forecast delta while live, with **of N · pace over the last 5 min** in the
  sub; an ended board keeps the sparkline, spread over the whole run, with
  no delta and **of N** in the sub, where N is the total turn budget; time
  left on a live clock; agents against the cap with how many are busy or
  waiting; and fresh tokens with cached tokens beside them; the two are
  never summed, because a cached token costs a fraction of a fresh one
- the same full-width **Map**, then **Conversation**, with the newest eight
  messages and transcript link as the cockpit, followed by the eligible
  **Message the lead** composer
- **Timeline**, **Details** and **Stop swarm…** at the far end of the row.
  The **Message the lead** form under Conversation posts in the channel as
  you and wakes the lead. Its placeholder reads **posts as you, wakes the
  lead**. The button reads **Sending…** until the note is posted, the toast
  says where it went, and the note shows at once under Activity as
  **you posted in #swarm-<id>: …**

Ended section order: Outcome, Result, actions, Agents, Produced when
applicable, Activity when events exist, About, then the separate Ended swarms
back-link.

The ended Result orders Turns, Time, Tokens, Pull requests when eligible, then
Runs verified only when runs exist. There is no Agents tile.
Tokens is 0 when no turns ran; after positive turns without usage it is
unavailable, not an invented zero.

The Pull requests tile appears when workflows were named, `writeEnabled`
is true, a legacy writer has a worktree, or any run or writer PR exists.
Eligible write or dispatch swarms with no PRs show 0 with "0 with CI passing".
A chat-only swarm with no runs and no PRs omits the tile.
It counts distinct URLs across runs and writers, with **M with CI passing**
beneath the total.
A URL counts as passing only when every recorded owner explicitly reports
pass. Run CI must also identify the same PR URL. A verified run is not a
substitute for CI evidence. Live boards omit the Pull requests tile.

The actions strip is Retry or Go deeper, Timeline, Details.
Retry and Go deeper are omitted when retained launch inputs are unavailable.

The outcome is one card. When the lead published a report, the card carries
its title, the conclusion with a copy button, **Open the report**, and a
footnote with who concluded,
when, the conclusion's length and the report's size. Without a report the card
is titled **Conclusion**. A swarm that did not conclude shows its cause
instead, such as **Stopped by you at 21:50**, **Out of turns at 40** or
**Failed: …**. A refused draft keeps its **Read the draft** action. A model
that refuses a reasoning setting reads **<model> can't take a thinking
setting. Retry with another model.** Outcome has no channel field.

Live details do not repeat an agent bench. The remaining details depend on
the lifecycle:

- **Agents · N** (ended only): proportional identity-colored agent cards with
  turns, role, tokens and the last event. They select the same read-only
  inspector, without monospace/stacked cards or ghost seats.
- **Spend** (live boards and cockpits only), once two agents have spent:
  a bar per agent, its fresh tokens against the swarm's, with the count and
  share beside it. For ended swarms, Spend by agent is on the record only,
  with fresh and cached tokens apart.
- **Produced so far** while live, **Produced** once ended: reports,
  dispatched runs, writer draft PRs, and, once ended, kept worktrees, as
  described below
- **Activity**: Ended Activity shows at most the newest 12 events, with actor,
  time and repeats, and no Read the full log row. Only live Activity adds
  Read the full log when earlier events exist; it opens the record's latest
  200 retained events, not the reading pane.
  Each row starts with who it is by: the agent's handle in its color, or
  **you**. A turn is one row, written when it ends: **turn 3 ok · 42 s · 2
  new**, or **nudged** or **run update** when no message woke it
- **About** (ended only): times, health and one transcript link. About leaves
  out the cause the Outcome card already shows; Details keeps it. The back-link
  to Ended swarms is a separate row outside About. The transcript link is
  omitted when its address is unavailable.

Timeline reaches Activity as well as the timeline and spend.

Task and context disclosures live in Details, not on the cockpit or
per-swarm board. Setup and live health evidence also live in Details.

### Produced so far

The cockpit and per-swarm board share one inventory, titled **Produced** once
the swarm ends. Artifacts appear in
landing order, oldest first: report publication time, run start time, and
PR opening time. Equal times keep report/run/writer order and ledger order.
Missing legacy times fall back to the swarm start. Run gate answers stay
immediately under their parent run. Kept worktrees follow the artifact rows
only after the swarm ends, never while running or stopping.

Local merges appear as ordinary activity lines naming writer, branch, and merge
commit, not as PR rows or CI evidence. The lead describes them in its conclusion.

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
cancellation that fails appears in Details, and in About after ending.

**Open the report** opens the swarm's report: a designed page the lead
publishes with `chat_report` before it concludes, with the answer first and the
evidence behind it, and tables, charts, or diagrams where they help. The lead
reads Keelson's canvas design guide first, and the page follows the same rules
as Keelson's canvas artifacts, so it matches the app's theme in light and dark.
The cockpit offers **Open the report** once the page exists, even while the
swarm is still running. A folded card offers **Report**, and an ended row marks
it with **◧ report**. The lead skips the report when the whole answer fits in a
sentence or two.

**Read the draft** opens the reading pane with the lead's refused draft and
the full task, not questions, gates, context, runs or activity. The Outcome
card shows the conclusion itself; its copy button copies all of it, not the
board preview.

## A swarm's record

**Timeline** shows the swarm's record, a page the rib draws, live or ended. It
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
- **Activity**: the latest 200 retained entries, newest first, with actor,
  date/time, event and repeat count. The operator reads as **you**, absent
  actors as **rib**, and unknown actors stay identified. Retained events are
  not a complete transcript.
- **Evidence given**: each context item's id, kind, title, source, retrieval
  time and commit

The page has no buttons: the board keeps every verb. A live record redraws
when the swarm's course changes, at most every five seconds. Swarms that ended
before this page existed show their events and runs but no turn bars, since
their turns were not kept.
The record shares timeline lanes, spans, marks and their titles with the cockpit,
not its deadline window or native rendering.

## Starting a swarm

The **Start a swarm** header above the index is a themed HTML launcher. With a
live or retained ended swarm and no restored expanded draft, it starts as
one compact line. Type in **Describe a problem. Agents work it out
together.** **Start** and **Options** sit beside it.

Compact Start uses chat mode with no project: nothing on disk is read or
changed. It sends no size, power, model, provider, workflow or lead-tool
overrides. **Options** expands the launcher in place without losing the
task. Expansion alone does not change
the default plan. **Fewer options** returns to the compact line, keeping the
task's first line and dropping every other choice.

With no live or retained ended swarms, the launcher opens expanded with
**Task**, **Project** and **Start swarm**. Starting-only entries do not compact
it.

Describe the question in **Task**. A GitHub issue or PR link in the task is
read with the gh CLI at Start and attached as a context item: title, body and
comments, with its URL and retrieval time. The task hint says **Will attach
issue #N from owner/repo**. At most 5 links are read. Agents cannot open other
links: any other URL or a bare `#123` is refused before a channel exists, so
paste the text instead. A link gh cannot read refuses Start with gh's reason.

**Project** starts on **No project · chat only**. Agents work from the task
and attached evidence; nothing on disk is read or changed. Registered projects
list as **name · path**, shortening the home directory to `~` and leaving
other paths absolute. Picking one gives agents read access to its checkout.
It does not grant write access or workflows.

**New project…** appears last in Project only when the host exposes optional
`createProject`, even with no registered projects. Older hosts omit it and
refuse crafted creation requests. Enter a required **Name** and an optional
**Folder**. The placeholder `~/keelson/<name>` is illustrative: a blank Folder
uses the host's workspace root plus the name, not a universal home-directory
path. The host expands a leading `~`; the rib passes it unchanged.

Start asks the host to create and register the project before admitting the
swarm. The host initializes a missing or empty folder with git and a first
empty "Initialize project" commit. An existing git repository or a nonempty
non-git folder is registered untouched; the rib does not repair it. Missing
git identity can cause a host initialization error. Host refusal messages
appear unchanged in a toast, with no swarm started. If creation succeeds but
swarm admission fails, the registered project remains available for retry.

For New project…, **Write is on and locked on** (checked and disabled). The swarm
uses the returned registered project ID and starts with write access. Writers
can work locally without origin after the project has a branch and a first
commit. Each writer uses a branch-isolated worktree. An existing repository
supplied as Folder follows the engine's remote or local write rules.
The sentence ends `creating <name>`, followed by `, then <workflows>` only
when present, then `, with beads` when tracker intent is on.

**Use the tracker** defaults on when `beads_init` is reachable, even with no
reachable lead tools. You can switch it off. After creation, the rib rechecks
initialization reachability and awaits
`callTool("beads", "beads_init", { project: created.name })` before admitting
the write swarm. Only successful initialization enables the requested,
currently reachable tracker lead tools, rechecked after initialization.
The launcher-only `beads_init` call is not a lead tool. Tracker off,
unreachable initialization or a missing reachability hook skips initialization
and starts without tracker tools. Without reachable initialization, the switch
is off and disabled with "no tracker yet in a new project"; the row is hidden
when no tracker lead tool is reachable either. A failed initialization
(including a missing cross-rib caller) still starts a write swarm without
tracker tools and reports `beads_init` with the original error in a toast.
An explicit reachability-probe error or admission refusal still refuses Start.
There is no automatic retry or project rollback.

Grant initialization and the six lead tools in `config.json`:

```json
{
  "crossRibGrants": {
    "chat": {
      "beads": [
        "beads_init",
        "beads_ready",
        "beads_show",
        "beads_create",
        "beads_update",
        "beads_close",
        "beads_dep"
      ]
    }
  }
}
```

The switch and initialization create no grants. The rib never runs `bd init`
itself; the host-owned beads tool initializes and refreshes the tracker.
Existing-project starts, Retry and Go deeper do not initialize a tracker.

With no project selected, the **ALSO ALLOW** group is absent. Selecting an
existing project reveals **Write**, **Run workflows** and **Use the tracker**,
all off.

**Write** permits code changes. The lead spawns writers, and only those writers
receive their own worktrees and branches. Turning it off restores read access.

**Run workflows** shows removable workflow chips. Enter or comma adds names;
paste whitespace/comma-separated names to add a batch. Duplicates are ignored.
Remove a chip with its remove button. The limit is **10** distinct workflows.
Valid pending text is added on Start; invalid or over-limit text stays in the
input and blocks Start. Names become `{ name, isolated: true }` grants and still
need the operator's `ribWorkflowGrants`. A host without workflow dispatch
support disables the switch and explains why. Answer approvals in Workflows
when the host has not granted automatic responses; remembered approval
refusals append a note to that row. The separate `ribApprovalGrants` policy
still applies to lead responses.

**Use the tracker** lists `beads_ready`, `beads_show`, `beads_create`,
`beads_update`, `beads_close` and `beads_dep`, in that order. Only host-reported
reachable tools are sent. Muted chips say **needs your grant: crossRibGrants**.
The switch does not create host grants. Without a reachability hook it is
disabled: **This host does not say which tools a lead may hold.** For existing
projects, a supported host reporting no reachable tools leaves it usable,
with all chips muted.
The rib rechecks lead-tool reachability on Start, Retry and Go deeper.

Turning switches off omits their grants; workflow chips stay for that project.
Changing or clearing the project resets all switches and chips, not the task.
Returning to New project… reapplies its defaults and keeps local Name and Folder edits.
The sentence follows your choices: **reading \<name\>**, then **and writing
on a branch** when Write is on, then **, then \<workflows\>** when workflows
are named, then **, with beads** when the tracker is on. The beads suffix
records switch intent, not a promise that every tracker tool was granted.

**Size** offers three plans. **Scout is selected by
default**. Each card shows its agents, turns, minutes and the effective
provider's models. Beside the figures, every card lists a Lead row and a Workers
row, even when they name the same model. Providers without pins use the matching
class model.

| Plan | For | Agents | Turns | Minutes |
| --- | --- | --- | --- | --- |
| Scout | A narrow question, or a first pass before a bigger run. | 3 | 20 | 15 |
| Crew | Most tasks: investigate, debate, and decide. | 5 | 40 | 30 |
| Fleet | Wide or hard problems that are worth the spend. | 8 | 80 | 60 |

**Lead model** and **Workers model** sit under the cards, beside **Project**, and start on
the plan's lead and the plan's workers. Provider groups contain each provider's
default model, class models and pinned models, without duplicates within a
group. **Other…** on **Lead model** accepts a model name and uses the effective default
provider. Each picker replaces its own row on the selected card and keeps the
card selected; picking only a lead keeps the plan's workers, and picking only
workers keeps the plan's lead. Lead and workers must come from one provider.
Picking a card clears both picks and restores that plan.

**Start swarm** sits at the end of the form with one sentence beside it: N
agents for up to N min, then the picked models, then where they
work, such as **3 agents for up to 15 min, chat only.** or **8 agents for up to
60 min on claude-opus-5.5, reading keelson and writing on a branch, then
fix-issue, with beads.** Untouched Scout sends no size, power or
model overrides. Crew records medium/balanced; Fleet records large/deep. A
named model records size, model and provider, with no power. For advanced
inputs, use
[`chat_swarm_start`](../../reference/tools-and-commands/#chat_swarm_start).

Compact **Start** and expanded **Start swarm** show **Starting…** and disable
the button for about two seconds as a duplicate-click guard, not a completion
signal. Your task stays in the box. Expanding during the guard keeps it active.
A successful start opens the swarm on the index. Its card shows starting
while it boots; a later failure becomes an ended row with the reason. An
outright refusal, such as an unknown project or a provider that cannot run
agents, appears in a host toast. After the guard clears you can retry.

Ordinary refreshes preserve local expansion, the draft, plan and model
choices, switches and chips while swarm presence stays unchanged. Additional
swarms and live-to-ended transitions keep the same launcher page. Crossing
between no live or retained ended swarms and at least one can replace the
page. A project-list, provider, capability, dispatch or remembered-refusal
configuration change can also replace the page. On Keelson v0.119.0 or later,
replacement documents restore the task verbatim, plan and model choices,
project, switches and chips, pending field text, and expanded
presentation. A restored expanded or multiline draft opens the full controls
instead of compact defaults.

New project… selection, Name and Folder restore verbatim while creation remains
available, even after the project list grows. Losing creation capability
restores chat-only with elevated access and workflow chips cleared.
Replacement documents force Write on for creation and preserve explicit
tracker opt-out. Losing initialization capability clears tracker consent.
Projects restore by ID for existing projects; a removed or hidden project
becomes chat-only and clears its switches and workflow chips. Current capability
restrictions still apply. A changed project root clears elevated consent until
you opt in again.
Named models keep their selected provider; an unavailable provider
requires choosing a model or plan again. Workflow chips restore exactly as
typed, in order; the host refuses unknown workflows at Start. The launcher
does not detect removed workflows.

Each Start dispatch clears the saved draft before sending the action, even if
the host refuses it. Local validation failures do not clear it. The current
document keeps its fields for retry; the next edit saves a fresh draft.

The bridge keeps state only in browser-tab memory, not durable storage.
A browser-page reload loses saved drafts. The host retains at most 64 view
keys and caps each JSON snapshot at 65,536 UTF-8 bytes. An oversized save
leaves the last accepted snapshot intact without truncating visible text.
Older hosts without the state bridge can discard local edits when the
launcher page is replaced.

A swarm started any other way, over MCP or from the `chat-swarm` workflow,
appears in the same live area.

## Retry or go deeper

A swarm that did not finish offers **Retry**, with a **Retry with** model
picker seeded with its effective model/provider, since the model is the usual
cause. A finished Scout or Crew offers **Go deeper**: one click
starts the same launch on the next plan up with that plan's models. A finished
Fleet offers neither. Both start a new swarm with the same task, project,
workflows, and context. Their hint names what they reuse, including how many
context items and when they were captured; context is not refreshed.

Retry reuses the saved size and plan power unless a model is named. Accepting
an unchanged plan-derived lead keeps the pair, not one model for everyone.
Deliberately saved model/worker overrides are retained unchanged. Choosing
another model drops the old worker override; clearing the model restores saved
power or its omitted default. The rib keeps each launch in its data directory
next to the history, and a server reset forgets them with it. Retry and Go
deeper recheck retained lead tools against the host's current reachability, so
revoked grants are dropped.

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
