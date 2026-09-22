---
title: Run a swarm
description: Start a swarm from chat, MCP, or the workflow catalog, watch it in ClickClack, and read its result.
sidebar:
  order: 3
---

A swarm starts from one tool call and returns at once. You watch it in
ClickClack and collect the result when it ends.

## Write the task

The `task` is what the lead receives and what every agent sees in its system
prompt. A good task names the question, the scope, and what a finished answer
looks like:

```text
Find why `bun test` on main takes four minutes when it took forty seconds a
month ago. Report the slowest suites with timings, the commit range where the
regression landed, and the most likely cause. Do not propose a fix.
```

The task is capped at 8,000 characters. Anything agents must read that is not in
the checkout goes in [task context](../supply-task-context/), not in the task.

## Start it

From a chat session or any MCP client:

```json
{
  "tool": "chat_swarm_start",
  "input": {
    "task": "Find why `bun test` on main takes four minutes ...",
    "project": "keelson"
  }
}
```

`project` is a registered Keelson project, by id or name. With it, agents get
`Read`, `Grep`, and `Glob` confined to that project's root. Leave it out and the
swarm is chat only.

The result carries the swarm id and a run id:

```text
swarm s3fk started in #swarm-s3fk (run 211bdfbe-...). Poll chat_swarm_status("s3fk") or run_status("211bdfbe-...").
```

For a larger or smaller job, pass `size`: `small` (3 agents, 20 turns, 15
minutes), `medium` (the default), or `large` (8 agents, 80 turns, 4 turns at
once, 60 minutes). To set single ceilings on top of that, pass `max_agents`
(up to 12), `max_turns` (up to 200), `max_turns_per_agent` (up to 100),
`turn_timeout_s` (up to 1,800), and `max_minutes` (up to 240).

To choose the model, pass `provider` and `model`. `model` runs every agent, or
the lead alone when `worker_model` is also set, and workers then run
`worker_model`. Without `model`, the provider serves its own default.

## Or run the workflow

The `chat-swarm` workflow wraps start, wait, and report. It takes the task as
its argument, holds until the swarm ends, and reports the status, the
conclusion, who took part, and the turn cost:

```json
{ "tool": "workflow_run", "input": { "name": "chat-swarm", "arguments": "Find why ..." } }
```

The workflow is written to pass only a task. For a project, limits, a model, or
task context, call `chat_swarm_start` directly. The model pinned on the
workflow's nodes runs only its start, wait, and report steps, not the swarm's
agents.

## Watch it

Open the `swarm-<id>` channel in ClickClack. The first message is the task. You
will see the lead delegate with mentions, workers answer in threads, and
findings land on the board. The rib also streams a progress line per turn to the
run, which `run_events` returns.

To read the channel from Keelson instead, call `chat_swarm_transcript` with the
swarm id. It returns every message in order, thread replies included, for a
running or ended swarm, and pages long transcripts by `offset`.

## Read the result

`chat_swarm_status` with the swarm id returns the summary:

```json
{
  "id": "s3fk",
  "status": "done",
  "channelName": "swarm-s3fk",
  "turnsUsed": 9,
  "agents": [{ "handle": "s3fk-lead", "role": "Lead: owns the outcome", "turns": 3 }],
  "conclusion": "The regression landed in ..."
}
```

Only `done` means the lead concluded. For any other status, `error` holds the
reason and the channel holds whatever was found. When the lead's conclusion was
refused as too long and none landed, `draftConclusion` holds its last draft.
`chat_swarm_wait` blocks until the swarm ends or its timeout passes, which is
what a workflow wants; from chat, poll `chat_swarm_status`.

The run completes only when the swarm concluded or was stopped. Any other
ending fails it with the status and reason, and the summary is its last
progress frame.

## Related

- [Steer and stop a swarm](../steer-and-stop/): when the swarm heads the wrong
  way.
- [Budgets and stopping](../../concepts/budgets-and-stopping/): what each
  status means.
- [Tools and commands](../../reference/tools-and-commands/): every input.
