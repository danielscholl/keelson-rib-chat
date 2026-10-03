// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasActionItem, CanvasBoardView } from "@keelson/shared";
import { modelLabel, servedModels, sizeText, tokensText } from "../labels.ts";
import type { Need, NeedKind } from "../needs.ts";
import {
  type ChildRun,
  isLive,
  SIZE_PRESETS,
  SWARM_SIZES,
  type SwarmStatus,
  type SwarmSummary,
} from "../types.ts";
import {
  activityText,
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

// Text and types the index, the drawer, the launch header and the server inspector share.

type Card = Extract<CanvasBoardView["sections"][number], { kind: "cards" }>["items"][number];
type Pill = NonNullable<Card["pill"]>;
type Row = Extract<CanvasBoardView["sections"][number], { kind: "rows" }>["items"][number];

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

export function serverState(server: ServerLine): string {
  if (server.mode === "external") {
    return server.running
      ? "reachable"
      : `unreachable${server.unreachableSince ? ` since ${hhmm(server.unreachableSince)}` : ""}`;
  }
  return server.running ? "running" : "stopped";
}

export function serverAddress(server: ServerLine): string | undefined {
  return server.url?.replace(/^https?:\/\//, "");
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

export function modelRow(s: SwarmSummary): string {
  const provider =
    s.provider ?? s.agents.find((a) => a.providerId)?.providerId ?? "the host's default provider";
  const lead = s.model;
  const workers = s.workerModel ?? s.model;
  if (lead && workers && lead !== workers) return `${provider} · lead ${lead} · workers ${workers}`;
  if (lead) return `${provider} · every agent on ${lead}`;
  const power = s.power ? `${s.power} power` : undefined;
  if (workers) return `${provider} · lead at ${power ?? "its default"} · workers ${workers}`;
  const models = servedModels(s);
  const on =
    models.length === 1
      ? ` · every agent on ${models[0]}`
      : models.length > 1
        ? ` · agents on ${models.join(", ")}`
        : "";
  return power ? `${power} on ${provider}${on}` : `${provider} · the provider's default model${on}`;
}

function detailedSetupRows(s: SwarmSummary): Row[] {
  const l = s.limits;
  const defaultModel = s.power
    ? `${s.power} power; no explicit model recorded`
    : "host default; no explicit model recorded";
  return [
    { icon: "◫", text: `Size: ${sizeWord(s)}` },
    {
      text: `Effective limits: ${l.maxAgents} agents · ${l.maxTurns} total turns · ${l.maxTurnsPerAgent} turns per worker · ${l.maxConcurrent} concurrent turns`,
    },
    {
      text: `Wall-clock limit: ${l.wallClockMs} ms · Turn timeout: ${l.turnTimeoutMs} ms · Idle nudge limit: ${l.maxNudges}`,
    },
    { text: `Requested provider: ${s.provider ?? "host default; no explicit provider recorded"}` },
    { text: `Requested lead model: ${s.model ?? defaultModel}` },
    {
      text: `Requested worker model: ${s.workerModel ?? s.model ?? defaultModel}${s.workerModel ? " (worker role override)" : " (inherits lead setting)"}`,
    },
    { text: `Requested power: ${s.power ?? "not recorded"}` },
    { text: `Recorded reasoning effort: ${s.effort ?? "not recorded"}` },
    ...s.agents.flatMap((a): Row[] => {
      const roleModel = a.lead ? s.model : (s.workerModel ?? s.model);
      const override = a.model && roleModel && a.model !== roleModel;
      const who = `@${shortHandle(a.handle, s.id)} (${a.lead ? "lead" : "worker"})`;
      return [
        {
          text: `Requested model for ${who}: ${a.model ?? "no per-agent request recorded"}${override ? ` (overrides role setting ${roleModel})` : ""}`,
        },
        {
          text: `Served model for ${who}: ${a.servedModel ?? "not reported"} · provider: ${a.providerId ?? "not reported"}`,
        },
      ];
    }),
    ...(s.agents.length ? [] : [{ text: "Served models and per-agent requests not recorded." }]),
  ];
}

export function setupRows(s: SwarmSummary, options: { detailed?: boolean } = {}): Row[] {
  return [
    ...(options.detailed
      ? detailedSetupRows(s)
      : [
          { icon: "◫", text: sizeDetail(s) },
          { icon: "◆", text: modelRow(s) },
        ]),
    ...(s.usage ? [{ icon: "∑", text: `${tokensText(s.usage)} tokens` }] : []),
  ];
}

export function healthRows(s: SwarmSummary): Row[] {
  const h = s.health;
  const warn = (text: string): Row => ({ icon: "!", glyph: "warn", text });
  return [
    ...(h?.socketDrops
      ? [warn(`socket closed ${h.socketDrops} time(s) since it last opened`)]
      : []),
    ...(h?.channelFault ? [warn(`ClickClack fault: ${h.channelFault}`)] : []),
    ...(h?.lastLeadFailure
      ? [
          warn(
            `the lead's last turn failed (${h.leadFailures ?? 1} in a row): ${h.lastLeadFailure}`,
          ),
        ]
      : []),
    ...(h?.nudges
      ? [{ icon: "◌", text: `idle: nudged the lead ${h.nudges} of ${s.limits.maxNudges} times` }]
      : []),
    ...(h?.refusedConclusions
      ? [warn(`the lead's conclusion was refused ${h.refusedConclusions} time(s) for length`)]
      : []),
    ...(h?.cancelFault ? [warn(h.cancelFault)] : []),
    ...(!isLive(s.status) && s.error
      ? [{ icon: "✕", glyph: "error" as const, text: s.error }]
      : []),
  ];
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

export function stateLine(
  s: SwarmSummary,
  needs: readonly Need[],
  server?: ServerLine,
): { text: string; warn: boolean } {
  const clauses: string[] = [];
  const need = needs[0];
  if (s.status === "stopping") {
    clauses.push("stopping: cancelling runs and revoking tokens");
  } else {
    if (need) {
      const title = requestOf(s, need, server).title;
      const request = title.startsWith("@")
        ? title
        : title.charAt(0).toLowerCase() + title.slice(1);
      clauses.push(
        `waits on you: ${request}${need.since && need.kind !== "quiet" ? ` since ${hhmm(need.since)}` : ""}${needs.length > 1 ? ` (+${needs.length - 1} more)` : ""}`,
      );
    }
    const busy = s.agents.filter((a) => a.status === "busy");
    for (const a of busy.slice(0, 3)) {
      const turn = [...(s.spans ?? [])].reverse().find((t) => t.agentId === a.id && !t.endedAt);
      clauses.push(
        `@${shortHandle(a.handle, s.id)} is on ${turn ? `turn ${turn.n} since ${hhmm(turn.startedAt)}` : "a turn"}`,
      );
    }
    if (busy.length > 3) clauses.push(`+${busy.length - 3} more on turns`);
    const waiting = s.agents.filter((a) => a.status === "waiting");
    for (const a of waiting.slice(0, 3)) {
      clauses.push(
        `@${shortHandle(a.handle, s.id)} waits with ${plural(a.queued ?? 0, "message")}`,
      );
    }
    if (waiting.length > 3) clauses.push(`+${waiting.length - 3} more waiting`);
    for (const run of s.runs ?? []) {
      const gate = run.pendingApproval;
      if (
        run.status !== "paused" ||
        !gate ||
        gate.answerer === "operator" ||
        needs.some((n) => n.run?.runId === run.runId)
      ) {
        continue;
      }
      clauses.push(
        `${run.workflow} ${shortRun(run.runId)} paused at ${gate.nodeId}${gate.openedAt ? ` since ${hhmm(gate.openedAt)}` : ""}${gate.reviewer ? `, with @${shortHandle(gate.reviewer, s.id)} reviewing` : ""}`,
      );
    }
    if (s.conclusion !== undefined) {
      const conclusion = [...(s.activity ?? [])].reverse().find((e) => e.kind === "conclusion");
      clauses.push(
        `${conclusion ? `concluded at ${hhmm(conclusion.at)}` : "the lead concluded"}; turns in flight finish`,
      );
    }
    if (clauses.length === 0) {
      const latest = s.activity?.at(-1);
      clauses.push(
        latest
          ? `${hhmm(latest.at)} ${activityText(s.id, latest.text)}`
          : "waiting for the lead's first turn",
      );
    }
  }
  const health: string[] = [];
  const h = s.health;
  if (h?.socketDrops && need?.kind !== "connection") {
    health.push(`ClickClack socket closed ${plural(h.socketDrops, "time")}`);
  }
  if (h?.channelFault) health.push(`ClickClack fault: ${firstLine(h.channelFault, 80)}`);
  if (h?.lastLeadFailure) health.push("the lead's last turn failed");
  if (h?.nudges) health.push(`nudged the lead ${h.nudges} of ${s.limits.maxNudges} times`);
  return { text: firstLine([...clauses, ...health].join(" · "), 240), warn: health.length > 0 };
}

// Runs that reached verified evidence, over the runs the lead started.
export function verifiedText(s: SwarmSummary): string | undefined {
  const runs = s.runs ?? [];
  if (runs.length === 0) return undefined;
  const verified = runs.filter((r) => r.verified).length;
  return `${verified} of ${plural(runs.length, "run")} verified`;
}

// The budget in one supporting line: turns spent and left, and time spent of the wall clock.
export function budgetLine(s: SwarmSummary): string {
  const left = Math.max(0, s.limits.maxTurns - s.turnsUsed);
  return `${s.turnsUsed} of ${s.limits.maxTurns} turns used · ${left} remaining`;
}

export function endsAt(s: Pick<SwarmSummary, "startedAt" | "limits">): string {
  return new Date(Date.parse(s.startedAt) + s.limits.wallClockMs).toISOString();
}

// The host ticks these between frames, so a waiting request stays true.
const SINCE_LABEL: Record<NeedKind, string> = {
  decide: "opened",
  question: "asked",
  connection: "since",
  quiet: "last turn",
};

export function sinceClock(need: Need) {
  return need.since
    ? [{ label: SINCE_LABEL[need.kind], clock: { at: need.since, mode: "since" as const } }]
    : [];
}

export function timeLeft(s: SwarmSummary) {
  return { label: "time", clock: { at: endsAt(s), mode: "until" as const } };
}

// The turn meter, captioned on its own track.
export function turnMeter(s: SwarmSummary) {
  const left = Math.max(0, s.limits.maxTurns - s.turnsUsed);
  return {
    value: s.turnsUsed,
    total: s.limits.maxTurns,
    label: "Turn budget used",
    trailing: `${s.turnsUsed} of ${s.limits.maxTurns} · ${left} remaining`,
  };
}

// The gate's own verb, for the gates the rib knows.
export function gateVerb(nodeId: string): string {
  if (/plan/i.test(nodeId)) return "Review plan";
  if (/merge|release|deploy/i.test(nodeId)) return "Review and approve";
  return "Answer";
}

export function gateIdentity(run: Pick<ChildRun, "runId" | "pendingApproval">): string | undefined {
  const gate = run.pendingApproval;
  if (!gate) return undefined;
  return JSON.stringify(
    gate.pauseId
      ? [run.runId, "pause", gate.pauseId]
      : [run.runId, "legacy", gate.nodeId, gate.openedAt ?? null, gate.threadId ?? null],
  );
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
      line: `${run.workflow} ${shortRun(run.runId)} paused at ${gate.nodeId} · only you can approve ${run.workflow} on this host`,
      primary: {
        type: "open-run",
        label: verb,
        tone: "brand",
        binding: { id: s.id, runId: run.runId },
      },
      more: [
        {
          type: "select-gate",
          label: "Read gate",
          payload: { id: s.id, runId: run.runId, gateIdentity: gateIdentity(run) },
        },
        ...(gate.threadId ? [replyAction(s, { runId: run.runId }, "the approval thread")] : []),
      ],
    };
  }
  if (need.kind === "question" && need.ask) {
    const ask = need.ask;
    const who = shortHandle(ask.handle, s.id);
    return {
      kind: "question",
      title: `@${who} asked: ${askGist(ask.text, 96)}`,
      pill: NEED_PILL.question,
      line: `in #${s.channelName} · a reply in its thread answers it; other questions stay open`,
      primary: {
        type: "select-ask",
        label: "Read question",
        tone: "brand",
        glyph: "▤",
        payload: { id: s.id, messageId: ask.messageId },
      },
      more: [
        replyAction(s, { threadRootId: ask.threadRootId, messageId: ask.messageId }, "the thread"),
        dismissAskAction(s, ask.messageId),
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
      ...linkTo(channelHref(s), "transcript ↗"),
      primary: down
        ? {
            type: "server-start",
            label: "Start ClickClack",
            pendingLabel: "Starting…",
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

export function selectSwarm(s: SwarmSummary, tone?: CanvasActionItem["tone"]): CanvasActionItem {
  return {
    type: "select-swarm",
    label: "Open swarm",
    glyph: "↓",
    payload: { id: s.id },
    hint: openHint(s),
    ...(tone ? { tone } : {}),
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
        placeholder: "posts as you, wakes the lead",
        required: true,
      },
    ],
    submitLabel: "Send",
    pendingLabel: "Sending…",
  };
}

// A reply as the operator in a thread: an approval's, or a question's. It never
// approves anything, and the field says so.
export function replyAction(
  s: SwarmSummary,
  where: { runId: string; gateIdentity?: string } | { threadRootId: string; messageId: string },
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
        placeholder: `Posts in ${what} as you · does not approve · Enter sends`,
        required: true,
      },
    ],
    submitLabel: "Reply",
    pendingLabel: "Sending…",
    ...(href ? { hint: `Thread: ${href}` } : {}),
  };
}

export function dismissAskAction(s: SwarmSummary, messageId: string): CanvasActionItem {
  return {
    type: "dismiss-ask",
    label: "Dismiss",
    hint: "Clears the question from the tab. The message stays in the channel.",
    payload: { id: s.id, messageId },
  };
}

export function stopAction(s: SwarmSummary, inline = false): CanvasActionItem {
  const live = (s.runs ?? []).filter((r) => r.status === "running" || r.status === "paused");
  return {
    type: "stop-swarm",
    label: "Stop swarm…",
    pendingLabel: "Stopping…",
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
export function causeTitle(s: SwarmSummary, withTime = true): string {
  const at = withTime && s.endedAt ? ` at ${hhmm(s.endedAt)}` : "";
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
