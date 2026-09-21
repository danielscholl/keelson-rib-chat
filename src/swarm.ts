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
import { nudgeText, renderInbox, systemPrompt } from "./prompts.ts";
import { route } from "./router.ts";
import { type RunAgentTurn, runTurn } from "./turn-runner.ts";
import {
  type ChatMessage,
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
  private readonly threadParticipants = new Map<string, Set<string>>();
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
    const participants = this.threadParticipants.get(message.threadRootId) ?? new Set<string>();
    const recipients = route({ message, agents: roster, threadParticipants: participants });

    const author = roster.find((a) => a.botUserId === message.authorId);
    if (author) participants.add(author.id);
    for (const id of recipients) participants.add(id);
    this.threadParticipants.set(message.threadRootId, participants);

    for (const id of recipients) {
      const agent = this.agents.get(id);
      if (!agent || agent.status === "capped") continue;
      this.inboxes.get(id)?.push(message);
      if (agent.lead) this.kickedOff = true;
    }
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
    agent.status = "capped";
    this.inboxes.set(agent.id, []);
    this.log(`@${agent.handle} reached its turn cap`);
    void this.owner
      .postMessage(
        this.channel.id,
        `@${agent.handle} has used all ${this.limits.maxTurnsPerAgent} of its turns and will not respond further.`,
      )
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
    if (!lead || lead.status === "capped" || this.nudges >= this.limits.maxNudges) {
      void this.finish("stalled", "the swarm went idle without a conclusion");
      return;
    }
    if (this.turnsUsed >= this.limits.maxTurns) {
      void this.finish("exhausted", `turn budget of ${this.limits.maxTurns} spent`);
      return;
    }
    this.nudges++;
    this.log(`swarm idle; nudging the lead (${this.nudges}/${this.limits.maxNudges})`);
    void this.runAgent(lead, [], nudgeText());
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
    const prompt = [note, messages.length > 0 ? renderInbox(messages, budget) : undefined]
      .filter(Boolean)
      .join("\n\n");
    this.log(`@${agent.handle} turn ${agent.turns} (${messages.length} new)`);

    const tools = [...AGENT_TOOLS, ...(this.opts.workTools ?? [])].map((name) => ({ name }));
    const outcome = await runTurn(
      this.opts.runAgentTurn,
      {
        system: systemPrompt({
          agent,
          task: this.task,
          channelName: this.channel.name,
          limits: this.limits,
          contextIndex: renderContextIndex(this.opts.context ?? []),
        }),
        prompt,
        tools,
        turnContext: { swarmId: this.id, agentId: agent.id },
        ...(this.opts.cwd ? { cwd: this.opts.cwd, allowedDirectories: [this.opts.cwd] } : {}),
        ...(this.opts.provider ? { provider: this.opts.provider } : {}),
        ...(this.opts.model ? { model: this.opts.model } : {}),
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
    this.pump();
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
    await client.postMessage(this.channel.id, `**Conclusion**\n\n${summary}`);
    this.conclusion = summary;
    for (const id of this.inboxes.keys()) this.inboxes.set(id, []);
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
