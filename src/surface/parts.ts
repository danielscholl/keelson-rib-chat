// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasActionItem, CanvasBoardView } from "@keelson/shared";
import { modelLabel, sizeText } from "../labels.ts";
import type { Need, NeedKind } from "../needs.ts";
import { SIZE_PRESETS, SWARM_SIZES, type SwarmStatus, type SwarmSummary } from "../types.ts";
import {
  channelHref,
  firstLine,
  hhmm,
  minutes,
  plural,
  prLabel,
  shortHandle,
  shortRun,
  span,
  threadHref,
} from "./format.ts";

// Text and types the index, the drawer, the launch header and the footer share.

type Card = Extract<CanvasBoardView["sections"][number], { kind: "cards" }>["items"][number];
type Pill = NonNullable<Card["pill"]>;

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
  // External servers are probed on each refresh; the pill says since when one
  // has failed to answer.
  checkedAt?: string;
  unreachableSince?: string;
}

// The hover on Start and the tool's size input share these words.
export function sizesHint(): string {
  return SWARM_SIZES.map((k) => `${k}: ${sizeText(SIZE_PRESETS[k])}`).join(" · ");
}

// The size in one word: the preset, or the preset a custom start was adjusted from.
export function sizeWord(s: Pick<SwarmSummary, "size" | "sizeBase">): string {
  return s.size === "custom" ? `${s.sizeBase}, adjusted` : s.size;
}

export function sizeDetail(s: Pick<SwarmSummary, "limits" | "size" | "sizeBase">): string {
  const l = s.limits;
  return `${sizeWord(s)}: up to ${l.maxAgents} agents · ${l.maxTurns} turns, ${l.maxTurnsPerAgent} per worker · ${l.maxConcurrent} at once · ${minutes(l.turnTimeoutMs)} min a turn`;
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
    power?: SwarmSummary["power"];
    agents: SwarmSummary["agents"];
  },
): string {
  return `${sizeDetail(s)}. Model: ${modelLabel(s)}.`;
}

// The lifecycle word an ended swarm wears, and its tone.
export const LIFECYCLE: Record<SwarmStatus, { label: string; tone: Pill["tone"] }> = {
  running: { label: "running", tone: "info" },
  stopping: { label: "stopping", tone: "neutral" },
  done: { label: "done", tone: "ok" },
  stopped: { label: "stopped", tone: "neutral" },
  stalled: { label: "stalled", tone: "warn" },
  exhausted: { label: "out of budget", tone: "warn" },
  error: { label: "failed", tone: "error" },
};

// The pill a live swarm wears when nothing is asked of the operator.
export function livePill(s: SwarmSummary): Pill {
  if (s.status === "stopping") return LIFECYCLE.stopping;
  if (s.conclusion !== undefined) return { label: "concluding", tone: "info" };
  return LIFECYCLE.running;
}

// Runs that reached verified evidence, over the runs the lead started.
export function verifiedText(s: SwarmSummary): string | undefined {
  const runs = s.runs ?? [];
  if (runs.length === 0) return undefined;
  const verified = runs.filter((r) => r.verified).length;
  return `${verified} of ${plural(runs.length, "run")} verified`;
}

// The budget in one supporting line: turns spent and left, and time spent of the wall clock.
export function budgetLine(s: SwarmSummary, now = Date.now()): string {
  const left = Math.max(0, s.limits.maxTurns - s.turnsUsed);
  const elapsed = Math.max(0, Math.round((now - Date.parse(s.startedAt)) / 60_000));
  return `${s.turnsUsed} of ${s.limits.maxTurns} turns used · ${left} remaining · ${elapsed} of ${minutes(s.limits.wallClockMs)} min`;
}

// The named meter's text, shown above the track until the host draws it on the bar.
export function meterLine(s: SwarmSummary): string {
  const left = Math.max(0, s.limits.maxTurns - s.turnsUsed);
  return `Turn budget used · ${s.turnsUsed} of ${s.limits.maxTurns} · ${left} remaining`;
}

// The gate's own verb, for the gates the rib knows.
export function gateVerb(nodeId: string): string {
  if (/plan/i.test(nodeId)) return "Review plan";
  if (/merge|release|deploy/i.test(nodeId)) return "Review and approve";
  return "Answer";
}

export const NEED_PILL: Record<NeedKind, Pill> = {
  decide: { label: "decide", tone: "caution" },
  question: { label: "question", tone: "caution" },
  connection: { label: "connection", tone: "error" },
  quiet: { label: "quiet", tone: "warn" },
};

export interface Request {
  kind: NeedKind;
  title: string;
  pill: Pill;
  // The second level: what happened and why it is the operator's.
  line: string;
  // Where to look, when the request has a place outside the tab.
  link?: { value: string; href: string };
  // The verb that clears it, first on the card.
  primary: CanvasActionItem;
  // Further verbs the board shows beside the primary one.
  more: CanvasActionItem[];
}

function linkTo(href: string | undefined, value: string): Pick<Request, "link"> {
  return href ? { link: { value, href } } : {};
}

// One request the operator can act on, from a need. The title is the request
// itself, in the words the operator would use; the id names nothing here.
export function requestOf(s: SwarmSummary, need: Need, server?: ServerLine): Request {
  const run = need.run;
  const gate = run?.pendingApproval;
  if (need.kind === "decide" && run && gate) {
    const verb = gateVerb(gate.nodeId);
    const what = /plan/i.test(gate.nodeId)
      ? `Review the plan for ${firstLine(run.purpose, 56)}`
      : `Answer ${gate.nodeId} for ${firstLine(run.purpose, 56)}`;
    return {
      kind: "decide",
      title: what,
      pill: NEED_PILL.decide,
      line: `${run.workflow} ${shortRun(run.runId)} paused at ${gate.nodeId}${gate.openedAt ? ` since ${hhmm(gate.openedAt)}` : ""} · only you can approve ${run.workflow} on this host`,
      ...linkTo(threadHref(s, gate.threadId), "the approval thread in ClickClack"),
      primary: {
        type: "open-run",
        label: verb,
        tone: "brand",
        hint: "Opens the run beside the tab, where you answer its approval.",
        binding: { id: s.id, runId: run.runId },
      },
      more: gate.threadId ? [replyAction(s, { runId: run.runId }, "the approval thread")] : [],
    };
  }
  if (need.kind === "question" && need.ask) {
    const ask = need.ask;
    const who = shortHandle(ask.handle, s.id);
    return {
      kind: "question",
      title: `@${who} asked: ${askGist(ask.text, 96)}`,
      pill: NEED_PILL.question,
      line: `asked at ${hhmm(ask.at)} in #${s.channelName} · a reply in its thread answers it; other questions stay open`,
      ...linkTo(
        threadHref(s, ask.threadRootId) ?? threadHref(s, ask.messageId),
        "the question in ClickClack",
      ),
      primary: {
        type: "read-doc",
        label: "Read question",
        tone: "brand",
        glyph: "▤",
        payload: { id: s.id },
      },
      more: [
        replyAction(s, { threadRootId: ask.threadRootId, messageId: ask.messageId }, "the thread"),
        {
          type: "dismiss-ask",
          label: "Dismiss",
          hint: "Clears the question from the tab. The message stays in the channel.",
          payload: { id: s.id, messageId: ask.messageId },
        },
      ],
    };
  }
  if (need.kind === "connection") {
    const fault = s.health?.channelFault;
    const down = server?.mode === "managed" && !server.running;
    return {
      kind: "connection",
      title: "ClickClack stopped answering",
      pill: NEED_PILL.connection,
      line: `the swarm's socket closed ${s.health?.socketDrops ?? 2} times without reopening${fault ? ` · ${firstLine(fault, 80)}` : ""} · ${down ? "the managed server is not running" : "the swarm retries every 2 seconds"}`,
      ...linkTo(channelHref(s), `#${s.channelName} in ClickClack`),
      primary: down
        ? {
            type: "server-start",
            label: "Start ClickClack",
            tone: "brand",
            glyph: "▶",
            hint: "Starts the managed server. The swarm reconnects and replays what it missed.",
          }
        : openSwarm(s, "brand"),
      more: down ? [openSwarm(s)] : [],
    };
  }
  const since = need.since ? hhmm(need.since) : hhmm(s.startedAt);
  return {
    kind: "quiet",
    title: `No agent has worked since ${since}`,
    pill: NEED_PILL.quiet,
    line:
      run && gate
        ? `${run.workflow} ${shortRun(run.runId)} waits at ${gate.nodeId} and the swarm could answer it · a note wakes the lead`
        : "the swarm is idle · a note wakes the lead",
    primary: messageLead(s, "brand"),
    more:
      gate?.threadId && run ? [replyAction(s, { runId: run.runId }, "the approval thread")] : [],
  };
}

export function openSwarm(s: SwarmSummary, tone?: CanvasActionItem["tone"]): CanvasActionItem {
  return {
    type: "swarm-open",
    label: "Open swarm",
    glyph: "→",
    ...(tone ? { tone } : {}),
    payload: { id: s.id },
    hint: openHint(s),
  };
}

// A note to the lead, posted in the channel as the operator.
export function messageLead(s: SwarmSummary, tone?: CanvasActionItem["tone"]): CanvasActionItem {
  return {
    type: "message-lead",
    label: "Message the lead",
    ...(tone ? { tone } : {}),
    binding: { id: s.id },
    fields: [
      {
        name: "note",
        label: "Message",
        placeholder: `Posts in #${s.channelName} as you and wakes the lead · Enter sends`,
        required: true,
      },
    ],
    submitLabel: "Send",
  };
}

// A reply as the operator in a thread: an approval's, or a question's. It never
// approves anything, and the field says so.
function replyAction(
  s: SwarmSummary,
  where: { runId: string } | { threadRootId: string; messageId: string },
  what: string,
): CanvasActionItem {
  const type = "runId" in where ? "reply" : "reply-ask";
  const href =
    "runId" in where
      ? undefined
      : (threadHref(s, where.threadRootId) ?? threadHref(s, where.messageId));
  return {
    type,
    label: "Reply",
    binding: { id: s.id, ...where },
    fields: [
      {
        name: "note",
        label: "Reply",
        placeholder: `Posts in ${what} as you · does not approve; Answer opens the run · Enter sends`,
        required: true,
      },
    ],
    submitLabel: "Reply",
    ...(href ? { hint: `Thread: ${href}` } : {}),
  };
}

export function stopAction(s: SwarmSummary, inline = false): CanvasActionItem {
  const live = (s.runs ?? []).filter((r) => r.status === "running" || r.status === "paused");
  return {
    type: "stop-swarm",
    label: "Stop swarm…",
    destructive: true,
    ...(inline ? { inline: true, align: "end" as const } : {}),
    payload: { id: s.id },
    confirm: {
      title: `Stop swarm ${s.id}?`,
      body:
        live.length > 0
          ? `Its agents stop, and ${live.length} live run(s) are cancelled: ${live.map((r) => `${r.workflow} ${shortRun(r.runId)}`).join(", ")}.`
          : "Its agents stop and their tokens are revoked. The channel keeps the transcript.",
      confirmLabel: "Stop swarm",
    },
  };
}

// The cause an ended swarm names in its outcome card's title.
export function causeTitle(s: SwarmSummary): string {
  const at = s.endedAt ? ` at ${hhmm(s.endedAt)}` : "";
  const why = s.error ?? "";
  switch (s.status) {
    case "stopped":
      return /operator|swarms tab|cancelled/i.test(why) ? `Stopped by you${at}` : `Stopped${at}`;
    case "exhausted":
      if (/turn budget/i.test(why)) return `Out of turns at ${s.limits.maxTurns}`;
      if (/wall clock/i.test(why)) return `Out of time at ${minutes(s.limits.wallClockMs)} min`;
      return `Out of budget${at}`;
    case "stalled":
      return `Stalled${at}`;
    case "error":
      return `Failed: ${firstLine(why || "no reason recorded", 80)}`;
    default:
      return "Ended without a conclusion";
  }
}

// The verified PR, for the places that still point at one.
export function verifiedPr(s: SwarmSummary): string | undefined {
  return s.runs?.find((r) => r.verified && r.prUrls.length > 0)?.prUrls[0];
}

export function prText(url: string): string {
  return prLabel(url);
}

export function ranFor(s: SwarmSummary): string {
  return span(s.startedAt, s.endedAt);
}
