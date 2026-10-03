// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { SwarmSummary } from "../types.ts";
import { hhmm } from "./format.ts";
import { endsAt } from "./parts.ts";

export const PACE_WINDOW_MINUTES = 5;
const FIT_SHARE = 0.1;

export type ForecastReading =
  | "runs-out-first"
  | "clock-first"
  | "fits"
  | "no-pace"
  | "out-of-turns";

interface ForecastBase {
  reading: ForecastReading;
  left: number;
  clockEndsAt: string;
}

export type Forecast = ForecastBase &
  (
    | { reading: "no-pace" | "out-of-turns" }
    | { reading: "runs-out-first"; rate: number; runOutAt: string }
    | { reading: "clock-first" | "fits"; rate: number; runOutAt: string; unused: number }
  );

export function forecast(
  s: Pick<SwarmSummary, "pace" | "turnsUsed" | "limits" | "startedAt">,
  now: Date,
): Forecast {
  const left = Math.max(0, s.limits.maxTurns - s.turnsUsed);
  const clockEndsAt = endsAt(s);
  const base = { left, clockEndsAt };
  if (left === 0) return { ...base, reading: "out-of-turns" };

  const window = Math.min(
    PACE_WINDOW_MINUTES,
    Math.max(1, (now.getTime() - Date.parse(s.startedAt)) / 60_000),
  );
  const turns = s.pace
    ? s.pace.slice(-PACE_WINDOW_MINUTES).reduce((sum, n) => sum + n, 0)
    : s.turnsUsed;
  if (turns < 1) return { ...base, reading: "no-pace" };

  const rate = turns / window;
  const runOutAt = new Date(now.getTime() + (left / rate) * 60_000).toISOString();
  if (Date.parse(runOutAt) < Date.parse(clockEndsAt)) {
    return { ...base, reading: "runs-out-first", rate, runOutAt };
  }

  const minutesToClock = Math.max(0, (Date.parse(clockEndsAt) - now.getTime()) / 60_000);
  const unused = Math.round(left - rate * minutesToClock);
  return {
    ...base,
    reading: unused >= Math.ceil(s.limits.maxTurns * FIT_SHARE) ? "clock-first" : "fits",
    rate,
    runOutAt,
    unused,
  };
}

function rateText(rate: number): string {
  return rate.toFixed(1).replace(/\.0$/, "");
}

export function forecastDelta(f: Forecast): {
  text: string;
  direction: "down" | "flat";
  tone?: "warn" | "caution";
} {
  switch (f.reading) {
    case "runs-out-first":
      return {
        text: `${f.left} left · at ${rateText(f.rate)} a minute they run out about ${hhmm(f.runOutAt)}, before the clock`,
        direction: "down",
        tone: "warn",
      };
    case "clock-first":
      return {
        text: `${f.left} left · at this pace about ${f.unused} unused when the clock ends at ${hhmm(f.clockEndsAt)}`,
        direction: "flat",
        tone: "caution",
      };
    case "fits":
      return { text: `${f.left} left · pace fits the clock`, direction: "flat" };
    case "no-pace":
      return {
        text: `${f.left} left · no turn in ${PACE_WINDOW_MINUTES} min`,
        direction: "flat",
      };
    case "out-of-turns":
      return { text: "none left · agents finish their turns", direction: "down", tone: "warn" };
  }
}
