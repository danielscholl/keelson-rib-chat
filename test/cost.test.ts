import { afterEach, describe, expect, test } from "bun:test";
import {
  byModel,
  cacheHit,
  costOf,
  costText,
  modelRows,
  type Pricer,
  pricedCounts,
  setPricer,
  swarmCost,
  usd,
} from "../src/cost.ts";
import type { ModelUsage, SwarmSummary } from "../src/types.ts";

type Agent = SwarmSummary["agents"][number];

// $1 per million of every kind, $2 for 1-hour writes; unknown models unpriced.
const flat: Pricer = (_provider, model, t) =>
  model === "unpriced"
    ? undefined
    : (t.inputTokens +
        t.outputTokens +
        (t.cacheReadTokens ?? 0) +
        (t.cacheWriteTokens ?? 0) +
        (t.cacheWrite1hTokens ?? 0)) /
      1_000_000;

function row(patch: Partial<ModelUsage> = {}): ModelUsage {
  return {
    provider: "copilot",
    model: "gpt-6.1-sol",
    turns: 2,
    input: 1_000_000,
    output: 1_000_000,
    cached: 1_000_000,
    ...patch,
  };
}

function agent(patch: Partial<Agent> = {}): Agent {
  return {
    id: "a",
    handle: "s1-a",
    displayName: "a",
    role: "r",
    lead: false,
    tone: "neutral",
    botUserId: "u",
    turns: 2,
    status: "idle",
    ...patch,
  };
}

afterEach(() => setPricer(undefined));

describe("cost", () => {
  test("splits cache writes out of input and keeps the 1-hour share", () => {
    expect(
      pricedCounts({ input: 900, output: 10, cached: 50, cacheWrite: 600, cacheWrite1h: 400 }),
    ).toEqual({
      inputTokens: 300,
      outputTokens: 10,
      cacheReadTokens: 50,
      cacheWriteTokens: 600,
      cacheWrite1hTokens: 400,
    });
    expect(pricedCounts({ input: 900, output: 10, cached: 50 })).toEqual({
      inputTokens: 900,
      outputTokens: 10,
      cacheReadTokens: 50,
    });
  });

  test("prices nothing without a host pricer", () => {
    expect(costOf([row()])).toBeUndefined();
  });

  test("an unpriced model makes the cost a floor and counts its turns", () => {
    setPricer(flat);
    const cost = costOf([row(), row({ model: "unpriced", turns: 5 })]);
    expect(cost).toEqual({ usd: 3, unpricedTurns: 5 });
    expect(costText(cost!)).toBe("≥ $3.00");
  });

  test("an agent recorded before per-model tallies prices at its served model", () => {
    const legacy = agent({
      usage: { input: 10, output: 5, cached: 2 },
      servedModel: "claude-opus-5-5",
      providerId: "claude",
    });
    expect(modelRows(legacy)).toEqual([
      { input: 10, output: 5, cached: 2, provider: "claude", model: "claude-opus-5-5", turns: 2 },
    ]);
    expect(modelRows(agent({ usage: { input: 1, output: 1, cached: 0 } }))).toEqual([]);
  });

  test("folds every agent's rows by model, costliest first", () => {
    setPricer(flat);
    const s = {
      agents: [
        agent({ usageByModel: [row({ input: 1 })] }),
        agent({ usageByModel: [row(), row({ model: "claude-opus-5-5", provider: "claude" })] }),
      ],
    };
    const models = byModel(s);
    expect(models.map((m) => [m.model, m.turns])).toEqual([
      ["gpt-6.1-sol", 4],
      ["claude-opus-5-5", 2],
    ]);
    expect(swarmCost(s)?.usd).toBeCloseTo(8.000001, 9);
  });

  test("cache hit and money read the way the Usage page reads them", () => {
    expect(cacheHit({ input: 50, output: 0, cached: 950 })).toBe(0.95);
    expect(cacheHit({ input: 50, output: 0, cached: 0 })).toBeUndefined();
    expect(usd(12.694)).toBe("$12.69");
    expect(usd(0.07921)).toBe("$0.0792");
  });
});
