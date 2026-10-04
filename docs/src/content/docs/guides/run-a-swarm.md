---
title: Run a swarm
description: Start a swarm from the Swarms tab, chat, MCP, or the workflow catalog, and read its result.
sidebar:
  order: 3
---

A swarm starts from the **Swarms** tab or one tool call and returns at once.
You watch it in Keelson or ClickClack and collect the result when it ends.

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

In the **Swarms** tab, type the task into **Start a swarm**, then press
**Start swarm**. **No project · chat only** is selected by default, so agents
read nothing on disk. Pick a project to grant read access; each option shows
its name and path, with the home directory shortened to `~`. The footer shows
the fixed medium limits (5 agents, up to 40 turns, about 30 minutes) and the
effective provider's balanced models. This launcher has no size, model, write
or workflow controls.

For an issue or PR, paste its text or use **Prepare in chat** to gather and
attach the evidence. A task naming a URL or `#N` is refused with a host toast.
**Starting…** is a two-second duplicate-click guard, not a completion signal;
the task stays in place and a successful start opens the swarm on the index.
See [the launcher](../swarms-tab/#starting-a-swarm) for draft retention and
retry behavior.

For advanced inputs, call `chat_swarm_start` from chat or any MCP client:

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

To choose how much model the agents get, pass `power`: `fast`, `balanced` (the
default) or `deep`. Each provider maps a power to one of its models, and the
host's `modelClasses` setting can change that map. To name a model instead, pass
`provider` and `model`. `model` runs every agent, or the lead alone when
`worker_model` is also set, and workers then run `worker_model`. An agent with a
named model ignores `power` for its model.

`power` also sets the reasoning effort every turn asks for: `fast` asks for
`low`, `balanced` for `medium`, `deep` for `high`. To set it apart from the
power, pass `effort` (`none`, `low`, `medium`, `high` or `xhigh`); it applies to
every agent, named model or not. A provider without effort support ignores it.
`chat_swarm_status` reports the effort in use as `effort`.

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

## Measuring swarms

A swarm's answer varies from run to run, so the first thing to measure is
agreement: run the same tasks several times and see how often they pass the
same checks. Until that pass rate is steady, a prompt change cannot be told
from noise. Measure before you tune.

The rib ships a case set at `evals/chat-swarm.eval.yaml`: three tasks, each
run three times, graded by a judge against claims a reader could check in the
workflow's report. It runs through the `chat-swarm` workflow, so it needs a
running Keelson with this rib and a ClickClack it can reach, and every case
starts a real swarm that spends model turns.

```sh
keelson eval run evals/chat-swarm.eval.yaml
```

Read the test split's pass rate and its interval first. A `NOISE` warning means
the interval is too wide to judge a change: add reps or cases before touching a
prompt. Once it is narrow, change one thing, run the set again, and let
`keelson eval compare before.json after.json` say whether the change stayed
within noise. Keelson's
[Evaluating workflows](https://danielscholl.github.io/keelson/docs/guides/evaluating-workflows/)
guide covers the case file and the verdict.

## Related

- [Steer and stop a swarm](../steer-and-stop/): when the swarm heads the wrong
  way.
- [Budgets and stopping](../../concepts/budgets-and-stopping/): what each
  status means.
- [Tools and commands](../../reference/tools-and-commands/): every input.
