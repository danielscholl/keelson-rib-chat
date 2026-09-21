---
title: Supply task context
description: Snapshot issue bodies, diffs, reviews, and check results, and pass them to a swarm so agents read them verbatim.
sidebar:
  order: 5
---

Agents cannot fetch anything from outside the checkout. You retrieve it first,
then pass it as `context` on `chat_swarm_start`. See
[Task context](../../concepts/task-context/) for why.

## Snapshot the evidence

Retrieve each piece whole and note when you did. With the GitHub CLI:

```bash
gh issue view 874 --repo danielscholl/keelson --json body,title,url
gh pr diff 880 --repo danielscholl/keelson
gh pr view 880 --repo danielscholl/keelson --json headRefOid,baseRefOid
gh pr checks 880 --repo danielscholl/keelson
```

Do not summarize. The point is that the acceptance criteria survive.

## Build the items

```json
{
  "task": "Review PR 880 against issue 874. Does it meet every acceptance criterion?",
  "project": "keelson",
  "context": [
    {
      "id": "issue-874",
      "kind": "issue",
      "title": "Record who authored an artifact",
      "source_url": "https://github.com/danielscholl/keelson/issues/874",
      "retrieved_at": "2026-09-20T18:00:00Z",
      "body": "## Proposed change\nAdd an `author` input. ..."
    },
    {
      "id": "pr-880-diff",
      "kind": "diff",
      "title": "PR 880 diff",
      "source_url": "https://github.com/danielscholl/keelson/pull/880",
      "retrieved_at": "2026-09-20T18:00:00Z",
      "head_sha": "3349e173782bedbe87fee14c42eab281b6b3028a",
      "body": "diff --git a/..."
    }
  ]
}
```

| Field | Required | Rule |
|---|---|---|
| `id` | yes | Kebab-case, up to 40 characters, unique. Agents cite it. |
| `kind` | yes | `issue`, `pr`, `diff`, `review`, `checks`, or `note`. |
| `title` | yes | One line, up to 200 characters. |
| `body` | yes | The full text, up to 60,000 characters. |
| `source_url` | no | An `http` or `https` URL. |
| `retrieved_at` | no | ISO 8601 with an offset, for example `2026-09-20T18:00:00Z`. |
| `head_sha` | for `diff`, `review`, `checks` | 7 to 40 hex characters. |
| `base_sha` | no | 7 to 40 hex characters. |

Up to 20 items, 300,000 characters across all bodies. A start that breaks a rule
is refused with the reason, and no swarm is created.

## Give it a source and a time

`source_url` and `retrieved_at` are optional, and you should set them on
anything that came from somewhere. An item without a retrieval time is shown to
agents as "retrieval time unknown", and they are told to treat it as possibly
stale. A `note` with neither is shown as an operator note, since your own words
have no source to go stale.

## Bind moving evidence to a commit

A diff, a review, and a check run all describe one commit. Set `head_sha` to the
commit they were taken against, and say in the task which head is under review.
An agent that finds the two disagree reports STALE EVIDENCE instead of reviewing
the wrong code.

## What agents see

The system prompt of every agent lists the items, one line each:

```text
- issue-874 [issue] Record who authored an artifact (1840 chars; source https://..., retrieved 2026-09-20T18:00:00Z)
```

`chat_context` with an id returns the text under an attribution header. Items
over 20,000 characters come back a page at a time, and each page says which
`offset` continues it.

## Related

- [Task context](../../concepts/task-context/): the reasoning behind the rules.
- [Investigate an issue with evidence](../../tutorials/investigate-an-issue/):
  this guide as an end-to-end run.
- [Tools and commands](../../reference/tools-and-commands/): the full input
  schema.
