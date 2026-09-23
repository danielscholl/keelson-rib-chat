// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { SwarmLimits, SwarmSummary, TokenTally } from "./types.ts";

// The models the host reported serving the swarm's agents, each once.
export function servedModels(s: Pick<SwarmSummary, "agents">): string[] {
  return [...new Set(s.agents.flatMap((a) => (a.servedModel ? [a.servedModel] : [])))];
}

// What a swarm runs on, in one short label: the model asked for, the split when
// lead and workers differ, else what served its power, or the provider's default.
export function modelLabel(
  s: Pick<SwarmSummary, "model" | "workerModel" | "power" | "agents">,
): string {
  const lead = s.model;
  const workers = s.workerModel ?? s.model;
  const power = s.power ? `${s.power} power` : undefined;
  if (lead && workers && lead !== workers) return `${lead} · workers ${workers}`;
  if (workers && !lead) return `${power ?? "provider default"} · workers ${workers}`;
  if (lead) return lead;
  const models = servedModels(s);
  if (models.length === 1 && models[0]) return power ? `${models[0]} · ${power}` : models[0];
  const served = s.agents.find((a) => a.providerId)?.providerId;
  if (power) return served ? `${power} on ${served}` : power;
  return served ? `${served} default` : "provider default";
}

// A size's numbers in one line, for descriptions and hovers.
export function sizeText(limits: SwarmLimits): string {
  return `${limits.maxAgents} agents · ${limits.maxTurns} turns, ${limits.maxTurnsPerAgent} per worker · ${limits.maxConcurrent} at once · ${limits.wallClockMs / 60_000} min`;
}

export function tokenCount(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function tokensText(t: TokenTally): string {
  return `${tokenCount(t.input)} in · ${tokenCount(t.output)} out${t.cached > 0 ? ` · ${tokenCount(t.cached)} cached` : ""}`;
}

export function tokenTotal(t: TokenTally): number {
  return t.input + t.output + t.cached;
}
