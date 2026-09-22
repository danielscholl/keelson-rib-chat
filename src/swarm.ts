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
import {
  applyStatus,
  describeRun,
  isLive,
  isolationBreach,
  type WorkflowDispatcher,
} from "./dispatch.ts";
import { nudgeText, renderTurn, systemPrompt, type TeamMember } from "./prompts.ts";
import { route } from "./router.ts";
import { type RunAgentTurn, runTurn } from "./turn-runner.ts";
import {
  BODY_MAX,
  type ChatMessage,
  type ChildRun,
  CONCLUSION_MAX,
  DEFAULT_LIMITS,
  type DispatchGrant,
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

// Granted to the lead only, and only when the operator gave the swarm workflows.
export const DISPATCH_TOOLS = [
  "chat_workflow_start",
  "chat_workflow_status",
  "chat_workflow_cancel",
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
  // Catalog workflows the lead may start on the project, and the seams to do it.
  dispatch?: { grants: readonly DispatchGrant[]; dispatcher: WorkflowDispatcher; pollMs?: number };
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
  private readonly runs = new Map<string, ChildRun>();
  private readonly syncing = new Set<string>();
  private readonly resync = new Set<string>();
  // Run updates waiting for the lead's next turn; they wake it like a message.
  private readonly notes: string[] = [];
  private runPoll: ReturnType<typeof setInterval> | undefined;
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
  // The last time an agent's channel call failed because ClickClack itself did.
  private channelFault: string | undefined;
  private readonly unrevoked: string[] = [];
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
        const inbox = this.inboxes.get(agent.id) ?? [];
        const notes = agent.lead ? this.notes : [];
        if (agent.status !== "idle" || (inbox.length === 0 && notes.length === 0)) continue;
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
        void this.runAgent(agent, inbox.splice(0), undefined, notes.splice(0));
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
    if (waiting || this.notes.length > 0 || !this.kickedOff) return;
    // A run in flight will wake the lead when it moves; waiting on it is not idleness.
    if (this.liveRuns().length > 0) return;
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
    if (this.channelFault) return `agents could not reach ClickClack: ${this.channelFault}`;
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

  private async runAgent(
    agent: SwarmAgent,
    messages: ChatMessage[],
    note?: string,
    events: string[] = [],
  ): Promise<void> {
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
      ...(events.length > 0 ? { events } : {}),
      ...(agent.lead && this.runs.size > 0
        ? { runs: [...this.runs.values()].map(describeRun) }
        : {}),
    });
    this.log(`@${agent.handle} turn ${agent.turns} (${messages.length} new)`);

    const workTools = this.opts.workTools ?? [];
    const dispatchTools = agent.lead && this.opts.dispatch ? DISPATCH_TOOLS : [];
    const tools = [...AGENT_TOOLS, ...dispatchTools, ...workTools].map((name) => ({ name }));
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
          ...(agent.lead && this.opts.dispatch ? { grants: this.opts.dispatch.grants } : {}),
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
      this.onTurnFailed(
        agent,
        messages,
        background,
        `${outcome.status}: ${outcome.error ?? ""}`,
        events,
      );
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
    events: string[] = [],
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
    if (agent.lead) this.notes.unshift(...events);
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

  // A network failure or a 5xx is ClickClack's fault, not the agent's; a stall
  // that follows one names it.
  private async onChannel<T>(work: () => Promise<T>): Promise<T> {
    try {
      const out = await work();
      this.channelFault = undefined;
      return out;
    } catch (e) {
      if (!(e instanceof ClickClackError) || e.status >= 500) this.channelFault = errText(e);
      throw e;
    }
  }

  async post(agentId: string, body: string): Promise<ChatMessage> {
    const { client } = this.as(agentId);
    const message = await this.onChannel(() => client.postMessage(this.channel.id, body));
    this.enqueueMessage(message);
    return message;
  }

  async reply(agentId: string, messageId: string, body: string): Promise<ChatMessage> {
    const { client } = this.as(agentId);
    // Replies attach to a thread root, so a reply-to-a-reply is lifted to it.
    const target = await this.onChannel(() => client.getMessage(messageId));
    if (target.channelId !== this.channel.id) {
      throw new Error(`message ${messageId} is not in this swarm's channel`);
    }
    const message = await this.onChannel(() => client.replyInThread(target.threadRootId, body));
    this.enqueueMessage(message);
    return message;
  }

  async read(agentId: string, opts: { threadId?: string; limit: number }): Promise<ChatMessage[]> {
    const { client } = this.as(agentId);
    const threadId = opts.threadId;
    if (!threadId) return this.onChannel(() => client.listMessages(this.channel.id, opts.limit));
    const thread = await this.onChannel(() => client.getThread(threadId));
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
    const message = await this.onChannel(() =>
      client.postMessage(
        this.channel.id,
        `@${agent.handle} joining as **${input.role}**.\n\n${input.brief}`,
      ),
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

  // ---- Workflow dispatch, on behalf of the lead. ----

  private liveRuns(): ChildRun[] {
    return [...this.runs.values()].filter(isLive);
  }

  ownsRun(runId: string): boolean {
    return this.runs.has(runId);
  }

  runLedger(): readonly ChildRun[] {
    return [...this.runs.values()].map((r) => ({ ...r, prUrls: [...r.prUrls] }));
  }

  private dispatcherFor(agentId: string): {
    dispatch: NonNullable<SwarmOptions["dispatch"]>;
    client: ClickClackClient;
  } {
    const { agent, client } = this.as(agentId);
    if (!agent.lead) throw new Error("only the lead may start or cancel workflow runs");
    const dispatch = this.opts.dispatch;
    if (!dispatch) throw new Error("this swarm was not started with workflows to dispatch");
    return { dispatch, client };
  }

  async startRun(
    agentId: string,
    input: { workflow: string; purpose: string; inputs: Record<string, string> },
  ): Promise<ChildRun> {
    const { dispatch, client } = this.dispatcherFor(agentId);
    if (this.conclusion !== undefined) throw new Error("the swarm has concluded");
    const grant = dispatch.grants.find((g) => g.name === input.workflow);
    if (!grant) {
      throw new Error(
        `workflow '${input.workflow}' is not one this swarm may start. It may start: ${dispatch.grants.map((g) => g.name).join(", ")}`,
      );
    }
    const { runId } = await dispatch.dispatcher.start(grant.name, input.inputs);
    const run: ChildRun = {
      runId,
      workflow: grant.name,
      purpose: input.purpose,
      inputs: { ...input.inputs },
      status: "running",
      startedAt: new Date().toISOString(),
      isolated: grant.isolated,
      nodesDone: 0,
      prUrls: [],
      verified: false,
    };
    this.runs.set(runId, run);
    this.log(`started ${grant.name} run ${runId}: ${input.purpose}`);
    void this.onChannel(() =>
      client.postMessage(
        this.channel.id,
        `**Run started** \`${grant.name}\` \`${runId}\`: ${input.purpose}`,
      ),
    )
      .then((m) => this.enqueueMessage(m))
      .catch(() => {});
    this.armRunPoll(dispatch.pollMs ?? 20_000);
    void this.syncRun(runId);
    return run;
  }

  async cancelChildRun(agentId: string, runId: string): Promise<ChildRun> {
    const { dispatch } = this.dispatcherFor(agentId);
    const run = this.runs.get(runId);
    if (!run) throw new Error(`no run '${runId}' was started by this swarm`);
    if (!isLive(run)) return run;
    const result = await dispatch.dispatcher.cancel(runId);
    if (!result.ok) throw new Error(`could not cancel run ${runId}: ${result.error}`);
    await this.syncRun(runId, { quiet: true });
    if (isLive(run)) run.status = "cancelled";
    return run;
  }

  onRunEvent(runId: string): void {
    if (this.runs.has(runId)) void this.syncRun(runId);
  }

  private armRunPoll(pollMs: number): void {
    if (this.runPoll) return;
    this.runPoll = setInterval(() => {
      for (const run of this.liveRuns()) void this.syncRun(run.runId);
    }, pollMs);
    (this.runPoll as { unref?: () => void }).unref?.();
  }

  // Reads a run's status into the ledger. One read per run at a time; an update
  // that lands during a read triggers one more.
  private async syncRun(runId: string, opts: { quiet?: boolean } = {}): Promise<void> {
    const run = this.runs.get(runId);
    const dispatch = this.opts.dispatch;
    if (!run || !dispatch || !isLive(run) || this.status !== "running") return;
    if (this.syncing.has(runId)) {
      this.resync.add(runId);
      return;
    }
    this.syncing.add(runId);
    try {
      const status = await dispatch.dispatcher.status(runId);
      if (!status || this.status !== "running") return;
      const change = applyStatus(run, status);
      const breach = isolationBreach(run);
      if (breach) {
        await dispatch.dispatcher.cancel(runId).catch(() => undefined);
        run.status = "cancelled";
        run.error = `cancelled by the swarm: ${breach}`;
        run.verified = false;
        this.notifyLead(
          `Run ${runId} (${run.workflow}) was cancelled: ${breach}. Its grant requires an isolated worktree.`,
        );
      } else if (change && !opts.quiet) {
        // A run resuming after its approval needs nothing from the lead.
        this.notifyLead(change, { wake: run.status !== "running" });
      }
    } catch (e) {
      this.log(`could not read run ${runId}: ${errText(e)}`);
    } finally {
      this.syncing.delete(runId);
      if (this.resync.delete(runId)) void this.syncRun(runId);
    }
  }

  // Queues a run update for the lead's next turn and puts it on the channel, as
  // the lead, so the operator sees it without waking anyone.
  private notifyLead(text: string, opts: { wake?: boolean } = {}): void {
    if (this.status !== "running") return;
    this.log(text);
    const lead = [...this.agents.values()].find((a) => a.lead);
    const token = lead ? this.tokens.get(lead.id) : undefined;
    if (token) {
      void this.owner
        .withToken(token)
        .postMessage(this.channel.id, `**Run update** ${text}`)
        .then((m) => this.enqueueMessage(m))
        .catch(() => {});
    }
    if (this.conclusion !== undefined || opts.wake === false) return;
    this.notes.push(text);
    this.pump();
  }

  roster(): SwarmSummary["agents"] {
    return [...this.agents.values()].map(({ tokenId: _t, sessionId: _s, ...rest }) => rest);
  }

  // Records the conclusion before posting it: the answer is the deliverable, and
  // a channel that cannot take the post must not lose it. Returns the post error.
  async conclude(agentId: string, summary: string): Promise<string | undefined> {
    const { agent, client } = this.as(agentId);
    if (!agent.lead) throw new Error("only the lead may conclude the swarm");
    const live = this.liveRuns();
    if (live.length > 0) {
      this.draftConclusion = summary;
      throw new Error(
        `${live.length} workflow run(s) are still live: ${live.map((r) => `${r.runId} (${r.workflow}, ${r.status})`).join(", ")}. Wait for them to finish, or cancel them with chat_workflow_cancel, then conclude.`,
      );
    }
    if (summary.length > CONCLUSION_MAX) {
      this.draftConclusion = summary;
      this.refusedConclusions++;
      throw new Error(
        `conclusion refused: it is ${summary.length} characters and the limit is ${CONCLUSION_MAX}. Cut at least ${summary.length - CONCLUSION_MAX} characters and call chat_done again. Detail that does not fit can go in a chat_post first.`,
      );
    }
    this.conclusion = summary;
    this.draftConclusion = undefined;
    for (const id of this.inboxes.keys()) this.inboxes.set(id, []);
    this.background.clear();
    this.log(`@${agent.handle} concluded the swarm`);
    const parts = splitBody(summary, BODY_MAX - 32);
    try {
      for (const [i, part] of parts.entries()) {
        const heading =
          parts.length > 1 ? `**Conclusion (${i + 1}/${parts.length})**` : "**Conclusion**";
        await this.onChannel(() => client.postMessage(this.channel.id, `${heading}\n\n${part}`));
      }
      return undefined;
    } catch (e) {
      this.log(`the conclusion could not be posted to the channel: ${errText(e)}`);
      return errText(e);
    }
  }

  // Bot tokens finish() could not revoke, for the host to retry later.
  unrevokedTokens(): readonly string[] {
    return this.unrevoked;
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
      ...(this.runs.size > 0 ? { runs: this.runLedger() } : {}),
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
    if (this.runPoll) clearInterval(this.runPoll);
    for (const run of this.liveRuns()) {
      await this.opts.dispatch?.dispatcher.cancel(run.runId).catch(() => undefined);
      run.status = "cancelled";
      run.error = `the swarm ended (${status}) while the run was live`;
      run.verified = false;
    }
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
          this.unrevoked.push(agent.tokenId);
          this.log(`could not revoke the token for @${agent.handle}: ${errText(e)}`);
        }
      });
    }
    this.tokens.clear();
    this.log(`swarm ${this.id} ${status}${reason ? `: ${reason}` : ""}`);
    this.done.resolve(this.summary());
  }
}
