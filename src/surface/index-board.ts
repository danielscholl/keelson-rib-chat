// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView, RibSurfaceBadge } from "@keelson/shared";
import { modelLabel } from "../labels.ts";
import { type Need, needsYou, oldestNeed } from "../needs.ts";
import { type StartingSwarm, type SwarmSummary, sizeOf } from "../types.ts";
import { activityText, day, firstLine, hhmm, plural, shortHandle, span } from "./format.ts";
import {
  budgetLine,
  LIFECYCLE,
  livePill,
  meterLine,
  openHint,
  openSwarm,
  requestOf,
  type ServerLine,
  sizeWord,
  stopAction,
  verifiedText,
} from "./parts.ts";

export interface SurfaceState {
  live: readonly SwarmSummary[];
  starting: readonly StartingSwarm[];
  // Oldest first, as the rib keeps them.
  ended: readonly SwarmSummary[];
  server?: ServerLine;
}

type Section = CanvasBoardView["sections"][number];
type Card = Extract<Section, { kind: "cards" }>["items"][number];
type Row = Extract<Section, { kind: "rows" }>["items"][number];
type Field = NonNullable<Card["fields"]>[number];

export const ENDED_SHOWN = 8;

// What the swarm is doing this minute, from its latest event or health.
function activityLine(s: SwarmSummary): string {
  const h = s.health;
  if (s.status === "stopping") return "stopping: cancelling runs and revoking tokens";
  if (s.conclusion !== undefined) return "the lead has concluded; turns in flight finish";
  const gated = s.runs?.find((r) => r.status === "paused" && r.pendingApproval);
  if (gated?.pendingApproval) {
    const who = gated.pendingApproval.reviewer;
    return `${gated.pendingApproval.nodeId} on ${gated.workflow} is in review${who ? ` by @${shortHandle(who, s.id)}` : ""} since ${hhmm(gated.pendingApproval.openedAt)}`;
  }
  if (h?.channelFault) return `ClickClack fault: ${firstLine(h.channelFault, 80)}`;
  if (h?.lastLeadFailure) return `the lead's last turn failed: ${firstLine(h.lastLeadFailure, 80)}`;
  if (h?.nudges) return `idle: nudged the lead ${h.nudges} of ${s.limits.maxNudges} times`;
  const busy = s.agents.filter((a) => a.status === "busy");
  const last = s.activity?.at(-1);
  if (busy.length > 0) {
    return `${busy.map((a) => `@${shortHandle(a.handle, s.id)}`).join(", ")} working${last ? ` · ${firstLine(activityText(s.id, last.text), 60)}` : ""}`;
  }
  if (last) return `${hhmm(last.at)} ${firstLine(activityText(s.id, last.text), 90)}`;
  return "waiting for the lead's first turn";
}

// The third level: what the swarm is, in one muted line.
function setup(s: SwarmSummary, withTask: boolean): string {
  return [
    ...(withTask ? [firstLine(s.task, 72)] : []),
    ...(s.project ? [s.project.name] : []),
    sizeWord(s),
    modelLabel(s),
    ...(s.agents.length > 0 ? [plural(s.agents.length, "agent")] : []),
    `started ${hhmm(s.startedAt)}`,
  ].join(" · ");
}

function people(s: SwarmSummary): Field[] {
  if (s.agents.length === 0) return [];
  return [{ people: s.agents.map((a) => ({ name: shortHandle(a.handle, s.id), tone: a.tone })) }];
}

function reportAction(s: SwarmSummary) {
  return s.report
    ? [
        {
          type: "open-report",
          label: "Report",
          glyph: "◧",
          payload: { id: s.id },
          hint: s.report.title,
        },
      ]
    : [];
}

// A swarm that asks something: the request is the title, its verb the first
// action, and the task drops to the footnote.
function requestCard(s: SwarmSummary, needs: readonly Need[]): Card {
  const first = needs[0] as Need;
  const request = requestOf(s, first);
  const more = needs.length - 1;
  return {
    title: request.title,
    pill: request.pill,
    // One level per line: the request, the budget, the roster.
    stacked: true,
    fields: [{ value: request.line }, { value: budgetLine(s) }, ...people(s)],
    footnote: setup(s, true),
    ...(more > 0 ? { reason: { text: `+${plural(more, "more request")}` } } : {}),
    actions: [request.primary, openSwarm(s), ...reportAction(s), stopAction(s)],
  };
}

// A swarm that asks nothing: the task is the title, the first line is what it
// is doing now, and the budget is a named meter under it.
function runningCard(s: SwarmSummary): Card {
  return {
    title: `${firstLine(s.task)} · ${s.id}`,
    pill: livePill(s),
    bar: { value: s.turnsUsed, total: s.limits.maxTurns },
    stacked: true,
    fields: [{ value: activityLine(s) }, { value: meterLine(s) }, ...people(s)],
    footnote: setup(s, false),
    actions: [openSwarm(s, "brand"), ...reportAction(s), stopAction(s)],
  };
}

function startingCard(s: StartingSwarm): Card {
  const shape = { ...s, size: sizeOf(s.limits, s.sizeBase), agents: [] };
  return {
    title: `${firstLine(s.task)} · ${s.id}`,
    pill: { label: "starting", tone: "neutral" },
    fields: [{ value: "creating the channel and the lead" }],
    footnote: [
      ...(s.project ? [s.project.name] : []),
      sizeWord(shape),
      modelLabel(shape),
      `started ${hhmm(s.startedAt)}`,
    ].join(" · "),
    actions: [
      {
        type: "swarm-open",
        label: "Open swarm",
        glyph: "→",
        payload: { id: s.id },
        hint: openHint(shape),
      },
    ],
  };
}

// An ended swarm leads with its lifecycle, then the task, then the result.
export function endedRow(s: SwarmSummary): Row {
  const life = LIFECYCLE[s.status];
  const took = span(s.startedAt, s.endedAt);
  const verified = verifiedText(s);
  return {
    chip: { label: life.label, tone: life.tone },
    text: firstLine(s.task, 72),
    trailing: [
      s.id,
      modelLabel(s),
      plural(s.turnsUsed, "turn"),
      ...(took ? [took] : []),
      `${day(s.startedAt)} ${hhmm(s.startedAt)}`,
      ...(verified ? [verified] : []),
      ...(s.report ? ["◧ report"] : []),
    ].join(" · "),
    action: { type: "swarm-open", payload: { id: s.id } },
  };
}

export function buildBadge(state: SurfaceState): RibSurfaceBadge {
  const count = state.live.filter((s) => needsYou(s).length > 0).length;
  return count > 0
    ? { count, title: `${count} ${count === 1 ? "swarm needs" : "swarms need"} you` }
    : { count };
}

export function buildIndex(state: SurfaceState): CanvasBoardView {
  const live = state.live.map((s) => ({ s, needs: needsYou(s) }));
  const needing = live
    .filter((x) => x.needs.length > 0)
    .sort((a, b) => (oldestNeed(a.needs) ?? "").localeCompare(oldestNeed(b.needs) ?? ""));
  const running = live
    .filter((x) => x.needs.length === 0)
    .sort((a, b) => a.s.startedAt.localeCompare(b.s.startedAt));
  const cards = [
    ...needing.map((x) => requestCard(x.s, x.needs)),
    ...state.starting.map(startingCard),
    ...running.map((x) => runningCard(x.s)),
  ];
  const ended = [...state.ended].reverse();
  const shown = ended.slice(0, ENDED_SHOWN);
  const earlier = ended.length - shown.length;
  const liveCount = live.length + state.starting.length;
  const status =
    needing.length > 0
      ? {
          label: `${needing.length} need${needing.length === 1 ? "s" : ""} you`,
          tone: "caution" as const,
        }
      : liveCount > 0
        ? { label: `${liveCount} live`, tone: "info" as const }
        : undefined;
  const segments =
    liveCount > 0
      ? [
          { label: "needs you", n: needing.length, tone: "caution" as const },
          { label: "running", n: running.length, tone: "info" as const },
          { label: "starting", n: state.starting.length, tone: "neutral" as const },
        ].filter((seg) => seg.n > 0)
      : [];
  const empty = cards.length === 0 && ended.length === 0;

  return {
    view: "board",
    title: "Swarms",
    ...(status ? { header: { status, ...(segments.length > 0 ? { segments } : {}) } } : {}),
    sections: [
      ...(cards.length > 0 ? [{ kind: "cards" as const, title: "Live", items: cards }] : []),
      ...(shown.length > 0
        ? [
            {
              kind: "rows" as const,
              title: "Ended",
              items: [
                ...shown.map(endedRow),
                ...(earlier > 0
                  ? [
                      {
                        icon: "…",
                        text: `${earlier} earlier ended swarm${earlier === 1 ? "" : "s"}`,
                        action: { type: "history-open" },
                      },
                    ]
                  : []),
              ],
            },
          ]
        : []),
      ...(empty
        ? [
            {
              kind: "journey" as const,
              items: [
                { title: "Start a swarm", text: "Name the task above and pick a size." },
                {
                  title: "Agents talk in #swarm-<id>",
                  text: "The lead spawns workers and they work it out in ClickClack.",
                },
                {
                  title: "The lead concludes here",
                  text: "The answer and its report land on this tab.",
                },
              ],
            },
          ]
        : []),
    ],
  };
}

export function buildHistory(state: SurfaceState): CanvasBoardView {
  const ended = [...state.ended].reverse();
  return {
    view: "board",
    title: "Ended swarms",
    header: { chip: `${ended.length} kept` },
    sections: [
      {
        kind: "rows",
        items:
          ended.length > 0 ? ended.map(endedRow) : [{ icon: "◌", text: "No ended swarms yet." }],
      },
    ],
  };
}
