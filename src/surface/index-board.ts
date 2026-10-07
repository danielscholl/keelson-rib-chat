// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasActionItem, CanvasBoardView, RibSurfaceBadge } from "@keelson/shared";
import { estimated, rowCost, swarmCost } from "../cost.ts";
import { freshTokens, modelLabel, tokenCount } from "../labels.ts";
import { NEED_ORDER, type Need, needsYou, oldestNeed, UNDATED } from "../needs.ts";
import { type StartingSwarm, type SwarmSummary, sizeOf } from "../types.ts";
import { dayHeading, firstLine, gist, hhmm, plural, shortHandle, span } from "./format.ts";
import {
  causeTitle,
  LIFECYCLE,
  livePill,
  openHint,
  requestOf,
  type ServerLine,
  selectSwarm,
  serverAddress,
  serverState,
  sinceClock,
  sizeWord,
  stateLine,
  stopAction,
  timeLeft,
  turnMeter,
  verifiedText,
} from "./parts.ts";
import { type ServerOp, pill as serverPill } from "./server-panel.ts";
import { buildCockpit } from "./swarm-board.ts";

export interface SurfaceState {
  live: readonly SwarmSummary[];
  starting: readonly StartingSwarm[];
  // Oldest first, as the rib keeps them.
  ended: readonly SwarmSummary[];
  server?: ServerLine;
  op?: ServerOp;
  selected?: string;
  selectedAgents?: ReadonlyMap<string, string>;
}

type Section = CanvasBoardView["sections"][number];
type Card = Extract<Section, { kind: "cards" }>["items"][number];
type Row = Extract<Section, { kind: "rows" }>["items"][number];
type Field = NonNullable<Card["fields"]>[number];

export const ENDED_SHOWN = 8;
// An ended row's outcome and task together stay under this.
const ENDED_TEXT = 90;
const OUTCOME_CHARS = 48;
const NEEDS_SHOWN = 12;

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

function needCard(s: SwarmSummary, need: Need, server?: ServerLine): Card {
  const request = requestOf(s, need, server);
  const local = (action: CanvasActionItem): CanvasActionItem =>
    action.type === "swarm-open" ? { ...action, type: "select-swarm", glyph: "↓" } : action;
  const actions = [request.primary, ...request.more].map(local);
  if (!actions.some((a) => a.type === "select-swarm")) actions.push(selectSwarm(s));
  return {
    title: request.title,
    pill: request.pill,
    edge: request.pill.tone,
    stacked: true,
    fields: [{ value: request.line }, ...sinceClock(need), ...(request.link ? [request.link] : [])],
    footnote: `${firstLine(s.task, 60)} · ${s.id}`,
    actions,
  };
}

function runningCard(s: SwarmSummary, needs: readonly Need[], server?: ServerLine): Card {
  return {
    title: `${firstLine(s.task)} · ${s.id}`,
    pill: needs.length ? { label: "needs you", tone: "caution" } : livePill(s),
    bar: turnMeter(s),
    stacked: true,
    fields: [{ value: stateLine(s, needs, server).text }, timeLeft(s), ...people(s)],
    footnote: setup(s, false),
    actions: [selectSwarm(s, "brand"), ...reportAction(s), stopAction(s)],
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

// What came of a swarm: the report's title, the conclusion's first sentence, or
// why it ended.
function outcomeOf(s: SwarmSummary): string {
  if (s.report) return firstLine(s.report.title, OUTCOME_CHARS);
  const said = s.conclusion ? gist(s.conclusion, OUTCOME_CHARS) : "";
  return said || firstLine(causeTitle(s, false).split(". ")[0]!, OUTCOME_CHARS);
}

// An ended swarm leads with the task it was for, then its outcome. A done row
// carries a quiet check, so a chip marks only the swarms that did not finish.
// The trailing text never shrinks on the host, so it carries only the short facts.
export function endedRow(s: SwarmSummary): Row {
  const took = span(s.startedAt, s.endedAt);
  const verified = verifiedText(s);
  const tail = ` · ${outcomeOf(s)}`;
  const cost = swarmCost(s);
  return {
    ...(s.status === "done"
      ? { icon: "✓" }
      : { chip: { label: LIFECYCLE[s.status].label, tone: LIFECYCLE[s.status].tone } }),
    text: `${s.rerunOf ? "↻ " : ""}${firstLine(s.task, Math.max(24, ENDED_TEXT - tail.length))}${tail}`,
    trailing: [
      plural(s.turnsUsed, "turn"),
      ...(took ? [took] : []),
      ...(s.usage ? [tokenCount(freshTokens(s.usage))] : []),
      ...(cost ? [rowCost(cost, estimated(s))] : []),
      hhmm(s.endedAt ?? s.startedAt),
      ...(verified ? [verified] : []),
      ...(s.report ? ["◧ report"] : []),
    ].join(" · "),
    action: { type: "swarm-open", payload: { id: s.id } },
  };
}

// Ended swarms, newest first, one rows section per day they ended.
// A day that spent anything carries its total in the heading, over every kept
// swarm that ended that day, not only the rows shown.
function byDay(
  ended: readonly SwarmSummary[],
  now: Date,
  kept: readonly SwarmSummary[] = ended,
): Extract<Section, { kind: "rows" }>[] {
  const days: { day: string; swarms: SwarmSummary[] }[] = [];
  for (const s of ended) {
    const day = dayHeading(s.endedAt ?? s.startedAt, now);
    const last = days.at(-1);
    if (last?.day === day) last.swarms.push(s);
    else days.push({ day, swarms: [s] });
  }
  return days.map(({ day, swarms: shown }) => {
    const swarms = kept.filter((s) => dayHeading(s.endedAt ?? s.startedAt, now) === day);
    const costs = swarms.map((s) => swarmCost(s)).filter((c) => c !== undefined);
    const total = costs.reduce((n, c) => n + c.usd, 0);
    const spent =
      total > 0
        ? ` · ${rowCost(
            { usd: total, unpricedTurns: costs.reduce((n, c) => n + c.unpricedTurns, 0) },
            swarms.some(estimated),
          )}`
        : "";
    return { kind: "rows" as const, title: `${day}${spent}`, items: shown.map(endedRow) };
  });
}

export function buildBadge(state: SurfaceState): RibSurfaceBadge {
  const count = state.live.filter((s) => needsYou(s).length > 0).length;
  return count > 0
    ? { count, title: `${count} ${count === 1 ? "swarm needs" : "swarms need"} you` }
    : { count };
}

function serverRow(server: ServerLine | undefined, op: ServerOp | undefined, live: number): Row {
  const address = server ? serverAddress(server) : undefined;
  const operation = op && op.phase !== "done" ? serverPill({ server, op, live }) : undefined;
  const status = operation?.label ?? (server ? serverState(server) : "checking");
  return {
    ...(operation ? { chip: operation } : {}),
    text: [
      server
        ? `Server · ClickClack ${status}${address ? ` on ${address}` : ""}`
        : "Server · ClickClack checking…",
      ...(server ? [server.mode] : []),
      ...(live > 0 ? [plural(live, "swarm")] : []),
    ].join(" · "),
    trailing: "Manage ›",
    action: { type: "server-manage" },
  };
}

export function buildIndex(state: SurfaceState, now = new Date()): CanvasBoardView {
  const live = state.live.map((s) => ({ s, needs: needsYou(s) }));
  const needing = live
    .filter((x) => x.needs.length > 0)
    .sort((a, b) => (oldestNeed(a.needs) ?? UNDATED).localeCompare(oldestNeed(b.needs) ?? UNDATED));
  const running = live
    .filter((x) => x.needs.length === 0)
    .sort((a, b) => a.s.startedAt.localeCompare(b.s.startedAt));
  const ordered = [...needing, ...running];
  const expanded = ordered.find((x) => x.s.id === state.selected) ?? ordered[0];
  const needs = live
    .flatMap((x) => x.needs.map((n) => ({ s: x.s, n })))
    .sort(
      (a, b) =>
        (a.n.since ?? UNDATED).localeCompare(b.n.since ?? UNDATED) ||
        NEED_ORDER.indexOf(a.n.kind) - NEED_ORDER.indexOf(b.n.kind) ||
        a.s.startedAt.localeCompare(b.s.startedAt),
    );
  const cards = [
    ...ordered.filter((x) => x !== expanded).map((x) => runningCard(x.s, x.needs, state.server)),
    ...state.starting.map(startingCard),
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
  const empty = liveCount === 0 && ended.length === 0;
  const days = byDay(shown, now, ended);
  if (earlier > 0) {
    days.at(-1)?.items.push({
      icon: "…",
      text: `${earlier} earlier`,
      action: { type: "history-open" },
    });
  }

  return {
    view: "board",
    title: "Swarms",
    ...(status ? { header: { status, ...(segments.length > 0 ? { segments } : {}) } } : {}),
    sections: [
      ...(needs.length > 0
        ? [
            {
              kind: "cards" as const,
              title:
                needs.length > NEEDS_SHOWN
                  ? `Needs you · ${needs.length} · oldest ${NEEDS_SHOWN} shown`
                  : "Needs you",
              items: needs.slice(0, NEEDS_SHOWN).map((x) => needCard(x.s, x.n, state.server)),
            },
          ]
        : []),
      ...(live.length >= 2
        ? [
            {
              kind: "actions" as const,
              title: `Live · ${live.length}`,
              wrap: true,
              items: ordered.map((x) => ({
                type: "select-swarm",
                label: `${firstLine(x.s.task, 28)} · ${x.s.id}`,
                hint: `Expand ${x.s.id} on the page. This choice is shared by every viewer.`,
                payload: { id: x.s.id },
                ...(x.needs.length ? { tone: "caution" as const } : {}),
                ...(x === expanded ? { selected: true } : {}),
              })),
            },
          ]
        : []),
      ...(expanded
        ? buildCockpit(expanded.s, expanded.needs, {
            server: state.server,
            titled: live.length < 2,
            now,
            selectedAgentId: state.selectedAgents?.get(expanded.s.id),
          })
        : []),
      ...(cards.length > 0 ? [{ kind: "cards" as const, title: "Also live", items: cards }] : []),
      ...days,
      ...(empty
        ? [
            {
              kind: "journey" as const,
              items: [
                { title: "Start a swarm", text: "Name the task above and pick a size." },
                {
                  title: "Agents work it out",
                  text: "The lead spawns workers, and they talk it through in #swarm-<id>.",
                },
                {
                  title: "The lead concludes here",
                  text: "The answer and its report land on this tab.",
                },
              ],
            },
          ]
        : []),
      { kind: "rows", items: [serverRow(state.server, state.op, liveCount)] },
    ],
  };
}

export function buildHistory(state: SurfaceState, now = new Date()): CanvasBoardView {
  const ended = [...state.ended].reverse();
  return {
    view: "board",
    title: "Ended swarms",
    header: { chip: `${ended.length} kept` },
    sections:
      ended.length > 0
        ? byDay(ended, now)
        : [{ kind: "rows", items: [{ icon: "◌", text: "No ended swarms yet." }] }],
  };
}
