---
title: Tools and commands
description: Every tool the Chat rib registers, who may call it, and its inputs.
sidebar:
  order: 2
---

The rib registers twenty-one tools, all prefixed `chat_`. Nine are for the
operator or an orchestrating agent: five run swarms and four run the managed
ClickClack server. Twelve work only inside a swarm agent's turn: six for every
agent, two for the lead, and four workflow tools for the lead of a swarm granted
workflows. The rib registers no slash commands.

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
| `size` | `small` \| `medium` \| `large` | `medium` | The preset the limits start from. The `max_*` inputs override single limits on top of it. See [Limits and statuses](../limits-and-statuses/). |
| `max_agents` | integer | 5 | 1 to 12, lead included. |
| `max_turns` | integer | 40 | 1 to 200, across the swarm. |
| `max_turns_per_agent` | integer | 12 | 1 to 100. Turns each worker may take. The lead is bounded by `max_turns` only. |
| `turn_timeout_s` | integer | 300 | 30 to 1,800. Seconds one agent turn may run. |
| `max_minutes` | integer | 30 | 1 to 240. Wall clock for the whole swarm. |
| `context` | array | none | Task context items, below. |
| `provider` | string | host default | Serves every agent. An unregistered provider fails the start. |
| `power` | string | `balanced` | `fast`, `balanced` or `deep`. The provider's model for that class, for every agent without a named model. |
| `model` | string | the power's model | Every agent, or the lead alone when `worker_model` is set. |
| `worker_model` | string | `model` | Workers only. |
| `workflows` | array | none | Catalog workflows the lead may start, each `{ name, isolated? }`, at most 10. `isolated` defaults to `true`. Needs `project`. See [Dispatch workflows](../../guides/dispatch-workflows/). |

Without `provider`, the host uses `KEELSON_WORKFLOW_PROVIDER` when it is set,
and otherwise its first registered provider. Without `model`, that provider
serves its own default model. The lead always runs `model`.

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
`size`, `sizeBase`, `provider`, `model`, `workerModel`, `power`, `project`, `opId`,
`clickclack` (its URL and workspace), `health` (present only while something is
wrong: socket drops, a ClickClack fault, lead failures, nudges, refused
conclusions, or `quietSince` when the swarm went idle at an open gate),
`context` (the item list without bodies), `conclusion`, `draftConclusion`, and
`error`. `draftConclusion` is the lead's last refused conclusion, present only
when no conclusion landed. Each agent carries the model it asks for and the
provider that served its last turn, and the tokens its turns spent, as the
provider reported them. `usage` sums them for the swarm. Without an id, returns
a short row per swarm, starting swarms first, with its size, model, and tokens. The last 50 ended swarms
are kept in the rib's data directory, so they survive a restart.

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

### `chat_swarm_transcript`

| Input | Type | Default | Notes |
|---|---|---|---|
| `swarm` | string | required | A swarm id, running or ended. |
| `thread` | string | none | A thread's root message id. Omit to read the whole channel. |
| `offset` | integer | 0 | Character offset to continue a long transcript from. |

Reads a swarm's channel as the operator: every message in order, thread replies
included, or one thread. The result is headed by the channel, the message
count, and the character range shown, and pages by 40,000 characters; call
again with the `offset` it names. It answers for any swarm `chat_swarm_status`
knows. It never starts a stopped managed server, and refuses a thread outside
the swarm's channel. Swarm agents do not hold it.

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
| `chat_reply` | `message_id`, `body` | Answers in the thread of any message id. Wakes the thread's starter, or every agent in the thread when the starter replies. See [Routing](../../concepts/routing/). |
| `chat_read` | `thread_id?`, `limit?` | Reads the channel's latest messages, or one thread. `limit` defaults to 20, at most 50. |
| `chat_roster` | none | Lists agents with handle, role, turns, and status. |
| `chat_context` | `id?`, `offset?` | With no `id`, lists the context items. With one, returns the body under an attribution header, 20,000 characters per page. |
| `chat_spawn` | `handle`, `role`, `brief` | Adds a worker and posts the brief as a mention. Fails at the agent cap. |
| `chat_done` | `summary` | Lead only. Concludes the swarm. Posts the conclusion to the channel in parts of at most 8,000 characters. |
| `chat_report` | `title`, `html` | Lead only. Publishes the swarm's report, a designed HTML page the Swarms tab opens. Calling it again replaces it. |

`body` and `brief` are 1 to 8,000 characters, and `summary` 1 to 20,000. A
value over its limit is refused with its length and how many characters to cut.
A refused `summary` is kept, and a swarm that ends without a conclusion carries
it as `draftConclusion`. `handle` is up to 20
characters and is normalized to kebab-case and prefixed with the swarm id.
`role` is up to 200 characters.

`chat_reply` and `chat_read` refuse a message or thread outside the swarm's own
channel.

`chat_report` takes a `title` of up to 80 characters and an `html` body of up
to 512 KB. It follows the contract of Keelson's `canvas_publish`: inline CSS and
script only, the system font stack, colors as CSS custom properties with a
`:root[data-theme="light"]` override. A categorical palette declared on
`<body>` as `data-palette-dark` and `data-palette-light` is checked for
color-vision separation and contrast. An external script or stylesheet, or a
failing palette, is refused with the reason. The lead also holds Keelson's
`canvas_design_guide` to read the design rules first.

### Workflow tools

The lead of a swarm started with `workflows` also holds these. Workers never do.

| Tool | Inputs | Does |
|---|---|---|
| `chat_workflow_start` | `workflow`, `purpose`, `inputs?` | Starts a granted workflow on the project and tracks the run. Returns the run id. |
| `chat_workflow_status` | `run_id?` | Lists the swarm's runs, or one: status, the gate it waits on and those answered, branch, pull requests, isolation, CI verdict, and `verified`. |
| `chat_workflow_cancel` | `run_id` | Cancels a live run the swarm started. |
| `chat_workflow_respond` | `run_id`, `decision`, `review`, `reason`, `feedback?` | Answers a paused run's approval gate for the operator. `decision` is `approve` or `changes`, and `changes` needs `feedback`, the change the run applies. `review` is the id of a message another agent or the operator wrote after the gate opened. Held only when Keelson lets the rib answer gates. |

`chat_done` is refused while any run is live.

## Related

- [Agents and swarms](../../concepts/agents-and-swarms/): the tool boundary.
- [Dispatch workflows](../../guides/dispatch-workflows/): the workflow tools in use.
- [Supply task context](../../guides/supply-task-context/): the `context` input
  in use.
- [Limits and statuses](../limits-and-statuses/): the `status` and `limits`
  fields.
