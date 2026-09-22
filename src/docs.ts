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
import { ENDED_KEPT, READ_BOUNDS, START_BOUNDS, TRANSCRIPT_PAGE, WAIT_BOUNDS } from "./tools.ts";
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

Agents themselves can talk, and at most read a project checkout. They cannot
edit files, run shell commands, lease workspaces, or reach a forge, and no
prompt can grant those. Changes go through Keelson workflows instead: a swarm
started with \`workflows\` lets its lead start those workflows on the project,
and each run does its editing, committing, and pull requests in its own
worktree. See Workflow dispatch. Without \`workflows\` a swarm is read-only
investigation, and the caller carries its conclusion into an implementation
workflow itself. Anything an agent needs to know that is not in the checkout (an
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
| \`work_tools\` | \`read\` | \`read\` grants Read, Grep, and Glob. \`none\` is chat only. |
| \`size\` | \`medium\` | \`small\`, \`medium\` or \`large\`: the preset the limits start from. See Limits and completion. |
| \`max_agents\` | ${l.maxAgents} | Agent cap, lead included. 1 to ${START_BOUNDS.maxAgents}. |
| \`max_turns\` | ${l.maxTurns} | Total turns across the swarm. 1 to ${START_BOUNDS.maxTurns}. |
| \`max_turns_per_agent\` | ${l.maxTurnsPerAgent} | Turns each worker may take. 1 to ${START_BOUNDS.maxTurnsPerAgent}. The lead is bounded by \`max_turns\` only. |
| \`turn_timeout_s\` | ${l.turnTimeoutMs / 1_000} | Seconds one agent turn may run. ${START_BOUNDS.turnTimeoutS.min} to ${START_BOUNDS.turnTimeoutS.max}. |
| \`max_minutes\` | ${minutes(l.wallClockMs)} | Wall clock for the whole swarm. 1 to ${START_BOUNDS.maxMinutes}. |
| \`context\` | none | Evidence the agents cannot fetch themselves. See Task context. |
| \`provider\` | host default | Provider id used for every agent's turns. |
| \`model\` | provider default | Model for every agent, or for the lead alone when \`worker_model\` is set. |
| \`worker_model\` | \`model\` | Model for workers. |
| \`workflows\` | none | Catalog workflows the lead may start on the project, each \`{ name, isolated? }\`, at most ${START_BOUNDS.maxWorkflows}. Needs \`project\`. See Workflow dispatch. |

Project confinement: with a \`project\`, every turn runs with the project root as
its working directory and as its only allowed directory. Without a \`project\`
there is nothing to confine reads to, so \`work_tools: read\` grants nothing and
the swarm is chat only.

One provider serves the whole swarm. Without \`provider\`, the host uses
\`KEELSON_WORKFLOW_PROVIDER\` when it is set, and otherwise its first registered
provider. A \`provider\` that is not registered, or that cannot run agent turns,
fails the start before a channel is made. Without \`model\`, that provider
serves its own default model. The lead
always runs \`model\`; workers run \`worker_model\` when it is given. The
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
| \`chat_spawn\` | Add a worker with a handle, a role, and a narrow brief. Fails at the agent cap. |
| \`chat_done\` | Lead only. Conclude the swarm with its final answer, at most ${CONCLUSION_MAX} characters. |

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
a project and \`work_tools: read\`. The lead of a swarm started with \`workflows\`
also holds the workflow tools. See Workflow dispatch. An agent holds
nothing else.

# Workflow dispatch

> How a lead hands changes to Keelson workflows, and the evidence a run must show.

Start a swarm with a \`project\` and \`workflows\`, a list of catalog workflow
names. Its lead then holds these tools. Workers never do.

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
is in flight. Its wall clock still applies, so give long runs a larger
\`max_minutes\`. The lead cannot conclude while a run is live. A swarm that ends
any other way cancels its live runs.

Every run branches from the project's default branch, so a run cannot see
another run's change until that run's pull request is merged. Only the operator
merges. For dependent work the lead asks the operator to merge the pull request
it needs, and starts the dependent run once they say it is merged. The rib does
not enforce that order.

The summary's \`runs\` records each run: workflow, purpose, inputs, status,
checkout, the gate it waits on, the gates the swarm answered, the pull request
links found in its node output, its CI verdict, any error, and \`verified\`. The CI verdict is the run's own: the last
\`CI_GATE:\` line in its node output, or failing that the last \`CI_STATUS:\`
line, read as \`pass\`, \`fail\`, or \`unknown\` with the reason the workflow
gave. An isolated run is verified only when it succeeded in an established
worktree, produced a pull request, and its CI verdict is \`pass\`. A run that
need not be isolated is verified when it succeeded and its CI did not fail. A
run whose workflow could not read the checks is not verified.

# Operator tools

> The tools a caller uses to start, observe, wait on, and stop a swarm.

| Tool | For |
| --- | --- |
| \`chat_swarm_start\` | Start a swarm. Returns the swarm id at once, with a run id when the host supports durable ops. |
| \`chat_swarm_status\` | One swarm's agents, turns, status, and conclusion, or a list of all known swarms with each one's size and model. |
| \`chat_swarm_wait\` | Block until the swarm ends or \`timeout_s\` passes (default ${WAIT_BOUNDS.defaultS}, at most ${WAIT_BOUNDS.maxS}). The result begins with \`RUNNING\` or \`ENDED\`. |
| \`chat_swarm_stop\` | Stop a running swarm and revoke its agents' credentials. |
| \`chat_swarm_transcript\` | Read a swarm's channel, running or ended: every message in order with thread replies, or one \`thread\`. Pages by ${TRANSCRIPT_PAGE} characters with \`offset\`. Never starts a stopped managed server. |

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
      "The Chat rib for Keelson: read-only agent swarms that coordinate over a ClickClack channel. Covers starting a swarm, routing, the agent tool boundary, project confinement, limits, completion and stall semantics, steering, and what survives a restart.",
    content: corpus(),
  };
}
