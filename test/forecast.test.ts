import { describe, expect, test } from "bun:test";
import {
  type Forecast,
  forecast,
  forecastDelta,
  PACE_WINDOW_MINUTES,
} from "../src/surface/forecast.ts";
import { hhmm } from "../src/surface/format.ts";
import { endsAt } from "../src/surface/parts.ts";
import { SIZE_PRESETS, type SwarmSummary } from "../src/types.ts";

type Summary = Pick<SwarmSummary, "pace" | "turnsUsed" | "limits" | "startedAt">;
const START = "2026-09-22T14:00:00.000Z";
const NOW = new Date("2026-09-22T14:21:00.000Z");

function summary(patch: Partial<Summary> = {}): Summary {
  return { startedAt: START, limits: SIZE_PRESETS.medium, turnsUsed: 18, ...patch };
}

describe("turn budget forecast", () => {
  test("projects turns running out before the clock from only the last five buckets", () => {
    expect(PACE_WINDOW_MINUTES).toBe(5);
    const s = summary({ turnsUsed: 32, pace: [20, 2, 1, 2, 1, 2] });
    const f: Forecast = forecast(s, NOW);
    expect(f).toEqual({
      reading: "runs-out-first",
      left: 8,
      rate: 1.6,
      runOutAt: "2026-09-22T14:26:00.000Z",
      clockEndsAt: endsAt(s),
    });
    expect(forecastDelta(f)).toEqual({
      text: `8 left · at 1.6 a minute they run out about ${hhmm("2026-09-22T14:26:00.000Z")}, before the clock`,
      direction: "down",
      tone: "warn",
    });
  });

  test("projects unused turns when the clock ends first", () => {
    const s = summary({ pace: [1, 1, 1, 1, 2] });
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
      text: `22 left · at this pace about 11 unused when the clock ends at ${hhmm(endsAt(s))}`,
      direction: "flat",
      tone: "caution",
    });
  });

  test("reports pace fitting the clock when less than a tenth would be unused", () => {
    const f = forecast(summary({ pace: [2, 2, 2, 2, 3] }), NOW);
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

  test("reports no pace when recent buckets are empty despite earlier turns", () => {
    const f = forecast(summary({ pace: [18, 0, 0, 0, 0, 0] }), NOW);
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
      const pace = [1, 1, 1, 1, 1];
      expect(
        forecast(summary({ limits, pace, turnsUsed: maxTurns - 10 - threshold + 1 }), now),
      ).toMatchObject({ reading: "fits", unused: threshold - 1 });
      expect(
        forecast(summary({ limits, pace, turnsUsed: maxTurns - 10 - threshold }), now),
      ).toMatchObject({ reading: "clock-first", unused: threshold });
    },
  );

  test("equal run-out and clock times fit rather than running out first", () => {
    expect(forecast(summary({ turnsUsed: 31, pace: [1, 1, 1, 1, 1] }), NOW)).toMatchObject({
      reading: "fits",
      runOutAt: endsAt(summary()),
      unused: 0,
    });
  });

  test("clamps the time remaining at zero after the wall clock expires", () => {
    const now = new Date("2026-09-22T14:31:00.000Z");
    expect(forecast(summary({ pace: [1, 1, 1, 1, 1] }), now)).toMatchObject({
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
    [5, "1"],
    [10, "2"],
    [1, "0.2"],
    [8, "1.6"],
  ])("formats %i turns in five minutes as %s a minute", (turns, text) => {
    const f = forecast(summary({ turnsUsed: 39, pace: [turns, 0, 0, 0, 0] }), NOW);
    expect(forecastDelta(f).text).toContain(`at ${text} a minute`);
  });

  test("leaves directional glyphs to the host for every reading", () => {
    const forecasts = [
      forecast(summary({ turnsUsed: 32, pace: [2, 1, 2, 1, 2] }), NOW),
      forecast(summary({ pace: [1, 1, 1, 1, 2] }), NOW),
      forecast(summary({ pace: [2, 2, 2, 2, 3] }), NOW),
      forecast(summary({ pace: [0, 0, 0, 0, 0] }), NOW),
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
