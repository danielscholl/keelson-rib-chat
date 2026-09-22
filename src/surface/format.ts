// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { SwarmSummary } from "../types.ts";

// Push regions get no "updated 2m ago" label, and a relative time would freeze
// between frames, so the tab shows clock times.
export function hhmm(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function day(iso: string): string {
  const d = new Date(iso);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

// The first line of a task, cut to fit a card title.
export function firstLine(text: string, max = 72): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

// Inside a swarm's own views the id is already named, so handles drop it.
export function shortHandle(handle: string, swarmId: string): string {
  return handle.startsWith(`${swarmId}-`) ? handle.slice(swarmId.length + 1) : handle;
}

export function shortRun(runId: string): string {
  return runId.slice(0, 8);
}

type Linked = Pick<SwarmSummary, "clickclack" | "channelId">;

export function channelHref(s: Linked): string | undefined {
  if (!s.clickclack || !s.channelId) return undefined;
  return `${s.clickclack.url}/app/${encodeURIComponent(s.clickclack.workspaceId)}/${encodeURIComponent(s.channelId)}`;
}

export function threadHref(s: Linked, threadId: string | undefined): string | undefined {
  if (!s.clickclack || !threadId) return undefined;
  return `${s.clickclack.url}/app/${encodeURIComponent(s.clickclack.workspaceId)}/${encodeURIComponent(threadId)}`;
}

export function prLabel(url: string): string {
  const n = url.match(/\/pull\/(\d+)/)?.[1];
  return n ? `PR #${n}` : "PR";
}

export function firstPr(s: Pick<SwarmSummary, "runs">): string | undefined {
  return s.runs?.flatMap((r) => r.prUrls)[0];
}

export function minutes(ms: number): number {
  return Math.round(ms / 60_000);
}
