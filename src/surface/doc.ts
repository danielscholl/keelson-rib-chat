// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { GateFileText, SwarmSummary } from "../types.ts";
import { channelHref, day, hhmm, threadHref } from "./format.ts";

function fileSection(f: GateFileText): string {
  if (f.text === undefined) return `### ${f.path}\n\n*Could not be read: ${f.error ?? "no text"}.*`;
  const body = /\.(md|markdown)$/i.test(f.path) ? f.text : `\`\`\`\`\n${f.text}\n\`\`\`\``;
  return `### ${f.path}${f.truncated ? " (cut short)" : ""}\n\n${body}`;
}

// The reading pane: a markdown drawer view, one per swarm, so two viewers
// reading different swarms never race on one key.
export function buildDoc(s: SwarmSummary | undefined, id: string): string {
  if (!s)
    return `# Swarm ${id}\n\nThis swarm is no longer in the rib's history. Its channel \`#swarm-${id}\` in ClickClack keeps the transcript.\n`;
  const channel = channelHref(s);
  const where = channel ? `[#${s.channelName}](${channel})` : `#${s.channelName}`;
  const title = `# ${s.task.trim().split("\n")[0]}`;
  if (s.conclusion !== undefined) {
    const by = s.agents.find((a) => a.lead)?.handle ?? `${s.id}-lead`;
    const when = s.endedAt ? ` · ${day(s.endedAt)} ${hhmm(s.endedAt)}` : "";
    return `${title}\n\n*Swarm ${s.id} · by @${by}${when} · ${where}*\n\n${s.conclusion}\n`;
  }
  if (s.status !== "running") {
    const why = s.error ?? "the swarm ended without a conclusion";
    const draft = s.draftConclusion
      ? `\n\n> The lead's last conclusion was refused, and is kept below.\n\n${s.draftConclusion}`
      : "";
    return `${title}\n\n*Swarm ${s.id} ended ${s.status}: ${why}. ${where}*${draft}\n`;
  }
  const gates = (s.runs ?? []).filter((r) => r.status === "paused" && r.pendingApproval);
  if (gates.length > 0) {
    const parts = gates.map((r) => {
      const gate = r.pendingApproval;
      const thread = threadHref(s, gate?.threadId);
      const quoted = (gate?.prompt ?? "")
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
      const files = (gate?.files ?? []).map(fileSection).join("\n\n");
      return `## ${gate?.nodeId} · ${r.workflow} ${r.runId}\n\n${quoted}${files ? `\n\n${files}` : ""}${thread ? `\n\n[The gate thread](${thread}) holds the review.` : ""}`;
    });
    return `${title}\n\n*Swarm ${s.id} · ${where}*\n\n${parts.join("\n\n")}\n`;
  }
  return `${title}\n\n*Swarm ${s.id} is working in ${where}.* Nothing to read here yet: a conclusion or an open gate shows here.\n`;
}
