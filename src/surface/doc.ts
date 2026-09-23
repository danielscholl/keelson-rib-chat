// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { ChildRun, GateFileText, SwarmSummary } from "../types.ts";
import {
  activityText,
  channelHref,
  day,
  firstLine,
  hhmm,
  prLabel,
  shortHandle,
  shortRun,
  span,
  threadHref,
} from "./format.ts";
import { askText } from "./parts.ts";

function fileSection(f: GateFileText): string {
  if (f.text === undefined) return `### ${f.path}\n\n*Could not be read: ${f.error ?? "no text"}.*`;
  const body = /\.(md|markdown)$/i.test(f.path) ? f.text : `\`\`\`\`\n${f.text}\n\`\`\`\``;
  return `### ${f.path}${f.truncated ? " (cut short)" : ""}\n\n${body}`;
}

// A run in full: the board's row cuts the error and has no room for CI detail.
function runSection(run: ChildRun): string {
  const took = span(run.startedAt, run.completedAt);
  const meta = [
    firstLine(run.purpose, 160),
    ...(run.checkout?.branch ? [`branch \`${run.checkout.branch}\``] : []),
    ...run.prUrls.map((u) => `[${prLabel(u)}](${u})`),
    ...(took ? [`took ${took}`] : []),
    ...(run.ci ? [`CI ${run.ci.verdict}`] : []),
  ].join(" · ");
  const error = run.error ? `\n\n\`\`\`\`\n${run.error}\n\`\`\`\`` : "";
  const ci = run.ci?.detail ? `\n\nCI: ${run.ci.detail}` : "";
  return `### ${run.workflow} · ${shortRun(run.runId)} · ${run.status}\n\n*${meta}*${error}${ci}`;
}

// The task in full, each context item's excerpt, and every run, so the pane
// holds what the board's rows cut.
function details(s: SwarmSummary): string {
  const task = s.task.trim();
  const lines = task.split("\n");
  const rest = lines.slice(1).join("\n").trim();
  const parts = [rest ? `## Task\n\n${task}` : ""];
  for (const c of s.context ?? []) {
    const meta = [
      c.sourceUrl ? `[source](${c.sourceUrl})` : "",
      c.retrievedAt ? `retrieved ${day(c.retrievedAt)} ${hhmm(c.retrievedAt)}` : "",
      c.headSha ? `head ${c.headSha.slice(0, 7)}` : "",
      `${c.chars.toLocaleString("en-US")} characters`,
    ]
      .filter(Boolean)
      .join(" · ");
    const body = c.excerpt
      ? `\n\n\`\`\`\`\n${c.excerpt}${c.chars > c.excerpt.length ? `\n… (first ${c.excerpt.length.toLocaleString("en-US")} of ${c.chars.toLocaleString("en-US")} characters; agents read the rest with chat_context)` : ""}\n\`\`\`\``
      : "";
    parts.push(`## ${c.kind}: ${c.title}\n\n*${meta}*${body}`);
  }
  if (s.runs?.length) parts.push(`## Runs\n\n${s.runs.map(runSection).join("\n\n")}`);
  const log = (s.activity ?? []).map(
    (e) =>
      `- ${hhmm(e.at)} ${firstLine(activityText(s.id, e.text), 160)}${e.count && e.count > 1 ? ` ×${e.count}` : ""}`,
  );
  if (log.length > 0) parts.push(`## Activity\n\n${log.join("\n")}`);
  return parts.filter(Boolean).join("\n\n");
}

// The reading pane: a markdown drawer view, one per swarm, so two viewers
// reading different swarms never race on one key.
export function buildDoc(s: SwarmSummary | undefined, id: string): string {
  if (!s)
    return `# Swarm ${id}\n\nThis swarm is no longer in the rib's history. Its channel \`#swarm-${id}\` in ClickClack keeps the transcript.\n`;
  const channel = channelHref(s);
  const where = channel ? `[#${s.channelName}](${channel})` : `#${s.channelName}`;
  const title = `# ${s.task.trim().split("\n")[0]}`;
  const tail = details(s);
  const after = tail ? `\n\n${tail}` : "";
  if (s.conclusion !== undefined) {
    const by = s.agents.find((a) => a.lead)?.handle ?? `${s.id}-lead`;
    const when = s.endedAt ? ` · ${day(s.endedAt)} ${hhmm(s.endedAt)}` : "";
    return `${title}\n\n*Swarm ${s.id} · by @${by}${when} · ${where}*\n\n${s.conclusion}${after}\n`;
  }
  if (s.status !== "running" && s.status !== "stopping") {
    const why = s.error ?? "the swarm ended without a conclusion";
    const draft = s.draftConclusion
      ? `\n\n> The lead's last conclusion was refused, and is kept below.\n\n${s.draftConclusion}`
      : "";
    return `${title}\n\n*Swarm ${s.id} ended ${s.status}: ${why}. ${where}*${draft}${after}\n`;
  }
  const asks = (s.health?.asks ?? []).map((a) => {
    const thread = threadHref(s, a.threadRootId);
    const how = thread
      ? `Reply [in its thread](${thread}), or mention @${shortHandle(a.handle, s.id)} in ${where}, to answer it.`
      : `Mention @${shortHandle(a.handle, s.id)} in ${where} to answer it.`;
    return `## @${shortHandle(a.handle, s.id)} asked you · ${hhmm(a.at)}\n\n${askText(a.text)}\n\n${how}`;
  });
  const gates = (s.runs ?? []).filter((r) => r.status === "paused" && r.pendingApproval);
  if (gates.length > 0 || asks.length > 0) {
    const gateParts = gates.map((r) => {
      const gate = r.pendingApproval;
      const thread = threadHref(s, gate?.threadId);
      const quoted = (gate?.prompt ?? "")
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
      const files = (gate?.files ?? []).map(fileSection).join("\n\n");
      return `## ${gate?.nodeId} · ${r.workflow} ${r.runId}\n\n${quoted}${files ? `\n\n${files}` : ""}${thread ? `\n\n[The approval thread](${thread}) holds the review.` : ""}`;
    });
    return `${title}\n\n*Swarm ${s.id} · ${where}*\n\n${[...asks, ...gateParts].join("\n\n")}${after}\n`;
  }
  return `${title}\n\n*Swarm ${s.id} is working in ${where}.* Nothing waits on you: a conclusion, a question for you, or an open approval shows here first.${after}\n`;
}
