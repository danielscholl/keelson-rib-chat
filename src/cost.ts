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

// Usage's money format, held to cents for rows where four places are noise.
export function cents(n: number): string {
  return n > 0 && n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`;
}

// List dollars per minute since the swarm started, once a minute has passed.
export function spendRate(
  s: Pick<SwarmSummary, "agents" | "startedAt" | "endedAt">,
  now = new Date(),
): number | undefined {
  const cost = swarmCost(s)?.usd;
  const end = s.endedAt ? Date.parse(s.endedAt) : now.getTime();
  const minutes = (end - Date.parse(s.startedAt)) / 60_000;
  return cost !== undefined && minutes >= 1 ? cost / minutes : undefined;
}

// How far into its ceilings a swarm is, by the nearer of the two.
export interface SpendProgress {
  kind: "cost" | "tokens";
  used: number;
  ceiling: number;
}

export function spendProgress(s: SwarmSummary): SpendProgress | undefined {
  const c = s.spend;
  if (!c) return undefined;
  const fresh = s.usage ? s.usage.input + s.usage.output : 0;
  const tokens: SpendProgress = { kind: "tokens", used: fresh, ceiling: c.maxTokens };
  const cost = swarmCost(s)?.usd;
  if (cost === undefined || c.maxCostUsd === undefined) return tokens;
  const dollars: SpendProgress = { kind: "cost", used: cost, ceiling: c.maxCostUsd };
  return dollars.used / dollars.ceiling >= tokens.used / tokens.ceiling ? dollars : tokens;
}

// The next round step up from a ceiling, about half again: $40 to $60, 1M to 1.5M.
export function raisedCeiling(n: number): number {
  const target = n * 1.5;
  const step = 10 ** Math.floor(Math.log10(target)) / 2;
  return Math.ceil(target / step) * step;
}

export interface PlanHistory {
  median: number;
  highest: number;
  runs: number;
}

// What each plan has cost on this host, from ended swarms the host could price.
export function planHistory(
  ended: readonly SwarmSummary[],
): Partial<Record<SwarmSummary["sizeBase"], PlanHistory>> {
  const costs = new Map<SwarmSummary["sizeBase"], number[]>();
  for (const s of ended) {
    const cost = swarmCost(s);
    if (!cost || cost.unpricedTurns > 0 || cost.usd <= 0) continue;
    costs.set(s.sizeBase, [...(costs.get(s.sizeBase) ?? []), cost.usd]);
  }
  return Object.fromEntries(
    [...costs].map(([size, list]) => {
      const sorted = [...list].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median =
        sorted.length % 2 === 1
          ? (sorted[mid] as number)
          : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
      return [size, { median, highest: sorted.at(-1) as number, runs: sorted.length }];
    }),
  );
}

// Priced from a tally kept before cache writes and models were recorded per agent.
export function estimated(s: Pick<SwarmSummary, "agents">): boolean {
  return s.agents.some((a) => a.usage && !a.usageByModel);
}

// A row's cost in cents, marked ≈ for an estimate and ≥ for a floor.
export function rowCost(c: Cost, estimate = false): string {
  return `${estimate ? "≈ " : ""}${c.unpricedTurns > 0 ? "≥ " : ""}${cents(c.usd)}`;
}
