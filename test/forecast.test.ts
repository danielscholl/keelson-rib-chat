import { describe, expect, test } from "bun:test";
import {
  type Forecast,
  forecast,
  forecastDelta,
  PACE_WINDOW_MINUTES,
} from "../src/surface/forecast.ts";
import { hhmm } from "../src/surface/format.ts";
import { endsAt } from "../src/surface/parts.ts";
import { turnsTile } from "../src/surface/swarm-board.ts";
import { SIZE_PRESETS, type SwarmSummary, type TurnSpan } from "../src/types.ts";

type Summary = Pick<SwarmSummary, "spans" | "pace" | "turnsUsed" | "limits" | "startedAt" | "runs">;
const START = "2026-09-22T14:00:00.000Z";
const NOW = new Date("2026-09-22T14:21:00.000Z");

function summary(patch: Partial<Summary> = {}): Summary {
  return { startedAt: START, limits: SIZE_PRESETS.medium, turnsUsed: 18, ...patch };
}

function spans(minutes: readonly number[]): TurnSpan[] {
  return minutes.map((minute, i) => ({
    agentId: "lead",
    n: i + 1,
    startedAt: new Date(Date.parse(START) + minute * 60_000).toISOString(),
    messages: 1,
    wokeBy: ["rib"],
  }));
}

function recentSpans(turns: number, minute = 20.5): TurnSpan[] {
  return spans(Array.from({ length: turns }, () => minute));
}

describe("turn budget forecast", () => {
  test("projects turns running out before the clock from recent turn starts", () => {
    expect(PACE_WINDOW_MINUTES).toBe(5);
    const s = summary({ turnsUsed: 32, pace: [20, 2, 1, 2, 1, 2], spans: recentSpans(8) });
    const f: Forecast = forecast(s, NOW);
    expect(f).toEqual({
      reading: "runs-out-first",
      left: 8,
      rate: 1.6,
      runOutAt: "2026-09-22T14:26:00.000Z",
      clockEndsAt: endsAt(s),
    });
    expect(forecastDelta(f)).toEqual({
      text: `8 left · out about ${hhmm("2026-09-22T14:26:00.000Z")}, before the clock`,
      direction: "down",
      tone: "warn",
    });
  });

  test("projects unused turns when the clock ends first", () => {
    const s = summary({ pace: [1, 1, 1, 1, 2], spans: recentSpans(6) });
    const f = forecast(s, NOW);
    expect(f).toEqual({
      reading: "clock-first",
      left: 22,
      rate: 1.2,
      runOutAt: "2026-09-22T14:39:20.000Z",
      clockEndsAt: endsAt(s),
      unused: 11,
    });
    expect(forecastDelta(f)).toEqual({
      text: `22 left · about 11 unused at ${hhmm(endsAt(s))}`,
      direction: "flat",
      tone: "caution",
    });
  });

  test("reports pace fitting the clock when less than a tenth would be unused", () => {
    const f = forecast(summary({ pace: [2, 2, 2, 2, 3], spans: recentSpans(11) }), NOW);
    expect(f).toMatchObject({
      reading: "fits",
      left: 22,
      rate: 2.2,
      runOutAt: "2026-09-22T14:31:00.000Z",
      unused: 2,
    });
    expect(forecastDelta(f)).toEqual({
      text: "22 left · pace fits the clock",
      direction: "flat",
    });
  });

  test("a live workflow run holds the projection instead of extrapolating the early pace", () => {
    const live = (status: "running" | "paused" | "succeeded") => ({
      runId: "r1",
      workflow: "fix-issue",
      purpose: "Fix issue 2",
      inputs: {},
      status,
      startedAt: START,
      isolated: true,
      nodesDone: 3,
      prUrls: [],
      verified: false,
    });
    const busy = summary({ turnsUsed: 20, spans: recentSpans(20) });
    expect(forecast(busy, NOW).reading).toBe("runs-out-first");
    for (const status of ["running", "paused"] as const) {
      const f = forecast({ ...busy, runs: [live(status)] }, NOW);
      expect(f).toEqual({ reading: "on-run", left: 20, clockEndsAt: endsAt(summary()) });
      expect(forecastDelta(f)).toEqual({
        text: "20 left · waiting on a workflow run",
        direction: "flat",
      });
    }
    expect(forecast({ ...busy, runs: [live("succeeded")] }, NOW).reading).toBe("runs-out-first");
  });

  test("reports no pace when turn starts are old despite nonempty pace buckets", () => {
    const f = forecast(summary({ pace: [18, 1, 1, 1, 1, 1], spans: spans([1, 2, 3]) }), NOW);
    expect(f).toEqual({ reading: "no-pace", left: 22, clockEndsAt: endsAt(summary()) });
    expect(forecastDelta(f)).toEqual({
      text: "22 left · no turn in 5 min",
      direction: "flat",
    });
  });

  test.each([40, 43])("reports no turns left when %i are used", (turnsUsed) => {
    const f = forecast(summary({ turnsUsed, pace: [2, 2, 2, 2, 2] }), NOW);
    expect(f).toEqual({ reading: "out-of-turns", left: 0, clockEndsAt: endsAt(summary()) });
    expect(forecastDelta(f)).toEqual({
      text: "none left · agents finish their turns",
      direction: "down",
      tone: "warn",
    });
  });

  test("uses elapsed time rather than five minutes for a short pace array", () => {
    const f = forecast(
      summary({ turnsUsed: 6, pace: [2, 1, 3] }),
      new Date("2026-09-22T14:02:30.000Z"),
    );
    expect(f).toMatchObject({ reading: "runs-out-first", left: 34, rate: 2.4 });
  });

  test("counts all five turns in the reviewer's partial-bucket example", () => {
    const f = forecast(
      summary({
        turnsUsed: 5,
        pace: [0, 1, 1, 1, 1, 1, 0],
        spans: spans([1.75, 2.75, 3.75, 4.75, 5.75]),
      }),
      new Date("2026-09-22T14:06:30.000Z"),
    );
    expect(f).toMatchObject({ reading: "clock-first", rate: 1, unused: 12 });
  });

  test("includes the window boundaries but excludes older and future turn starts", () => {
    const f = forecast(
      summary({ spans: spans([1.499, 1.5, 2.75, 6.5, 6.501]) }),
      new Date("2026-09-22T14:06:30.000Z"),
    );
    expect(f).toMatchObject({ rate: 0.6 });
  });

  test("uses elapsed time for timestamp pace in a young swarm before buckets exist", () => {
    const f = forecast(
      summary({ turnsUsed: 3, spans: spans([0, 0.5, 1.25]) }),
      new Date("2026-09-22T14:01:30.000Z"),
    );
    expect(f).toMatchObject({ reading: "runs-out-first", rate: 2 });
  });

  test("uses at least one minute for timestamp pace just after start", () => {
    const f = forecast(
      summary({ turnsUsed: 3, spans: spans([0, 0.1, 0.25]) }),
      new Date("2026-09-22T14:00:30.000Z"),
    );
    expect(f).toMatchObject({ reading: "runs-out-first", rate: 3 });
  });

  test("does not fall back to pace buckets or total turns when spans are empty", () => {
    expect(forecast(summary({ spans: [], pace: [2, 2, 2, 2, 2] }), NOW)).toMatchObject({
      reading: "no-pace",
    });
  });

  test("corrects the partial-bucket denominator for the reviewer's example without spans", () => {
    const f = forecast(
      summary({ turnsUsed: 5, pace: [0, 1, 1, 1, 1, 1, 0] }),
      new Date("2026-09-22T14:06:30.000Z"),
    );
    expect(f).toMatchObject({ reading: "clock-first", rate: 4 / 4.5 });
  });

  test.each([21, 30, 30.5, 120.5])(
    "keeps the timestamp window at five minutes after %f elapsed minutes",
    (elapsed) => {
      const f = forecast(
        summary({ spans: recentSpans(8, elapsed - 0.5) }),
        new Date(Date.parse(START) + elapsed * 60_000),
      );
      expect(f).toMatchObject({ rate: 1.6 });
    },
  );

  test.each([
    [21, 4],
    [21.5, 4.5],
    [29.5, 4.5],
    [30, 4],
    [30.5, 4],
    [120.5, 4],
  ])("uses %f elapsed minutes to infer a legacy bucket window of %f minutes", (elapsed, window) => {
    const f = forecast(
      summary({ pace: [20, 2, 1, 2, 1, 2] }),
      new Date(Date.parse(START) + elapsed * 60_000),
    );
    expect(f).toMatchObject({ rate: 8 / window });
  });

  test("keeps a finite legacy rate with only a partial first bucket", () => {
    expect(forecast(summary({ pace: [3] }), new Date("2026-09-22T14:00:30.000Z"))).toMatchObject({
      rate: 3,
    });
  });

  test("reports no pace for an empty legacy bucket array", () => {
    expect(forecast(summary({ pace: [] }), NOW)).toMatchObject({ reading: "no-pace" });
  });

  test("uses turns so far when pace is absent just after start", () => {
    const f = forecast(summary({ turnsUsed: 3 }), new Date("2026-09-22T14:01:00.000Z"));
    expect(f).toMatchObject({ reading: "runs-out-first", left: 37, rate: 3 });
  });

  test("reports no pace without buckets or turns", () => {
    expect(forecast(summary({ turnsUsed: 0 }), new Date(START))).toEqual({
      reading: "no-pace",
      left: 40,
      clockEndsAt: endsAt(summary()),
    });
  });

  test.each([20, 40, 80, 41])(
    "uses the rounded-up tenth-of-budget boundary for %i turns",
    (maxTurns) => {
      const threshold = Math.ceil(maxTurns / 10);
      const limits = { ...SIZE_PRESETS.medium, maxTurns };
      const now = new Date("2026-09-22T14:20:00.000Z");
      const recent = recentSpans(5, 20);
      expect(
        forecast(summary({ limits, spans: recent, turnsUsed: maxTurns - 10 - threshold + 1 }), now),
      ).toMatchObject({ reading: "fits", unused: threshold - 1 });
      expect(
        forecast(summary({ limits, spans: recent, turnsUsed: maxTurns - 10 - threshold }), now),
      ).toMatchObject({ reading: "clock-first", unused: threshold });
    },
  );

  test("equal run-out and clock times fit rather than running out first", () => {
    expect(forecast(summary({ turnsUsed: 31, spans: recentSpans(5) }), NOW)).toMatchObject({
      reading: "fits",
      runOutAt: endsAt(summary()),
      unused: 0,
    });
  });

  test("clamps the time remaining at zero after the wall clock expires", () => {
    const now = new Date("2026-09-22T14:31:00.000Z");
    expect(forecast(summary({ spans: spans([30, 30, 30, 30, 30]) }), now)).toMatchObject({
      reading: "clock-first",
      rate: 1,
      runOutAt: "2026-09-22T14:53:00.000Z",
      unused: 22,
    });
  });

  test("uses at least a minute of elapsed time before the first minute ends", () => {
    expect(forecast(summary({ turnsUsed: 3 }), new Date("2026-09-22T14:00:30.000Z"))).toMatchObject(
      { reading: "runs-out-first", rate: 3 },
    );
  });

  test("reports fewer than one turn as no pace without an infinite projection", () => {
    const f = forecast(summary({ pace: [0, 0, 0, 0, 0.5] }), NOW);
    expect(f).toMatchObject({ reading: "no-pace" });
    expect(f).not.toHaveProperty("runOutAt");
    expect(f).not.toHaveProperty("rate");
  });

  test.each([
    [5, 1],
    [10, 2],
    [1, 0.2],
    [8, 1.6],
  ])("retains the rate of %i turns in five minutes as %f without displaying it", (turns, rate) => {
    const f = forecast(summary({ turnsUsed: 39, spans: recentSpans(turns) }), NOW);
    expect(f).toMatchObject({ rate });
    if (f.reading !== "runs-out-first") throw new Error("expected turns to run out first");
    expect(forecastDelta(f).text).toBe(`1 left · out about ${hhmm(f.runOutAt)}, before the clock`);
    expect(forecastDelta(f).text).not.toContain("a minute");
  });

  test("keeps every reading within 44 characters for all admitted left and unused counts", () => {
    const base = {
      clockEndsAt: "2026-09-22T20:13:00.000Z",
      runOutAt: "2026-09-22T20:09:00.000Z",
      rate: 1,
    };
    const check = (f: Forecast, direction: "down" | "flat", tone?: "warn" | "caution") => {
      const delta = forecastDelta(f);
      expect(delta.text.length).toBeLessThanOrEqual(44);
      expect(delta.text).not.toMatch(/[▼▲→↓↑←↔]/);
      expect(delta.direction).toBe(direction);
      expect(delta.tone).toBe(tone);
    };
    check({ ...base, left: 0, reading: "out-of-turns" }, "down", "warn");
    for (let left = 1; left <= 200; left++) {
      check({ ...base, left, reading: "runs-out-first" }, "down", "warn");
      check({ ...base, left, reading: "no-pace" }, "flat");
      for (let unused = 0; unused <= left; unused++) {
        check({ ...base, left, unused, reading: "clock-first" }, "flat", "caution");
        check({ ...base, left, unused, reading: "fits" }, "flat");
      }
    }
  });

  test("leaves directional glyphs to the host for every reading", () => {
    const forecasts = [
      forecast(summary({ turnsUsed: 32, spans: recentSpans(8) }), NOW),
      forecast(summary({ spans: recentSpans(6) }), NOW),
      forecast(summary({ spans: recentSpans(11) }), NOW),
      forecast(summary({ spans: [] }), NOW),
      forecast(summary({ turnsUsed: 40 }), NOW),
    ];
    expect(new Set(forecasts.map((f) => f.reading)).size).toBe(5);
    for (const f of forecasts) {
      const delta = forecastDelta(f);
      expect(delta.text).not.toMatch(/[▼▲→]/);
      if (f.reading === "fits" || f.reading === "no-pace") {
        expect(delta).not.toHaveProperty("tone");
      }
    }
  });

  test("does not mutate the summary, its nested fields or the caller's clock", () => {
    const s = Object.freeze(
      summary({
        pace: Object.freeze([2, 1, 2, 1, 2]),
        spans: Object.freeze(recentSpans(8).map((span) => Object.freeze(span))),
        limits: Object.freeze({ ...SIZE_PRESETS.medium }),
      }),
    );
    const original = structuredClone(s);
    const now = new Date(NOW);
    expect(forecast(s, now)).toEqual(forecast(s, now));
    expect(s).toEqual(original);
    expect(now.toISOString()).toBe(NOW.toISOString());
  });
});

describe("turns tile forecast", () => {
  const tile = (patch: Record<string, unknown>, now: Date) =>
    turnsTile({ ...summary(), status: "running", ...patch } as unknown as SwarmSummary, now);

  test("waits for two minutes of runtime before forecasting", () => {
    const early = tile(
      { turnsUsed: 1, spans: recentSpans(1, 0.2) },
      new Date(Date.parse(START) + 30_000),
    );
    expect(early.delta).toBeUndefined();
    expect(early.sub).toBe(`of ${SIZE_PRESETS.medium.maxTurns}`);
    expect(tile({}, NOW).delta).toBeDefined();
  });

  test("drops the forecast once the lead has concluded", () => {
    expect(tile({ conclusion: "done" }, NOW).delta).toBeUndefined();
  });

  test("still warns at once when no turns are left", () => {
    const out = tile(
      { turnsUsed: SIZE_PRESETS.medium.maxTurns },
      new Date(Date.parse(START) + 30_000),
    );
    expect(out.delta?.tone).toBe("warn");
  });
});
