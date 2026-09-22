// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { RibRunStatus } from "@keelson/shared";
import type { ChildRun } from "./types.ts";

// The harness seams a swarm dispatches through, narrowed so the engine can be
// tested without a host.
export interface WorkflowDispatcher {
  start(name: string, inputs: Record<string, string>): Promise<{ runId: string }>;
  status(runId: string): Promise<RibRunStatus | undefined>;
  cancel(runId: string): Promise<{ ok: true } | { ok: false; error: string }>;
}

const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

export function isLive(run: ChildRun): boolean {
  return run.status === "running" || run.status === "paused";
}

export function prUrlsIn(status: RibRunStatus): string[] {
  const found = new Set<string>();
  for (const node of status.nodes) {
    for (const text of [node.output, node.error]) {
      for (const match of text?.matchAll(PR_URL) ?? []) found.add(match[0]);
    }
  }
  return [...found];
}

export function verified(run: ChildRun): boolean {
  if (run.status !== "succeeded") return false;
  if (!run.isolated) return true;
  return run.checkout?.worktreeEstablished === true && run.prUrls.length > 0;
}

// A live isolated run that has begun executing outside its own worktree. Until
// a node has finished, the harness reports the project root for a run whose
// worktree is still being created, so that alone proves nothing.
export function isolationBreach(run: ChildRun): string | undefined {
  if (!run.isolated || !isLive(run) || !run.checkout?.path || run.nodesDone === 0) return undefined;
  if (run.checkout.worktreeEstablished) return undefined;
  return `it is running in ${run.checkout.path}, not an isolated worktree`;
}

// Folds a status read into the ledger entry. Returns what changed that the lead
// should hear about, or undefined when nothing did.
export function applyStatus(run: ChildRun, status: RibRunStatus): string | undefined {
  const before = run.status;
  const approvalBefore = run.pendingApproval?.nodeId;
  run.status = status.status;
  run.checkout = { ...status.checkout };
  run.nodesDone = status.nodes.length;
  if (status.completedAt) run.completedAt = status.completedAt;
  if (status.error) run.error = status.error;
  if (status.pendingApproval) run.pendingApproval = { ...status.pendingApproval };
  else delete run.pendingApproval;
  for (const url of prUrlsIn(status)) if (!run.prUrls.includes(url)) run.prUrls.push(url);
  run.verified = verified(run);

  if (run.status === "paused" && run.pendingApproval?.nodeId !== approvalBefore) {
    return `${label(run)} is paused for human approval at node ${run.pendingApproval?.nodeId}: ${run.pendingApproval?.prompt} Only the operator can answer it.`;
  }
  if (run.status === before) return undefined;
  return describeRun(run);
}

function label(run: ChildRun): string {
  return `Run ${run.runId} (${run.workflow}, for: ${run.purpose})`;
}

export function describeRun(run: ChildRun): string {
  const parts = [`${label(run)} is ${run.status}`];
  if (run.pendingApproval) {
    parts.push(
      `waiting on approval at ${run.pendingApproval.nodeId}: ${run.pendingApproval.prompt}`,
    );
  }
  if (run.checkout?.branch) parts.push(`branch ${run.checkout.branch}`);
  if (run.isolated && run.checkout && !run.checkout.worktreeEstablished && run.checkout.path) {
    parts.push("NOT isolated");
  }
  if (run.prUrls.length > 0) parts.push(`PR ${run.prUrls.join(", ")}`);
  if (run.error) parts.push(`error: ${run.error}`);
  if (run.status === "succeeded") {
    parts.push(
      run.verified
        ? "verified"
        : "NOT verified: an isolated run needs an established worktree and a pull request",
    );
  }
  return `${parts.join("; ")}.`;
}
