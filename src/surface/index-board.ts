// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasActionItem, CanvasBoardView, RibSurfaceBadge } from "@keelson/shared";
import { modelLabel } from "../labels.ts";
import { type Need, needsYou, oldestNeed } from "../needs.ts";
import { type StartingSwarm, type SwarmStatus, type SwarmSummary, sizeOf } from "../types.ts";
import {
  activityText,
  channelHref,
  day,
  firstLine,
  firstPr,
  hhmm,
  prLabel,
  shortHandle,
  shortRun,
  span,
} from "./format.ts";
import { endedOutcome, needReason, openHint, type ServerLine } from "./parts.ts";

export interface SurfaceState {
  live: readonly SwarmSummary[];
  starting: readonly StartingSwarm[];
  // Oldest first, as the rib keeps them.
  ended: readonly SwarmSummary[];
  server?: ServerLine;
}

type Card = Extract<CanvasBoardView["sections"][number], { kind: "cards" }>["items"][number];
type Row = Extract<CanvasBoardView["sections"][number], { kind: "rows" }>["items"][number];

export const ENDED_SHOWN = 8;

export const STATUS_GLYPH: Record<SwarmStatus, { icon: string; tone: Row["glyph"] }> = {
  running: { icon: "●", tone: "info" },
  done: { icon: "✓", tone: "ok" },
  stopped: { icon: "■", tone: "neutral" },
  stalled: { icon: "◌", tone: "warn" },
  exhausted: { icon: "◔", tone: "warn" },
  error: { icon: "✕", tone: "error" },
};

// One line on what the swarm is doing, when nothing needs the operator.
function statusReason(s: SwarmSummary): Card["reason"] | undefined {
  const gated = s.runs?.find((r) => r.status === "paused" && r.pendingApproval);
  if (gated?.pendingApproval) {
    return {
      label: "gate",
      text: `${gated.pendingApproval.nodeId} on ${gated.workflow} ${shortRun(gated.runId)}, in peer review since ${hhmm(gated.pendingApproval.openedAt)}`,
    };
  }
  const h = s.health;
  if (h?.channelFault) return { label: "ClickClack", text: h.channelFault };
  if (h?.lastLeadFailure) return { label: "lead", text: `last turn failed: ${h.lastLeadFailure}` };
  if (h?.nudges) {
    return { label: "idle", text: `nudged the lead ${h.nudges} of ${s.limits.maxNudges} times` };
  }
  const last = s.activity?.at(-1);
  if (last) return { label: hhmm(last.at), text: firstLine(activityText(s.id, last.text), 120) };
  return undefined;
}

function stopAction(s: SwarmSummary): CanvasActionItem {
  const live = (s.runs ?? []).filter((r) => r.status === "running" || r.status === "paused");
  return {
    type: "stop-swarm",
    label: "Stop swarm…",
    destructive: true,
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

function liveCard(s: SwarmSummary, needs: readonly Need[]): Card {
  const first = needs[0];
  const pr = firstPr(s);
  const reason = first ? needReason(s, first) : statusReason(s);
  const href = channelHref(s);
  return {
    title: `${firstLine(s.task)} · ${s.id}`,
    pill: first ? { label: "needs you", tone: "caution" } : { label: "running", tone: "info" },
    bar: { value: s.turnsUsed, total: s.limits.maxTurns },
    fields: [
      { label: "channel", value: `#${s.channelName}`, ...(href ? { href } : {}) },
      ...(s.agents.length > 0
        ? [
            {
              label: "with",
              people: s.agents.map((a) => ({ name: shortHandle(a.handle, s.id), tone: a.tone })),
            },
          ]
        : []),
      ...(s.project ? [{ label: "on", value: s.project.name }] : []),
      { label: "size", value: s.size },
      { label: "model", value: modelLabel(s) },
      { label: "started", value: hhmm(s.startedAt) },
      ...(pr ? [{ label: "PR", value: prLabel(pr), href: pr }] : []),
    ],
    ...(reason ? { reason } : {}),
    actions: [
      {
        type: "swarm-open",
        label: "Open",
        glyph: "→",
        payload: { id: s.id },
        hint: openHint(s),
      },
      ...(s.report
        ? [
            {
              type: "open-report",
              label: "Report",
              glyph: "◧",
              payload: { id: s.id },
              hint: s.report.title,
            },
          ]
        : []),
      stopAction(s),
    ],
  };
}

function startingCard(s: StartingSwarm): Card {
  const shape = { ...s, size: sizeOf(s.limits, s.sizeBase), agents: [] };
  return {
    title: `${firstLine(s.task)} · ${s.id}`,
    pill: { label: "starting", tone: "neutral" },
    fields: [
      ...(s.project ? [{ label: "on", value: s.project.name }] : []),
      { label: "size", value: shape.size },
      { label: "model", value: modelLabel(shape) },
      { label: "started", value: hhmm(s.startedAt) },
    ],
    reason: { label: "starting", text: "Creating the channel and the lead." },
    actions: [
      {
        type: "swarm-open",
        label: "Open",
        glyph: "→",
        payload: { id: s.id },
        hint: openHint(shape),
      },
    ],
  };
}

export function endedRow(s: SwarmSummary): Row {
  const g = STATUS_GLYPH[s.status];
  const took = span(s.startedAt, s.endedAt);
  const end = took ? ` · ${took}` : "";
  return {
    icon: g.icon,
    glyph: g.tone,
    text: `${s.id} ${firstLine(s.task, 64)} · ${modelLabel(s)}`,
    trailing: `${day(s.startedAt)} ${hhmm(s.startedAt)}${end} · ${endedOutcome(s)}${s.report ? " · ◧ report" : ""}`,
    action: { type: "swarm-open", payload: { id: s.id } },
  };
}

function serverRow(server: ServerLine | undefined): Row | undefined {
  if (!server) return undefined;
  if (!server.running || !server.url) {
    return server.mode === "managed"
      ? { icon: "◌", text: "ClickClack is stopped; the next swarm starts it managed" }
      : { icon: "◌", glyph: "warn", text: "ClickClack is not reachable", trailing: "external" };
  }
  return {
    icon: "↗",
    text: `ClickClack at ${server.url.replace(/^https?:\/\//, "")}`,
    href: `${server.url}/app`,
    trailing: server.mode,
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
    ...needing.map((x) => liveCard(x.s, x.needs)),
    ...state.starting.map(startingCard),
    ...running.map((x) => liveCard(x.s, x.needs)),
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
  const server = serverRow(state.server);
  const empty = cards.length === 0 && ended.length === 0;

  return {
    view: "board",
    title: "Swarms",
    ...(status ? { header: { status } } : {}),
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
      ...(empty ? [{ kind: "rows" as const, items: [{ icon: "◌", text: "No swarms yet." }] }] : []),
      ...(server ? [{ kind: "rows" as const, items: [server] }] : []),
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
