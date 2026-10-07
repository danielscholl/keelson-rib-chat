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
  | "on-run"
  | "out-of-turns";

interface ForecastBase {
  reading: ForecastReading;
  left: number;
  clockEndsAt: string;
}

export type Forecast = ForecastBase &
  (
    | { reading: "no-pace" | "on-run" | "out-of-turns" }
    | { reading: "runs-out-first"; rate: number; runOutAt: string }
    | { reading: "clock-first" | "fits"; rate: number; runOutAt: string; unused: number }
  );

// Count turn starts in the recent window; legacy pace buckets include a partial last minute.
// A live workflow run idles the swarm, so its early pace says nothing about the rest.
export function forecast(
  s: Pick<SwarmSummary, "spans" | "pace" | "turnsUsed" | "limits" | "startedAt" | "runs">,
  now: Date,
): Forecast {
  const left = Math.max(0, s.limits.maxTurns - s.turnsUsed);
  const clockEndsAt = endsAt(s);
  const base = { left, clockEndsAt };
  if (left === 0) return { ...base, reading: "out-of-turns" };
  if (s.runs?.some((r) => r.status === "running" || r.status === "paused")) {
    return { ...base, reading: "on-run" };
  }

  const nowMs = now.getTime();
  const elapsed = (nowMs - Date.parse(s.startedAt)) / 60_000;
  let window = Math.min(PACE_WINDOW_MINUTES, Math.max(1, elapsed));
  let turns = s.turnsUsed;
  if (s.spans !== undefined) {
    const from = nowMs - window * 60_000;
    turns = s.spans.filter((span) => {
      const started = Date.parse(span.startedAt);
      return started >= from && started <= nowMs;
    }).length;
  } else if (s.pace) {
    const buckets = s.pace.slice(-PACE_WINDOW_MINUTES);
    turns = buckets.reduce((sum, n) => sum + n, 0);
    // At 30 minutes the live spark switches from start-aligned to a sliding window.
    window = Math.max(1, buckets.length - 1 + (elapsed < 30 ? elapsed % 1 : 0));
  }
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

export function forecastDelta(f: Forecast): {
  text: string;
  direction: "down" | "flat";
  tone?: "warn" | "caution";
} {
  switch (f.reading) {
    case "runs-out-first":
      return {
        text: `${f.left} left · out about ${hhmm(f.runOutAt)}, before the clock`,
        direction: "down",
        tone: "warn",
      };
    case "clock-first":
      return {
        text: `${f.left} left · about ${f.unused} unused at ${hhmm(f.clockEndsAt)}`,
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
    case "on-run":
      return { text: `${f.left} left · waiting on a workflow run`, direction: "flat" };
    case "out-of-turns":
      return { text: "none left · agents finish their turns", direction: "down", tone: "warn" };
  }
}
