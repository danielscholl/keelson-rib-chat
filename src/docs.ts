// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { RibDocsSource } from "@keelson/shared";
import { CONTEXT_BOUNDS } from "./context.ts";
import { BODY_MAX, ENDED_KEPT, READ_BOUNDS, START_BOUNDS, WAIT_BOUNDS } from "./tools.ts";
import { DEFAULT_LIMITS } from "./types.ts";

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

A swarm is for read-only investigation. Its agents can talk, and at most read a
project checkout. They cannot edit files, run shell commands, start workflows,
lease workspaces, or reach a forge. No prompt can grant those. To implement what
a swarm recommends, the caller runs an implementation workflow from
\`workflow_list\` itself, and carries the swarm's conclusion into it. Anything an
agent needs to know that is not in the checkout (an issue body, a PR diff, review
comments, CI results) must be supplied by the caller as task context.

# Starting a swarm

> The chat_swarm_start inputs, their defaults, and how project and model are chosen.

\`chat_swarm_start\` returns at once with a swarm id and, when the host supports
durable ops, a run id. The channel is named \`swarm-<id>\`.

| Input | Default | Meaning |
| --- | --- | --- |
| \`task\` | required | What the swarm should work out. At most ${BODY_MAX} characters. Every agent sees it in its system prompt, and the lead receives it as the kickoff message. |
| \`project\` | none | A registered Keelson project, by id or name. An unknown project fails the start. |
| \`work_tools\` | \`read\` | \`read\` grants Read, Grep, and Glob. \`none\` is chat only. |
| \`max_agents\` | ${l.maxAgents} | Agent cap, lead included. 1 to ${START_BOUNDS.maxAgents}. |
| \`max_turns\` | ${l.maxTurns} | Total turns across the swarm. 1 to ${START_BOUNDS.maxTurns}. |
| \`context\` | none | Evidence the agents cannot fetch themselves. See Task context. |
| \`provider\` | host default | Provider id used for every agent's turns. |
| \`model\` | host default | Model id used for every agent's turns. |

Project confinement: with a \`project\`, every turn runs with the project root as
its working directory and as its only allowed directory. Without a \`project\`
there is nothing to confine reads to, so \`work_tools: read\` grants nothing and
the swarm is chat only.

One provider and model apply to the whole swarm. There is no per-agent choice.

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
| reply in a thread | the agents already in that thread, plus anyone mentioned |
| human, top-level, unaddressed | the lead |
| agent, top-level, unaddressed | nobody |

Agent handles are prefixed with the swarm id, for example \`s3fk-lead\`. Writing
to the channel is free; costing a peer a turn takes deliberate addressing. An
agent's plain reply text is never posted, so silence is the default. An idle
agent with pending messages runs one turn with all of them batched in.

# Agent tools

> The tools a swarm agent holds, and the boundary around them.

| Tool | For |
| --- | --- |
| \`chat_post\` | A top-level message. Wakes no one without an @mention. |
| \`chat_reply\` | An answer inside a thread. |
| \`chat_read\` | Re-read the channel's latest messages, or one thread. ${READ_BOUNDS.defaultLimit} messages by default, at most ${READ_BOUNDS.maxLimit}. |
| \`chat_roster\` | The agents, their roles, and their turn counts. |
| \`chat_context\` | List the task context items, or read one verbatim with its attribution. |
| \`chat_spawn\` | Add a worker with a handle, a role, and a narrow brief. Fails at the agent cap. |
| \`chat_done\` | Lead only. Conclude the swarm with its final answer. |

These refuse any caller that is not inside a swarm turn. The calling agent is
taken from the turn context the engine sets, never from tool input, so an agent
cannot speak as another. Each agent posts with its own bot token, so ClickClack
stamps the author. Message bodies, briefs, and the conclusion are each at most
${BODY_MAX} characters.

Beside these, an agent holds Read, Grep, and Glob when the swarm was started with
a project and \`work_tools: read\`. It holds nothing else.

# Operator tools

> The tools a caller uses to start, observe, wait on, and stop a swarm.

| Tool | For |
| --- | --- |
| \`chat_swarm_start\` | Start a swarm. Returns the swarm id at once, with a run id when the host supports durable ops. |
| \`chat_swarm_status\` | One swarm's agents, turns, status, and conclusion, or a list of all known swarms. |
| \`chat_swarm_wait\` | Block until the swarm ends or \`timeout_s\` passes (default ${WAIT_BOUNDS.defaultS}, at most ${WAIT_BOUNDS.maxS}). The result begins with \`RUNNING\` or \`ENDED\`. |
| \`chat_swarm_stop\` | Stop a running swarm and revoke its agents' credentials. |

The generic \`run_status\`, \`run_events\`, \`run_cancel\`, and \`run_steer\` tools
work on the run id. The \`chat-swarm\` workflow wraps start, wait, and report.

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

Only the agent cap and the swarm turn budget can be set at start. The lead is
exempt from the per-worker cap, since capping it would leave the swarm
leaderless. A worker that has spent its turns is capped the next time a message
addresses it: the cap is announced in the channel and its messages are dropped.

| Status | Meaning |
| --- | --- |
| \`running\` | In flight. |
| \`done\` | The lead called \`chat_done\`. \`conclusion\` holds the answer. |
| \`stalled\` | The swarm went idle and the lead did not conclude after ${l.maxNudges} nudges. |
| \`exhausted\` | The turn budget or the wall clock ran out. |
| \`stopped\` | Stopped by \`chat_swarm_stop\`, \`run_cancel\`, or a host shutdown. |
| \`error\` | The swarm failed to start, or ClickClack revoked the owner session. |

For every ending but \`done\`, \`error\` holds the reason and the channel
transcript holds whatever was found. After \`chat_done\` no new turn starts;
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

# Restarts

> What survives a Keelson restart, and what does not.

Survives: the ClickClack channel and its full transcript, the bot identities,
and the terminal record of a finished run in the op registry.

Does not survive: a swarm in flight. Swarm state, inboxes, agent sessions, and
bot tokens are held in memory, so a restart ends the swarm without resuming it.
A clean shutdown stops each swarm and revokes its tokens; a crash leaves the
tokens unrevoked. \`chat_swarm_status\` answers for the last ${ENDED_KEPT} ended swarms of
the current process only; after a restart use \`run_status\` on the run id.

# Setup

> The ClickClack session and environment the rib needs.

The rib mints each agent's bot with an owner session. It must be a human
session, because a bot token cannot create bots.

| Variable | Default | Meaning |
| --- | --- | --- |
| \`CLICKCLACK_URL\` | \`http://localhost:8080\` | The ClickClack server. |
| \`CLICKCLACK_TOKEN\` | keychain \`rib_chat_token\` | Owner session used to mint and revoke the agents' bots. |
| \`CLICKCLACK_WORKSPACE\` | the only visible workspace | Required when the session sees several. |
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
