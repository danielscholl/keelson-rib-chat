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

// `failed`: retired after too many consecutive failed turns.
export type AgentStatus = "idle" | "busy" | "capped" | "failed";

export interface SwarmAgent {
  id: string;
  handle: string;
  displayName: string;
  role: string;
  lead: boolean;
  botUserId: string;
  tokenId: string;
  spawnedBy?: string;
  sessionId?: string;
  turns: number;
  status: AgentStatus;
}

export type SwarmStatus = "running" | "done" | "stalled" | "exhausted" | "stopped" | "error";

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
  pendingApproval?: { nodeId: string; prompt: string };
  prUrls: string[];
  // The CI verdict the run's workflow printed, if it printed one.
  ci?: { verdict: CiVerdict; detail?: string };
  error?: string;
  // Succeeded with the evidence its grant demands: for an isolated run, an
  // established worktree, a pull request, and a passing CI verdict.
  verified: boolean;
}

export type CiVerdict = "pass" | "fail" | "unknown";

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
  agents: readonly Omit<SwarmAgent, "tokenId" | "sessionId">[];
  // The evidence the swarm was given, without the bodies.
  context?: readonly ContextIndexEntry[];
  // Workflow runs the lead started, with their evidence.
  runs?: readonly ChildRun[];
  conclusion?: string;
  // The lead's last conclusion that was refused, kept when no conclusion landed.
  draftConclusion?: string;
  error?: string;
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
