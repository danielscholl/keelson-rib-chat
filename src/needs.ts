// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { ChildRun, OperatorAsk, SwarmSummary } from "./types.ts";

// What keeps a live swarm from progressing without the operator, in the order a
// card shows them: ClickClack stopped answering, a gate only the operator can
// answer, a gate nobody is working on, a question an agent put to the operator.
export type NeedKind = "clickclack" | "only-you" | "quiet" | "ask";

export interface Need {
  kind: NeedKind;
  since?: string;
  run?: ChildRun;
  ask?: OperatorAsk;
}

export function needsYou(s: SwarmSummary): Need[] {
  if (s.status !== "running") return [];
  const needs: Need[] = [];
  if ((s.health?.socketDrops ?? 0) >= 2) needs.push({ kind: "clickclack" });
  const gates = (s.runs ?? []).filter((r) => r.status === "paused" && r.pendingApproval);
  for (const run of gates) {
    if (run.pendingApproval?.answerer !== "operator") continue;
    const since = run.pendingApproval.openedAt;
    needs.push({ kind: "only-you", run, ...(since ? { since } : {}) });
  }
  const quiet = s.health?.quietSince;
  const reviewed = gates.find((r) => r.pendingApproval?.answerer !== "operator");
  if (quiet && reviewed) needs.push({ kind: "quiet", since: quiet, run: reviewed });
  for (const ask of s.health?.asks ?? []) needs.push({ kind: "ask", since: ask.at, ask });
  return needs;
}

// The oldest time among a swarm's needs, so the one waiting longest sorts first.
export function oldestNeed(needs: readonly Need[]): string | undefined {
  return needs
    .map((n) => n.since)
    .filter((t): t is string => t !== undefined)
    .sort()[0];
}
