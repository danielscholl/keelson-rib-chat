// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { SwarmSummary } from "../types.ts";
import { channelHref, day, firstLine, hhmm } from "./format.ts";

// The reading pane: a markdown drawer view, one per swarm, so two viewers
// reading different swarms never race on one key.
export function buildDoc(s: SwarmSummary | undefined, id: string, linkable = true): string {
  if (!s)
    return `# Swarm ${id}\n\nThis swarm is no longer in the rib's history. Its channel \`#swarm-${id}\` keeps the transcript.\n`;
  const channel = channelHref(s);
  const transcript = !channel
    ? ""
    : linkable
      ? ` · [transcript ↗](${channel})`
      : " · transcript (start ClickClack from Server › Manage to open it)";
  const where = `#${s.channelName}`;
  const title = `# ${firstLine(s.task, 160)}`;
  const after = `\n\n## Task\n\n${s.task}`;
  if (s.conclusion !== undefined) {
    const by = s.agents.find((a) => a.lead)?.handle ?? `${s.id}-lead`;
    const when = s.endedAt ? ` · ${day(s.endedAt)} ${hhmm(s.endedAt)}` : "";
    return `${title}\n\n*Swarm ${s.id} · ${s.status} · by @${by}${when}${transcript}*\n\n${s.conclusion}${after}\n`;
  }
  const draft = s.draftConclusion
    ? `\n\n> The lead's last conclusion was refused, and is kept below.\n\n${s.draftConclusion}`
    : "";
  if (s.status !== "running" && s.status !== "stopping") {
    const why = s.error ?? "the swarm ended without a conclusion";
    return `${title}\n\n*Swarm ${s.id} ended ${s.status}: ${why}.${transcript}*${draft}${after}\n`;
  }
  return `${title}\n\n*Swarm ${s.id} is working in ${where}. Status: ${s.status}${transcript}*\n\nOpen questions and gates in the tab's inspectors.${draft}${after}\n`;
}
