// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { RibApprovalArtifact, RibRunStatus } from "@keelson/shared";
import type { ChildRun, CiVerdict } from "./types.ts";

// The harness seams a swarm dispatches through, narrowed so the engine can be
// tested without a host.
export interface WorkflowDispatcher {
  start(name: string, inputs: Record<string, string>): Promise<{ runId: string }>;
  status(runId: string): Promise<RibRunStatus | undefined>;
  cancel(runId: string): Promise<{ ok: true } | { ok: false; error: string }>;
  // Absent on a host that cannot answer a gate for the operator.
  respond?(
    runId: string,
    nodeId: string,
    text: string,
    pauseId?: string,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
}

// Starts on one checkout run one at a time: each waits until the run before it
// has set up (a worktree, a finished node, or an end), since concurrent
// `git worktree add` calls race on the repository's config lock.
export function serialStarts(
  start: WorkflowDispatcher["start"],
  status: WorkflowDispatcher["status"],
  opts: { pollMs?: number; timeoutMs?: number } = {},
): WorkflowDispatcher["start"] {
  const pollMs = opts.pollMs ?? 500;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  let gate: Promise<void> = Promise.resolve();
  const settled = async (runId: string): Promise<void> => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const s = await status(runId).catch(() => undefined);
      const live = s?.status === "running" || s?.status === "paused";
      if (!s || !live || s.checkout.worktreeEstablished || s.nodes.length > 0) return;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  };
  return (name, inputs) => {
    const started = gate.then(() => start(name, inputs));
    gate = started.then(
      ({ runId }) => settled(runId),
      () => undefined,
    );
    return started;
  };
}

// A file a paused gate names, such as the plan it asks about.
export type GateFile = RibApprovalArtifact;

// A loop gate pauses again on the same node, so a gate is its node and its pause.
export function gateKey(
  gate: { nodeId: string; pauseId?: string } | undefined,
): string | undefined {
  return gate ? `${gate.nodeId}:${gate.pauseId ?? ""}` : undefined;
}

export function gateFiles(status: RibRunStatus): GateFile[] {
  return [...(status.pendingApproval?.artifacts ?? [])];
}

// A line that only names a gate file, which the gate thread carries in full.
const FILE_HINT = /^[\s`'"([]*\$ARTIFACTS_DIR\/\S+?[\s`'")\].,:;]*$/;

export function withoutFileHints(prompt: string): string {
  return prompt
    .split("\n")
    .filter((line) => !FILE_HINT.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

// fix-issue and its kin print `CI_STATUS:` after watching the pull request's
// checks and `CI_GATE:` as their final verdict, which outranks it.
const CI_LINE = /^[ \t]*CI_(GATE|STATUS):[ \t]*(PASS|FAIL|UNKNOWN)\b[ \t—–-]*(.*)$/gm;

export function ciIn(status: RibRunStatus): ChildRun["ci"] {
  let gate: ChildRun["ci"];
  let watch: ChildRun["ci"];
  for (const node of status.nodes) {
    for (const text of [node.output, node.error]) {
      for (const [, kind, verdict = "", detail = ""] of text?.matchAll(CI_LINE) ?? []) {
        const found = {
          verdict: verdict.toLowerCase() as CiVerdict,
          ...(detail.trim() ? { detail: detail.trim() } : {}),
        };
        if (kind === "GATE") gate = found;
        else watch = found;
      }
    }
  }
  return gate ?? watch;
}

// The evidence a succeeded run lacks before it counts as verified.
export function missingEvidence(run: ChildRun): string[] {
  if (!run.isolated) return run.ci?.verdict === "fail" ? ["passing CI"] : [];
  const missing: string[] = [];
  if (!run.checkout?.worktreeEstablished) missing.push("its own worktree");
  if (run.prUrls.length === 0) missing.push("a pull request");
  if (run.ci?.verdict !== "pass") missing.push("passing CI");
  return missing;
}

export function verified(run: ChildRun): boolean {
  return run.status === "succeeded" && missingEvidence(run).length === 0;
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
// `owned` says a pull request belongs to another run, as when a bead's
// dependency notes quote the PR that landed it; this run never claims those.
export function applyStatus(
  run: ChildRun,
  status: RibRunStatus,
  owned: (url: string) => boolean = () => false,
): string | undefined {
  const before = run.status;
  const gateBefore = gateKey(run.pendingApproval);
  run.status = status.status;
  run.checkout = { ...status.checkout };
  run.nodesDone = status.nodes.length;
  const last = status.nodes.at(-1)?.nodeId;
  if (last) run.lastNode = last;
  if (status.completedAt) run.completedAt = status.completedAt;
  if (status.error) run.error = status.error;
  if (status.pendingApproval) {
    const { nodeId, prompt, pauseId } = status.pendingApproval;
    const same = gateKey(run.pendingApproval) === gateKey(status.pendingApproval);
    run.pendingApproval = {
      ...(same ? run.pendingApproval : {}),
      nodeId,
      prompt,
      ...(pauseId ? { pauseId } : {}),
    };
  } else delete run.pendingApproval;
  for (const url of prUrlsIn(status)) {
    if (!run.prUrls.includes(url) && !owned(url)) run.prUrls.push(url);
  }
  const ci = ciIn(status);
  if (ci) run.ci = ci;
  run.verified = verified(run);

  if (run.status === "paused" && gateKey(run.pendingApproval) !== gateBefore) {
    return `${label(run)} is paused for approval at node ${run.pendingApproval?.nodeId}.`;
  }
  if (run.status === before) return undefined;
  return describeRun(run);
}

function label(run: ChildRun): string {
  return `Run ${run.runId} (${run.workflow}, for: ${run.purpose})`;
}

export function describeRun(run: ChildRun): string {
  const parts = [`${label(run)} is ${run.status}`];
  const gate = run.pendingApproval;
  if (gate) {
    parts.push(
      gate.threadId
        ? `waiting on approval at ${gate.nodeId}, its prompt and files in thread ${gate.threadId}`
        : `waiting on approval at ${gate.nodeId}: ${gate.prompt}`,
    );
  }
  for (const answer of run.approvals ?? []) {
    parts.push(
      `${answer.decision === "approve" ? "approved" : "sent changes at"} ${answer.nodeId} on ${answer.reviewer}'s review ${answer.review}`,
    );
  }
  if (run.checkout?.branch) parts.push(`branch ${run.checkout.branch}`);
  if (run.isolated && run.checkout && !run.checkout.worktreeEstablished && run.checkout.path) {
    parts.push("NOT isolated");
  }
  if (run.prUrls.length > 0) parts.push(`PR ${run.prUrls.join(", ")}`);
  if (run.ci) parts.push(`CI ${run.ci.verdict}${run.ci.detail ? ` (${run.ci.detail})` : ""}`);
  if (run.error) parts.push(`error: ${run.error}`);
  if (run.status === "succeeded") {
    parts.push(
      run.verified ? "verified" : `NOT verified: it lacks ${missingEvidence(run).join(", ")}`,
    );
  }
  return `${parts.join("; ")}.`;
}
