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
  type GateFile,
  gateFiles,
  gateKey,
  isLive,
  isolationBreach,
  type WorkflowDispatcher,
  withoutFileHints,
} from "./dispatch.ts";
import { nudgeText, renderTurn, systemPrompt, type TeamMember } from "./prompts.ts";
import { checkReport, reportMeta, type SwarmReport, unwrapReport } from "./report.ts";
import { addressedHandles, mentionedHandles, route } from "./router.ts";
import { type RunAgentTurn, runTurn } from "./turn-runner.ts";
import {
  type ActivityEntry,
  type ActivityKind,
  addTokens,
  BODY_MAX,
  type ChatMessage,
  type ChildRun,
  CONCLUSION_MAX,
  type DispatchGrant,
  type GateAnswer,
  type GateFileText,
  type OperatorAsk,
  SIZE_PRESETS,
  type SwarmAgent,
  type SwarmHealth,
  type SwarmLimits,
  type SwarmPower,
  type SwarmProject,
  type SwarmSize,
  type SwarmStatus,
  type SwarmSummary,
  sizeOf,
  type TurnSpan,
  WORKER_TONES,
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

// Granted to the lead only: its designed report, and Keelson's design guide for it.
export const REPORT_TOOLS = ["chat_report", "canvas_design_guide"] as const;

// Granted to the lead only, and only when the operator gave the swarm workflows.
export const DISPATCH_TOOLS = [
  "chat_workflow_start",
  "chat_workflow_status",
  "chat_workflow_cancel",
] as const;
// Added to them when the host lets the rib answer a run's approval gate.
export const RESPOND_TOOL = "chat_workflow_respond";

const MESSAGE_EVENTS = new Set(["message.created", "thread.reply_created"]);
const AUTH_REVOKED = 1008;
// Consecutive failed turns before an agent is retired (or, for the lead, the swarm ends).
export const MAX_TURN_FAILURES = 3;
// Thread replies an agent was not woken for, kept for its next turn.
const BACKGROUND_KEPT = 12;
const ASKS_KEPT = 5;
export const GATE_FILES_MAX = 64_000;
export const ACTIVITY_KEPT = 200;
const ASK_CHARS = 2_000;
const PACE_MINUTES = 30;
// An ended swarm's spark spreads its whole run over at most this many buckets.
const PACE_BUCKETS = 30;

type ActivityMeta = { kind: ActivityKind; actor?: string; subject?: string };

// Trims the activity list to `kept`, oldest first, dropping turn entries before
// anything else: spans already hold every turn, and the rest mark the course.
export function keepActivity(entries: ActivityEntry[], kept: number): void {
  while (entries.length > kept) {
    const turn = entries.findIndex((e) => e.kind === "turn");
    entries.splice(turn >= 0 ? turn : 0, 1);
  }
}

// Turns started per bucket: per minute over the last PACE_MINUTES while live,
// and over the whole run once ended. Undefined until there are two buckets.
export function paceOf(
  starts: readonly number[],
  startedAt: number,
  anchor: number,
  ended: boolean,
): number[] | undefined {
  const from = ended ? startedAt : Math.max(startedAt, anchor - PACE_MINUTES * 60_000);
  const width = ended ? Math.max(60_000, Math.ceil((anchor - startedAt) / PACE_BUCKETS)) : 60_000;
  const count = Math.min(
    ended ? PACE_BUCKETS : PACE_MINUTES,
    Math.floor((anchor - from) / width) + 1,
  );
  if (count < 2) return undefined;
  const buckets = new Array<number>(count).fill(0);
  for (const t of starts) {
    const i = Math.min(count - 1, Math.floor((t - from) / width));
    if (i >= 0) buckets[i] = (buckets[i] ?? 0) + 1;
  }
  return buckets;
}

function seconds(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
}

export interface SwarmOptions {
  task: string;
  owner: ClickClackClient;
  workspaceId: string;
  runAgentTurn: RunAgentTurn;
  // The preset limits start from, medium when absent; `limits` overrides single values.
  size?: SwarmSize;
  limits?: Partial<SwarmLimits>;
  // Built-in tools granted beside the chat_* set (e.g. Read, Grep, Glob).
  workTools?: readonly string[];
  // Other ribs' tools the lead holds; the host drops any the operator has not granted.
  leadTools?: readonly string[];
  // Whether another swarm's run already owns a pull request, so this one never claims it.
  prOwnedElsewhere?: (url: string, swarmId: string) => boolean;
  // Evidence snapshotted by the caller; immutable for the life of the swarm.
  context?: readonly ContextItem[];
  cwd?: string;
  project?: SwarmProject;
  opId?: string;
  provider?: string;
  model?: string;
  // Model for workers; the lead always uses `model`.
  workerModel?: string;
  // The model class an agent with no model of its own runs at.
  power?: SwarmPower;
  // Workflows whose gates the host refused to let a swarm answer, shared across
  // swarms so the next gate on one is flagged for the operator at once.
  approvalRefusals?: ApprovalRefusals;
  // Catalog workflows the lead may start on the project, and the seams to do it.
  dispatch?: { grants: readonly DispatchGrant[]; dispatcher: WorkflowDispatcher; pollMs?: number };
  log?: (message: string, data?: unknown) => void;
  // Called after each change a view of the swarm would show.
  onChange?: (kind: SwarmChange) => void;
  // How long the swarm must sit idle before that counts as quiescent.
  quiesceMs?: number;
  reconnectMs?: number;
  id?: string;
  // The ended swarm this one reruns.
  rerunOf?: string;
}

// Thrown by Swarm.start when boot fails, carrying the ended summary so the
// failure stays on the record.
export class SwarmStartError extends Error {
  constructor(
    message: string,
    readonly summary: SwarmSummary,
  ) {
    super(message);
  }
}

export interface ApprovalRefusals {
  has(workflow: string): boolean;
  set(workflow: string, refused: boolean): void;
}

export type SwarmChange =
  | "start"
  | "turn"
  | "agent"
  | "run"
  | "gate"
  | "conclusion"
  | "report"
  | "health"
  | "activity"
  | "end";

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

// A gate's files as the reading pane keeps them, cut to a shared budget.
function keptFiles(files: readonly GateFile[]): GateFileText[] {
  let left = GATE_FILES_MAX;
  return files.map((f) => {
    if (f.text === undefined) return { path: f.path, error: f.error ?? "no text" };
    const text = f.text.slice(0, Math.max(0, left));
    left -= text.length;
    const truncated = f.truncated === true || text.length < f.text.length;
    return { path: f.path, text, ...(truncated ? { truncated } : {}) };
  });
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
  // Runs the swarm is cancelling: a gate they leave was not answered, and one
  // they reach on the way out is not announced.
  private readonly cancelling = new Set<string>();
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
  private report: SwarmReport | undefined;
  private refusedConclusions = 0;
  private socketDrops = 0;
  private quietSince: string | undefined;
  private readonly asks: OperatorAsk[] = [];
  private readonly activity: ActivityEntry[] = [];
  private ownerHandle = "";
  // Messages the rib posts as the owner, which are not the operator talking.
  private readonly ownPosts = new Set<string>();
  private lastLeadFailure: string | undefined;
  // The last time an agent's channel call failed because ClickClack itself did.
  private channelFault: string | undefined;
  private cancelFault: string | undefined;
  private lastWaiting = "";
  // Every turn, for the pace the Turns tile draws and the record's timeline.
  private readonly spans: TurnSpan[] = [];
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
    this.limits = { ...SIZE_PRESETS[opts.size ?? "medium"], ...opts.limits };
    this.finished = this.done.promise;
  }

  static async start(opts: SwarmOptions): Promise<Swarm> {
    const swarm = new Swarm(opts);
    try {
      await swarm.boot();
    } catch (e) {
      await swarm.finish("error", errText(e));
      throw new SwarmStartError(errText(e), swarm.summary());
    }
    return swarm;
  }

  // An event on the tab's activity list and in the op's progress log.
  private log(message: string, meta: ActivityMeta, data?: unknown): void {
    this.record(message, meta);
    this.progress(message, data);
  }

  private record(text: string, meta: ActivityMeta): void {
    const at = new Date().toISOString();
    const last = this.activity.at(-1);
    if (last && last.text === text && last.kind === meta.kind && last.actor === meta.actor) {
      last.at = at;
      last.count = (last.count ?? 1) + 1;
      return;
    }
    this.activity.push({
      at,
      text,
      kind: meta.kind,
      ...(meta.actor ? { actor: meta.actor } : {}),
      ...(meta.subject ? { subject: meta.subject } : {}),
    });
    keepActivity(this.activity, ACTIVITY_KEPT);
  }

  private progress(message: string, data?: unknown): void {
    try {
      this.opts.log?.(message, data);
    } catch {
      // a throwing logger must never break the swarm
    }
  }

  private changed(kind: SwarmChange): void {
    try {
      this.opts.onChange?.(kind);
    } catch {
      // a throwing listener must never break the swarm
    }
  }

  private async boot(): Promise<void> {
    // Captured first: everything the swarm itself creates lands after this
    // cursor, so the kickoff reaches the lead through the same event path a
    // human's message does.
    this.cursor = await this.owner.tailCursor(this.opts.workspaceId);
    this.channel = await this.owner.createChannel(this.opts.workspaceId, `swarm-${this.id}`);
    this.ownerHandle = await this.owner
      .me()
      .then((me) => me.handle.toLowerCase())
      .catch(() => "");
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
    this.ownPosts.add(kickoff.id);
    this.log(`swarm ${this.id} started in #${this.channel.name}`, { kind: "start" });
    this.changed("start");
    this.enqueueMessage(kickoff);
  }

  private connect(): void {
    if (this.status !== "running") return;
    this.subscription = this.owner.subscribe({
      workspaceId: this.opts.workspaceId,
      afterCursor: this.cursor,
      onEvent: (event) => this.onEvent(event),
      onClose: (code) => this.onSocketClose(code),
      onOpen: () => {
        if (this.socketDrops === 0) return;
        this.socketDrops = 0;
        this.changed("health");
      },
    });
  }

  private onSocketClose(code: number): void {
    this.subscription = undefined;
    if (this.status !== "running") return;
    this.socketDrops++;
    this.changed("health");
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
      .catch((e) => this.log(`event handling failed: ${errText(e)}`, { kind: "fault" }))
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
    if (message.authorKind === "human" && !this.ownPosts.has(message.id)) {
      this.answerAsks(message, isRoot);
    }
    if (author?.lead && !isRoot) this.noteReviewer(message);
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

  // Idle agents with messages queued: the ones the bench shows as waiting.
  private waitingKey(): string {
    return [...this.agents.values()]
      .filter((a) => a.status === "idle" && (this.inboxes.get(a.id)?.length ?? 0) > 0)
      .map((a) => a.id)
      .sort()
      .join(",");
  }

  // The lead's mention of another agent in a gate thread names the reviewer.
  private noteReviewer(message: ChatMessage): void {
    const run = [...this.runs.values()].find(
      (r) => r.status === "paused" && r.pendingApproval?.threadId === message.threadRootId,
    );
    const gate = run?.pendingApproval;
    if (!gate) return;
    const handles = new Set(mentionedHandles(message.body));
    const asked = [...this.agents.values()].find(
      (a) => !a.lead && handles.has(a.handle.toLowerCase()),
    );
    if (!asked || gate.reviewer === asked.handle) return;
    gate.reviewer = asked.handle;
    this.changed("gate");
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
    // Whoever is still queued after the slots are handed out is waiting.
    const waiting = this.waitingKey();
    if (waiting !== this.lastWaiting) {
      this.lastWaiting = waiting;
      this.changed("agent");
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
    this.log(`@${agent.handle} reached its turn cap`, { kind: "cap", actor: agent.id });
  }

  private retire(agent: SwarmAgent, status: "capped" | "failed", notice: string): void {
    agent.status = status;
    this.changed("agent");
    this.inboxes.set(agent.id, []);
    this.background.delete(agent.id);
    void this.owner
      .postMessage(this.channel.id, notice)
      .then((m) => {
        this.ownPosts.add(m.id);
        this.enqueueMessage(m);
      })
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
    // A gate nobody is working on is, though, and only the operator can move it.
    if (this.liveRuns().length > 0) {
      if (!this.quietSince && this.liveRuns().some((r) => r.status === "paused")) {
        this.quietSince = new Date().toISOString();
        this.changed("health");
      }
      return;
    }
    // An open question to the operator holds the swarm; only the wall clock ends it.
    if (this.asks.length > 0) return;
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
    this.log(`swarm idle; nudging the lead (${this.nudges}/${this.limits.maxNudges})`, {
      kind: "nudge",
      subject: lead.id,
    });
    this.changed("health");
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

  // Who a turn answers: each message's author, and the run notes or nudge beside them.
  private wokeBy(
    messages: readonly ChatMessage[],
    note?: string,
    events: readonly string[] = [],
  ): string[] {
    const by = new Set<string>();
    for (const m of messages) {
      const author = [...this.agents.values()].find((a) => a.botUserId === m.authorId);
      if (author) by.add(author.id);
      else if (this.ownPosts.has(m.id)) by.add("rib");
      else if (m.authorKind === "human") by.add("operator");
    }
    if (events.length > 0) by.add("runs");
    if (note) by.add("nudge");
    return [...by];
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
    // A turn's start goes to the op's progress only; its one activity entry lands
    // when it ends, with what came of it.
    this.progress(`@${agent.handle} turn ${agent.turns} (${messages.length} new)`);
    const turn: TurnSpan = {
      agentId: agent.id,
      n: agent.turns,
      startedAt: new Date().toISOString(),
      messages: messages.length,
      wokeBy: this.wokeBy(messages, note, events),
    };
    this.spans.push(turn);
    this.quietSince = undefined;
    this.changed("turn");

    const workTools = this.opts.workTools ?? [];
    const leadTools = agent.lead ? (this.opts.leadTools ?? []) : [];
    const dispatch = agent.lead ? this.opts.dispatch : undefined;
    const answersGates = Boolean(dispatch?.dispatcher.respond);
    const dispatchTools = dispatch
      ? [...DISPATCH_TOOLS, ...(answersGates ? [RESPOND_TOOL] : [])]
      : [];
    const tools = [
      ...new Set([
        ...AGENT_TOOLS,
        ...(agent.lead ? REPORT_TOOLS : []),
        ...dispatchTools,
        ...workTools,
        ...leadTools,
      ]),
    ].map((name) => ({ name }));
    const model = agent.model;
    const outcome = await runTurn(
      this.opts.runAgentTurn,
      {
        system: systemPrompt({
          agent,
          task: this.task,
          channelName: this.channel.name,
          limits: this.limits,
          workTools,
          leadTools,
          ...(dispatch ? { grants: dispatch.grants, answersGates } : {}),
          contextIndex: renderContextIndex(this.opts.context ?? []),
        }),
        prompt,
        tools,
        turnContext: { swarmId: this.id, agentId: agent.id },
        ...(this.opts.cwd ? { cwd: this.opts.cwd, allowedDirectories: [this.opts.cwd] } : {}),
        ...(this.opts.provider ? { provider: this.opts.provider } : {}),
        ...(model ? { model } : this.opts.power ? { modelClass: this.opts.power } : {}),
        ...(agent.sessionId ? { resumeSessionId: agent.sessionId } : {}),
      },
      this.limits.turnTimeoutMs,
      this.controller.signal,
    );

    if (outcome.sessionId) agent.sessionId = outcome.sessionId;
    if (outcome.providerId) agent.providerId = outcome.providerId;
    if (outcome.model) agent.servedModel = outcome.model;
    if (outcome.usage) {
      const u = outcome.usage;
      agent.usage = addTokens(agent.usage, {
        input: u.inputTokens + (u.cacheCreationInputTokens ?? 0),
        output: u.outputTokens,
        cached: u.cacheReadInputTokens ?? 0,
      });
    }
    this.busy--;
    if (agent.status === "busy") agent.status = "idle";
    if (!turn.endedAt) {
      turn.endedAt = new Date().toISOString();
      turn.outcome = outcome.status;
    }
    this.progress(`@${agent.handle} turn ${turn.n} ${outcome.status}`, {
      tools: outcome.toolCalls,
      durationMs: outcome.durationMs,
      ...(outcome.error ? { error: outcome.error } : {}),
    });
    const woke =
      messages.length > 0
        ? `${messages.length} new`
        : turn.wokeBy.includes("nudge")
          ? "nudged"
          : turn.wokeBy.includes("runs")
            ? "run update"
            : undefined;
    this.record(
      [
        `@${agent.handle} turn ${turn.n} ${outcome.status}`,
        seconds(outcome.durationMs),
        ...(woke ? [woke] : []),
      ].join(" · "),
      { kind: "turn", actor: agent.id, subject: `turn:${turn.n}` },
    );
    this.changed("turn");
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
      this.log(`@${agent.handle} retired after ${failures} failed turns`, {
        kind: "retire",
        actor: agent.id,
      });
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
    const model = input.lead ? this.opts.model : (this.opts.workerModel ?? this.opts.model);
    const workers = [...this.agents.values()].filter((a) => !a.lead).length;
    const tone = input.lead ? "brand" : (WORKER_TONES[workers] ?? "neutral");
    const agent: SwarmAgent = {
      id: bot.handle,
      handle: bot.handle,
      displayName: bot.displayName,
      role: input.role,
      lead: input.lead,
      tone,
      botUserId: bot.botUserId,
      tokenId: bot.tokenId,
      ...(input.spawnedBy ? { spawnedBy: input.spawnedBy } : {}),
      ...(model ? { model } : {}),
      turns: 0,
      status: "idle",
      joinedAt: new Date().toISOString(),
    };
    this.agents.set(agent.id, agent);
    this.tokens.set(agent.id, bot.token);
    this.inboxes.set(agent.id, []);
    this.background.set(agent.id, []);
    this.changed("agent");
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
    const { agent, client } = this.as(agentId);
    const message = await this.onChannel(() => client.postMessage(this.channel.id, body));
    this.noteAsk(agent, message);
    this.enqueueMessage(message);
    return message;
  }

  async reply(agentId: string, messageId: string, body: string): Promise<ChatMessage> {
    const { agent, client } = this.as(agentId);
    // Replies attach to a thread root, so a reply-to-a-reply is lifted to it.
    const target = await this.onChannel(() => client.getMessage(messageId));
    if (target.channelId !== this.channel.id) {
      throw new Error(`message ${messageId} is not in this swarm's channel`);
    }
    const message = await this.onChannel(() => client.replyInThread(target.threadRootId, body));
    this.noteAsk(agent, message);
    this.enqueueMessage(message);
    return message;
  }

  // An agent's message addressed to @operator, or the owner's own handle, is a
  // question the swarm waits on until the operator next writes. A passing
  // mention ("I'll present both to @operator") is not.
  private noteAsk(agent: SwarmAgent, message: ChatMessage): void {
    const handles = addressedHandles(message.body);
    const asked =
      handles.includes("operator") ||
      (this.ownerHandle !== "" && handles.includes(this.ownerHandle));
    if (!asked) return;
    this.asks.push({
      agentId: agent.id,
      handle: agent.handle,
      messageId: message.id,
      threadRootId: message.threadRootId || message.id,
      text:
        message.body.length > ASK_CHARS ? `${message.body.slice(0, ASK_CHARS - 1)}…` : message.body,
      at: message.createdAt || new Date().toISOString(),
    });
    this.log(`@${agent.handle} asked the operator`, {
      kind: "ask",
      actor: agent.id,
      subject: message.threadRootId || message.id,
    });
    this.changed("health");
  }

  // A question clears when the operator replies in its thread or mentions the
  // asker; a top-level note that mentions nobody goes to the lead, so it clears
  // the lead's questions and no one else's.
  private answerAsks(message: ChatMessage, isRoot: boolean): void {
    if (this.asks.length === 0) return;
    const handles = new Set(mentionedHandles(message.body));
    const toLead =
      isRoot && ![...this.agents.values()].some((a) => handles.has(a.handle.toLowerCase()));
    const answered = this.asks.filter((ask) => {
      if (ask.threadRootId === message.threadRootId) return true;
      if (handles.has(ask.handle.toLowerCase())) return true;
      return toLead && this.agents.get(ask.agentId)?.lead === true;
    });
    if (answered.length === 0) return;
    this.dropAsks(answered, "the operator answered");
  }

  // Dismiss from the tab: the question stays in the channel, the card goes.
  dismissAsk(messageId: string): boolean {
    const ask = this.asks.find((a) => a.messageId === messageId);
    if (!ask) return false;
    this.dropAsks([ask], `dismissed @${ask.handle}'s question`);
    return true;
  }

  private dropAsks(gone: readonly OperatorAsk[], why: string): void {
    for (const ask of gone) {
      const at = this.asks.indexOf(ask);
      if (at >= 0) this.asks.splice(at, 1);
    }
    this.log(why, {
      kind: "answer",
      actor: "operator",
      ...(gone[0] ? { subject: gone[0].threadRootId } : {}),
    });
    this.changed("health");
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
    this.log(`@${spawner.handle} spawned @${agent.handle}: ${input.role}`, {
      kind: "spawn",
      actor: spawner.id,
      subject: agent.id,
    });
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
    const answers = Boolean(this.opts.dispatch?.dispatcher.respond);
    return [...this.runs.values()].map((r) => ({
      ...r,
      prUrls: [...r.prUrls],
      ...(r.pendingApproval
        ? {
            pendingApproval: {
              ...r.pendingApproval,
              answerer:
                answers && !this.opts.approvalRefusals?.has(r.workflow) ? "swarm" : "operator",
            },
          }
        : {}),
      ...(r.approvals ? { approvals: [...r.approvals] } : {}),
      ...(r.gates ? { gates: r.gates.map((g) => ({ ...g })) } : {}),
    }));
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
    if (this.status !== "running" || this.conclusion !== undefined) {
      const cancelled = await dispatch.dispatcher
        .cancel(runId)
        .catch((e): { ok: false; error: string } => ({ ok: false, error: errText(e) }));
      if (!cancelled.ok) {
        this.log(
          `could not cancel run ${runId}, started after the swarm ended: ${cancelled.error}`,
          {
            kind: "fault",
            subject: runId,
          },
        );
        throw new Error(
          `the swarm ended while run ${runId} was waiting to start, and cancelling it failed (${cancelled.error}); cancel it with run_cancel`,
        );
      }
      throw new Error("the swarm ended while the run was waiting to start; it was cancelled");
    }
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
    this.log(`started ${grant.name} run ${runId}: ${input.purpose}`, {
      kind: "run",
      actor: agentId,
      subject: runId,
    });
    this.changed("run");
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
    this.cancelling.add(runId);
    const result = await dispatch.dispatcher.cancel(runId);
    if (!result.ok) {
      this.cancelling.delete(runId);
      throw new Error(`could not cancel run ${runId}: ${result.error}`);
    }
    await this.syncRun(runId, { quiet: true });
    if (isLive(run)) {
      run.status = "cancelled";
      this.settleEnded(run);
    }
    this.changed("run");
    return run;
  }

  // An ended run waits at no gate, however it ended.
  private settleEnded(run: ChildRun): void {
    delete run.pendingApproval;
    const now = new Date().toISOString();
    for (const gate of run.gates ?? []) gate.closedAt ??= now;
    this.cancelling.delete(run.runId);
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
      // A read that raced a local cancel must not bring the run back.
      if (!status || this.status !== "running" || !isLive(run)) return;
      const gateBefore = gateKey(run.pendingApproval);
      const change = applyStatus(
        run,
        status,
        (url) =>
          [...this.runs.values()].some((r) => r !== run && r.prUrls.includes(url)) ||
          (this.opts.prOwnedElsewhere?.(url, this.id) ?? false),
      );
      if (gateKey(run.pendingApproval) !== gateBefore) this.trackGate(run);
      if (!isLive(run)) this.settleEnded(run);
      const breach = isolationBreach(run);
      if (breach) {
        await dispatch.dispatcher.cancel(runId).catch(() => undefined);
        run.status = "cancelled";
        run.error = `cancelled by the swarm: ${breach}`;
        run.verified = false;
        this.notifyLead(
          `Run ${runId} (${run.workflow}) was cancelled: ${breach}. Its grant requires an isolated worktree.`,
          { kind: "run", subject: runId },
        );
      } else if (
        change &&
        run.pendingApproval &&
        gateKey(run.pendingApproval) !== gateBefore &&
        !this.cancelling.has(runId)
      ) {
        await this.openGate(run, gateFiles(status), change);
      } else if (change && !opts.quiet) {
        // A run resuming after its approval needs nothing from the lead.
        this.notifyLead(
          change,
          { kind: "run", subject: runId },
          { wake: run.status !== "running" },
        );
      }
      this.changed(gateKey(run.pendingApproval) !== gateBefore ? "gate" : "run");
    } catch (e) {
      this.log(`could not read run ${runId}: ${errText(e)}`, { kind: "fault", subject: runId });
    } finally {
      this.syncing.delete(runId);
      if (this.resync.delete(runId)) void this.syncRun(runId);
    }
  }

  // Closes the gate the run left and opens the one it reached. A gate the swarm
  // answered has an approval since it opened; any other the run moved past, the
  // operator answered.
  private trackGate(run: ChildRun): void {
    const now = new Date().toISOString();
    const open = [...(run.gates ?? [])].reverse().find((g) => !g.closedAt);
    if (open) {
      open.closedAt = now;
      const bySwarm = run.approvals?.some((a) => a.nodeId === open.nodeId && a.at >= open.openedAt);
      if (bySwarm) open.by = "swarm";
      else if (this.cancelling.has(run.runId)) {
        // The swarm cancelled the run at this gate; nobody answered it.
      } else if (
        run.status === "running" ||
        run.status === "paused" ||
        run.status === "succeeded"
      ) {
        open.by = "operator";
      }
    }
    if (run.pendingApproval) {
      run.gates = [...(run.gates ?? []), { nodeId: run.pendingApproval.nodeId, openedAt: now }];
    }
  }

  private leadClient(): ClickClackClient | undefined {
    const lead = [...this.agents.values()].find((a) => a.lead);
    const token = lead ? this.tokens.get(lead.id) : undefined;
    return token ? this.owner.withToken(token) : undefined;
  }

  // Queues a run update for the lead's next turn and puts it on the channel, as
  // the lead, so the operator sees it without waking anyone.
  private notifyLead(
    text: string,
    meta: ActivityMeta,
    opts: { wake?: boolean; post?: boolean } = {},
  ): void {
    if (this.status !== "running") return;
    this.log(text, meta);
    const client = opts.post === false ? undefined : this.leadClient();
    if (client) {
      void client
        .postMessage(this.channel.id, `**Run update** ${text}`)
        .then((m) => this.enqueueMessage(m))
        .catch(() => {});
    }
    if (this.conclusion !== undefined || opts.wake === false) return;
    this.notes.push(text);
    this.pump();
  }

  // Puts a paused gate's prompt and files in a thread any agent can read, then
  // wakes the lead to have it answered.
  private async openGate(run: ChildRun, files: readonly GateFile[], change: string): Promise<void> {
    const gate = run.pendingApproval;
    const client = this.leadClient();
    if (!gate || !client) return;
    gate.openedAt = new Date().toISOString();
    gate.files = keptFiles(files);
    const prompt = files.some((f) => f.text !== undefined)
      ? withoutFileHints(gate.prompt)
      : gate.prompt;
    const parts = [
      ...splitBody(prompt, BODY_MAX - 64).map((p) => `**Gate prompt**\n\n${p}`),
      ...files.flatMap((f) =>
        f.text === undefined
          ? [`**${f.path}** could not be read: ${f.error ?? "no text"}`]
          : splitBody(f.text, BODY_MAX - 128).map(
              (p, i, all) =>
                `**${f.path}**${all.length > 1 ? ` (${i + 1}/${all.length})` : ""}${f.truncated && i === all.length - 1 ? " (cut short by the host)" : ""}\n\n${p}`,
            ),
      ),
    ];
    try {
      const root = await this.onChannel(() =>
        client.postMessage(
          this.channel.id,
          `**Approval needed** ${change} Its prompt and files follow in this thread.`,
        ),
      );
      gate.threadId = root.id;
      this.enqueueMessage(root);
      for (const part of parts) {
        this.enqueueMessage(await this.onChannel(() => client.replyInThread(root.id, part)));
      }
    } catch (e) {
      this.log(`could not post the gate for run ${run.runId}: ${errText(e)}`, {
        kind: "fault",
        subject: run.runId,
      });
    }
    const where = gate.threadId
      ? `Its prompt and files are in thread ${gate.threadId}.`
      : `Its prompt: ${gate.prompt}`;
    const how =
      this.opts.dispatch?.dispatcher.respond && !this.opts.approvalRefusals?.has(run.workflow)
        ? "Have another agent review it, then answer with chat_workflow_respond, citing that review."
        : "Only the operator can answer it: tell @operator in the channel what it is waiting for.";
    this.notifyLead(
      `${change} ${where} ${how}`,
      { kind: "gate", subject: run.runId },
      { post: false },
    );
  }

  async answerGate(
    agentId: string,
    input: {
      runId: string;
      decision: GateAnswer["decision"];
      review: string;
      reason: string;
      feedback?: string;
    },
  ): Promise<ChildRun> {
    const { dispatch, client } = this.dispatcherFor(agentId);
    const respond = dispatch.dispatcher.respond;
    if (!respond) {
      throw new Error(
        "this keelson host cannot answer a gate for the operator: tell @operator in the channel what the run is waiting for",
      );
    }
    const run = this.runs.get(input.runId);
    if (!run) throw new Error(`no run '${input.runId}' was started by this swarm`);
    const gate = run.pendingApproval;
    if (run.status !== "paused" || !gate) {
      throw new Error(`run ${input.runId} is ${run.status}, not waiting on an approval`);
    }
    const feedback = input.feedback?.trim();
    if (input.decision === "changes" && !feedback) {
      throw new Error("a changes decision needs feedback: what the run must change, and why");
    }
    if (input.decision === "changes" && feedback?.toLowerCase() === "approve") {
      throw new Error("the run reads the feedback 'approve' as an approval: say what to change");
    }
    const reviewer = await this.reviewer(input.review, gate.openedAt);
    const result = await respond(
      run.runId,
      gate.nodeId,
      input.decision === "approve" ? "approve" : (feedback ?? ""),
      gate.pauseId,
    );
    if (!result.ok) {
      if (/ribApprovalGrants/.test(result.error)) {
        this.opts.approvalRefusals?.set(run.workflow, true);
        this.changed("gate");
      }
      const refused = /ribApprovalGrants/.test(result.error)
        ? " The operator has not let this swarm answer this workflow's gates: tell @operator in the channel what the run is waiting for, then wait."
        : "";
      throw new Error(
        `could not answer ${gate.nodeId} on run ${run.runId}: ${result.error}.${refused}`,
      );
    }
    const answer: GateAnswer = {
      nodeId: gate.nodeId,
      decision: input.decision,
      reason: input.reason,
      ...(input.decision === "changes" && feedback ? { feedback } : {}),
      review: input.review,
      reviewer,
      at: new Date().toISOString(),
    };
    run.approvals = [...(run.approvals ?? []), answer];
    this.opts.approvalRefusals?.set(run.workflow, false);
    this.log(`answered ${gate.nodeId} on run ${run.runId}: ${input.decision}`, {
      kind: "gate-answer",
      actor: agentId,
      subject: run.runId,
    });
    this.changed("gate");
    const record = [
      `**${input.decision === "approve" ? "Approved" : "Changes requested"}** \`${gate.nodeId}\` on run \`${run.runId}\`, on ${reviewer}'s review ${input.review}.`,
      input.reason,
      ...(answer.feedback ? [`Sent to the run:\n${answer.feedback}`] : []),
    ].join("\n\n");
    const threadId = gate.threadId;
    for (const part of splitBody(record, BODY_MAX - 32)) {
      await this.onChannel(() =>
        threadId ? client.replyInThread(threadId, part) : client.postMessage(this.channel.id, part),
      )
        .then((m) => this.enqueueMessage(m))
        .catch((e) =>
          this.log(`could not post the answer for run ${run.runId}: ${errText(e)}`, {
            kind: "fault",
            subject: run.runId,
          }),
        );
    }
    void this.syncRun(run.runId, { quiet: true });
    return run;
  }

  // Who wrote the review a gate answer rests on: another agent of this swarm or
  // the operator, in this channel, after the gate opened. Never the lead.
  private async reviewer(messageId: string, openedAt: string | undefined): Promise<string> {
    let message: ChatMessage;
    try {
      message = await this.owner.getMessage(messageId);
    } catch {
      throw new Error(`no message '${messageId}': cite the id of the review message`);
    }
    if (message.channelId !== this.channel.id) {
      throw new Error(`message ${messageId} is not in this swarm's channel`);
    }
    if (openedAt && Date.parse(message.createdAt) < Date.parse(openedAt)) {
      throw new Error(
        `message ${messageId} predates the gate: cite a review written after it opened`,
      );
    }
    if (message.authorKind === "human") return message.authorName || "the operator";
    const author = [...this.agents.values()].find((a) => a.botUserId === message.authorId);
    if (!author)
      throw new Error(`message ${messageId} is not from this swarm's agents or the operator`);
    if (author.lead) {
      throw new Error(
        "the lead cannot review its own run's gate: have another agent review it, or ask @operator",
      );
    }
    return `@${author.handle}`;
  }

  private usage(): { usage?: SwarmSummary["usage"] } {
    const tallies = [...this.agents.values()].flatMap((a) => (a.usage ? [a.usage] : []));
    if (tallies.length === 0) return {};
    return {
      usage: tallies.reduce<SwarmSummary["usage"]>((sum, t) => addTokens(sum, t), undefined),
    };
  }

  // `waiting` is derived: an idle agent with messages queued has no slot, or the
  // swarm has concluded and starts nothing new.
  roster(): SwarmSummary["agents"] {
    return [...this.agents.values()].map(({ tokenId: _t, sessionId: _s, ...rest }) => {
      const queued = (this.inboxes.get(rest.id)?.length ?? 0) + (rest.lead ? this.notes.length : 0);
      if (queued === 0) return rest;
      return { ...rest, queued, ...(rest.status === "idle" ? { status: "waiting" as const } : {}) };
    });
  }

  // Turns started per minute over the last PACE_MINUTES, once two have passed.
  private pace(): number[] | undefined {
    return paceOf(
      this.spans.map((t) => Date.parse(t.startedAt)),
      Date.parse(this.startedAt),
      this.endedAt ? Date.parse(this.endedAt) : Date.now(),
      this.endedAt !== undefined,
    );
  }

  // Records the conclusion before posting it: the answer is the deliverable, and
  // a channel that cannot take the post must not lose it. Returns the post error.
  async conclude(agentId: string, summary: string): Promise<string | undefined> {
    const { agent, client } = this.as(agentId);
    if (!agent.lead) throw new Error("only the lead may conclude the swarm");
    const live = this.liveRuns();
    if (live.length > 0) {
      this.draftConclusion = summary;
      this.changed("conclusion");
      throw new Error(
        `${live.length} workflow run(s) are still live: ${live.map((r) => `${r.runId} (${r.workflow}, ${r.status})`).join(", ")}. Wait for them to finish, or cancel them with chat_workflow_cancel, then conclude.`,
      );
    }
    const asked = this.asks.filter((a) => a.agentId === agent.id);
    if (asked.length > 0) {
      this.draftConclusion = summary;
      this.changed("conclusion");
      throw new Error(
        `you asked @operator ${asked.length === 1 ? "a question" : `${asked.length} questions`} that ${asked.length === 1 ? "is" : "are"} still open (${asked.map((a) => a.messageId).join(", ")}). Their reply wakes you: wait for it, then conclude.`,
      );
    }
    if (summary.length > CONCLUSION_MAX) {
      this.draftConclusion = summary;
      this.refusedConclusions++;
      this.changed("conclusion");
      throw new Error(
        `conclusion refused: it is ${summary.length} characters and the limit is ${CONCLUSION_MAX}. Cut at least ${summary.length - CONCLUSION_MAX} characters and call chat_done again. Detail that does not fit can go in a chat_post first.`,
      );
    }
    this.conclusion = summary;
    this.draftConclusion = undefined;
    for (const id of this.inboxes.keys()) this.inboxes.set(id, []);
    this.background.clear();
    this.log(`@${agent.handle} concluded the swarm`, { kind: "conclusion", actor: agent.id });
    this.changed("conclusion");
    const parts = splitBody(summary, BODY_MAX - 32);
    try {
      for (const [i, part] of parts.entries()) {
        const heading =
          parts.length > 1 ? `**Conclusion (${i + 1}/${parts.length})**` : "**Conclusion**";
        await this.onChannel(() => client.postMessage(this.channel.id, `${heading}\n\n${part}`));
      }
      return undefined;
    } catch (e) {
      this.log(`the conclusion could not be posted to the channel: ${errText(e)}`, {
        kind: "fault",
      });
      return errText(e);
    }
  }

  // The lead's designed report. Publishing again replaces it.
  publishReport(agentId: string, title: string, html: string): SwarmReport {
    const { agent } = this.as(agentId);
    if (!agent.lead) throw new Error("only the lead publishes the swarm's report");
    const page = unwrapReport(html);
    const problem = checkReport(page);
    if (problem) throw new Error(problem);
    const report = { title, html: page, at: new Date().toISOString() };
    const again = this.report?.title === title;
    this.report = report;
    if (!again) {
      this.log(`@${agent.handle} published the report "${title}"`, {
        kind: "report",
        actor: agent.id,
      });
    }
    this.changed("report");
    return report;
  }

  reportPage(): SwarmReport | undefined {
    return this.report;
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
    this.noteOperator(`you posted in #${this.channel.name}`, note);
    this.enqueueMessage(message);
  }

  // Posted as the owner in the gate's thread, so it wakes everyone working there.
  async replyToGate(runId: string, note: string): Promise<void> {
    const run = this.runs.get(runId);
    const threadId = run?.status === "paused" ? run.pendingApproval?.threadId : undefined;
    if (this.status !== "running" || !threadId) {
      throw new Error(`run ${runId} has no open gate thread`);
    }
    const message = await this.owner.replyInThread(threadId, `**Operator:** ${note}`);
    this.noteOperator("you replied in the approval thread", note);
    this.enqueueMessage(message);
  }

  // Posted as the owner in a question's thread, so it wakes the agent who asked.
  async replyInThread(threadRootId: string, note: string): Promise<void> {
    if (this.status !== "running") throw new Error(`swarm ${this.id} is ${this.status}`);
    const message = await this.owner.replyInThread(threadRootId, `**Operator:** ${note}`);
    this.noteOperator("you replied in the question's thread", note);
    this.enqueueMessage(message);
  }

  // The board shows the operator's own post at once, before the lead's turn does.
  private noteOperator(where: string, note: string): void {
    const gist = note.split("\n", 1)[0]?.trim() ?? "";
    this.log(`${where}: ${gist.length > 80 ? `${gist.slice(0, 79).trimEnd()}…` : gist}`, {
      kind: "operator",
      actor: "operator",
    });
    this.changed("activity");
  }

  stop(reason = "stopped by operator"): Promise<SwarmSummary> {
    void this.finish("stopped", reason);
    return this.finished;
  }

  private health(): SwarmHealth | undefined {
    const lead = [...this.agents.values()].find((a) => a.lead);
    const leadFailures = lead ? (this.failures.get(lead.id) ?? 0) : 0;
    const health: SwarmHealth = {
      ...(this.socketDrops > 0 ? { socketDrops: this.socketDrops } : {}),
      ...(this.channelFault ? { channelFault: this.channelFault } : {}),
      ...(leadFailures > 0 ? { leadFailures } : {}),
      ...(this.lastLeadFailure ? { lastLeadFailure: this.lastLeadFailure } : {}),
      ...(this.nudges > 0 ? { nudges: this.nudges } : {}),
      ...(this.refusedConclusions > 0 ? { refusedConclusions: this.refusedConclusions } : {}),
      ...(this.quietSince ? { quietSince: this.quietSince } : {}),
      ...(this.asks.length > 0 ? { asks: this.asks.slice(-ASKS_KEPT) } : {}),
      ...(this.cancelFault ? { cancelFault: this.cancelFault } : {}),
    };
    return Object.keys(health).length > 0 ? health : undefined;
  }

  summary(): SwarmSummary {
    const health = this.health();
    const pace = this.pace();
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
      size: sizeOf(this.limits, this.opts.size ?? "medium"),
      sizeBase: this.opts.size ?? "medium",
      ...(this.opts.provider ? { provider: this.opts.provider } : {}),
      ...(this.opts.model ? { model: this.opts.model } : {}),
      ...(this.opts.workerModel ? { workerModel: this.opts.workerModel } : {}),
      // A named model overrides the power, so the power no longer applies.
      ...(this.opts.power && !this.opts.model ? { power: this.opts.power } : {}),
      ...(this.opts.project ? { project: this.opts.project } : {}),
      ...(this.opts.opId ? { opId: this.opts.opId } : {}),
      clickclack: { url: this.owner.baseUrl, workspaceId: this.opts.workspaceId },
      ...(health ? { health } : {}),
      agents: this.roster(),
      ...this.usage(),
      ...(this.activity.length > 0 ? { activity: this.activity.map((e) => ({ ...e })) } : {}),
      ...(this.opts.context?.length
        ? { context: contextIndex(this.opts.context, { excerpts: true }) }
        : {}),
      ...(this.opts.dispatch ? { workflows: this.opts.dispatch.grants.map((g) => g.name) } : {}),
      ...(this.opts.leadTools?.length ? { leadTools: [...this.opts.leadTools] } : {}),
      ...(this.runs.size > 0 ? { runs: this.runLedger() } : {}),
      ...(pace ? { pace } : {}),
      ...(this.spans.length > 0
        ? { spans: this.spans.map((t) => ({ ...t, wokeBy: [...t.wokeBy] })) }
        : {}),
      ...(this.conclusion !== undefined ? { conclusion: this.conclusion } : {}),
      ...(this.report ? { report: reportMeta(this.report) } : {}),
      ...(this.conclusion === undefined && this.draftConclusion !== undefined
        ? { draftConclusion: this.draftConclusion }
        : {}),
      ...(this.error ? { error: this.error } : {}),
      ...(this.opts.rerunOf ? { rerunOf: this.opts.rerunOf } : {}),
    };
  }

  private async finish(
    status: Exclude<SwarmStatus, "running" | "stopping">,
    reason?: string,
  ): Promise<void> {
    if (this.status !== "running") return;
    // A stop has runs to cancel and tokens to revoke before it is stopped.
    this.status = status === "stopped" ? "stopping" : status;
    this.endedAt = new Date().toISOString();
    if (status !== "done" && reason) this.error = reason;
    this.changed("end");
    for (const timer of [this.quiesceTimer, this.wallClockTimer, this.reconnectTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.controller.abort();
    if (this.runPoll) clearInterval(this.runPoll);
    for (const run of this.liveRuns()) {
      await this.opts.dispatch?.dispatcher.cancel(run.runId).catch((e) => {
        this.cancelFault = `run ${run.runId} (${run.workflow}) could not be cancelled: ${errText(e)}`;
        this.log(this.cancelFault, { kind: "fault", subject: run.runId });
      });
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
          this.log(`could not revoke the token for @${agent.handle}: ${errText(e)}`, {
            kind: "fault",
            subject: agent.id,
          });
        }
      });
    }
    this.tokens.clear();
    // Turns aborted by the end may report after the summary is frozen.
    const now = new Date().toISOString();
    for (const t of this.spans) {
      if (t.endedAt) continue;
      t.endedAt = now;
      t.outcome = "aborted";
    }
    this.status = status;
    this.log(`swarm ${this.id} ${status}${reason ? `: ${reason}` : ""}`, { kind: "end" });
    this.changed("end");
    this.done.resolve(this.summary());
  }
}
