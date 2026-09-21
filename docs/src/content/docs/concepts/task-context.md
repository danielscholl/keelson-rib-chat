---
title: Task context
description: Swarm agents cannot reach a forge, so the caller snapshots the evidence and hands it over whole. Agents read it verbatim and report what is missing.
sidebar:
  order: 5
---

A swarm investigating a GitHub issue can read the checkout. It cannot read the
issue. Its agents have no shell, no token, and no forge access, and that is
correct for read-only agents. The gap is on the intake side.

## What goes wrong without it

The `task` text is capped at 8,000 characters, so a caller summarizes. The
summary drops acceptance criteria, and agents fill the gap from what a name
suggests. In one real swarm, an issue defined an input named `author` as the
model ID that wrote an artifact. No agent had read the issue body, and the
conclusion treated `author` as a possible GitHub login.

## Snapshot, then delegate

Task context is evidence the caller retrieves **before** starting the swarm and
passes in whole: issue bodies, PR descriptions, diffs, review comments, check
results, or a plain note. Each item has an id the agents cite, a kind, a title,
and the full text. It can carry where the text came from and when.

The swarm stores each body verbatim, and nothing can change it for the life of
the swarm. Every agent, spawned workers included, sees the list of items in its
system prompt and reads a body with `chat_context`. The bodies stay out of the
prompt, so a large diff costs nothing until an agent asks for it.

The rib fetches nothing. There is no GitHub adapter in the rib or the harness,
and an agent never holds a credential.

## Attribution travels with the text

Each read is headed by the item's source URL, retrieval time, and SHAs, so a
quote stays attributable wherever an agent repeats it. Evidence about a moving
target is only meaningful against the commit it was taken from, so a `diff`,
`review`, or `checks` item is refused without a `head_sha`.

## Missing beats invented

Every agent's prompt carries three rules:

- The task context is the only external evidence it has.
- Requirements live in the context items, not in the task text's summary of
  them. Read the item before relying on it, and cite its id.
- If something is absent, has no retrieval time, or is bound to a different head
  SHA than the one under discussion, write **MISSING EVIDENCE** or **STALE
  EVIDENCE** and name what is needed.

A swarm started with no context says so in every agent's prompt. Asking for an
item that was not supplied returns an error that tells the agent to report it as
missing, along with the list of items that do exist.

The list of items, without the bodies, is kept in the swarm's summary, which
`chat_swarm_status` returns and which becomes the run's result. The record
shows what evidence a conclusion rested on.

## Related

- [Supply task context](../../guides/supply-task-context/): the fields and a
  worked example.
- [Investigate an issue with evidence](../../tutorials/investigate-an-issue/): an
  end-to-end run.
- [Tools and commands](../../reference/tools-and-commands/): the `context` input
  and `chat_context`.
