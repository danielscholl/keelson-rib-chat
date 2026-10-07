// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { addTokens, type ModelUsage, type SwarmSummary, type TokenTally } from "./types.ts";

type Agent = SwarmSummary["agents"][number];

// The host's RibContext.priceTokens, mirrored structurally so the rib builds
// against a shared package that predates it.
export interface PricedCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  cacheWrite1hTokens?: number | null;
}
export type Pricer = (provider: string, model: string, tokens: PricedCounts) => number | undefined;

// List-price dollars, priced on every read so a price correction reprices history.
// `unpricedTurns` > 0 makes `usd` a floor.
export interface Cost {
  usd: number;
  unpricedTurns: number;
}

let pricer: Pricer | undefined;

export function setPricer(next: Pricer | undefined): void {
  pricer = next;
}

export function pricedCounts(t: TokenTally): PricedCounts {
  const write = t.cacheWrite ?? 0;
  return {
    inputTokens: Math.max(0, t.input - write),
    outputTokens: t.output,
    cacheReadTokens: t.cached,
    ...(t.cacheWrite !== undefined ? { cacheWriteTokens: write } : {}),
    ...(t.cacheWrite1h !== undefined ? { cacheWrite1hTokens: t.cacheWrite1h } : {}),
  };
}

// An agent recorded before per-model tallies were kept prices its whole tally at
// the last model it was served.
export function modelRows(a: Agent): readonly ModelUsage[] {
  if (a.usageByModel) return a.usageByModel;
  if (!a.usage) return [];
  const model = a.servedModel ?? a.model;
  return model ? [{ ...a.usage, provider: a.providerId ?? "unknown", model, turns: a.turns }] : [];
}

export function costOf(rows: readonly ModelUsage[]): Cost | undefined {
  if (!pricer || rows.length === 0) return undefined;
  let usd = 0;
  let unpricedTurns = 0;
  for (const row of rows) {
    const priced = pricer(row.provider, row.model, pricedCounts(row));
    if (priced === undefined) unpricedTurns += row.turns;
    else usd += priced;
  }
  return { usd, unpricedTurns };
}

export const agentCost = (a: Agent): Cost | undefined => costOf(modelRows(a));

export const swarmCost = (s: Pick<SwarmSummary, "agents">): Cost | undefined =>
  costOf(s.agents.flatMap(modelRows));

// Every agent's rows folded by provider and model, costliest first when priced.
export function byModel(s: Pick<SwarmSummary, "agents">): ModelUsage[] {
  const folded = new Map<string, ModelUsage>();
  for (const row of s.agents.flatMap(modelRows)) {
    const key = `${row.provider}\u0000${row.model}`;
    const prior = folded.get(key);
    folded.set(
      key,
      prior ? { ...prior, ...addTokens(prior, row), turns: prior.turns + row.turns } : { ...row },
    );
  }
  const rows = [...folded.values()];
  return rows.sort((a, b) => (costOf([b])?.usd ?? 0) - (costOf([a])?.usd ?? 0));
}

// Share of prompt tokens served from cache, as the Usage page reports it.
export function cacheHit(t: TokenTally): number | undefined {
  const prompt = t.input + t.cached;
  return t.cached > 0 && prompt > 0 ? t.cached / prompt : undefined;
}

// Usage's money format: cents at a dollar and up, four places under it.
export function usd(n: number): string {
  return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
}

export function costText(c: Cost): string {
  return c.unpricedTurns > 0 ? `≥ ${usd(c.usd)}` : usd(c.usd);
}
