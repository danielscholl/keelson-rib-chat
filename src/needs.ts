// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { ChildRun, OperatorAsk, SwarmSummary } from "./types.ts";

// What a live swarm asks of the operator, as a ladder: a decision only the
// operator can make, a question an agent put to them, a ClickClack connection
// that stopped answering, and a gate nobody is working on. The index, the
// board, the badge and the reading pane all use this list in this order.
export type NeedKind = "decide" | "question" | "connection" | "quiet";

export const NEED_ORDER: readonly NeedKind[] = ["decide", "question", "connection", "quiet"];

export interface Need {
  kind: NeedKind;
  since?: string;
  run?: ChildRun;
  ask?: OperatorAsk;
}

const rank = (n: Need) => NEED_ORDER.indexOf(n.kind);

export function needsYou(s: SwarmSummary): Need[] {
  if (s.status !== "running") return [];
  const needs: Need[] = [];
  const gates = (s.runs ?? []).filter((r) => r.status === "paused" && r.pendingApproval);
  for (const run of gates) {
    if (run.pendingApproval?.answerer !== "operator") continue;
    const since = run.pendingApproval.openedAt;
    needs.push({ kind: "decide", run, ...(since ? { since } : {}) });
  }
  for (const ask of s.health?.asks ?? []) needs.push({ kind: "question", since: ask.at, ask });
  if ((s.health?.socketDrops ?? 0) >= 2) needs.push({ kind: "connection" });
  const quiet = s.health?.quietSince;
  const reviewed = gates.find((r) => r.pendingApproval?.answerer !== "operator");
  if (quiet && reviewed) needs.push({ kind: "quiet", since: quiet, run: reviewed });
  // The ladder first, then the oldest within a kind.
  return needs.sort((a, b) => rank(a) - rank(b) || (a.since ?? "").localeCompare(b.since ?? ""));
}

// The oldest time among a swarm's needs, so the one waiting longest sorts first.
export function oldestNeed(needs: readonly Need[]): string | undefined {
  return needs
    .map((n) => n.since)
    .filter((t): t is string => t !== undefined)
    .sort()[0];
}
