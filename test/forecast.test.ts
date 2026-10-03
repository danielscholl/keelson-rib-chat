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
});
