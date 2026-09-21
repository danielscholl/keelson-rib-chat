---
title: Tools and commands
description: Every tool the Chat rib registers, who may call it, and its inputs.
sidebar:
  order: 2
---

The rib registers fifteen tools, all prefixed `chat_`. Eight are for the
operator or an orchestrating agent: four run swarms and four run the managed
ClickClack server. Seven work only inside a swarm agent's turn. The rib
registers no slash commands.

A tool failure is returned as an error result the caller can read. It never
throws into the harness.

## Operator tools

### `chat_swarm_start`

Starts a swarm and returns at once with the swarm id and, when the host supports
durable ops, a run id.

| Input | Type | Default | Notes |
|---|---|---|---|
| `task` | string | required | 1 to 8,000 characters. |
| `project` | string | none | A registered project's id or name. Unknown fails the start. |
| `work_tools` | `none` \| `read` | `read` | `read` grants `Read`, `Grep`, `Glob`, only when `project` is set. |
| `max_agents` | integer | 5 | 1 to 12, lead included. |
| `max_turns` | integer | 40 | 1 to 200. |
| `context` | array | none | Task context items, below. |
| `provider` | string | host default | Applies to every agent. |
| `model` | string | host default | Applies to every agent. |

A `context` item:

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | Kebab-case, 1 to 40 characters, unique in the array. |
| `kind` | enum | yes | `issue`, `pr`, `diff`, `review`, `checks`, `note`. |
| `title` | string | yes | One line, 1 to 200 characters. |
| `body` | string | yes | 1 to 60,000 characters, stored verbatim. |
| `source_url` | URL | no | `http` or `https`, up to 2,000 characters. |
| `retrieved_at` | datetime | no | ISO 8601 with an offset. |
| `head_sha` | string | for `diff`, `review`, `checks` | 7 to 40 hex characters. |
| `base_sha` | string | no | 7 to 40 hex characters. |

At most 20 items and 300,000 body characters in total. Unknown fields are
refused.

### `chat_swarm_status`

| Input | Type | Notes |
|---|---|---|
| `swarm` | string, optional | A swarm id. Omit to list every known swarm. |

With an id, returns the summary: `id`, `task`, `status`, `channelId`,
`channelName`, `startedAt`, `endedAt`, `turnsUsed`, `limits`, `agents`,
`context` (the item list without bodies), `conclusion`, and `error`. Without
one, returns a short row per swarm. Ended swarms are answered for from memory:
the last 20 of the current process.

### `chat_swarm_wait`

| Input | Type | Default | Notes |
|---|---|---|---|
| `swarm` | string | required | A swarm id. |
| `timeout_s` | integer | 120 | 1 to 600. |

Blocks until the swarm ends or the timeout passes. The result begins with
`RUNNING` or `ENDED`, followed by the summary. Built for workflows; from chat,
poll `chat_swarm_status`.

### `chat_swarm_stop`

| Input | Type | Notes |
|---|---|---|
| `swarm` | string | A running swarm's id. |

Aborts turns in flight, revokes every agent's bot token, and ends the swarm as
`stopped`.

### Generic run tools

The run id from `chat_swarm_start` works with the harness's `run_status`,
`run_events`, `run_cancel`, and `run_steer`. `run_cancel` stops the swarm the
way `chat_swarm_stop` does, and leaves the run `cancelled` with no summary.
`run_steer` posts its note in the channel as the operator.

## Server tools

These act on the ClickClack server when the rib [manages it](../configuration/#managed-server).
`chat_server_status` answers in either mode. The other three refuse when the
server is external, and swarm agents can call none of them.

| Tool | Inputs | Does |
|---|---|---|
| `chat_server_status` | none | Returns `mode` (`managed` or `external`), `url`, `liveSwarms`, and for a managed server `running`, `pid`, `adopted`, `operator` (started by hand), `binary`, and `dataDir`. Starts nothing. |
| `chat_server_start` | none | Starts the managed server, or confirms it is running. Returns the URL and the web UI address, `<url>/app`. A swarm starts the server on demand, so this is for opening the UI first. |
| `chat_server_stop` | none | Stops the managed server. Channels and transcripts stay on disk and return with the next start. |
| `chat_server_reset` | `confirm?` | Stops the server, deletes its data directory, and starts it empty. Without `confirm: true` it reports what it would delete and deletes nothing. |

`chat_server_stop` and `chat_server_reset` refuse while a swarm is running or
still starting. A reset deletes every channel, transcript, bot, and session, and
it can't be undone. It also clears the ended swarms `chat_swarm_status` lists,
because their channels are gone.

## Agent tools

These refuse any caller that is not inside a swarm turn. The calling agent is
read from the turn context the engine sets, never from input.

| Tool | Inputs | Does |
|---|---|---|
| `chat_post` | `body` | Writes a top-level message. Wakes no one without a mention. |
| `chat_reply` | `message_id`, `body` | Answers in the thread of any message id. |
| `chat_read` | `thread_id?`, `limit?` | Reads the channel's latest messages, or one thread. `limit` defaults to 20, at most 50. |
| `chat_roster` | none | Lists agents with handle, role, turns, and status. |
| `chat_context` | `id?`, `offset?` | With no `id`, lists the context items. With one, returns the body under an attribution header, 20,000 characters per page. |
| `chat_spawn` | `handle`, `role`, `brief` | Adds a worker and posts the brief as a mention. Fails at the agent cap. |
| `chat_done` | `summary` | Lead only. Concludes the swarm. |

`body`, `brief`, and `summary` are 1 to 8,000 characters. `handle` is up to 20
characters and is normalized to kebab-case and prefixed with the swarm id.
`role` is up to 200 characters.

`chat_reply` and `chat_read` refuse a message or thread outside the swarm's own
channel.

## Related

- [Agents and swarms](../../concepts/agents-and-swarms/): the tool boundary.
- [Supply task context](../../guides/supply-task-context/): the `context` input
  in use.
- [Limits and statuses](../limits-and-statuses/): the `status` and `limits`
  fields.
