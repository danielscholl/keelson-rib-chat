// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import {
  type ClickClackClient,
  ClickClackError,
  type ClickClackEvent,
  type Subscription,
} from "./clickclack.ts";
import {
  type ContextItem,
  contextIndex,
  renderContextIndex,
  renderContextItem,
} from "./context.ts";
import { nudgeText, renderTurn, systemPrompt, type TeamMember } from "./prompts.ts";
import { route } from "./router.ts";
import { type RunAgentTurn, runTurn } from "./turn-runner.ts";
import {
  BODY_MAX,
  type ChatMessage,
  CONCLUSION_MAX,
  DEFAULT_LIMITS,
  type SwarmAgent,
  type SwarmLimits,
  type SwarmStatus,
  type SwarmSummary,
} from "./types.ts";

// The swarm engine. ClickClack is the bus and the durable record; this is the
// dispatcher that turns "a message addressed an agent" into "that agent runs a
// turn". Agents hold no process of their own: each is a bot identity, an inbox,
// and a resumable provider session.

export const AGENT_TOOLS = [
  "chat_post",
  "chat_reply",
  "chat_read",
  "chat_roster",
  "chat_context",
  "chat_spawn",
  "chat_done",
] as const;

const MESSAGE_EVENTS = new Set(["message.created", "thread.reply_created"]);
const AUTH_REVOKED = 1008;
// Consecutive failed turns before an agent is retired (or, for the lead, the swarm ends).
export const MAX_TURN_FAILURES = 3;
// Thread replies an agent was not woken for, kept for its next turn.
const BACKGROUND_KEPT = 12;

export interface SwarmOptions {
  task: string;
  owner: ClickClackClient;
  workspaceId: string;
  runAgentTurn: RunAgentTurn;
  limits?: Partial<SwarmLimits>;
  // Built-in tools granted beside the chat_* set (e.g. Read, Grep, Glob).
  workTools?: readonly string[];
  // Evidence snapshotted by the caller; immutable for the life of the swarm.
  context?: readonly ContextItem[];
  cwd?: string;
  provider?: string;
  model?: string;
  // Model for workers; the lead always uses `model`.
  workerModel?: string;
  log?: (message: string, data?: unknown) => void;
  // How long the swarm must sit idle before that counts as quiescent.
  quiesceMs?: number;
  reconnectMs?: number;
  id?: string;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function newSwarmId(): string {
  return `s${Math.random().toString(36).slice(2, 6)}`;
}

// Splits a long body into parts of at most `max` characters, preferring a
// paragraph break, then a line break, so a part rarely ends mid-sentence.
export function splitBody(text: string, max: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf("\n\n");
    if (cut < max / 2) cut = window.lastIndexOf("\n");
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}

export function sanitizeHandle(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20);
  return cleaned || "agent";
}

export class Swarm {
  readonly id: string;
  readonly task: string;
  readonly limits: SwarmLimits;
  readonly startedAt = new Date().toISOString();
  readonly finished: Promise<SwarmSummary>;

  private readonly opts: SwarmOptions;
  private readonly owner: ClickClackClient;
  private readonly agents = new Map<string, SwarmAgent>();
  private readonly tokens = new Map<string, string>();
  private readonly inboxes = new Map<string, ChatMessage[]>();
  private readonly background = new Map<string, ChatMessage[]>();
  private readonly threadParticipants = new Map<string, Set<string>>();
  // Thread root id to the agent that started it; absent for a human's thread.
  private readonly threadStarters = new Map<string, string>();
  private readonly failures = new Map<string, number>();
  // Agents whose last turn failed, so their next prompt says why messages repeat.
  private readonly redelivery = new Map<string, string>();
  private readonly seen = new Set<string>();
  private readonly controller = new AbortController();
  private readonly done = deferred<SwarmSummary>();

  private channel = { id: "", name: "" };
  private status: SwarmStatus = "running";
  private cursor = "";
  private subscription: Subscription | undefined;
  private eventChain: Promise<void> = Promise.resolve();
  private pendingEvents = 0;
  private busy = 0;
  private turnsUsed = 0;
  private nudges = 0;
  private kickedOff = false;
  private conclusion: string | undefined;
  private draftConclusion: string | undefined;
  private refusedConclusions = 0;
  private lastLeadFailure: string | undefined;
  private error: string | undefined;
  private endedAt: string | undefined;
  private quiesceTimer: ReturnType<typeof setTimeout> | undefined;
  private wallClockTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  private constructor(opts: SwarmOptions) {
    this.opts = opts;
    this.owner = opts.owner;
    this.id = opts.id ?? newSwarmId();
    this.task = opts.task;
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.finished = this.done.promise;
  }

  static async start(opts: SwarmOptions): Promise<Swarm> {
    const swarm = new Swarm(opts);
    try {
      await swarm.boot();
    } catch (e) {
      await swarm.finish("error", errText(e));
      throw e;
    }
    return swarm;
  }

  private log(message: string, data?: unknown): void {
    try {
      this.opts.log?.(message, data);
    } catch {
      // a throwing logger must never break the swarm
    }
  }

  private async boot(): Promise<void> {
    // Captured first: everything the swarm itself creates lands after this
    // cursor, so the kickoff reaches the lead through the same event path a
    // human's message does.
    this.cursor = await this.owner.tailCursor(this.opts.workspaceId);
    this.channel = await this.owner.createChannel(this.opts.workspaceId, `swarm-${this.id}`);
    await this.addAgent({ handle: "lead", role: "Lead: owns the outcome", lead: true });
    this.connect();
    this.wallClockTimer = setTimeout(
      () => void this.finish("exhausted", "wall clock limit reached"),
      this.limits.wallClockMs,
    );
    const kickoff = await this.owner.postMessage(
      this.channel.id,
      `**Swarm ${this.id}**\n\n${this.task}`,
    );
    this.log(`swarm ${this.id} started in #${this.channel.name}`);
    this.enqueueMessage(kickoff);
  }

  private connect(): void {
    if (this.status !== "running") return;
    this.subscription = this.owner.subscribe({
      workspaceId: this.opts.workspaceId,
      afterCursor: this.cursor,
      onEvent: (event) => this.onEvent(event),
      onClose: (code) => this.onSocketClose(code),
    });
  }

  private onSocketClose(code: number): void {
    this.subscription = undefined;
    if (this.status !== "running") return;
    if (code === AUTH_REVOKED) {
      void this.finish("error", "ClickClack closed the socket: credential revoked");
      return;
    }
    // The durable cursor makes a reconnect lossless: the server replays from it.
    this.reconnectTimer = setTimeout(() => this.connect(), this.opts.reconnectMs ?? 2_000);
  }

  private onEvent(event: ClickClackEvent): void {
    if (event.cursor) this.cursor = event.cursor;
    if (event.channel_id !== this.channel.id || !MESSAGE_EVENTS.has(event.type)) return;
    const messageId = event.payload.message_id;
    if (typeof messageId !== "string" || this.seen.has(messageId)) return;
    // Events carry ids, never bodies, so each one is hydrated.
    this.serial(async () => {
      if (this.seen.has(messageId)) return;
      this.ingest(await this.owner.getMessage(messageId));
    });
  }

  // Ingestion is serialized so routing sees messages in arrival order.
  private serial(work: () => Promise<void>): void {
    this.pendingEvents++;
    this.eventChain = this.eventChain
      .then(work)
      .catch((e) => this.log(`event handling failed: ${errText(e)}`))
      .finally(() => {
        this.pendingEvents--;
        this.pump();
      });
  }

  // A message the swarm itself just wrote is ingested at once rather than
  // waiting for its event to come back over the socket; `seen` drops the echo.
  private enqueueMessage(message: ChatMessage): void {
    this.serial(async () => this.ingest(message));
  }

  private ingest(message: ChatMessage): void {
    if (this.status !== "running" || this.seen.has(message.id)) return;
    this.seen.add(message.id);
    const roster = [...this.agents.values()];
    const author = roster.find((a) => a.botUserId === message.authorId);
    const isRoot = message.threadRootId === message.id;
    if (isRoot && author) this.threadStarters.set(message.id, author.id);
    const participants = this.threadParticipants.get(message.threadRootId) ?? new Set<string>();
    const starter = this.threadStarters.get(message.threadRootId);
    const recipients = route({
      message,
      agents: roster,
      threadParticipants: participants,
      ...(starter ? { threadStarter: starter } : {}),
    });

    // Participants a reply did not wake still see it, as background on their next turn.
    if (!isRoot) {
      for (const id of participants) {
        if (id === author?.id || recipients.includes(id) || !this.canWork(id)) continue;
        const kept = this.background.get(id) ?? [];
        kept.push(message);
        this.background.set(id, kept.slice(-BACKGROUND_KEPT));
      }
    }

    if (author) participants.add(author.id);
    for (const id of recipients) participants.add(id);
    this.threadParticipants.set(message.threadRootId, participants);

    for (const id of recipients) {
      const agent = this.agents.get(id);
      if (!agent || !this.canWork(id)) continue;
      this.inboxes.get(id)?.push(message);
      if (agent.lead) this.kickedOff = true;
    }
  }

  private canWork(agentId: string): boolean {
    const status = this.agents.get(agentId)?.status;
    return status === "idle" || status === "busy";
  }

  private pump(): void {
    if (this.status !== "running") return;
    if (this.quiesceTimer) {
      clearTimeout(this.quiesceTimer);
      this.quiesceTimer = undefined;
    }
    // A concluded swarm starts nothing new; it only waits out turns in flight.
    if (this.conclusion === undefined) {
      for (const agent of this.agents.values()) {
        if (this.busy >= this.limits.maxConcurrent) break;
        const inbox = this.inboxes.get(agent.id);
        if (agent.status !== "idle" || !inbox || inbox.length === 0) continue;
        if (this.turnsUsed >= this.limits.maxTurns) {
          void this.finish("exhausted", `turn budget of ${this.limits.maxTurns} spent`);
          return;
        }
        // The lead integrates everyone's results, so only the swarm budget bounds it;
        // capping it would leave the swarm leaderless.
        if (!agent.lead && agent.turns >= this.limits.maxTurnsPerAgent) {
          this.capAgent(agent);
          continue;
        }
        void this.runAgent(agent, inbox.splice(0));
      }
    }
    if (this.busy === 0 && this.pendingEvents === 0) {
      this.quiesceTimer = setTimeout(() => this.onQuiescent(), this.opts.quiesceMs ?? 1_500);
    }
  }

  private capAgent(agent: SwarmAgent): void {
    this.retire(
      agent,
      "capped",
      `@${agent.handle} has used all ${this.limits.maxTurnsPerAgent} of its turns and will not respond further.`,
    );
    this.log(`@${agent.handle} reached its turn cap`);
  }

  private retire(agent: SwarmAgent, status: "capped" | "failed", notice: string): void {
    agent.status = status;
    this.inboxes.set(agent.id, []);
    this.background.delete(agent.id);
    void this.owner
      .postMessage(this.channel.id, notice)
      .then((m) => this.enqueueMessage(m))
      .catch(() => {});
  }

  private onQuiescent(): void {
    this.quiesceTimer = undefined;
    if (this.status !== "running" || this.busy > 0 || this.pendingEvents > 0) return;
    if (this.conclusion !== undefined) {
      void this.finish("done");
      return;
    }
    const waiting = [...this.inboxes.values()].some((inbox) => inbox.length > 0);
    if (waiting || !this.kickedOff) return;
    const lead = [...this.agents.values()].find((a) => a.lead);
    if (!lead || !this.canWork(lead.id) || this.nudges >= this.limits.maxNudges) {
      void this.finish("stalled", this.stallReason());
      return;
    }
    if (this.turnsUsed >= this.limits.maxTurns) {
      void this.finish("exhausted", `turn budget of ${this.limits.maxTurns} spent`);
      return;
    }
    this.nudges++;
    this.log(`swarm idle; nudging the lead (${this.nudges}/${this.limits.maxNudges})`);
    void this.runAgent(lead, [], nudgeText(CONCLUSION_MAX));
  }

  // Says what actually kept the swarm from concluding, not just that it went quiet.
  private stallReason(): string {
    if (this.refusedConclusions > 0) {
      return `the lead's conclusion was refused ${this.refusedConclusions} time(s) for exceeding ${CONCLUSION_MAX} characters; its last draft is kept as draftConclusion`;
    }
    if (this.lastLeadFailure) return `the lead's last turn failed: ${this.lastLeadFailure}`;
    return "the swarm went idle without a conclusion";
  }

  private team(): TeamMember[] {
    return [...this.agents.values()]
      .filter((a) => !a.lead)
      .map((a) => ({ handle: a.handle, status: a.status, turns: a.turns }));
  }

  private async runAgent(agent: SwarmAgent, messages: ChatMessage[], note?: string): Promise<void> {
    agent.status = "busy";
    agent.turns++;
    this.busy++;
    this.turnsUsed++;
    const budget = {
      turnsUsed: this.turnsUsed,
      maxTurns: this.limits.maxTurns,
      agentTurns: agent.turns,
      ...(agent.lead ? {} : { maxTurnsPerAgent: this.limits.maxTurnsPerAgent }),
    };
    const background = this.background.get(agent.id) ?? [];
    this.background.delete(agent.id);
    const redelivered = this.redelivery.get(agent.id);
    this.redelivery.delete(agent.id);
    const prompt = renderTurn({
      ...(note ? { note } : {}),
      ...(redelivered ? { redelivered } : {}),
      messages,
      background,
      budget,
      ...(agent.lead ? { team: this.team() } : {}),
    });
    this.log(`@${agent.handle} turn ${agent.turns} (${messages.length} new)`);

    const workTools = this.opts.workTools ?? [];
    const tools = [...AGENT_TOOLS, ...workTools].map((name) => ({ name }));
    const model = agent.lead ? this.opts.model : (this.opts.workerModel ?? this.opts.model);
    const outcome = await runTurn(
      this.opts.runAgentTurn,
      {
        system: systemPrompt({
          agent,
          task: this.task,
          channelName: this.channel.name,
          limits: this.limits,
          workTools,
          contextIndex: renderContextIndex(this.opts.context ?? []),
        }),
        prompt,
        tools,
        turnContext: { swarmId: this.id, agentId: agent.id },
        ...(this.opts.cwd ? { cwd: this.opts.cwd, allowedDirectories: [this.opts.cwd] } : {}),
        ...(this.opts.provider ? { provider: this.opts.provider } : {}),
        ...(model ? { model } : {}),
        ...(agent.sessionId ? { resumeSessionId: agent.sessionId } : {}),
      },
      this.limits.turnTimeoutMs,
      this.controller.signal,
    );

    if (outcome.sessionId) agent.sessionId = outcome.sessionId;
    this.busy--;
    if (agent.status === "busy") agent.status = "idle";
    this.log(`@${agent.handle} turn ${agent.turns} ${outcome.status}`, {
      tools: outcome.toolCalls,
      durationMs: outcome.durationMs,
      ...(outcome.error ? { error: outcome.error } : {}),
    });
    if (outcome.status === "timeout" || outcome.status === "error") {
      this.onTurnFailed(agent, messages, background, `${outcome.status}: ${outcome.error ?? ""}`);
    } else if (outcome.status === "ok") {
      this.failures.delete(agent.id);
      if (agent.lead) this.lastLeadFailure = undefined;
    }
    this.pump();
  }

  // A failed turn may never have shown the agent its messages, so they go back
  // to the front of its inbox. Repeated failures retire the agent instead of
  // letting it burn a turn timeout on every wake.
  private onTurnFailed(
    agent: SwarmAgent,
    messages: ChatMessage[],
    background: ChatMessage[],
    reason: string,
  ): void {
    if (this.status !== "running" || this.conclusion !== undefined) return;
    const failures = (this.failures.get(agent.id) ?? 0) + 1;
    this.failures.set(agent.id, failures);
    if (agent.lead) this.lastLeadFailure = reason;
    if (failures >= MAX_TURN_FAILURES) {
      if (agent.lead) {
        void this.finish("error", `the lead's last ${failures} turns failed; last: ${reason}`);
        return;
      }
      this.retire(
        agent,
        "failed",
        `@${agent.handle} will not respond further: its last ${failures} turns failed (${reason}).`,
      );
      this.log(`@${agent.handle} retired after ${failures} failed turns`);
      return;
    }
    if (!this.canWork(agent.id)) return;
    this.inboxes.get(agent.id)?.unshift(...messages);
    if (background.length > 0) {
      this.background.set(agent.id, [...background, ...(this.background.get(agent.id) ?? [])]);
    }
    if (messages.length > 0) this.redelivery.set(agent.id, reason);
  }

  private async addAgent(input: {
    handle: string;
    role: string;
    lead: boolean;
    spawnedBy?: string;
  }): Promise<SwarmAgent> {
    const base = `${this.id}-${sanitizeHandle(input.handle)}`;
    let handle = base;
    for (let attempt = 1; [...this.agents.values()].some((a) => a.handle === handle); attempt++) {
      handle = `${base}-${attempt + 1}`;
    }
    const bot = await this.owner.createBot(this.opts.workspaceId, {
      handle,
      displayName: `${sanitizeHandle(input.handle)} (${this.id})`,
    });
    const agent: SwarmAgent = {
      id: bot.handle,
      handle: bot.handle,
      displayName: bot.displayName,
      role: input.role,
      lead: input.lead,
      botUserId: bot.botUserId,
      tokenId: bot.tokenId,
      ...(input.spawnedBy ? { spawnedBy: input.spawnedBy } : {}),
      turns: 0,
      status: "idle",
    };
    this.agents.set(agent.id, agent);
    this.tokens.set(agent.id, bot.token);
    this.inboxes.set(agent.id, []);
    this.background.set(agent.id, []);
    return agent;
  }

  // ---- The surface the chat_* tools call, always on behalf of one agent. ----

  private as(agentId: string): { agent: SwarmAgent; client: ClickClackClient } {
    const agent = this.agents.get(agentId);
    const token = this.tokens.get(agentId);
    if (!agent || !token) throw new Error(`no agent '${agentId}' in swarm ${this.id}`);
    if (this.status !== "running") throw new Error(`swarm ${this.id} is ${this.status}`);
    return { agent, client: this.owner.withToken(token) };
  }

  async post(agentId: string, body: string): Promise<ChatMessage> {
    const message = await this.as(agentId).client.postMessage(this.channel.id, body);
    this.enqueueMessage(message);
    return message;
  }

  async reply(agentId: string, messageId: string, body: string): Promise<ChatMessage> {
    const { client } = this.as(agentId);
    // Replies attach to a thread root, so a reply-to-a-reply is lifted to it.
    const target = await client.getMessage(messageId);
    if (target.channelId !== this.channel.id) {
      throw new Error(`message ${messageId} is not in this swarm's channel`);
    }
    const message = await client.replyInThread(target.threadRootId, body);
    this.enqueueMessage(message);
    return message;
  }

  async read(agentId: string, opts: { threadId?: string; limit: number }): Promise<ChatMessage[]> {
    const { client } = this.as(agentId);
    if (!opts.threadId) return client.listMessages(this.channel.id, opts.limit);
    const thread = await client.getThread(opts.threadId);
    if (thread[0] && thread[0].channelId !== this.channel.id) {
      throw new Error(`thread ${opts.threadId} is not in this swarm's channel`);
    }
    return thread.slice(-opts.limit);
  }

  async spawn(
    agentId: string,
    input: { handle: string; role: string; brief: string },
  ): Promise<SwarmAgent> {
    const { agent: spawner, client } = this.as(agentId);
    if (this.agents.size >= this.limits.maxAgents) {
      throw new Error(
        `spawn cap reached: the swarm already has ${this.agents.size} of ${this.limits.maxAgents} agents. Reuse an existing agent via @mention.`,
      );
    }
    const agent = await this.addAgent({
      handle: input.handle,
      role: input.role,
      lead: false,
      spawnedBy: spawner.id,
    });
    this.log(`@${spawner.handle} spawned @${agent.handle}: ${input.role}`);
    // The brief is an ordinary mention from the spawner, so the new agent wakes
    // through the router and its thread reply finds its way back.
    const message = await client.postMessage(
      this.channel.id,
      `@${agent.handle} joining as **${input.role}**.\n\n${input.brief}`,
    );
    this.enqueueMessage(message);
    return agent;
  }

  context(agentId: string, opts: { id?: string; offset: number }): string {
    this.as(agentId);
    const items = this.opts.context ?? [];
    if (!opts.id) return renderContextIndex(items);
    const item = items.find((i) => i.id === opts.id);
    if (!item) {
      throw new Error(
        `no context item '${opts.id}'. It was not supplied to this swarm: report it as missing evidence. Items:\n${renderContextIndex(items)}`,
      );
    }
    if (opts.offset >= item.body.length) {
      throw new Error(
        `offset ${opts.offset} is past the end of '${item.id}' (${item.body.length} chars)`,
      );
    }
    return renderContextItem(item, opts.offset);
  }

  roster(): SwarmSummary["agents"] {
    return [...this.agents.values()].map(({ tokenId: _t, sessionId: _s, ...rest }) => rest);
  }

  async conclude(agentId: string, summary: string): Promise<void> {
    const { agent, client } = this.as(agentId);
    if (!agent.lead) throw new Error("only the lead may conclude the swarm");
    if (summary.length > CONCLUSION_MAX) {
      this.draftConclusion = summary;
      this.refusedConclusions++;
      throw new Error(
        `conclusion refused: it is ${summary.length} characters and the limit is ${CONCLUSION_MAX}. Cut at least ${summary.length - CONCLUSION_MAX} characters and call chat_done again. Detail that does not fit can go in a chat_post first.`,
      );
    }
    const parts = splitBody(summary, BODY_MAX - 32);
    for (const [i, part] of parts.entries()) {
      const heading =
        parts.length > 1 ? `**Conclusion (${i + 1}/${parts.length})**` : "**Conclusion**";
      await client.postMessage(this.channel.id, `${heading}\n\n${part}`);
    }
    this.conclusion = summary;
    this.draftConclusion = undefined;
    for (const id of this.inboxes.keys()) this.inboxes.set(id, []);
    this.background.clear();
    this.log(`@${agent.handle} concluded the swarm`);
  }

  // ---- Operator controls. ----

  async steer(note: string): Promise<void> {
    if (this.status !== "running") return;
    // Posted as the human owner, so it routes to the lead like any operator message.
    const message = await this.owner.postMessage(this.channel.id, `**Operator:** ${note}`);
    this.enqueueMessage(message);
  }

  stop(reason = "stopped by operator"): Promise<SwarmSummary> {
    void this.finish("stopped", reason);
    return this.finished;
  }

  summary(): SwarmSummary {
    return {
      id: this.id,
      task: this.task,
      status: this.status,
      channelId: this.channel.id,
      channelName: this.channel.name,
      startedAt: this.startedAt,
      ...(this.endedAt ? { endedAt: this.endedAt } : {}),
      turnsUsed: this.turnsUsed,
      limits: this.limits,
      agents: this.roster(),
      ...(this.opts.context?.length ? { context: contextIndex(this.opts.context) } : {}),
      ...(this.conclusion !== undefined ? { conclusion: this.conclusion } : {}),
      ...(this.conclusion === undefined && this.draftConclusion !== undefined
        ? { draftConclusion: this.draftConclusion }
        : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  private async finish(status: Exclude<SwarmStatus, "running">, reason?: string): Promise<void> {
    if (this.status !== "running") return;
    this.status = status;
    this.endedAt = new Date().toISOString();
    if (status !== "done" && reason) this.error = reason;
    for (const timer of [this.quiesceTimer, this.wallClockTimer, this.reconnectTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.controller.abort();
    this.subscription?.close();
    this.subscription = undefined;

    if (this.channel.id) {
      const line = `Swarm ${this.id} ${status}${reason ? `: ${reason}` : ""}. ${this.turnsUsed} turns, ${this.agents.size} agents.`;
      await this.owner.postMessage(this.channel.id, line).catch(() => {});
    }
    // The bots stay so the transcript keeps its authors; only their credentials go.
    for (const agent of this.agents.values()) {
      await this.owner.revokeBotToken(agent.tokenId).catch((e) => {
        if (!(e instanceof ClickClackError && e.status === 404)) {
          this.log(`could not revoke the token for @${agent.handle}: ${errText(e)}`);
        }
      });
    }
    this.tokens.clear();
    this.log(`swarm ${this.id} ${status}${reason ? `: ${reason}` : ""}`);
    this.done.resolve(this.summary());
  }
}
