// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { SwarmLimits, SwarmSummary, TokenTally } from "./types.ts";

// What a swarm runs on, in one short label: the model asked for, the split when
// lead and workers differ, or the provider's default once a turn named the provider.
export function modelLabel(s: Pick<SwarmSummary, "model" | "workerModel" | "agents">): string {
  const lead = s.model;
  const workers = s.workerModel ?? s.model;
  if (lead && workers && lead !== workers) return `${lead} · workers ${workers}`;
  if (workers && !lead) return `provider default · workers ${workers}`;
  if (lead) return lead;
  const served = s.agents.find((a) => a.providerId)?.providerId;
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
