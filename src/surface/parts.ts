// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView } from "@keelson/shared";
import { modelLabel, sizeText } from "../labels.ts";
import type { Need } from "../needs.ts";
import { SIZE_PRESETS, SWARM_SIZES, type SwarmSummary } from "../types.ts";
import { firstLine, hhmm, minutes, prLabel, shortHandle, shortRun } from "./format.ts";

// Text and types the index, the drawer, the launch header and the footer share.

type Card = Extract<CanvasBoardView["sections"][number], { kind: "cards" }>["items"][number];

export interface ServerLine {
  mode: "managed" | "external";
  url?: string;
  running: boolean;
  pid?: number;
  adopted?: boolean;
  operator?: boolean;
  binary?: string;
  dataDir?: string;
  startedAt?: string;
}

// The hover on Start and the tool's size input share these words.
export function sizesHint(): string {
  return SWARM_SIZES.map((k) => `${k}: ${sizeText(SIZE_PRESETS[k])}`).join(" · ");
}

export function sizeDetail(s: Pick<SwarmSummary, "limits" | "size" | "sizeBase">): string {
  const l = s.limits;
  const word = s.size === "custom" ? `custom, from ${s.sizeBase}` : s.size;
  return `${word}: up to ${l.maxAgents} agents · ${l.maxTurns} turns, ${l.maxTurnsPerAgent} per worker · ${l.maxConcurrent} at once · ${minutes(l.turnTimeoutMs)} min a turn`;
}

export function needReason(s: SwarmSummary, need: Need): Card["reason"] {
  const run = need.run;
  const gate = run?.pendingApproval;
  if (need.kind === "clickclack") {
    return {
      label: "needs you",
      text: "ClickClack stopped answering: the swarm's socket closed twice without reopening.",
    };
  }
  if (need.kind === "only-you" && run && gate) {
    return {
      label: "needs you",
      text: `${run.workflow} ${shortRun(run.runId)} waits at ${gate.nodeId} since ${hhmm(gate.openedAt)}. This swarm can't answer ${run.workflow} gates: answer it in the Workflows tab.`,
    };
  }
  if (need.kind === "quiet" && run && gate) {
    return {
      label: "needs you",
      text: `No agent has worked since ${hhmm(need.since)} and ${run.workflow} ${shortRun(run.runId)} still waits at ${gate.nodeId}. Reply in the gate thread, steer the lead, or answer it in the Workflows tab.`,
    };
  }
  if (need.kind === "ask" && need.ask) {
    return {
      label: "needs you",
      text: `@${shortHandle(need.ask.handle, s.id)} asked at ${hhmm(need.ask.at)}: ${askGist(need.ask.text)}`,
    };
  }
  return { label: "needs you", text: `swarm ${s.id} is waiting on you` };
}

// The question without the @operator that addressed it.
export function askText(body: string): string {
  return body.replace(/(^|\s)@operator\b[,:]?\s*/gi, "$1").trim();
}

// The question in one plain line: the first line that asks something, else the first line.
export function askGist(body: string, max = 160): string {
  const lines = askText(body)
    .split("\n")
    .map((l) => l.replace(/[*_`#>]+/g, "").trim())
    .filter((l) => l.length > 0);
  const asking = lines.find((l) => l.includes("?"));
  return firstLine(asking ?? lines[0] ?? "", max);
}

export function openHint(
  s: Pick<SwarmSummary, "limits" | "size" | "sizeBase"> & {
    model?: string;
    workerModel?: string;
    agents: SwarmSummary["agents"];
  },
): string {
  return `${sizeDetail(s)}. Model: ${modelLabel(s)}.`;
}

export function endedOutcome(s: SwarmSummary): string {
  const verified = s.runs?.find((r) => r.verified && r.prUrls.length > 0);
  if (verified?.prUrls[0]) return `${prLabel(verified.prUrls[0])} verified`;
  return s.status;
}
