---
title: Let agents write code
description: Start a write swarm with isolated writers, delivering draft pull requests or reviewed local merges.
sidebar:
  order: 7
---

A write swarm changes code itself instead of handing the change to a Keelson
workflow. Its lead decides which agents write. Each writer gets its own git
worktree and branch, edits and tests there, and delivers a draft pull request
when the project has origin. Without origin, the lead lands reviewed writer
commits locally. The lead's file tools and every other agent stay read-only.

Use it to compare a swarm that writes against the
[workflow-driven path](../dispatch-workflows/), or for changes small enough that
a workflow's plan gate is more ceremony than the work.

## Start one

Pass `work_tools: "write"` with a `project`:

```json
{
  "task": "Fix the flaky retry test in packages/net and cover the timeout path.",
  "project": "keelson",
  "work_tools": "write"
}
```

Start it with [`chat_swarm_start`](../../reference/tools-and-commands/#chat_swarm_start),
or select a registered project and enable **Write** on the Swarms tab before
**Start swarm**. **New project…** still starts read-only with Write disabled;
select the registered project and enable Write for a subsequent swarm.
A write swarm without a project is refused before a channel exists.

## What a writer gets

The lead spawns a writer with `chat_spawn` and `writes: true`. Only the lead
can, and only in a write swarm. Mode is decided once at boot by `git remote`:
only a list without origin selects local mode. An existing but unusable origin
never falls back locally.

With origin, the rib:

1. Runs `git fetch origin` in the project.
2. Finds the remote default branch (`origin/HEAD`, else `origin/main` or
   `origin/master`). It does not use a potentially stale local branch.
3. Adds `.worktrees/` to `.git/info/exclude` when the project does not already
   ignore it. That file is local and never committed.
4. Creates `<project>/.worktrees/swarm-<swarm id>-<name>` on the new branch
   `keelson/swarm/<swarm id>/<name>`, cut from `origin/<default>`.

Without origin, the base is the root's current branch (symbolic HEAD),
which must already have a commit. Each writer branches from the current tip of
`refs/heads/<base>`, without fetching, so later writers inherit local merges.
The captured base branch stays the same for the swarm. Worktree paths,
branches, and the local exclude entry follow the same rules in both modes.

The writer's turns run in that worktree, with it as the only allowed
directory, and hold `Read`, `Grep`, `Glob`, `Edit`, `Write`, and `Bash`. No
other agent edits it, so two writers cannot collide. Its prompt tells it to
commit without AI attribution, to run the project's tests, typecheck, and lint
before reporting, and never to merge directly.

:::caution[Bash is not sandboxed]
The allowed directory confines the file tools, and Keelson's policy checks the
paths it can see in a shell command. Neither stops a command from reaching
other directories, the network, or the operator's credentials, including the
`gh` login the rib opens pull requests with. The worktree is isolation for the
checkout, not a sandbox. Only start a write swarm on a project and a machine
where that is acceptable, and use Keelson's `ask_on_shell` policy if you want
to approve each command.
:::

## Review and pull requests

Every agent in a write swarm holds `chat_diff`, which returns a writer's
commits, its uncommitted files, and `git diff origin/<default>...HEAD` or local
`git diff refs/heads/<base>...<head>` from its worktree. Local results include
the full head SHA. Reviewers have no shell, so this is how they read the change; they
can also `Read` the writer's files, since the worktree sits under the project
root. The lead is told to have an agent without writes review each writer's
change before it concludes.

With origin, a writer opens its pull request with `chat_pr_open`, passing a title and body.
The rib refuses when the worktree has uncommitted changes, when the branch has
no commits, or when any commit, the title, or the body credits an AI (a
`Co-Authored-By` trailer naming Claude or another assistant, a "Generated with"
line, a `Claude-Session` link). It lists the offending commits and pushes
nothing. Otherwise it pushes the branch and runs `gh pr create --draft` against
the default branch.

Each writer gets one pull request. Calling `chat_pr_open` again pushes the new
commits and returns the pull request already open. The summary's `prs` lists
each one with its writer and branch, and the lead's turns list them for the
report. Only the operator merges pull requests.

## Local review and merge

In local mode the writer commits, runs the project's existing checks, and
reports its branch and full head to the lead. The lead arranges read-only peer
review with `chat_diff`, waits for the writer's turn to settle, and calls
`chat_merge` with `writer` and `head_sha`, a full 40- or 64-character hexadecimal
commit SHA. Local writers cannot use `chat_pr_open`; its refusal names `chat_merge`.

The tool refuses a dirty root or writer, a changed head, an unexpected root or
writer branch, an existing merge/rebase, and any incoming commit carrying AI
attribution. It serializes on the existing per-root queue and runs:

```text
git merge --no-ff --no-edit --no-autostash -m "Merge writer @<handle> branch <branch> into <base>" <head_sha>
```

On conflict, the tool lists conflicting files, runs `git merge --abort`, and
returns their paths. Have the writer rebase or fix in its own worktree, rerun
checks, and get a new review before retrying. A changed head also needs a new
review. Keep the root clean and do not edit it during a merge.
The lead's file tools remain read-only; only the narrow merge tool modifies the root.

Successful merges are ordinary activity lines naming writer, branch, and merge
commit; the lead includes them in its conclusion. Local mode never fetches,
pushes, calls `gh`, adds remotes, or creates a forge repository. There are no
local PRs or CI verdicts. These are engine rules, not a shell sandbox.

## When the swarm ends

The rib checks each writer's worktree. One with no uncommitted changes and
every commit on the remote is removed, along with its local branch. Any other
is kept, and the summary's `worktrees` names the agent, path, branch, and why,
such as `2 uncommitted change(s), 1 commit(s) not pushed`. Clean kept ones up
with `git worktree remove` once you have what you need.

For local writers, removal instead requires every commit to be reachable from
`refs/heads/<base>`. Unmerged writers stay with reason "not merged into <base>".
Dirty or unsettled writers also stay; an unreadable base is a retention error.

## Related

- [Dispatch workflows](../dispatch-workflows/): the other way a swarm changes code.
- [Agents and swarms](../../concepts/agents-and-swarms/): what each agent can touch.
- [Tools and commands](../../reference/tools-and-commands/): `chat_spawn`,
  `chat_pr_open`, `chat_diff`, and `chat_merge` in full.
