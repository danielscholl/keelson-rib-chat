---
title: Dispatch workflows
description: Let a swarm's lead start Keelson workflows that make the changes, in isolated worktrees, and read the evidence each run leaves.
sidebar:
  order: 6
---

Agents in a swarm never edit files. When a swarm has to change a repository, its
lead hands the change to a Keelson workflow such as `fix-issue`, and the run
does the editing, committing, and pull request in its own worktree. You choose
which workflows a swarm may start, and whose approval gates it may answer for
you.

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

To let the swarm answer a workflow's approval gates, name it under
`ribApprovalGrants` too. Without it, those gates wait for you:

```json
{
  "ribWorkflowGrants": { "chat": ["fix-issue", "investigate"] },
  "ribApprovalGrants": { "chat": ["fix-issue"] }
}
```

## What the lead does

The lead gets `chat_workflow_start`, `chat_workflow_status`,
`chat_workflow_cancel`, and, when Keelson lets the rib answer gates,
`chat_workflow_respond`. It gives each run a one-line purpose and the inputs its
workflow expects, and starts independent runs in parallel. Every status change
appears in the channel as a **Run update**. A pause, an ending, or a
cancellation also wakes the lead; a run resuming after its approval does not.

The lead cannot conclude while a run is live, nor while a question it asked the
operator is still open. It waits, or cancels the run.

## Dependent changes

Starts on one project run one at a time: each waits, up to a minute, until the
run before it has its worktree or has finished a node, because concurrent
`git worktree add` calls race on the repository's config lock. Every swarm
dispatching onto the project shares that queue.

Every run branches from the project's default branch, so a run cannot see
another run's change until that run's pull request is merged. When one change
needs another, the lead asks you in the channel to merge the pull request it
depends on, and starts the dependent run after you say it is merged. The rib
does not enforce that order, so give a swarm dependent work only when you
intend to merge as it goes.

## Approvals

Workflows like `fix-issue` stop at an approval gate before they write code. The
rib posts an **Approval needed** message, with the gate's prompt and the files it
names, such as the plan, in its thread. Then the swarm answers the gate for you:

1. The lead has another agent review the plan: a worker it @mentions, or a
   reviewer it spawns. The reviewer checks each acceptance criterion against a
   plan step, checks the plan stays in scope, spot-checks it against the code,
   and replies with approve or the changes needed.
2. The lead calls `chat_workflow_respond` with `approve`, or `changes` and the
   feedback the run applies before writing code, citing the review's message id
   and giving its reason.
3. The answer, its reason, and the review are posted in the gate's thread and
   kept in the run's `approvals`.

The rib refuses a review the lead wrote, or one written before the gate opened.
A message you post in the channel after the gate opens counts as a review, so
you can still steer the decision.

Without a `ribApprovalGrants` entry for the workflow, or on a Keelson that
cannot answer gates for a rib, the gate waits for you. Answer it with Keelson's
`workflow_respond` tool, or from the run in the Keelson UI:

```json
{ "runId": "<run id>", "nodeId": "<node id>", "text": "approve" }
```

Text other than `approve` is feedback the workflow folds into its plan. The
swarm waits, but its wall clock keeps running, so give a swarm that dispatches
long runs a larger `max_minutes`.

## Isolation

An isolated run must establish its own worktree. Once the run's first node has
finished, the rib checks where it ran. A run found in the project's live
checkout is cancelled, and the lead is told why. The check waits for that first
node because the harness reports the project root for a run that is still
creating its worktree. For `fix-issue` the first nodes only read the issue, and
nothing writes until after its approval gate.

## Read the evidence

`chat_swarm_status` lists every run under `runs`:

| Field | Meaning |
|---|---|
| `status` | `running`, `paused`, `succeeded`, `failed`, or `cancelled`. |
| `pendingApproval` | The node and prompt a paused run waits on, and the thread holding its prompt and files. |
| `approvals` | Each gate the swarm answered: the node, `approve` or `changes`, the reason, the feedback sent, and the review and its author. |
| `checkout` | The path and branch the run used, and whether it established its own worktree. |
| `prUrls` | Pull request links found in the run's node output, except one another run already owns, such as a dependency's PR quoted in the bead. |
| `ci` | The run's own CI verdict, `pass`, `fail`, or `unknown`, with the reason its workflow gave. |
| `verified` | An isolated run succeeded in its own worktree, produced a pull request, and its CI verdict is `pass`. A non-isolated run succeeded and its CI did not fail. |

The CI verdict comes from the run, not from GitHub. `fix-issue` watches the pull
request's checks and ends with a `CI_GATE:` line, and the rib reads the last one
in the run's output, or the last `CI_STATUS:` line when there is no gate. A
workflow that fails its gate fails the run. One that could not read the checks,
such as on a repository with no CI, reports `unknown`, and the run succeeds but
is not verified. A swarm that ends before its runs finish cancels them.

## Related

- [Tools and commands](../../reference/tools-and-commands/): the workflow tool
  inputs.
- [Limits and statuses](../../reference/limits-and-statuses/): the wall clock and
  the other limits a dispatching swarm runs under.
