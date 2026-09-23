// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { ContextIndexEntry } from "./context.ts";

export interface ChatMessage {
  id: string;
  channelId: string;
  authorId: string;
  authorKind: "human" | "bot";
  authorHandle: string;
  authorName: string;
  body: string;
  // Equals `id` for a top-level message.
  threadRootId: string;
  parentId?: string;
  createdAt: string;
}

export interface SwarmLimits {
  maxAgents: number;
  // Total agent turns across the whole swarm: the spend ceiling.
  maxTurns: number;
  maxTurnsPerAgent: number;
  maxConcurrent: number;
  wallClockMs: number;
  turnTimeoutMs: number;
  // Times an idle swarm re-prompts its lead before giving up as stalled.
  maxNudges: number;
}

// A message, brief, or task body. The conclusion gets more room because it is the
// swarm's whole deliverable; the channel receives it in parts of BODY_MAX.
export const BODY_MAX = 8_000;
export const CONCLUSION_MAX = 20_000;

export const DEFAULT_LIMITS: SwarmLimits = {
  maxAgents: 5,
  maxTurns: 40,
  maxTurnsPerAgent: 12,
  maxConcurrent: 3,
  wallClockMs: 30 * 60_000,
  turnTimeoutMs: 5 * 60_000,
  maxNudges: 2,
};

export const SWARM_SIZES = ["small", "medium", "large"] as const;
export type SwarmSize = (typeof SWARM_SIZES)[number];

// Medium is DEFAULT_LIMITS, so a start that names no size behaves as it always has.
export const SIZE_PRESETS: Readonly<Record<SwarmSize, SwarmLimits>> = {
  small: {
    ...DEFAULT_LIMITS,
    maxAgents: 3,
    maxTurns: 20,
    maxTurnsPerAgent: 8,
    wallClockMs: 15 * 60_000,
  },
  medium: DEFAULT_LIMITS,
  large: {
    ...DEFAULT_LIMITS,
    maxAgents: 8,
    maxTurns: 80,
    maxTurnsPerAgent: 16,
    maxConcurrent: 4,
    wallClockMs: 60 * 60_000,
  },
};

// How much model the agents get: the provider's model for that class, unless a model is named.
export const SWARM_POWERS = ["fast", "balanced", "deep"] as const;
export type SwarmPower = (typeof SWARM_POWERS)[number];

// The size a swarm's limits match, or "custom" once an override moved one off its base.
export function sizeOf(limits: SwarmLimits, base: SwarmSize): SwarmSize | "custom" {
  const preset = SIZE_PRESETS[base];
  const keys = Object.keys(preset) as (keyof SwarmLimits)[];
  return keys.every((k) => limits[k] === preset[k]) ? base : "custom";
}

// Identity colors in spawn order: the lead is brand, the first five workers take
// the host's identity hues, and later ones are neutral beside their name.
export const WORKER_TONES = ["id-blue", "id-amber", "id-teal", "id-rose", "id-olive"] as const;
export type AgentTone = "brand" | (typeof WORKER_TONES)[number] | "neutral";

// `waiting`: idle with messages queued, because every slot is taken or the swarm
// has concluded. `failed`: retired after too many consecutive failed turns.
export type AgentStatus = "idle" | "waiting" | "busy" | "capped" | "failed";

// A swarm that is still on the tab as live: running, or stopping.
export function isLive(status: SwarmStatus): boolean {
  return status === "running" || status === "stopping";
}

export interface SwarmAgent {
  id: string;
  handle: string;
  displayName: string;
  role: string;
  lead: boolean;
  tone: AgentTone;
  botUserId: string;
  tokenId: string;
  spawnedBy?: string;
  sessionId?: string;
  // The model the swarm asked for on this agent's turns; absent means the provider's default.
  model?: string;
  // The provider that served this agent's last turn, and the model it reported.
  providerId?: string;
  servedModel?: string;
  usage?: TokenTally;
  turns: number;
  status: AgentStatus;
  // Messages waiting in the agent's inbox, when any are.
  queued?: number;
}

export interface GateFileText {
  path: string;
  text?: string;
  error?: string;
  truncated?: boolean;
}

export interface ActivityEntry {
  at: string;
  text: string;
  // Consecutive identical events collapse into one entry that counts them.
  count?: number;
}

// Tokens summed over turns. `input` counts cache writes too; `cached` is cache reads.
export interface TokenTally {
  input: number;
  output: number;
  cached: number;
}

export function addTokens(a: TokenTally | undefined, b: TokenTally): TokenTally {
  return {
    input: (a?.input ?? 0) + b.input,
    output: (a?.output ?? 0) + b.output,
    cached: (a?.cached ?? 0) + b.cached,
  };
}

// `stopping`: Stop was accepted; the child runs are being cancelled and the bot
// tokens revoked. It becomes `stopped` once that work is done.
export type SwarmStatus =
  | "running"
  | "stopping"
  | "done"
  | "stalled"
  | "exhausted"
  | "stopped"
  | "error";

// A catalog workflow the operator lets the lead start. `isolated` runs must
// establish their own worktree; one found in the live checkout is cancelled.
export interface DispatchGrant {
  name: string;
  isolated: boolean;
}

export type ChildRunStatus = "running" | "paused" | "succeeded" | "failed" | "cancelled";

export interface ChildRun {
  runId: string;
  workflow: string;
  purpose: string;
  inputs: Record<string, string>;
  status: ChildRunStatus;
  startedAt: string;
  completedAt?: string;
  isolated: boolean;
  checkout?: { path: string | null; branch: string | null; worktreeEstablished: boolean };
  // Nodes that have finished or paused.
  nodesDone: number;
  // The node the run reached last.
  lastNode?: string;
  // `threadId` is the channel thread holding the gate's prompt and files.
  pendingApproval?: {
    nodeId: string;
    prompt: string;
    pauseId?: string;
    threadId?: string;
    openedAt?: string;
    // `operator` when this swarm cannot answer the gate: the host offers no
    // respond, or refused one on this workflow under ribApprovalGrants.
    answerer?: "swarm" | "operator";
    // The agent the lead asked to review the plan, taken from the lead's
    // mention in the gate thread; absent when no agent was asked.
    reviewer?: string;
    // The files the gate names, such as the plan, kept for the reading pane.
    files?: GateFileText[];
  };
  // Gates the swarm answered for the operator.
  approvals?: GateAnswer[];
  prUrls: string[];
  // The CI verdict the run's workflow printed, if it printed one.
  ci?: { verdict: CiVerdict; detail?: string };
  error?: string;
  // Succeeded with the evidence its grant demands: for an isolated run, an
  // established worktree, a pull request, and a passing CI verdict.
  verified: boolean;
}

export type CiVerdict = "pass" | "fail" | "unknown";

export interface GateAnswer {
  nodeId: string;
  decision: "approve" | "changes";
  reason: string;
  // What the run was told to change, for a `changes` decision.
  feedback?: string;
  // The message the decision rests on, and who wrote it.
  review: string;
  reviewer: string;
  at: string;
}

export interface ReportMeta {
  title: string;
  at: string;
  bytes: number;
}

export interface SwarmSummary {
  id: string;
  task: string;
  status: SwarmStatus;
  channelId: string;
  channelName: string;
  startedAt: string;
  endedAt?: string;
  turnsUsed: number;
  limits: SwarmLimits;
  size: SwarmSize | "custom";
  // The preset the limits started from.
  sizeBase: SwarmSize;
  // As asked for at start; absent means the host's default.
  provider?: string;
  model?: string;
  workerModel?: string;
  power?: SwarmPower;
  project?: SwarmProject;
  // The durable op the swarm reports to.
  opId?: string;
  clickclack?: { url: string; workspaceId: string };
  // Present only while something is wrong or was.
  health?: SwarmHealth;
  agents: readonly Omit<SwarmAgent, "tokenId" | "sessionId">[];
  // The evidence the swarm was given, without the bodies.
  context?: readonly ContextIndexEntry[];
  // The workflows the launch let the lead start; absent on a Discuss swarm.
  workflows?: readonly string[];
  // Workflow runs the lead started, with their evidence.
  runs?: readonly ChildRun[];
  // Turns started per minute over the last 30 minutes, oldest first, once two
  // minutes have passed.
  pace?: readonly number[];
  conclusion?: string;
  // The lead's designed report page, when it published one.
  report?: ReportMeta;
  // Every agent's tokens summed; absent when the provider reported none.
  usage?: TokenTally;
  // The swarm's latest events, oldest first.
  activity?: readonly ActivityEntry[];
  // The lead's last conclusion that was refused, kept when no conclusion landed.
  draftConclusion?: string;
  error?: string;
}

export interface SwarmHealth {
  // Socket closes since it last opened; two means ClickClack stopped answering.
  socketDrops?: number;
  channelFault?: string;
  leadFailures?: number;
  lastLeadFailure?: string;
  nudges?: number;
  refusedConclusions?: number;
  // When the swarm went idle with a run paused at a gate; the next turn clears it.
  quietSince?: string;
  // Questions agents put to the operator, each open until answered in its
  // thread, by a post that mentions the asker, or dismissed.
  asks?: readonly OperatorAsk[];
  // A live run the swarm could not cancel when it stopped.
  cancelFault?: string;
}

export interface OperatorAsk {
  agentId: string;
  handle: string;
  messageId: string;
  // The thread the question lives in: the message itself, or its thread root.
  threadRootId: string;
  text: string;
  at: string;
}

export interface SwarmProject {
  id: string;
  name: string;
}

// A swarm between its start call and a booted channel.
export interface StartingSwarm {
  id: string;
  task: string;
  startedAt: string;
  limits: SwarmLimits;
  sizeBase: SwarmSize;
  provider?: string;
  model?: string;
  workerModel?: string;
  power?: SwarmPower;
  project?: SwarmProject;
  opId?: string;
}

// Carried on RibAgentTurnRequest.turnContext so a chat_* tool knows which agent
// is calling without the agent ever naming itself.
export interface ChatTurnContext {
  swarmId: string;
  agentId: string;
}

export function readTurnContext(
  raw: Readonly<Record<string, unknown>> | undefined,
): ChatTurnContext | null {
  const swarmId = raw?.swarmId;
  const agentId = raw?.agentId;
  return typeof swarmId === "string" && typeof agentId === "string" ? { swarmId, agentId } : null;
}
