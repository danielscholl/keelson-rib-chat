// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

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

export const DEFAULT_LIMITS: SwarmLimits = {
  maxAgents: 5,
  maxTurns: 40,
  maxTurnsPerAgent: 12,
  maxConcurrent: 3,
  wallClockMs: 30 * 60_000,
  turnTimeoutMs: 5 * 60_000,
  maxNudges: 2,
};

export type AgentStatus = "idle" | "busy" | "capped";

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
  conclusion?: string;
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
