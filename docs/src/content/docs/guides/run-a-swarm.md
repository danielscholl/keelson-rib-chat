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
its name and path, with the home directory shortened to `~`.

Choose a plan under **How hard it works**. **Working session is selected by
default**. Each card shows its agents, turns, minutes and the effective
provider's models. Providers without pins use the matching class model.

| Plan | For | Agents | Turns | Minutes |
| --- | --- | --- | --- | --- |
| Quick look | A narrow question, or a first pass before a bigger run. | 3 | 20 | 15 |
| Working session | Most tasks: investigate, debate, and decide. | 5 | 40 | 30 |
| Deep dig | Wide or hard problems that are worth the spend. | 8 | 80 | 60 |

**Customize** opens a drawer with **Effort** and **Model**; **Hide** keeps your
choices. Effort changes size budgets, not reasoning effort. Choose small,
medium or large to change agents, concurrent turns, total turns, turns per
worker and the time limit.

Model starts on **the plan's models**. Provider groups contain each provider's
default model, class models and pinned models, without duplicates within a
group. **Other…** accepts a model name and uses the effective default provider.
Changing Effort keeps the plan's pair. Naming a model runs every agent on it.
A choice that no longer matches a card shows **custom**. Picking a card clears
the named model and restores that plan.

The live footer follows the choice: agents, up to N turns, about N min, then
**quick models**, **balanced models**, **strongest models** or **one model**.
The models line below shows the pair, or the named model for lead and workers.
Untouched Working session sends no size, power or model overrides. Opening
Customize alone does not change that. Quick look records small/fast; Deep dig
records large/deep. A named model records size, model and provider, with no power.

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

For New project…, **Write is off and disabled**. The swarm uses the returned
registered project ID and starts with read access. Writers can work locally
without origin after the project has a branch and a first commit.
Then select the registered project and enable Write for
a new swarm. The scope footer reads `Creates <name>`, followed by selected
workflow names only when present, then ` · beads` when tracker intent is on.
**Use the tracker** is shown only when at least one tracker tool is reachable.
It defaults off with "no tracker yet in a new project". Reachability is not
proof of an initialized tracker: beads tools require an initialized `.beads/`.
The rib never runs `bd init`. Explicit tracker opt-in still needs host grants,
rechecked after asynchronous creation before admission.

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
The rib rechecks lead-tool reachability on Start and Run again.

Turning switches off omits their grants; workflow chips stay for that project.
Changing or clearing the project resets all switches and chips, not the task.
New project… always keeps Write disabled and keeps local Name and Folder edits.
The scope footer follows your choices: **Reads \<name\>**, optionally
**· writes on a branch**, workflow names or **· no workflows**, then optionally
**· beads**. The beads suffix records switch intent, not a promise that every
tracker tool was granted. Ordinary refreshes preserve your draft, switches and
chips. Project-list, provider, capability, dispatch or remembered-refusal
configuration changes can replace the page. On Keelson v0.119.0 or later,
replacement documents restore the task verbatim, plan and model choices,
project, switches and chips, pending field text, and expanded/Customize
presentation. A restored expanded or multiline draft opens the full controls
instead of compact defaults.

New project… selection, Name and Folder restore verbatim while creation remains
available, even after the project list grows. Losing creation capability
restores chat-only with elevated access and workflow chips cleared.
Projects restore by ID for existing projects; a removed or hidden project
becomes chat-only and clears its switches and workflow chips. Current capability
restrictions still apply. A changed project root clears elevated consent until
you opt in again.
Named models keep their selected provider; an unavailable provider
requires choosing a model or plan again. Workflow chips restore exactly as
typed, in order; the host refuses unknown workflows at Start. The launcher
does not detect removed workflows.

For an issue or PR, paste its text or use **Prepare in chat** to gather and
attach the evidence. A task naming a URL or `#N` is refused with a host toast.
**Starting…** is a two-second duplicate-click guard, not a completion signal;
the task stays in place and a successful start opens the swarm on the index.
Each Start dispatch clears the saved draft before sending the action, even if
the host refuses it. Local validation failures do not clear it. The current
document keeps its fields for retry; the next edit saves a fresh draft.

The bridge keeps state only in browser-tab memory, not durable storage.
A browser-page reload loses saved drafts. The host retains at most 64 view
keys and caps each JSON snapshot at 65,536 UTF-8 bytes. An oversized save
leaves the last accepted snapshot intact without truncating visible text.
Older hosts without the state bridge can discard local edits when the
launcher page is replaced.
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

## Run it again

An ended swarm's **Run again** form has **Effort and Model only**. It keeps the
same task, project, workflows and context, with the previous size and effective
model/provider seeded. The hint names the evidence and when it was captured;
context is not refreshed.

Run again reuses saved plan power unless a model is named; there is no Power
field. Accepting an unchanged plan-derived lead keeps the pair, not one model
for everyone. Deliberately saved model/worker overrides are retained unchanged.
Choosing another model drops the old worker override; clearing the model
restores saved power or its omitted default.

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
