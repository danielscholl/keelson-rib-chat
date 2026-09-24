---
title: Let agents write code
description: Start a write swarm whose lead spawns writers, each changing code in its own git worktree and opening a draft pull request.
sidebar:
  order: 7
---

A write swarm changes code itself instead of handing the change to a Keelson
workflow. Its lead decides which agents write. Each writer gets its own git
worktree and branch, edits and tests there, and opens a draft pull request. The
lead and every other agent stay read-only, and nothing in the swarm merges.

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

On the Swarms tab, pick a project and set **Agents may** to **write the
project**. A write swarm without a project is refused before a channel exists.

## What a writer gets

The lead spawns a writer with `chat_spawn` and `writes: true`. Only the lead
can, and only in a write swarm. The rib then:

1. Runs `git fetch origin` in the project.
2. Finds the remote default branch (`origin/HEAD`, else `origin/main` or
   `origin/master`). It never cuts from a local branch, which may be stale.
3. Adds `.worktrees/` to `.git/info/exclude` when the project does not already
   ignore it. That file is local and never committed.
4. Creates `<project>/.worktrees/swarm-<swarm id>-<name>` on the new branch
   `keelson/swarm/<swarm id>/<name>`, cut from `origin/<default>`.

The writer's turns run in that worktree, with it as the only allowed
directory, and hold `Read`, `Grep`, `Glob`, `Edit`, `Write`, and `Bash`. No
other agent edits it, so two writers cannot collide. Its prompt tells it to
commit without AI attribution, to run the project's tests, typecheck, and lint
before it opens a pull request, and never to merge.

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
commits, its uncommitted files, and `git diff origin/<default>...HEAD` from its
worktree. Reviewers have no shell, so this is how they read the change; they
can also `Read` the writer's files, since the worktree sits under the project
root. The lead is told to have an agent without writes review each writer's
change before it concludes.

A writer opens its pull request with `chat_pr_open`, passing a title and body.
The rib refuses when the worktree has uncommitted changes, when the branch has
no commits, or when any commit, the title, or the body credits an AI (a
`Co-Authored-By` trailer naming Claude or another assistant, a "Generated with"
line, a `Claude-Session` link). It lists the offending commits and pushes
nothing. Otherwise it pushes the branch and runs `gh pr create --draft` against
the default branch.

Each writer gets one pull request. Calling `chat_pr_open` again pushes the new
commits and returns the pull request already open. The summary's `prs` lists
each one with its writer and branch, and the lead's turns list them for the
report. Merging stays with you.

## When the swarm ends

The rib checks each writer's worktree. One with no uncommitted changes and
every commit on the remote is removed, along with its local branch. Any other
is kept, and the summary's `worktrees` names the agent, path, branch, and why,
such as `2 uncommitted change(s), 1 commit(s) not pushed`. Clean kept ones up
with `git worktree remove` once you have what you need.

## Related

- [Dispatch workflows](../dispatch-workflows/): the other way a swarm changes code.
- [Agents and swarms](../../concepts/agents-and-swarms/): what each agent can touch.
- [Tools and commands](../../reference/tools-and-commands/): `chat_spawn`,
  `chat_pr_open`, and `chat_diff` in full.
