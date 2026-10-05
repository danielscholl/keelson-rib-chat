// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { RibDocsSource } from "@keelson/shared";
import { CONTEXT_BOUNDS } from "./context.ts";
import { DEFAULT_PORT } from "./server.ts";
import { MAX_TURN_FAILURES } from "./swarm.ts";
import {
  DIFF_PAGE,
  ENDED_KEPT,
  PR_BOUNDS,
  READ_BOUNDS,
  START_BOUNDS,
  TRANSCRIPT_PAGE,
  WAIT_BOUNDS,
} from "./tools.ts";
import { SETTLE_GRACE_MS } from "./turn-runner.ts";
import { BODY_MAX, CONCLUSION_MAX, DEFAULT_LIMITS, SIZE_PRESETS, SWARM_SIZES } from "./types.ts";

// The corpus is a source module, not a file read at runtime, so an installed
// package serves it with no filesystem or network dependency. keelson_docs
// slices it on H1: each H1 is a topic, and a leading blockquote its summary.
const minutes = (ms: number): number => Math.round(ms / 60_000);

function corpus(): string {
  const l = DEFAULT_LIMITS;
  return `# Overview

> What a chat swarm is, when to use one, and what it cannot do.

A swarm is a group of agents that coordinate over a ClickClack channel. Each agent
is a real ClickClack bot with its own identity, inbox, and resumable session. A
human can watch the channel and post in it. The whole swarm runs as one durable
Keelson op, so it can be polled, steered, and cancelled like any other run.

Use a swarm when a problem is worth several agents investigating in parallel and
talking it through. Do not use one for a single-agent question, or for a fixed
roster taking turns over one transcript (that is a Chamber room).

By default agents can talk, and at most read a project checkout. They cannot
edit files, run shell commands, lease workspaces, or reach a forge, and no
prompt can grant those. A swarm changes code one of two ways. Started with
\`workflows\`, its lead starts those Keelson workflows on the project, and each
run does its editing, committing, and pull requests in its own worktree. See
Workflow dispatch. Started with \`work_tools: write\`, its lead spawns writers:
agents that edit, run commands, and commit in their own git worktree. See Write
mode. Without either a swarm is read-only investigation, and the caller carries
its conclusion into an implementation workflow itself. Anything an agent needs to know that is not in the checkout (an
issue body, a PR diff, review comments, CI results) must be supplied by the
caller as task context.

# Starting a swarm

> The chat_swarm_start inputs, their defaults, and how project and model are chosen.

\`chat_swarm_start\` returns at once with a swarm id and, when the host supports
durable ops, a run id. The channel is named \`swarm-<id>\`.

| Input | Default | Meaning |
| --- | --- | --- |
| \`task\` | required | What the swarm should work out. At most ${BODY_MAX} characters. Every agent sees it in its system prompt, and the lead receives it as the kickoff message. |
| \`project\` | none | A registered Keelson project, by id or name. An unknown project fails the start. |
| \`work_tools\` | \`read\` | \`read\` grants Read, Grep, and Glob. \`none\` is chat only. \`write\` reads too, and lets the lead spawn writers; it needs \`project\`. See Write mode. |
| \`size\` | \`medium\` | \`small\`, \`medium\` or \`large\`: the preset the limits start from. See Limits and completion. |
| \`max_agents\` | ${l.maxAgents} | Agent cap, lead included. 1 to ${START_BOUNDS.maxAgents}. |
| \`max_turns\` | ${l.maxTurns} | Total turns across the swarm. 1 to ${START_BOUNDS.maxTurns}. |
| \`max_turns_per_agent\` | ${l.maxTurnsPerAgent} | Turns each worker may take. 1 to ${START_BOUNDS.maxTurnsPerAgent}. The lead is bounded by \`max_turns\` only. |
| \`turn_timeout_s\` | ${l.turnTimeoutMs / 1_000} | Seconds one agent turn may run. ${START_BOUNDS.turnTimeoutS.min} to ${START_BOUNDS.turnTimeoutS.max}. |
| \`max_minutes\` | ${minutes(l.wallClockMs)} | Wall clock for the whole swarm. 1 to ${START_BOUNDS.maxMinutes}. |
| \`context\` | none | Evidence the agents cannot fetch themselves. See Task context. |
| \`provider\` | host default | Provider id used for every agent's turns. |
| \`power\` | balanced | fast, balanced or deep. On copilot each power pins a lead model and a worker model (see Models); on another provider it is the provider's model for that class. It also sets the reasoning effort every turn asks for: low, medium or high. |
| \`effort\` | the power's | none, low, medium, high or xhigh: the reasoning effort for every agent turn, overriding the power's. A provider without effort support ignores it. |
| \`model\` | the power's lead model | Model for every agent, or for the lead alone when \`worker_model\` is set. Naming one switches the power's pins off. |
| \`worker_model\` | the power's worker model, else \`model\` | Model for workers. |
| \`workflows\` | none | Catalog workflows the lead may start on the project, each \`{ name, isolated? }\`, at most ${START_BOUNDS.maxWorkflows}. Needs \`project\`. See Workflow dispatch. |
| \`lead_tools\` | none | Other ribs' tools the lead holds, such as \`beads_ready\` or \`beads_close\`, at most ${START_BOUNDS.maxLeadTools}. See Agent tools. |

Project confinement: with a \`project\`, every turn runs with the project root as
its working directory and as its only allowed directory. A writer's turns use
its own worktree instead. Without a \`project\` there is nothing to confine reads
to, so \`work_tools: read\` grants nothing and the swarm is chat only, and
\`work_tools: write\` is refused.

One provider serves the whole swarm. Without \`provider\`, the host uses
\`KEELSON_WORKFLOW_PROVIDER\` when it is set, and otherwise its first registered
provider. A \`provider\` that is not registered, or that cannot run agent turns,
fails the start before a channel is made.

Models. Without \`model\`, the rib pins the models by \`power\` on copilot:
balanced runs claude-sonnet-5 as the lead and claude-sonnet-5.5 as the workers,
deep runs claude-opus-5.5 as the lead and claude-sonnet-5 as the workers, and
fast runs claude-sonnet-5.5 throughout. The lead's model is chosen for how it
closes a swarm and the workers' for speed; a \`worker_model\` alone keeps the
lead's pin, and \`model\` switches the pins off. A Haiku model is refused for
either role, since it rejects the reasoning effort every power asks for and a
lead on it fails three turns in a second. On any other provider, that
provider serves its model for the swarm's \`power\`, and the host's
\`modelClasses\` setting can change which model that is. The
\`chat-swarm\` workflow's model pin covers its own start, wait, and report steps,
not the agents.

# Task context

> How to give a swarm full issue bodies, diffs, reviews, and check results it cannot fetch.

Agents have no shell, no token, and no forge access, and \`task\` is capped at
${BODY_MAX} characters. A short summary in \`task\` loses acceptance criteria, and
agents then infer requirements from field names. So snapshot the evidence before
delegating and pass it as \`context\`: up to ${CONTEXT_BOUNDS.maxItems} items, each body at most
${CONTEXT_BOUNDS.maxItemChars} characters, ${CONTEXT_BOUNDS.maxTotalChars} in total. Bodies are stored verbatim and
cannot change for the life of the swarm.

| Field | Required | Meaning |
| --- | --- | --- |
| \`id\` | yes | Short kebab-case key the agents cite, for example \`issue-874\`. Unique. |
| \`kind\` | yes | \`issue\`, \`pr\`, \`diff\`, \`review\`, \`checks\`, or \`note\`. |
| \`title\` | yes | One line. |
| \`body\` | yes | The full text. Do not summarize it. |
| \`source_url\` | no | Where it was retrieved from. |
| \`retrieved_at\` | no | ISO 8601 time of retrieval. |
| \`head_sha\` | for \`diff\`, \`review\`, \`checks\` | The commit the evidence was taken against. The start is refused without it. |
| \`base_sha\` | no | The base the diff was taken against. |

Every agent, spawned workers included, sees the item index in its system prompt
and reads bodies with \`chat_context\`. Each read is headed by the item's source,
retrieval time, and SHAs, so a quote stays attributable. Items longer than
${CONTEXT_BOUNDS.pageChars} characters page by \`offset\`.

Agents are told that the context is their only external evidence, and to write
MISSING EVIDENCE or STALE EVIDENCE, naming what is needed, when an item is
absent, has no retrieval time, or is bound to a different head SHA. A swarm
started with no context says so in every agent's prompt. The item index, without
bodies, is kept in the swarm's status and durable result.

# Routing

> Which agents a message wakes. Every wake spends a turn.

| Message | Wakes |
| --- | --- |
| \`@handle\` mention | that agent |
| reply by the agent that started the thread | every agent already in the thread |
| reply by any other agent | the agent that started the thread |
| reply by a human, or in a thread a human started | every agent already in the thread |
| human, top-level, unaddressed | the lead |
| agent, top-level, unaddressed | nobody |
| the rib's run and gate posts (\`Run started\`, \`Run update\`, \`Approval needed\`, \`Approved\`, \`Changes requested\`) | nobody, even when they name a reviewer |

Mentions add to every row. Agent handles are prefixed with the swarm id, for
example \`s3fk-lead\`. Writing to the channel is free; costing a peer a turn takes
deliberate addressing. An agent's plain reply text is never posted, so silence
is the default. An idle agent with pending messages runs one turn with all of
them batched in.

A thread reply that does not wake a participant still reaches it: the next time
that agent wakes, its turn lists the reply as background, a one-line preview it
can read in full with \`chat_read\`. So a report to the lead in a shared thread
costs one turn, not one per participant, and the others still see it.

# Agent tools

> The tools a swarm agent holds, and the boundary around them.

| Tool | For |
| --- | --- |
| \`chat_post\` | A top-level message. Wakes no one without an @mention. |
| \`chat_reply\` | An answer inside a thread. See Routing for who it wakes. |
| \`chat_read\` | Re-read the channel's latest messages, or one thread. ${READ_BOUNDS.defaultLimit} messages by default, at most ${READ_BOUNDS.maxLimit}. |
| \`chat_roster\` | The agents, their roles, and their turn counts. |
| \`chat_context\` | List the task context items, or read one verbatim with its attribution. |
| \`chat_spawn\` | Add a worker with a handle, a role, and a narrow brief. Fails at the agent cap. In a write swarm the lead passes \`writes: true\` for a writer. |
| \`chat_done\` | Lead only. Conclude the swarm with its final answer, at most ${CONCLUSION_MAX} characters. Refused while a worker is mid-turn or has messages waiting, while a run is live, or while the lead's question to the operator is open; the draft is kept. |
| \`chat_pr_open\` | Writers only, in a write swarm. Push the writer's branch and open a draft pull request. See Write mode. |
| \`chat_diff\` | Any agent of a write swarm. Read a writer's commits and diff against the remote default branch. See Write mode. |
| \`chat_report\` | Lead only. Publish the swarm's report: a designed, self-contained HTML page the operator opens from the Swarms tab. Calling it again replaces the page. |

These refuse any caller that is not inside a swarm turn. The calling agent is
taken from the turn context the engine sets, never from tool input, so an agent
cannot speak as another. Each agent posts with its own bot token, so ClickClack
stamps the author. Message bodies and briefs are each at most ${BODY_MAX} characters.
The conclusion may run to ${CONCLUSION_MAX}, and reaches the channel in parts of at most
${BODY_MAX}. A body over its limit is refused with its length and how much to cut,
so the agent can shorten it in one retry. A refused conclusion is kept: if the
swarm ends without one, the summary carries the last draft as \`draftConclusion\`.
The conclusion is recorded before it is posted, so a failed post does not lose it.

Beside these, an agent holds Read, Grep, and Glob when the swarm was started with
a project and \`work_tools\` \`read\` or \`write\`. A writer holds Read, Grep,
Glob, Edit, Write, and Bash in its own worktree. See Write mode. The lead also holds Keelson's
\`canvas_design_guide\`, to read the design rules before it writes the report,
and the lead of a swarm started with \`workflows\` holds the workflow tools. See
Workflow dispatch. An agent holds nothing else.

A swarm started with \`lead_tools\` also hands its lead those tools from other
ribs, for example the beads rib's \`beads_ready\`, \`beads_show\`, and
\`beads_close\`, so it can read the live queue and close a bead once its pull
request merges. Keelson projects each one onto the lead's turns only when
\`config.json\` grants it to the chat rib under \`crossRibGrants\`, as in
\`"crossRibGrants": { "chat": { "beads": ["beads_ready", "beads_close"] } }\`.
A tool the operator has not granted is dropped from the turn, and the lead is
told to say so rather than work around it. Workers never hold them.

In the launcher, select a project and turn on Use the tracker to request the
six beads tools. Solid chips are host-reported reachable tools; muted chips say
\`needs your grant: crossRibGrants\`. Only reachable tools are sent, and the rib
rechecks reachability at Start and Run again, dropping revoked grants.
The switch does not create host grants. Without a reachability hook, it is
disabled: This host does not say which tools a lead may hold.

The report follows the same contract as Keelson's \`canvas_publish\`: inline CSS
and script only, the system font stack, colors as CSS custom properties with a
light override, and any categorical palette declared on \`<body>\` and checked
for color-vision separation and contrast. A page that breaks the contract is
refused with the reason, so the lead fixes it and calls again. The lead is told
to publish one before \`chat_done\` unless the whole answer fits in a sentence
or two.

# Workflow dispatch

> How a lead hands changes to Keelson workflows, and the evidence a run must show.

Start a swarm with a \`project\` and \`workflows\`, a list of catalog workflow
names. Its lead then holds these tools. Workers never do.

In the launcher, selecting a project reveals Run workflows. Turn it on and add
workflow names with Enter or comma, or paste names separated by whitespace or
commas. Remove a chip with its remove button. Up to ${START_BOUNDS.maxWorkflows}
distinct names become isolated grants for this launch. Pending valid text is
added on Start; invalid text blocks Start and stays editable. The switch is
disabled when the host cannot start workflows for a rib.

| Tool | For |
| --- | --- |
| \`chat_workflow_start\` | Start a granted workflow with a one-line \`purpose\` and its \`inputs\`. Returns the run id. |
| \`chat_workflow_status\` | The swarm's runs, or one: status, the gate it waits on and those answered, branch, pull requests, isolation, CI verdict, and whether it is verified. |
| \`chat_workflow_cancel\` | Cancel a live run. |
| \`chat_workflow_respond\` | Answer a paused run's approval gate for the operator, citing another agent's review: \`approve\`, or \`changes\` with the feedback the run applies. Held only when Keelson lets the rib answer gates. |

Two grants apply. The swarm's \`workflows\` list is the grant for this swarm.
Keelson's \`config.json\` must also name each workflow for the \`chat\` rib under
\`ribWorkflowGrants\`, or Keelson refuses the start. A granted start then passes
Keelson's policy as a \`workflow_run\` call. For the swarm to answer a
workflow's approval gates, \`config.json\` must also name it under
\`ribApprovalGrants\`.

Run workflows does not create either host grant. Answer approvals in Workflows
when the host has not granted the swarm permission to answer them. The launcher
appends remembered approval refusals to that row; existing \`ribApprovalGrants\`
can still let the lead answer reviewed gates as described below.

Every entry is isolated unless it says \`isolated: false\`. An isolated run must
establish its own worktree. Once a run's first node has finished, the rib checks
where it ran, cancels one it finds in the project's live checkout, and tells the
lead. Before that the harness reports the project root even for a run still
creating its worktree, so the check waits. Mark a read-only workflow such as
\`investigate\` with \`isolated: false\`.

A run's status changes appear in the channel as a Run update posted by the
lead, so the operator sees them without waking anyone. A pause, an ending, or a
cancellation also wakes the lead with the update in its turn. A run resuming
after its approval does not. The rib also re-reads live runs every 20 seconds.

When a run pauses at an approval gate, the rib posts an Approval needed message
and, in its thread, the gate's prompt and the files it names, such as the plan,
so every agent can read them. The lead answers the gate for the operator with
\`chat_workflow_respond\`, citing a review: a message in the swarm's channel,
written after the gate opened, by a worker or the operator. The rib refuses a
review the lead wrote. \`approve\` lets the run go on; \`changes\` sends it
the feedback to apply before it writes code. The answer, its reason, and its
review are posted in the gate's thread and kept in the run's \`approvals\`.
Without the \`ribApprovalGrants\` entry, or on a Keelson that cannot answer
gates for a rib, the operator answers with \`workflow_respond\` and the swarm
waits.

A swarm with a live run is not idle, so it is never nudged or stalled while a run
is in flight. Neither is a swarm with an open question for the operator: an agent
asks one by opening a sentence with \`@operator\` (or the owner's ClickClack
handle), or by asking a question that names them; a passing mention ("I'll show
both to @operator") is not a question. A reply in
the question's thread, a channel post that mentions the asker, or Dismiss on the
Swarms tab answers it; a note to the lead answers the lead's own questions and
no one else's. Its wall clock still applies, so give long runs a larger
\`max_minutes\`. The lead cannot conclude while a run is live, nor while a question it asked
the operator is still open. A swarm that ends
any other way cancels its live runs.

Starts on one project run one at a time: each waits, up to a minute, until the
run before it has its worktree or has finished a node, because concurrent
\`git worktree add\` calls race on the repository's config lock. The wait is
shared by every swarm dispatching onto that project.

Every run branches from the project's default branch, so a run cannot see
another run's change until that run's pull request is merged. Only the operator
merges. For dependent work the lead asks the operator to merge the pull request
it needs, and starts the dependent run once they say it is merged. The rib does
not enforce that order.

The summary's \`runs\` records each run: workflow, purpose, inputs, status,
checkout, the gate it waits on, every gate it paused at with who answered it,
the gates the swarm answered, the pull request links found in its node output
(except one another run already owns, such as a dependency's PR quoted in a bead),
its CI verdict, any error, and \`verified\`. The CI verdict is the run's own: the last
\`CI_GATE:\` line in its node output, or failing that the last \`CI_STATUS:\`
line, read as \`pass\`, \`fail\`, or \`unknown\` with the reason the workflow
gave. An isolated run is verified only when it succeeded in an established
worktree, produced a pull request, and its CI verdict is \`pass\`. A run that
need not be isolated is verified when it succeeded and its CI did not fail. A
run whose workflow could not read the checks is not verified.

# Write mode

> How a lead has agents change code themselves, each in its own worktree, and what confines them.

Select a project and turn on Write in the launcher, or start a swarm with a
\`project\` and \`work_tools: write\`. Without a project the
start is refused. The lead and every other agent read the project root as in
\`read\`. To have code changed, the lead calls \`chat_spawn\` with
\`writes: true\`; a worker's spawn with \`writes\`, or any spawn with \`writes\`
in a swarm that is not a write swarm, is refused.

Each writer gets its own git worktree at
\`<project>/.worktrees/swarm-<swarm id>-<name>\` on a new branch
\`keelson/swarm/<swarm id>/<name>\`. The rib runs \`git fetch origin\` first and
cuts the branch from the remote default branch (\`origin/HEAD\`, else
\`origin/main\` or \`origin/master\`), never from a local branch that may be
stale. When the project does not already ignore \`.worktrees/\`, the rib adds it
to \`.git/info/exclude\`, which is local and never committed. Worktrees on one
repository are made one at a time.

A writer's turns run with its worktree as the working directory and the only
allowed directory, and hold Read, Grep, Glob, Edit, Write, and Bash. It is the
only agent that edits its worktree, so writers cannot collide. It is told to
commit on its branch without AI attribution, to run the project's tests,
typecheck, and lint before it reports, and never to merge.

Bash is not sandboxed. The allowed directory confines the file tools, and
Keelson's policy checks the paths it can see in a command, but a shell command
can still reach anything the operator's user can: other directories, the
network, and credentials such as the \`gh\` login. Only grant write mode on a
project and a machine where that is acceptable.

| Tool | For |
| --- | --- |
| \`chat_pr_open\` | Writers only. Push the branch and open a draft pull request against the default branch, with a \`title\` (at most ${PR_BOUNDS.title} characters) and a \`body\` (at most ${PR_BOUNDS.body}). |
| \`chat_diff\` | Every agent of a write swarm. A writer's commits, what it has not committed, and \`git diff origin/<default>...HEAD\` in its worktree, paged by ${DIFF_PAGE} characters. |

\`chat_pr_open\` refuses a worktree with uncommitted changes, a branch with no
commits ahead of the default branch, and any commit, title, or body that credits
an AI: a \`Co-Authored-By\` trailer naming Claude or another assistant, a
"Generated with" line, a \`Claude-Session\` link, or Anthropic's noreply
address. It lists the offending commits so the writer can rewrite them, and
pushes nothing until they are clean. It then runs \`git push -u origin <branch>\`
and \`gh pr create --draft\` with the project's \`gh\` login. Each writer opens
one pull request: a second call pushes the branch again and returns the one
already open. Nothing in the swarm merges; merging stays with the operator.

The summary's \`prs\` records each one with its writer, branch, opening time,
and optional \`ci\` verdict and detail. The lead's turns list them for its report.
Another swarm's run that quotes one of these pull requests does not claim it.
The optional \`writeEnabled\` summary flag records write capability even before
the lead spawns a writer.

The rib reads current-head checks with \`gh pr view\` after opening or pushing,
then every 20 seconds, even without dispatched runs. A new pushed head clears
the old observation; reads for a different head are discarded. Each read has a
3-second timeout. CI is pass only for a nonempty rollup with successful evidence
and no failing, running, or unrecognized checks. Neutral/skipped checks may
accompany success, but alone they are unknown. Fail means a terminal failure;
running means checks are queued or in progress. Unknown means unfamiliar
evidence or a read fault, recorded with a detail and a fault entry. No checks
means not reported, never pass. On ending, the rib makes one final read with
the same timeout; a timeout keeps the last observation. Ended CI is a saved
observation, not a continuously monitored guarantee.

A reviewer reads a writer's change with \`chat_diff\`, and its files directly:
the worktree sits under the project root, inside every agent's allowed
directory. Reviewers have no Bash, so \`chat_diff\` is how they see the diff.

When the swarm ends, each writer's worktree is checked. One with no
uncommitted changes and no commit missing from the remote is removed, with its
local branch. Any other is kept, and the summary's \`worktrees\` lists its
agent, path, branch, and why it was kept.

# Operator tools

> The tools a caller uses to start, observe, wait on, and stop a swarm.

| Tool | For |
| --- | --- |
| \`chat_swarm_start\` | Start a swarm. Returns the swarm id at once, with a run id when the host supports durable ops. |
| \`chat_swarm_status\` | One swarm's agents, turns, status, and conclusion, or a list of all known swarms with each one's size, model, and tokens. |
| \`chat_swarm_wait\` | Block until the swarm ends or \`timeout_s\` passes (default ${WAIT_BOUNDS.defaultS}, at most ${WAIT_BOUNDS.maxS}). The result begins with \`RUNNING\` or \`ENDED\`. |
| \`chat_swarm_stop\` | Stop a running swarm and revoke its agents' credentials. |
| \`chat_swarm_forget\` | Drop ended swarms from the tab, status, and history: one \`swarm\`, or every one that ended more than \`older_than_days\` ago (0 for all). Needs \`confirm: true\`; transcripts stay in ClickClack. |
| \`chat_swarm_transcript\` | Read a swarm's channel, running or ended: every message in order with thread replies, or one \`thread\`. Pages by ${TRANSCRIPT_PAGE} characters with \`offset\`; \`tail\` reads only the newest messages. Never starts a stopped managed server. |

The generic \`run_status\`, \`run_events\`, \`run_cancel\`, and \`run_steer\` tools
work on the run id. The \`chat-swarm\` workflow wraps start, wait, and report.

Four more tools act on the ClickClack server itself. See Managed server.

# Limits and completion

> The budgets that bound a swarm, and the status it ends with.

| Limit | Default |
| --- | --- |
| Agents | ${l.maxAgents} |
| Turns across the swarm | ${l.maxTurns} |
| Turns per worker | ${l.maxTurnsPerAgent} |
| Turns running at once | ${l.maxConcurrent} |
| Wall clock | ${minutes(l.wallClockMs)} minutes |
| One turn | ${minutes(l.turnTimeoutMs)} minutes |
| Idle nudges to the lead | ${l.maxNudges} |

Those defaults are the \`medium\` size. \`size\` picks a preset, and the \`max_*\`
inputs then override single limits on top of it. A swarm whose limits moved off
its preset reports its size as \`custom\`.

| Size | Agents | Turns | Per worker | At once | Wall clock |
| --- | --- | --- | --- | --- | --- |
${SWARM_SIZES.map((k) => {
  const p = SIZE_PRESETS[k];
  return `| \`${k}\` | ${p.maxAgents} | ${p.maxTurns} | ${p.maxTurnsPerAgent} | ${p.maxConcurrent} | ${minutes(p.wallClockMs)} minutes |`;
}).join("\n")}

Every size gives a turn ${minutes(l.turnTimeoutMs)} minutes. Every limit but
concurrency and nudges can be set at start; concurrency moves only with size. The lead is exempt
from the per-worker cap, since capping it would leave the swarm leaderless. A
worker that has spent its turns is capped the next time a message addresses it:
the cap is announced in the channel and its messages are dropped.

A turn that times out or errors may never have shown the agent its messages, so
they go back to the front of its inbox, and its next turn says they are
repeated. After ${MAX_TURN_FAILURES} failed turns in a row a worker is retired as \`failed\` and
the channel is told. The same run of failures in the lead ends the swarm as
\`error\`, rather than spending a turn timeout on every wake. A timed-out turn
first waits up to ${SETTLE_GRACE_MS / 1_000} seconds for the provider to release the agent's session,
since the next turn resumes that same session.

| Status | Meaning |
| --- | --- |
| \`running\` | In flight. |
| \`done\` | The lead called \`chat_done\`. \`conclusion\` holds the answer. |
| \`stalled\` | The swarm went idle and the lead did not conclude after ${l.maxNudges} nudges. |
| \`exhausted\` | The turn budget or the wall clock ran out. |
| \`stopped\` | Stopped by \`chat_swarm_stop\`, \`run_cancel\`, or a host shutdown. |
| \`error\` | The swarm failed to start, ClickClack revoked the owner session, or the lead's turns kept failing. |

For every ending but \`done\`, \`error\` holds the reason and the channel
transcript holds whatever was found. A \`stalled\` reason names the cause it can
see: ClickClack unreachable when an agent last tried it, a conclusion refused
as too long, the lead's last turn failing, or plain silence. A conclusion the
lead records stands even when ClickClack cannot take its post: the summary and
the run hold it, and the lead is told the post failed. Bot tokens the swarm
could not revoke at its end are retried when the next swarm starts. After \`chat_done\` no new turn starts;
turns already in flight finish, then the swarm ends as \`done\`. A stop or a
limit that lands in that window wins: the status is not \`done\`, and
\`conclusion\` still holds what the lead recorded.

# Steering and cancellation

> How an operator redirects or ends a swarm in flight.

\`run_steer\` on the run id posts the note in the channel as the operator. It is
an unaddressed human message, so it wakes the lead. Posting in the channel from
the ClickClack UI does the same. An @mention in either reaches that agent
directly.

\`run_cancel\` and \`chat_swarm_stop\` both abort turns in flight, revoke every
agent's bot token, post a closing line, and end the swarm as \`stopped\`. The bots
and the transcript stay, so the record keeps its authors.

The run record differs. After \`chat_swarm_stop\` the run completes with the
swarm summary as its result. After \`run_cancel\` the host marks the run
\`cancelled\` at once and it carries no summary; \`chat_swarm_status\` still has it.

A run completes only when the swarm concluded or was stopped. A swarm that ends
\`stalled\`, \`exhausted\` with no conclusion, or \`error\` fails its run with the
status and reason, and the summary is the run's last progress frame.

# Swarms tab

> The Keelson tab that shows every swarm, what each asks of the operator, and each swarm's budget, agents, runs and outcome.

The rib publishes a Swarms tab. Needs you is one list across every live swarm:
one card per request, oldest first, with the oldest 12 shown when there are
more. Each card leads with the request (Review the plan for …, @planner asked:
…, ClickClack stopped answering, No agent has worked since …) and its verb
(Review plan, Read question, Open swarm, Message the lead). The task and swarm
id sit in the footnote. Open swarm expands that live swarm on the page.

The expanded live swarm is a cockpit on the page, not in the drawer. It runs:
the task and id with a lifecycle or needs-you pill and people dots; a state
line; once the lead has concluded, the Outcome card; peer-review gate cards;
an agent strip (busy, waiting, idle, capped, failed, with hatched open
seats); three Budget tiles (Turns with its spark and a forecast as its delta,
Time as a ticking time-left clock, fresh Tokens with cached in the sub); full-width Map, then Conversation and Message the lead;
Spend, Produced so far and Activity; then Open the report when one exists,
Open the record, Details, and Stop swarm last. Message the lead is expanded directly under
Conversation while running, unless the lead has concluded. Tokens says none yet
before any turn, or that the provider reported none when turns ran without usage.

Map is a native graph with columns You, Lead, Workers, Runs at ranks 0, 1, 2, 3.
Grandchildren remain in Workers. Agent tones show identity; run tones show status:
running/info, paused/caution, succeeded/ok, failed/error, cancelled/neutral.
You shows genuine human posts, counted independently of the recent buffer;
operatorMessageCount excludes kickoff and rib notices. Zero is measured zero;
old records say posts not recorded. The lead shows turns and status, workers
show turns against their cap and status, and runs show status and steps done.
Lead turns have no worker cap.

Solid spawn edges fold the parent's wakes into ×n, including ×0 when none were
recorded. Other wake edges count one wake per source per turn. Questions to you
are dashed asked ×n edges, including retained repeats. Each individual run links
to the lead with updates, not a fabricated per-run wake count. The aggregate
runs source is never a map node. You is informational; run nodes open the run;
agent nodes select the agent.

Map keeps at most 48 nodes and 200 edges. It retains You, the lead and the
selected agent before optional nodes, removes dangling edges, and names actual
shown/total counts in the heading for each clipped dimension.
Map owns a full-width row on both live surfaces; Conversation and the eligible
composer follow. Task and context disclosures live in Details, not on
the cockpit or per-swarm board. The reading pane also keeps the full task.

Selecting an agent opens its freshly composed inspector at the side. Selection
is shared by every viewer, separately from the expanded swarm choice; another
agent replaces the side drawer. One inspector key per swarm keeps it bounded.
The single-column board is designed for the 520 px inspector. Its identity
card shows status, role and a turns meter; the lead's meter is the swarm budget,
explicitly not a worker cap. Facts show the current or last turn, times,
outcome, took, wake sources, fresh tokens and cached tokens separately, and the
actually served model/provider. Missing evidence says not reported or not recorded,
never the requested model as served. Provenance names the parent and join time.
Writers show worktree, branch, draft PR and observed CI, with an Open PR link.

Said is this agent's recent messages only, newest first, each linked to its
thread. Turns keeps its recorded spans newest first. The quiet its messages ·
transcript ↗ link opens the channel, not a complete agent-only message history.
Message @agent posts as you with the roster's full handle mentioned, through
the unchanged router. It wakes the selected agent and spends a turn; additional
mentions in your note follow normal routing. The activity names the recipient.
The 8,000-character body limit includes the operator prefix and mention.
Capped/failed workers and exhausted budgets disable messaging with a reason.
Stopping, concluded and ended inspectors are read-only with no composer; ended
inspectors have no live clock, even when an old span has no recorded end.
Ended agent heads use the swarm lifecycle pill: done, stopped, stalled, out of
budget or failed, not the agent's last live status. Live, unended heads retain
the agent's actual status. A retained end time with a still-live status
suppresses the activity pill rather than inventing an outcome.

Read question opens the question inspector at the side, at
\`rib:chat:ask:<swarm>\`. Question contains the complete admitted question,
up to 8,000 characters, without its @operator addressing, the asker, absolute
asked time and a live since clock while actionable. Thread is a quiet link.
Actions offers Reply and Dismiss. Needs you cards, the index and the per-swarm
board keep their bounded question previews; only the question inspector shows
the full body. Legacy summaries cannot recover question text already truncated.

Read gate and a reviewing card's body open the gate inspector at
\`rib:chat:gate:<swarm>\`. Gate shows the full retained prompt. Files has one
prose card per named file, including empty files, read errors and truncation
notices. Review names the reviewer and thread, or says not recorded. Actions
offers Reply when the gate has an actionable thread; operator-only gates also
offer Open run. Peer gates have no approval control. Reply posts as you in the
thread and never approves. Review plan and Answer still open the run drawer,
where operator decisions belong.

Details opens at the side from the cockpit, live board or ended board, at
\`rib:chat:details:<swarm>\`. Task and context keeps the full task in ordered
disclosures of at most 4,000 characters, and every retained context excerpt
with its id, kind/title, source, retrieval time, head/base SHA and character
count. A single-part task is labeled Task; longer tasks use numbered parts.
Excerpts are not complete source bodies; missing legacy excerpts and
truncation are explicit. Setup names the size/preset adjustment, all effective
limits, requested models per role/provider, recorded overrides and effort.
Actually served models stay separate from requested settings; missing legacy
evidence says not recorded. Details durations use exact whole minutes or
seconds, including fractional seconds: 1800000 ms becomes 30 min, 300000 ms
becomes 5 min, 45000 ms becomes 45 s, and 90000 ms remains 90 s.
Setup has one Lead model row and one Worker model row, requested settings first.
Without explicit settings, the request reads "balanced power, host default".
Workers inherit the lead setting unless a worker role override is recorded.
Each role's disclosure labels served model and served provider per agent by
short handle, with explicit per-agent request overrides. Missing served
evidence says not reported; missing role agents are explicitly not recorded.
Recorded reasoning effort and aggregate token usage remain visible.
Health shows recorded faults, and Transcript has
one row. Details is read-only with no composer.

Each inspector publishes before opening. Question and gate selection is shared
by every viewer, independently of expanded-swarm and agent selection, with one
key per swarm and kind. Open inspectors refresh from current summaries. A
resolved question or advanced gate stays explicitly read-only without Reply
or Dismiss, not silently switched to another target. Stopping, concluded and
ended question/gate inspectors have no live clock or composer. Forgetting,
retention trimming and disposal release inspector keys.

The live Turns tile has a numeric value and its sub reads
"of N · pace over the last 5 min". At 3 of 20 turns, its value is 3 and its sub
is "of 20 · pace over the last 5 min". The forecast counts
turn start timestamps over the last five minutes, or since the start when younger,
with at least one minute as the rate's denominator. Older records without spans
use the last five pace buckets over their covered time, accounting for the partial
last minute; without buckets, they use turns so far. Fewer than one turn is reported as no pace.
With positive pace, it projects when the remaining turns run out. If that is
before the wall clock ends, it reads runs-out-first. Otherwise, it rounds the
projected unused turns and reads clock-first when at least a tenth of the total
turn budget (rounded up) would be unused; less reads fits.

| Reading | Delta text | Direction | Tone |
|---|---|---|---|
| runs-out-first | N left · out about hh:mm, before the clock | down | warn |
| clock-first | N left · about M unused at hh:mm | flat | caution |
| fits | N left · pace fits the clock | flat | none |
| no-pace | N left · no turn in 5 min | flat | none |
| out-of-turns | none left · agents finish their turns | down | warn |

N is turns left and M is projected unused turns. Delta text stays within 44
characters through the 200-turn bound. The rate is not displayed; times use the
local clock. The host
supplies the directional glyph, not the text. This is an advisory projection
computed when the board composes, not stored or periodically refreshed.
It changes nothing the engine does: no limits, nudges or stopping.
An ended Turns tile has no forecast and its sub stays "of N".
It retains the numeric used count and existing sparkline.

Conversation shows the eight newest channel messages, newest first. Each row
carries its author's short handle in an identity-colored chip (you for the
operator), ↳ on a reply, its HH:MM time, and a link to its thread. A final count
line links the transcript. The rib keeps only the newest 20 messages and their
first 200 characters; the row shows the first line, at most 90 characters, as
plain field text. Emphasis and code marks come off; HTML and markdown links stay
literal. The status tools and the durable op record leave this recent-message
buffer out, while messageCount counts every ingested message.
\`chat_swarm_transcript\` reads the full channel. Conversation is absent when
there are no recent messages and on ended boards, which keep Activity.

The buffer's optional kind is ask for an agent addressing @operator or the
owner's handle, run for the rib's quiet run and gate bookkeeping posts, and
conclusion for the lead's Conclusion posts. MessageKind is
\`"ask" | "run" | "conclusion"\`. report is reserved for the lead's published
report and omitted: \`chat_report\` never posts to the channel.

The state line names requests first, then busy agents with each turn number and
start time, waiting agents with their queue counts, paused swarm-answerable
runs with their gates and reviewers, and the conclusion. Otherwise it shows
the newest activity or waits for the lead's first turn. Stopping overrides
those clauses. Socket drops, channel faults, a failed lead turn and idle nudges
append health warnings. Times are HH:MM so the line stays true between frames.

With two or more live swarms a selection strip picks the expanded one. The
choice is shared by every viewer. The pinned canvas contract does not allow
selected items in its form tabs, so this is a wrapping action strip with the
chosen swarm marked. Without a live selection, the first needing swarm by its
oldest request expands, else the oldest running swarm. The others fold to one
running card each under Also live, with the same state line and a named
turn-budget meter; starting swarms stay cards there.

Ended swarms are rows grouped under the day they ended (Today, Yesterday, then
the weekday and date), the newest eight on the tab and every one in the history
drawer. A row leads with what came of the swarm: the report's title, the
conclusion's first sentence, or why it ended (Stopped by you, Out of turns at
40), then · for: and the task. A done row carries a check and the rest a
lifecycle chip; ↻ marks a rerun. The trailing names the model, turns, time,
the clock when it ended, how many runs verified, and ◧ report.

Requests come in a ladder: decide (a run waits at an approval only the operator
can answer, because the host refused the workflow under \`ribApprovalGrants\`
or offers no respond), question (an agent addressed \`@operator\` to ask something), connection
(ClickClack's socket closed twice without reopening; the card links the transcript
and offers Start ClickClack when the managed server is down), quiet (a run waits at an
approval the swarm could answer and no agent has worked since). The tab's badge
counts swarms with any request. An approval a peer is reviewing appears in the
state line and a reviewing card in the cockpit and per-swarm board, and counts
as no request.
If that gate becomes quiet, its quiet request keeps Read gate while Message the
lead stays the primary action.

An ended row opens its board in the drawer. The per-swarm board also still
composes for MCP clients, live or ended. Live, it runs: the requests, the outcome once a
report exists, a budget strip (turns with the same forecast delta, time, agents, fresh
tokens with cached beside them), the same full-width Map, then Conversation
and the eligible Message the lead composer, Open the record, Details and Stop,
then Spend, Produced so far and Activity. Ended section order: Outcome, Result,
actions, Agents, Produced so far when applicable, Activity when events exist,
About, then the separate Ended swarms back-link.
The ended Result orders Turns, Time, Tokens, Pull requests when eligible, then
Runs verified only when runs exist. There is no Agents tile.
Tokens is 0 when no turns ran; after positive turns without usage it is
unavailable, not an invented zero.
The Pull requests tile appears when workflows were named, \`writeEnabled\`
is true, a legacy writer has a worktree, or any run or writer PR exists.
Eligible write or dispatch swarms with no PRs show 0 with "0 with CI passing".
A chat-only swarm with no runs and no PRs omits the tile.
It counts distinct URLs across runs and writers, with "M with CI passing".
A URL counts as passing only when every recorded owner explicitly reports pass.
Run CI must also identify the same PR URL. Run verification is not a substitute
for CI. Live boards omit the Pull requests tile.
The actions strip is Run again, Open the record, Details.
Run again is omitted when retained launch inputs are unavailable.
The outcome is one card: under the report's title when the lead published one
(else Conclusion), the conclusion with a copy button, Open the report, Read the
conclusion; a swarm that did not conclude shows
its cause instead, such as Stopped by you at 21:50 or Out of turns at 40, and
offers Read the draft when a refused draft exists. Outcome has no channel field. The
live details no longer repeat an agent bench. Ended boards keep proportional
identity-colored agent cards that select the same read-only inspector, without
monospace/stacked cards or ghost seats. Spend stays on live boards and cockpits
once two agents have spent: each agent's fresh tokens against the swarm's.
For ended swarms, Spend by agent is on the record only, with fresh and cached
tokens apart. Both lifecycles retain Produced so far when applicable.
Ended Activity shows at most the newest 12 events, with actor, time and repeats,
and no Read the full log row. Only live Activity adds Read the full log when
earlier events exist; it opens the record's latest 200 retained events, not the
reading pane. Open the record reaches Activity as well as the timeline and spend.
Only ended boards keep About: times, health and one transcript link.
The transcript link is omitted when its address is unavailable.
The back-link to Ended swarms is a separate row outside About.
Each activity row carries its actor as a chip in the
agent's color, or you for the operator, and a turn is one row written when it
ends, with its outcome, how long it took and what woke it. Each bench card's
footnote names the agent's last event, and the Turns tile keeps its spark after
the swarm ends. A note posted with Message the lead shows in the activity at
once.

Produced so far is one shared inventory in the cockpit and per-swarm board.
Reports, dispatched runs, and writer draft PRs appear in landing order, oldest
first: report publication time, run start time, and PR opening time. Equal times
keep report/run/writer order and ledger order; missing legacy times fall back to
the swarm start. Run gate answers stay immediately under their parent run.
Kept worktrees follow all artifacts only after the swarm ends.

The report row shows its title, KB size, and Open the report. Run rows keep their
purpose, branch, every PR, elapsed time, status, error, worktree/PR/CI evidence
strip, links and Open run action; gate rows keep the reviewer, reason and review
link. Writer PR rows show the writer's short handle in its identity color, branch,
draft PR link, and CI pass, fail, unknown, running, or not reported, with observed
detail under a disclosure. Missing evidence never implies pass. Kept-worktree
rows show the recorded path and retention reason, not a claim about the current
filesystem.

While empty, the section names permitted workflows and eligible writers. Before
its first writer, a write-enabled swarm says the lead may spawn writers. Ended
placeholders use past tense. An empty chat-only swarm without workflows omits
the section; a published report still appears. Only the operator merges pull
requests, and the board never removes worktrees. Engine cleanup policy is unchanged.

Open the record shows the swarm's record, a page the rib draws: a timeline with
a lane per agent (turns as bars in the agent's color, hatched when a turn timed
out or failed), the operator's lane above and a lane per run below, with marks
for spawns, questions to the operator, operator posts, the report, the
conclusion, gates opened and answered, and verification; a graph of who woke
whom; spend by agent with fresh and cached tokens apart; each run in full;
Activity; and the evidence the agents were given. Activity shows the latest
200 retained entries, newest first, with actor, date/time, event and repeat
count. The operator reads as you, absent actors as rib, and unknown actors stay
identified. Retained events are not a complete transcript. It has no buttons; the board keeps every
verb. A live record redraws when the swarm's course changes, at most every five
seconds.

Read the conclusion and Read the draft open the reading pane. It contains the
applicable conclusion or refused draft and the full task, not questions, gates,
context, runs or activity. The conclusion's copy button copies all of it, not
the board preview.

The Start a swarm header is a themed HTML launcher. With a live or retained
ended swarm and no restored expanded draft, it starts as one compact New swarm line. Type in
What should the swarm work out? The Working session chip sits beside
${SIZE_PRESETS.medium.maxAgents} agents · ${minutes(SIZE_PRESETS.medium.wallClockMs)} min.
Compact Start uses chat mode with no project: nothing on disk is read or changed.
It sends no size, power, model, provider, workflow or lead-tool overrides.
More options or the Working session chip expands the launcher in place without
losing the task. Expansion alone does not change the default plan.

With no live or retained ended swarms, the launcher opens expanded with Task,
Project and Start swarm. Starting-only entries do not compact it.
No project · chat only is the default. Projects list as name · path, with the
home directory shortened to ~; picking one gives agents read access, not write
access or workflows.

How hard it works offers three plans. Working session is selected by default.
Each card shows its agents, turns, minutes and the effective provider's models.
Matching lead and worker models read as one model for lead and workers; split
pairs name both. Providers without pins use the matching class model.

| Plan | For | Agents | Turns | Minutes |
| --- | --- | --- | --- | --- |
| Quick look | A narrow question, or a first pass before a bigger run. | ${SIZE_PRESETS.small.maxAgents} | ${SIZE_PRESETS.small.maxTurns} | ${minutes(SIZE_PRESETS.small.wallClockMs)} |
| Working session | Most tasks: investigate, debate, and decide. | ${SIZE_PRESETS.medium.maxAgents} | ${SIZE_PRESETS.medium.maxTurns} | ${minutes(SIZE_PRESETS.medium.wallClockMs)} |
| Deep dig | Wide or hard problems that are worth the spend. | ${SIZE_PRESETS.large.maxAgents} | ${SIZE_PRESETS.large.maxTurns} | ${minutes(SIZE_PRESETS.large.wallClockMs)} |

Customize opens a drawer with Effort and Model; Hide keeps your choices.
Effort changes size budgets, not reasoning effort. Small, medium and large show
agents, concurrent turns, total turns, turns per worker and the time limit.
Model starts on "the plan's models". Provider groups contain each provider's
default model, class models and pinned models, without duplicates within a group.
Other… accepts a model name and uses the effective default provider.
Changing Effort keeps the plan's pair. Naming a model runs every agent on it.
A choice that no longer matches a card shows custom. Picking a card clears
the named model and restores that plan.

The live footer follows the choice: agents, up to N turns, about N min, then
quick models, balanced models, strongest models or one model. The models line
below shows the pair, or the named model for lead and workers.
Untouched Working session sends no size, power or model overrides. Opening
Customize alone does not change that. Quick look records small/fast; Deep dig
records large/deep. A named model records size, model and provider, with no power.

New project… appears last in Project only when the host exposes optional
\`createProject\`, even with no registered projects. Older hosts omit it and
refuse crafted creation requests. Enter a required Name and an optional Folder.
The placeholder \`~/keelson/<name>\` is illustrative: a blank Folder uses the
host's workspace root plus the name, not a universal home-directory path.
The host expands a leading \`~\`; the rib passes it unchanged.

Start asks the host to create and register the project before admitting the
swarm. The host initializes a missing or empty folder with git and a first
empty "Initialize project" commit. An existing git repository or a nonempty
non-git folder is registered untouched; the rib does not repair it. Missing
git identity can cause a host initialization error. Host refusal messages
appear unchanged in a toast, with no swarm started. If creation succeeds but
swarm admission fails, the registered project remains available for retry.

For New project…, Write is on and locked on. The swarm uses the returned
registered project ID and starts with write access. The scope footer reads
\`Creates <name> · writes on a branch\`, followed by selected workflow names
only when present, then \` · beads\` when tracker intent is on.
Use the tracker is shown only when at least one tracker tool is reachable.
It defaults off with "no tracker yet in a new project". Reachability is not
proof of an initialized tracker: beads tools require an initialized \`.beads/\`.
The rib never runs \`bd init\`. Explicit tracker opt-in still needs host grants,
rechecked after asynchronous creation before admission.

With no project selected, the ALSO ALLOW group is absent. Selecting an existing project
reveals Write, Run workflows and Use the tracker, all off. Write permits changes;
only writers spawned by the lead receive their own worktrees and branches.
Run workflows shows removable workflow chips: Enter or comma adds names,
whitespace/comma-separated paste adds a batch, duplicates are ignored, and the
limit is ${START_BOUNDS.maxWorkflows}. Valid pending text is added on Start;
invalid or over-limit text stays in the input and blocks Start.
Workflow names become \`{ name, isolated: true }\` grants, and still need
\`ribWorkflowGrants\`. A dispatch-blocked host disables the switch and explains
why. A note about remembered approval refusals says you answer them in Workflows;
the separate \`ribApprovalGrants\` policy is unchanged.
Use the tracker lists \`beads_ready\`, \`beads_show\`, \`beads_create\`,
\`beads_update\`, \`beads_close\` and \`beads_dep\`, in that order. Only
host-reported reachable tools are sent; muted chips say
\`needs your grant: crossRibGrants\`. This switch does not create host grants.
Without a reachability hook it is disabled with
This host does not say which tools a lead may hold.
For existing projects, supported-but-empty results leave it usable, with every chip muted.
The rib rechecks lead-tool reachability on Start and Run again.
Turning switches off omits their grants; workflow chips stay for that project.
Changing or clearing the project resets all switches and chips, not the task.
New project… always reapplies locked Write and keeps local Name and Folder edits.
The footer follows your choices: Reads <name>, optionally · writes on a branch,
workflow names or · no workflows, then optionally · beads. The beads suffix
records switch intent, not a promise that every tracker tool was granted.

A task that names a URL or #N is refused, since agents cannot open links;
Prepare in chat opens a chat that gathers the evidence and calls \`chat_swarm_start\`.
Start shows Starting… for about two seconds to guard against duplicate clicks,
not to track completion, and leaves the typed task in place. A refusal appears
as a host toast; a successful start opens the swarm on the index. Ordinary
refreshes preserve local expansion, the draft, plan and model choices, switches
and chips while swarm presence stays unchanged. Additional swarms and live-to-ended
transitions keep the same launcher page. Crossing between no live or retained
ended swarms and at least one can replace the page. A project-list,
provider, capability, dispatch or remembered-refusal configuration change can
also replace the page. On Keelson v0.119.0 or later, replacement documents restore
the task verbatim, plan and model choices, project, switches and chips, pending
field text, and expanded/Customize presentation. A restored expanded or multiline
draft opens the full controls instead of compact defaults.
New project… selection, Name and Folder restore verbatim while creation remains
available, even after the project list grows. Losing creation capability
restores chat-only with elevated access and workflow chips cleared.
Projects restore by ID for existing projects; a removed or hidden project becomes chat-only and clears
its switches and workflow chips. Current capability restrictions still apply.
A changed project root clears elevated consent until you opt in again.
Named models keep their selected provider; an unavailable provider requires
choosing a model or plan again. Workflow chips restore exactly as typed, in order;
the host refuses unknown workflows at Start. The launcher does not detect removed workflows.

Each Start dispatch clears the saved draft before sending the action, even if
the host refuses it. Local validation failures do not clear it. The current
document keeps its fields for retry; the next edit saves a fresh draft.
The bridge keeps state only in browser-tab memory, not durable storage.
A browser-page reload loses saved drafts. The host retains at most 64 view keys
and caps each JSON snapshot at 65,536 UTF-8 bytes. An oversized save leaves the
last accepted snapshot intact without truncating visible text.
Older hosts without the state bridge can discard local edits when the launcher
page is replaced.

An ended swarm's board offers Run again with Effort and Model only. It reuses
the same task, project, workflows and context. Its hint names the evidence and
when it was captured; context is not refreshed. Run again reuses saved plan
power unless a model is named; there is no Power field. Accepting an unchanged
plan-derived lead keeps the pair, not one model for everyone. Deliberately saved
model/worker overrides are retained unchanged. Choosing another model drops the
old worker override; clearing the model restores saved power or its omitted default.

One muted server line ends the index, even on an empty tab:
Server · ClickClack running on 127.0.0.1:18080 · managed · 1 swarm.
A managed server reads running or stopped; an external one reads reachable or
unreachable since HH:MM. Manage opens the server inspector at the side. Its boxed
rows show address and mode, then process, started, binary and data directory for
a managed server, or the last probe for an external one. Its head pill carries
an operation in progress or a failed one. A managed server offers Start or Stop,
Reset (type reset to confirm, refused while a swarm is live), and Log, which opens
the last 200 lines of the server log. An external server offers Retry to probe it
again; the rib never starts, stops or resets it.

# Restarts

> What survives a Keelson restart, and what does not.

Survives: the ClickClack channel and its full transcript, the bot identities,
and the terminal record of a finished run in the op registry.

Does not survive: a swarm in flight. Swarm state, inboxes, agent sessions, and
bot tokens are held in memory, so a restart ends the swarm without resuming it.
A clean shutdown stops each swarm and revokes its tokens; a crash leaves the
tokens unrevoked. \`chat_swarm_status\` answers for the last ${ENDED_KEPT} ended swarms,
which the rib keeps in \`swarms.json\` in its data directory, so they survive a
restart. A swarm a crash cut short is not among them; use \`run_status\` on its
run id. A server reset forgets them.

A managed ClickClack stops with Keelson, after the swarms have revoked their
tokens, and starts again with the next swarm. One a person started by hand is
left running. Its channels and transcripts are
on disk and return with it. If Keelson is killed, the server is left running and
the next start adopts it.

# Managed server

> The local ClickClack the rib runs when it is pointed at none, and the tools that start, stop, and wipe it.

With \`CLICKCLACK_URL\` unset and no owner session in \`CLICKCLACK_TOKEN\` or the
keychain, the rib runs its own ClickClack. With either one set the server is
external: the rib uses it and never starts, stops, or wipes it.

The managed server starts with the first \`chat_swarm_start\`, or on
\`chat_server_start\`. It listens on \`127.0.0.1\` only, keeps its data under the
rib's data directory, and needs a \`clickclack\` binary. The rib mints a fresh
human owner session for each swarm over the loopback API, so there is no token
to configure. Not supported on Windows.

| Tool | For |
| --- | --- |
| \`chat_server_status\` | Mode (\`managed\` or \`external\`), URL, whether it is running, pid, data directory, and live swarms. Starts nothing. |
| \`chat_server_start\` | Start the managed server, or confirm it is running. Returns the URL; the web UI is at \`<url>/app\`. |
| \`chat_server_stop\` | Stop the managed server. Channels and transcripts stay on disk. |
| \`chat_server_reset\` | Stop it, delete every channel, transcript, bot, and session, and start it empty. Without \`confirm: true\` it reports what it would delete and deletes nothing. |

Stop and reset refuse while any swarm is running or starting: stop the swarms
with \`chat_swarm_stop\` first. Start, stop, and reset refuse when the server is
external. A reset also forgets the ended swarms \`chat_swarm_status\` would list,
since their channels no longer exist. Swarm agents cannot call these tools.

A person can start the same server by hand with \`bun dev/server.ts start\` from
the rib's checkout, which prints the web UI address. The rib adopts it, and
leaves it running when Keelson shuts down: only \`chat_server_stop\`,
\`chat_server_reset\`, or \`bun dev/server.ts stop\` end it.
\`chat_swarm_start\` also reports the web UI address of the server it used.

If something the rib did not start already listens on the port, the start fails
and names the port. The rib never signals a process it cannot prove is its own.

| Variable | Default | Meaning |
| --- | --- | --- |
| \`CLICKCLACK_BIN\` | \`clickclack\` on \`PATH\` | The binary to run. |
| \`CLICKCLACK_PORT\` | \`${DEFAULT_PORT}\` | The loopback port the managed server listens on. |

# Setup

> The ClickClack session and environment an external server needs.

With none of these set the rib runs its own server and needs only a
\`clickclack\` binary. See Managed server. To use a server you run yourself:

The rib mints each agent's bot with an owner session. It must be a human
session, because a bot token cannot create bots.

| Variable | Default | Meaning |
| --- | --- | --- |
| \`CLICKCLACK_URL\` | \`http://localhost:8080\` | The ClickClack server. |
| \`CLICKCLACK_TOKEN\` | keychain \`rib_chat_token\` | Owner session used to mint and revoke the agents' bots. |
| \`CLICKCLACK_WORKSPACE\` | the only visible workspace | Required when the session sees several. |

The rib checks the server's \`/readyz\` before it starts a swarm and when it
reports auth status. A server that is down fails with
\`ClickClack is not reachable at <url>\` and the reason, before the swarm's run is
registered.
`;
}

export function chatDocsSource(): RibDocsSource {
  return {
    title: "Chat",
    summary:
      "The Chat rib for Keelson: agent swarms that coordinate over a ClickClack channel. Covers starting a swarm, routing, the agent tool boundary, write mode, limits, completion and stall semantics, steering, and what survives a restart.",
    content: corpus(),
  };
}
