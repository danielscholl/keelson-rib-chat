---
title: Dispatch workflows
description: Let a swarm's lead start Keelson workflows that make the changes, in isolated worktrees, and read the evidence each run leaves.
sidebar:
  order: 6
---

Agents in a swarm never edit files. When a swarm has to change a repository, its
lead hands the change to a Keelson workflow such as `fix-issue`, and the run
does the editing, committing, and pull request in its own worktree. You choose
which workflows a swarm may start.

## Grant the workflows

Two grants apply, and both must name the workflow.

The first is Keelson's. The rib's starts are denied by default, so name each
workflow for the `chat` rib in Keelson's `config.json`:

```json
{
  "ribWorkflowGrants": {
    "chat": ["fix-issue", "investigate"]
  }
}
```

The second is the swarm's own. Pass `workflows` to `chat_swarm_start` with a
`project`:

```json
{
  "task": "Fix issues 12 and 14 in this repository. They are independent.",
  "project": "my-app",
  "max_minutes": 120,
  "workflows": [
    { "name": "fix-issue" },
    { "name": "investigate", "isolated": false }
  ]
}
```

A workflow is isolated unless its entry says `isolated: false`. Mark only
read-only workflows that way.

## What the lead does

The lead gets `chat_workflow_start`, `chat_workflow_status`, and
`chat_workflow_cancel`. It gives each run a one-line purpose and the inputs its
workflow expects, and starts independent runs in parallel. Every status change
wakes it, and the update also appears in the channel as a **Run update**.

The lead cannot conclude while a run is live. It waits, or cancels the run.

## Answer approvals

Workflows like `fix-issue` stop at a human gate before they write code. The
paused run's node and prompt show in the channel, in `chat_swarm_status`, and in
the lead's next turn. No agent can answer it. Answer it yourself with Keelson's
`workflow_respond` tool, or from the run in the Keelson UI:

```json
{ "runId": "<run id>", "nodeId": "<node id>", "text": "approve" }
```

Text other than `approve` is feedback the workflow folds into its plan.

The swarm waits for you, but its wall clock keeps running, so give a swarm that
dispatches long runs a larger `max_minutes`.

## Isolation

An isolated run must establish its own worktree. The rib reads each run's
checkout as the run starts. A run found in the project's live checkout is
cancelled, and the lead is told why. Your working tree is never the place an
isolated run writes.

## Read the evidence

`chat_swarm_status` lists every run under `runs`:

| Field | Meaning |
|---|---|
| `status` | `running`, `paused`, `succeeded`, `failed`, or `cancelled`. |
| `pendingApproval` | The node and prompt a paused run waits on. |
| `checkout` | The path and branch the run used, and whether it established its own worktree. |
| `prUrls` | Pull request links found in the run's node output. |
| `verified` | An isolated run succeeded in its own worktree and produced a pull request. A non-isolated run succeeded. |

The rib does not read CI, so a verified run still needs its checks reviewed. A
swarm that ends before its runs finish cancels them.

## Related

- [Tools and commands](../../reference/tools-and-commands/): the workflow tool
  inputs.
- [Limits and statuses](../../reference/limits-and-statuses/): the wall clock and
  the other limits a dispatching swarm runs under.
