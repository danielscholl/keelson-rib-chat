# keelson-rib-swarm

Agent swarms that coordinate over [ClickClack](https://github.com/openclaw/clickclack), as a [Keelson](https://danielscholl.github.io/keelson/) rib.

**Documentation: https://danielscholl.github.io/keelson-rib-swarm/**

Each agent in a swarm is a real ClickClack bot. Agents talk in a channel a human can watch and post in, a dispatcher wakes an agent when it is addressed, and agents can spawn more agents as a line of inquiry opens up. The whole swarm runs as one durable Keelson op, so it can be polled, steered, and cancelled like any other run.

## How it differs from a Chamber room

Chamber mediates every turn through one driver and deliberately has no bus. That fits a fixed roster taking turns over one transcript. This rib is for the other shape: independent agents, working in parallel, that have to find and reach each other. ClickClack is the bus, the durable record, and the live view.

## Setup

Link the rib into a Keelson checkout and start it:

```sh
bun install
bun run link:keelson
cd ../keelson && KEELSON_RIBS=swarm bun dev
```

With a `clickclack` binary on `PATH` (or `CLICKCLACK_BIN` set) that is all. The rib starts a local ClickClack with the first swarm, mints its own owner session, and stops the server when Keelson shuts down. Build the binary from a ClickClack checkout with `go build -o ~/bin/clickclack ./apps/api/cmd/clickclack`.

To use a ClickClack you run yourself, point the rib at it. It then never starts, stops, or wipes that server.

1. Run ClickClack and create an owner, following its quickstart.
2. Mint an owner session. It must be a human session, because a bot token cannot create bots:

   ```sh
   TOKEN=$(clickclack admin magic-link create --email you@example.com)
   export CLICKCLACK_TOKEN=$(clickclack login --magic-token "$TOKEN" --plain --no-store)
   ```

| Variable | Default | Meaning |
| --- | --- | --- |
| `CLICKCLACK_URL` | `http://localhost:8080` | The ClickClack server. |
| `CLICKCLACK_TOKEN` | keychain `rib_swarm_token` | Owner session used to mint and revoke the agents' bots. |
| `CLICKCLACK_WORKSPACE` | the only visible workspace | Required when the session sees several. |
| `CLICKCLACK_BIN` | `clickclack` on `PATH` | The binary a managed server runs. |
| `CLICKCLACK_PORT` | `18080` | The loopback port a managed server listens on. |

The rib manages a server only when `CLICKCLACK_URL` is unset and no owner session is configured.

## Use

In the **Swarms** tab, describe the task in **Start a swarm**, choose a project
if agents should read its checkout, and press **Start swarm**. **No project ·
chat only** is the default. Projects show their name and path (`~` for home).
Choose **Scout** (the default: 3 agents, up to 20 turns, about
15 minutes), **Crew**, or **Fleet**. **Lead model** and **Workers model**
sit under the plans, grouped by provider with **Other…** for a typed lead; each
one replaces only its own role, so the plan's other model stays. One sentence beside **Start swarm**
says how many agents run, for how long, on which model and where. With swarms
on the tab the launcher starts as one compact line; **Options** expands
it and **Fewer options** returns to it. An ended swarm offers **Retry** with a
model picker when it did not finish, or **Go deeper** onto the next plan when
a Scout or Crew finished. Selecting a project
reveals **Write**, **Run workflows** and **Use the tracker**, all off for an
existing project. **New project…** locks Write on and defaults the tracker on
when `beads_init` is reachable; you can switch the tracker off. Write
permits branch-isolated writers. Run workflows adds up to 10 removable
workflow-name chips with Enter, comma or paste, still subject to
`ribWorkflowGrants`. Use the tracker sends only host-reported reachable beads
tools, still subject to `crossRibGrants`; a host without a reachability hook
disables it. The Start sentence reflects the selected access. Changing or
clearing the project resets the switches and chips, not the task.
A GitHub issue or PR link in the task is read with the gh CLI at Start and
attached as a context item, up to 5 links; paste any other URL's text, since
another URL or a bare `#N` is refused. Refusals appear as
host toasts. **Starting…** guards duplicate clicks for about two seconds and
leaves the task intact. Ordinary refreshes preserve drafts, switches and chips;
on Keelson v0.119.0 or later, replacement documents restore them too, including
plan/model choices, pending text and expanded presentation.
Removed or hidden projects restore as chat-only with access and workflows
cleared. Named models retain their provider; an unavailable provider requires
reselection. Workflow chips restore exactly as typed, in order; the host refuses
unknown workflows at Start, rather than the launcher detecting removed names.
Each Start dispatch clears the saved draft, even on host refusal, but leaves
visible fields available for retry. Local validation failures do not clear it.
State lives only in browser-tab memory: a browser-page reload loses it.
The host retains at most 64 view keys, with a 65,536 UTF-8 byte JSON limit per
snapshot; oversized saves retain the last accepted snapshot without truncating
visible text. Older hosts without the state bridge can lose drafts on replacement.

From chat or over MCP, start a swarm with `chat_swarm_start`, then open the `swarm-<id>` channel in ClickClack to watch. Post in the channel to redirect it: an unaddressed message from a human goes to the lead.

| Tool | For |
| --- | --- |
| `chat_swarm_start` | Start a swarm. Returns the swarm id and a run id at once. |
| `chat_swarm_status` | One swarm's agents, turns, status, and conclusion, or a list of all. |
| `chat_swarm_wait` | Block until a swarm ends. For workflows. |
| `chat_swarm_stop` | Stop a swarm and revoke its credentials. |
| `chat_swarm_forget` | Drop ended swarms from the tab and history, by id or age. Transcripts stay in ClickClack. |
| `chat_swarm_transcript` | Read a swarm's channel, running or ended, with thread replies in order. |
| `chat_server_status` | Whether the server is managed or external, its URL, and whether it is running. |
| `chat_server_start` | Start the managed server ahead of a swarm. Returns the web UI address. |
| `chat_server_stop` | Stop the managed server. Transcripts stay on disk. |
| `chat_server_reset` | Wipe the managed server and start it empty. Needs `confirm: true`. |

The generic `run_status`, `run_events`, `run_cancel`, and `run_steer` tools work on the run id too. The `chat-swarm` workflow wraps start, wait, and report for the catalog.

`power` (`fast`, `balanced`, `deep`) picks the provider's model class and now also sets the reasoning effort of every turn (low, medium, high); an explicit `effort` on `chat_swarm_start` overrides it for the whole swarm, and `chat_swarm_status` reports the one in use.

The rib's operating contract (routing, tool boundary, limits, completion, steering, restarts) is served through `keelson_docs` as the `swarm` source, so an MCP caller does not need this repository.

Agents get `chat_post`, `chat_reply`, `chat_read`, `chat_roster`, `chat_context`, `chat_spawn`, and `chat_done`. Those refuse any caller that is not inside a swarm turn.

## Workflow dispatch

Select a project and enable **Run workflows** in the launcher to name the
workflows for this launch. The switch does not create host grants. Answer
approvals in Workflows when the host has not granted automatic responses;
remembered approval refusals appear beside the switch.

Unless a swarm is started with `work_tools: "write"` (see below), its agents never edit files themselves. A swarm started with a `project` and `workflows` lets its lead start those Keelson workflows on the project, such as `fix-issue`, through `chat_workflow_start`, `chat_workflow_status`, and `chat_workflow_cancel`. Each run edits, commits, and opens its pull request in its own worktree, and a run the rib finds in the live checkout is cancelled. Run updates wake the lead. When a run pauses at an approval gate, the rib posts the gate's prompt and plan in a thread, another agent reviews it, and the lead answers it for the operator with `chat_workflow_respond`, citing that review. The summary's `runs` records each run's branch, pull requests, CI verdict, the gates the swarm answered, and whether it is verified. Keelson must also grant the rib each workflow under `ribWorkflowGrants` in `config.json`, and each workflow whose gates the swarm may answer under `ribApprovalGrants`; without that, approvals wait for the operator.

## Write mode

Select a project and enable **Write** in the launcher for this mode.

A swarm started with a `project` and `work_tools: "write"` changes code itself.
Its lead spawns writers with `chat_spawn` and `writes: true`; every other agent
keeps read-only file tools on the project root. Each writer gets a git worktree
at `<project>/.worktrees/swarm-<id>-<name>` on branch
`keelson/swarm/<id>/<name>`, with `Read`, `Grep`, `Glob`, `Edit`, `Write`, and
`Bash` there. `Bash` is not sandboxed: it can reach anything the operator's user can.

Mode is decided once at boot by `git remote`. With origin, writers branch from
the fetched remote default and open draft PRs with `chat_pr_open`; only the
operator merges PRs. Without origin, the base is the root's symbolic HEAD branch,
which needs a first commit. Writers branch from its current tip without fetching.
After read-only peer review with `chat_diff`, the lead calls
`chat_merge({ writer, head_sha })` with the full reviewed SHA. Dirty checkouts,
changed heads, and AI-attributed commits are refused; conflicts list paths and
abort. Later writers inherit merges. Local mode never fetches, pushes, calls
`gh`, or changes remotes, and `chat_pr_open` points local writers to `chat_merge`.
Merges are recorded as ordinary activity and included in the lead's conclusion.
Cleanup removes clean writers only when their commits are pushed (origin) or
reachable from the local base; otherwise `worktrees` records why they remain,
including "not merged into <base>". **New project…** starts with Write locked
on; newly initialized repositories use this local mode without an origin.
An existing repository supplied as Folder keeps its remote or local write rules.

## Other ribs' tools

The launcher's **Use the tracker** switch requests `beads_ready`, `beads_show`,
`beads_create`, `beads_update`, `beads_close` and `beads_dep`. Unreachable chips
are muted and say `needs your grant: crossRibGrants`. The rib rechecks lead tools
at Start, Retry and Go deeper, so revoked grants are dropped.
For **New project…**, tracker consent invokes the host's governed `beads_init`
after creation and awaits it before write admission. Initialization needs its
own `crossRibGrants` entry and is not a lead tool. Failed initialization starts
without tracker tools and reports the original error. Neither the switch nor
initialization creates grants; existing-project starts, Retry and Go deeper never initialize.

`lead_tools` hands the lead tools that other ribs register, such as the beads rib's `beads_ready`, `beads_show`, and `beads_close`, so a swarm that works a backlog can read the live queue and close a bead once its pull request merges. Keelson projects a tool onto the lead's turns only when `config.json` grants it to the swarm rib under `crossRibGrants` (`"swarm": { "beads": ["beads_ready", "beads_close"] }`). Workers never hold them.

## Task context

Agents have no shell and no forge access, and `task` is capped at 8,000 characters. Pass what they cannot fetch (full issue bodies, PR diffs, reviews, check results) as `context` items on `chat_swarm_start`. An item can carry its source URL and retrieval time (an item without them is shown to agents as unattributed), and a `diff`, `review`, or `checks` item must carry the `head_sha` it was taken against. Every agent reads the items verbatim with `chat_context`, and is told to report missing or stale evidence instead of guessing.

## Who a message wakes

| Message | Wakes |
| --- | --- |
| `@handle` mention | that agent |
| reply by the agent that started the thread | every agent in the thread |
| reply by any other agent | the agent that started the thread |
| reply by a human | every agent in the thread |
| human, top-level, unaddressed | the lead |
| agent, top-level, unaddressed | nobody |

Writing to the board is free. Costing a peer a turn takes deliberate addressing. An agent's plain reply text is never posted, so silence is the default. Thread replies that did not wake an agent reach it as background on its next turn.

## Limits

A swarm ends when its lead calls `chat_done`, or when a limit trips: 5 agents, 40 turns in total, 12 turns per worker, 3 turns at once, a 5 minute turn, 30 minutes. `chat_swarm_start` can raise each of them but concurrency. An idle swarm nudges its lead twice, then ends as `stalled`. The lead is exempt from the per-worker cap, since capping it would leave the swarm leaderless.

A turn that times out or errors hands its messages to the agent's next turn. Three failed turns in a row retire a worker, or end the swarm as `error` when it is the lead. Messages hold 8,000 characters and the conclusion 20,000; a body over its limit is refused with its length, and a refused conclusion is kept on the summary as `draftConclusion`.

## Develop

```sh
bun test            # unit tests against an in-memory ClickClack
bun run typecheck
bun run check
CLICKCLACK_TOKEN=<owner session> bun dev/live-smoke.ts   # a real server, scripted agents, no model spend
CLICKCLACK_BIN=<binary> bun dev/live-smoke.ts            # the same through a managed server, plus adopt, reset, stop
bun dev/server.ts start | status | stop                  # run the managed server by hand; prints the UI address
keelson eval run evals/chat-swarm.eval.yaml              # run-to-run agreement of real swarms; needs ClickClack, spends model turns
```

The docs site lives in `docs/` (Astro Starlight): `cd docs && bun install && bun run dev`. See its [design tier](https://danielscholl.github.io/keelson-rib-swarm/design/) for the decisions behind the rib and what is deferred.
