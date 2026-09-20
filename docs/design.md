# Design

## The shape of the problem

Chamber's design record rejects a message bus, and gives the reason: a bus is what you build when each agent is an independent, long-running process that has to find and reach the others, and Chamber's Minds are stateless turns a driver already routes. This rib is for the case that record sets aside. It does not extend Chamber, because a bus would break the two invariants Chamber rests on: the driver as sole router, and the driver as sole authority on who authored a turn.

## Decisions

**ClickClack is the bus, not something the rib builds.** Durable cursors, replay after a dropped socket, threads, scoped revocable bot tokens, and a human UI already exist there. The rib talks to it only over the public HTTP and WebSocket API.

**An agent is an identity plus an inbox plus a resumable session, not a process.** The rib holds no long-lived agent loops. A message addressed to an agent lands in its inbox; an idle agent with a non-empty inbox runs one turn, with everything pending batched into it. `resumeSessionId` carries the agent's context from turn to turn.

**Authorship is the server's call.** Each agent posts with its own bot token, so ClickClack stamps the author. The calling agent reaches a tool through `turnContext`, which the engine sets and the agent cannot forge, so no agent can speak as another. Tokens live in memory only and are revoked when the swarm ends.

**Routing is a pure function.** `route()` takes a message, the roster, and the thread's participants and returns who wakes. The engine owns every side effect. This is the same split Chamber draws between a strategy and its driver, and it is why the routing rules are unit-tested without a server.

**The swarm is one durable op.** `registerOp` gives it an id at once, streams progress frames, and wires `run_cancel` to stop and `run_steer` to a message posted as the operator. This is Squad's coordinator pattern.

**Events carry ids, never bodies.** ClickClack's durable events hold a `message_id` only, and a thread reply arrives as `thread.reply_created` rather than `message.created`. The dispatcher handles both and hydrates each message.

**A message the swarm writes is ingested at once.** Waiting for its event to return over the socket would open a window where the swarm looks idle while a wake is still in flight. Local ingestion closes that window, a `seen` set drops the echo, and a short quiescence delay covers a human's message arriving late.

## Guardrails

Free-form agent chat burns budget without converging, which is why Chamber has a turn budget, an end vote, and an anti-monopoly cap. A bus has none of those for free, so this rib adds its own: a spawn cap, a swarm-wide turn budget, a per-worker turn cap, a concurrency limit, a wall clock, and a stopping rule (the lead concludes, or the swarm stalls after two nudges). The routing table is itself a guardrail: an unaddressed post from an agent wakes nobody.

## Deferred

- **A Keelson surface.** ClickClack's own UI is the live view. A board showing roster, budget, and status per swarm is the natural next step.
- **Surviving a server restart.** Swarm state and bot tokens are in memory. The op registry keeps the terminal record, but a swarm in flight does not resume.
- **Structured task state.** Agents coordinate by conversation only. A Beads ledger for who has claimed what would make decomposition less lossy than chat.
- **Minds as agents.** Mapping a Chamber Mind onto a swarm agent would give agents a persistent identity and memory across swarms.
- **Write access.** Agents get `Read`, `Grep`, and `Glob` confined to a project at most. Mutating work would need a leased worktree per agent.
