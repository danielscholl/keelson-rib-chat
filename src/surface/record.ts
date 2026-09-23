// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { DESIGN_TOKENS, designTokenCssBlock } from "@keelson/shared";
import { freshTokens, modelLabel, tokenCount } from "../labels.ts";
import {
  type ActivityEntry,
  type AgentTone,
  type ChildRun,
  isLive,
  type SwarmSummary,
  type TurnSpan,
} from "../types.ts";
import { day, firstLine, hhmm, plural, shortHandle, shortRun, span } from "./format.ts";
import { LIFECYCLE, sizeWord } from "./parts.ts";

// The record: a drawing of one swarm the rib composes as an html view. The host
// wraps it in its own document, stamps the theme, and refuses anything the frame
// posts back, so it carries no script and no controls; the board keeps the verbs.
// Every string from the summary is escaped, and none reaches an attribute other
// than a title's text.

type Agent = SwarmSummary["agents"][number];

const W = 720;
const GUTTER = 112;
const RIGHT = 12;
const PLOT = W - GUTTER - RIGHT;
const LANE = 16;
const GAP = 6;
const AXIS = 22;
const DIVIDER = 10;
const MIN_SPAN = 1.5;
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 240];
const MAX_TICKS = 8;
const MINUTE = 60_000;
const NODE_W = 96;
const NODE_H = 26;
const LAYER = 84;
const PER_ROW = 6;
const MAX_EDGES = 40;

const TONE_CLASS: Record<AgentTone, string> = {
  brand: "brand",
  "id-blue": "idb",
  "id-amber": "ida",
  "id-teal": "idt",
  "id-rose": "idr",
  "id-olive": "ido",
  neutral: "neu",
};

const RUN_CLASS: Record<ChildRun["status"], string> = {
  running: "info",
  paused: "caution",
  succeeded: "good",
  failed: "crit",
  cancelled: "neu",
};

// The glyph an event leaves on the timeline, and the lane it sits on.
const MARKS: Partial<Record<NonNullable<ActivityEntry["kind"]>, string>> = {
  ask: "?",
  answer: "▲",
  operator: "▲",
  report: "▪",
  conclusion: "●",
  nudge: "◌",
  cap: "✕",
  retire: "✕",
};

export function esc(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function cut(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function num(n: number): string {
  return String(Math.round(n * 10) / 10);
}

function ok(...ns: number[]): boolean {
  return ns.every(Number.isFinite);
}

function when(iso: string | undefined): number {
  return iso ? Date.parse(iso) : Number.NaN;
}

function identityCss(): string {
  const vars = (theme: "dark" | "light") =>
    Object.entries(DESIGN_TOKENS[theme].identity)
      .map(([k, v]) => `--id-${k}: ${v};`)
      .join(" ");
  return `:root { ${vars("dark")} }\n:root[data-theme="light"] { ${vars("light")} }`;
}

const PAGE_CSS = `
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 20px 16px 28px; }
h1 { font-size: 18px; line-height: 1.35; margin: 2px 0 6px; color: var(--fg-strong); font-weight: 600; }
h2 { font-size: 12px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted);
  margin: 26px 0 8px; font-weight: 600; }
h3 { font-size: 14px; margin: 0 0 4px; color: var(--fg-strong); font-weight: 600; }
p { margin: 0 0 6px; }
code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.eyebrow { font-size: 12px; color: var(--muted); letter-spacing: .04em; margin: 0; }
.meta, .note { color: var(--muted); font-size: 12.5px; }
.scroll { overflow-x: auto; }
svg { display: block; width: 100%; min-width: 640px; height: auto; }
svg text { font: 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif; fill: var(--muted); }
svg .lane { stroke: var(--border); stroke-width: 1; }
svg .tick { stroke: var(--border); stroke-dasharray: 2 3; }
svg .now { stroke: var(--accent); stroke-width: 1.5; }
svg .endrule { stroke: var(--muted); stroke-width: 1; }
svg .lbl { font-size: 11.5px; fill: var(--fg); }
svg .mk { font-size: 12px; fill: var(--fg-strong); text-anchor: middle;
  paint-order: stroke; stroke: var(--bg); stroke-width: 3px; stroke-linejoin: round; }
svg .hatch { fill: url(#hatch); }
svg .hatchline { stroke: var(--crit); stroke-width: 1.2; }
svg .open { stroke: var(--fg); stroke-dasharray: 2 2; stroke-width: 1; }
svg .edge { stroke: var(--muted); fill: none; opacity: .75; }
svg .asked { stroke-dasharray: 4 3; }
svg .arrow { fill: var(--muted); }
svg .node { fill: var(--card); stroke-width: 1.5; }
svg .nodet { font-size: 11.5px; text-anchor: middle; fill: var(--fg-strong); }
svg .count { font-size: 10.5px; fill: var(--fg);
  paint-order: stroke; stroke: var(--bg); stroke-width: 3px; stroke-linejoin: round; }
.t-brand { fill: var(--accent); } .t-idb { fill: var(--id-blue); } .t-ida { fill: var(--id-amber); }
.t-idt { fill: var(--id-teal); } .t-idr { fill: var(--id-rose); } .t-ido { fill: var(--id-olive); }
.t-neu { fill: var(--muted); } .t-good { fill: var(--good); } .t-crit { fill: var(--crit); }
.t-info { fill: var(--info); } .t-caution { fill: var(--warn); }
.s-brand { stroke: var(--accent); } .s-idb { stroke: var(--id-blue); } .s-ida { stroke: var(--id-amber); }
.s-idt { stroke: var(--id-teal); } .s-idr { stroke: var(--id-rose); } .s-ido { stroke: var(--id-olive); }
.s-neu { stroke: var(--muted); }
.c-brand { color: var(--accent); } .c-idb { color: var(--id-blue); } .c-ida { color: var(--id-amber); }
.c-idt { color: var(--id-teal); } .c-idr { color: var(--id-rose); } .c-ido { color: var(--id-olive); }
.c-neu { color: var(--muted); }
.spend + .note { margin-top: 8px; }
.spend { display: grid; grid-template-columns: max-content 1fr auto; gap: 6px 10px; align-items: center; }
.spend > span:first-child, .spend > .mono { white-space: nowrap; }
.bar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; background: var(--card-2); }
.bar i { display: block; height: 100%; }
.bar .fresh { background: var(--accent); } .bar .cached { background: var(--accent); opacity: .35; }
.run { border: 1px solid var(--border); border-radius: 8px; background: var(--card); padding: 10px 12px; margin: 0 0 8px; }
.run dl { display: grid; grid-template-columns: 88px 1fr; gap: 2px 10px; margin: 6px 0 0; font-size: 12.5px; }
.run dt { color: var(--muted); } .run dd { margin: 0; overflow-wrap: anywhere; }
.pill { font-size: 11px; border: 1px solid var(--border); border-radius: 10px; padding: 0 7px; margin-left: 6px;
  color: var(--muted); font-weight: 500; }
.error { color: var(--crit); }
table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
th { text-align: left; color: var(--muted); font-weight: 500; padding: 4px 8px 4px 0; border-bottom: 1px solid var(--border); }
td { padding: 4px 8px 4px 0; border-bottom: 1px solid var(--border); vertical-align: top; overflow-wrap: anywhere; }
footer { margin-top: 26px; color: var(--muted); font-size: 12px; border-top: 1px solid var(--border); padding-top: 10px; }
`;

function handleOf(s: SwarmSummary, id: string): string {
  if (id === "operator") return "you";
  const a = s.agents.find((x) => x.id === id);
  return a ? `@${shortHandle(a.handle, s.id)}` : id;
}

// ---- The timeline: a lane per agent, the operator above, the runs below. ----

interface Frame {
  t0: number;
  t1: number;
  now?: number;
  deadline: number;
}

function frameOf(s: SwarmSummary, composedAt: Date): Frame {
  const t0 = Date.parse(s.startedAt);
  const deadline = t0 + s.limits.wallClockMs;
  if (isLive(s.status) || !s.endedAt) {
    const now = Math.max(t0, composedAt.getTime());
    const elapsed = now - t0;
    const t1 = Math.max(
      now + MINUTE,
      Math.min(deadline, Math.max(now + elapsed / 4, t0 + 10 * MINUTE)),
    );
    return { t0, t1, now, deadline };
  }
  const ends = [
    when(s.endedAt),
    ...(s.spans ?? []).map((t) => when(t.endedAt)),
    ...(s.runs ?? []).map((r) => when(r.completedAt)),
  ].filter(Number.isFinite);
  return { t0, t1: Math.max(t0 + MINUTE, ...ends), deadline };
}

function xOf(f: Frame, t: number): number {
  const clamped = Math.min(f.t1, Math.max(f.t0, t));
  return GUTTER + (PLOT * (clamped - f.t0)) / (f.t1 - f.t0);
}

function ticks(f: Frame): string {
  const minutes = (f.t1 - f.t0) / MINUTE;
  const step = TICK_STEPS.find((m) => minutes / m <= MAX_TICKS) ?? 480;
  const out: string[] = [];
  for (let m = 0; m <= minutes; m += step) {
    const x = xOf(f, f.t0 + m * MINUTE);
    const anchor = m === 0 ? "start" : x > W - RIGHT - 24 ? "end" : "middle";
    out.push(`<text x="${num(x)}" y="12" text-anchor="${anchor}">${m} min</text>`);
  }
  return out.join("");
}

interface Lane {
  kind: "operator" | "agent" | "run";
  id: string;
  label: string;
  cls: string;
}

function lanes(s: SwarmSummary): Lane[] {
  const first = new Map<string, number>();
  for (const t of s.spans ?? []) {
    if (!first.has(t.agentId)) first.set(t.agentId, when(t.startedAt));
  }
  const order = (a: Agent) => first.get(a.id) ?? when(a.joinedAt) ?? Number.POSITIVE_INFINITY;
  const agents = [...s.agents].sort((a, b) => {
    const d = (order(a) || 0) - (order(b) || 0);
    return Number.isFinite(d) && d !== 0 ? d : Number(b.lead) - Number(a.lead);
  });
  return [
    { kind: "operator", id: "operator", label: "you", cls: "neu" },
    ...agents.map((a) => ({
      kind: "agent" as const,
      id: a.id,
      label: cut(`@${shortHandle(a.handle, s.id)}`, 16),
      cls: TONE_CLASS[a.tone] ?? "neu",
    })),
    ...(s.runs ?? []).map((r) => ({
      kind: "run" as const,
      id: r.runId,
      label: cut(`${r.workflow} ${shortRun(r.runId)}`, 18),
      cls: RUN_CLASS[r.status] ?? "neu",
    })),
  ];
}

function laneY(all: readonly Lane[], i: number): number {
  const runsBefore = all.slice(0, i).some((l) => l.kind === "run") || all[i]?.kind === "run";
  return AXIS + i * (LANE + GAP) + (runsBefore ? DIVIDER : 0);
}

function spanTitle(s: SwarmSummary, t: TurnSpan): string {
  const took = span(t.startedAt, t.endedAt);
  const by = t.wokeBy.map((w) =>
    w === "rib"
      ? "the task"
      : w === "runs"
        ? "a run update"
        : w === "nudge"
          ? "a nudge"
          : handleOf(s, w),
  );
  return cut(
    `${handleOf(s, t.agentId)} turn ${t.n} · ${t.outcome ?? "running"}${took ? ` · ${took}` : ""}${by.length ? ` · woken by ${by.join(", ")}` : ""}`,
    80,
  );
}

function mark(x: number, y: number, glyph: string, title: string): string {
  if (!ok(x, y)) return "";
  return `<text class="mk" x="${num(x)}" y="${num(y)}"><title>${esc(cut(title, 80))}</title>${glyph}</text>`;
}

function timeline(s: SwarmSummary, composedAt: Date): string {
  const f = frameOf(s, composedAt);
  const all = lanes(s);
  const index = new Map(all.map((l, i) => [l.id, i]));
  const height = laneY(all, all.length - 1) + LANE + GAP + 4;
  const mid = (i: number) => laneY(all, i) + LANE / 2 + 4;
  const parts: string[] = [];

  parts.push(
    `<defs><pattern id="hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line class="hatchline" x1="0" y1="0" x2="0" y2="4"/></pattern></defs>`,
  );
  parts.push(ticks(f));
  all.forEach((l, i) => {
    const y = laneY(all, i);
    parts.push(
      `<line class="lane" x1="${GUTTER}" y1="${y + LANE}" x2="${W - RIGHT}" y2="${y + LANE}"/>`,
      `<text class="lbl ${l.kind === "agent" ? `t-${l.cls}` : ""}" x="${GUTTER - 8}" y="${mid(i)}" text-anchor="end">${esc(l.label)}</text>`,
    );
  });

  const end = f.now ?? f.t1;
  for (const t of s.spans ?? []) {
    const i = index.get(t.agentId);
    const agent = s.agents.find((a) => a.id === t.agentId);
    const a = when(t.startedAt);
    const b = t.endedAt ? when(t.endedAt) : end;
    if (i === undefined || !ok(a, b)) continue;
    const x = xOf(f, a);
    const w = Math.max(MIN_SPAN, xOf(f, b) - x);
    const y = laneY(all, i) + 2;
    const cls = TONE_CLASS[agent?.tone ?? "neutral"] ?? "neu";
    const title = `<title>${esc(spanTitle(s, t))}</title>`;
    parts.push(
      `<rect class="t-${cls}${t.endedAt ? "" : " open"}" x="${num(x)}" y="${y}" width="${num(w)}" height="${LANE - 4}" rx="2">${title}</rect>`,
    );
    if (t.outcome === "timeout" || t.outcome === "error") {
      parts.push(
        `<rect class="hatch" x="${num(x)}" y="${y}" width="${num(w)}" height="${LANE - 4}" rx="2">${title}</rect>`,
      );
    }
  }

  for (const r of s.runs ?? []) {
    const i = index.get(r.runId);
    if (i === undefined) continue;
    const a = when(r.startedAt);
    const b = r.completedAt ? when(r.completedAt) : isLive(s.status) ? end : when(s.endedAt);
    if (!ok(a, b)) continue;
    const x = xOf(f, a);
    const w = Math.max(MIN_SPAN, xOf(f, b) - x);
    const y = laneY(all, i) + 4;
    const title = `${r.workflow} ${shortRun(r.runId)} · ${r.status}${r.completedAt ? ` · ${span(r.startedAt, r.completedAt)}` : ""}`;
    parts.push(
      `<rect class="t-${RUN_CLASS[r.status] ?? "neu"}${r.completedAt ? "" : " open"}" x="${num(x)}" y="${y}" width="${num(w)}" height="${LANE - 8}" rx="2" opacity=".8"><title>${esc(cut(title, 80))}</title></rect>`,
    );
    for (const g of r.gates ?? []) {
      parts.push(
        mark(xOf(f, when(g.openedAt)), mid(i), "◇", `${g.nodeId} opened ${hhmm(g.openedAt)}`),
      );
      if (g.closedAt) {
        const by =
          g.by === "swarm"
            ? "answered by the swarm"
            : g.by === "operator"
              ? "answered by you"
              : "closed";
        parts.push(
          mark(xOf(f, when(g.closedAt)), mid(i), "◆", `${g.nodeId} ${by} ${hhmm(g.closedAt)}`),
        );
      }
    }
    if (r.verified && r.completedAt) {
      parts.push(
        mark(
          xOf(f, when(r.completedAt)),
          mid(i),
          "✓",
          `${r.workflow} verified ${hhmm(r.completedAt)}`,
        ),
      );
    }
  }

  for (const a of s.agents) {
    const i = index.get(a.id);
    if (i === undefined || !a.joinedAt || !a.spawnedBy) continue;
    parts.push(
      mark(
        xOf(f, when(a.joinedAt)),
        mid(i),
        "○",
        `${handleOf(s, a.id)} spawned by ${handleOf(s, a.spawnedBy)} ${hhmm(a.joinedAt)}`,
      ),
    );
  }

  for (const e of s.activity ?? []) {
    const glyph = e.kind ? MARKS[e.kind] : undefined;
    if (!glyph) continue;
    const onLane = e.kind === "nudge" ? e.subject : e.kind === "answer" ? "operator" : e.actor;
    const i = onLane ? index.get(onLane) : undefined;
    if (i === undefined) continue;
    parts.push(
      mark(
        xOf(f, when(e.at)),
        mid(i),
        glyph,
        `${hhmm(e.at)} ${e.text.replaceAll(`@${s.id}-`, "@")}`,
      ),
    );
  }

  if (f.now !== undefined) {
    const x = num(xOf(f, f.now));
    parts.push(
      `<line class="now" x1="${x}" y1="${AXIS - 4}" x2="${x}" y2="${height - 4}"/>`,
      `<text x="${x}" y="${height + 8}" text-anchor="middle" fill="currentColor">now ${hhmm(new Date(f.now).toISOString())}</text>`,
    );
    if (f.t1 < f.deadline) {
      parts.push(
        `<text x="${W - RIGHT}" y="${height + 8}" text-anchor="end">ends ${hhmm(new Date(f.deadline).toISOString())} →</text>`,
      );
    }
  } else if (s.endedAt) {
    const x = num(xOf(f, when(s.endedAt)));
    parts.push(
      `<line class="endrule" x1="${x}" y1="${AXIS - 4}" x2="${x}" y2="${height - 4}"/>`,
      `<text x="${x}" y="${height + 8}" text-anchor="end">ended ${hhmm(s.endedAt)}</text>`,
    );
  }

  const svg = `<svg viewBox="0 0 ${W} ${height + 14}" role="img" aria-label="Timeline: turns by agent and runs over time">${parts.join("")}</svg>`;
  const legend =
    "Bars are turns in each agent's color, hatched when a turn timed out or failed, dashed while running. ○ spawned · ? asked you · ▲ you · ▪ report · ● conclusion · ◇ gate opened · ◆ gate answered · ✓ verified.";
  const missing = s.spans?.length
    ? ""
    : `<p class="note">This swarm was recorded before turns were kept, so the lanes carry its events and runs only.</p>`;
  return `<section><h2>Timeline</h2>${missing}<div class="scroll">${svg}</div><p class="note">${legend}</p></section>`;
}

// ---- Who woke whom: agents as nodes, edges for spawns, wakes and questions. ----

interface Edge {
  from: string;
  to: string;
  kind: "spawned" | "woke" | "asked";
  n: number;
  // On a spawn: the turns the spawner went on to wake, drawn on the same arrow.
  woke?: number;
}

function edges(s: SwarmSummary): Edge[] {
  const ids = new Set(s.agents.map((a) => a.id));
  const counted = new Map<string, Edge>();
  const add = (from: string, to: string, kind: Edge["kind"]) => {
    const key = `${kind}:${from}:${to}`;
    const held = counted.get(key);
    if (held) held.n++;
    else counted.set(key, { from, to, kind, n: 1 });
  };
  for (const a of s.agents)
    if (a.spawnedBy && ids.has(a.spawnedBy)) add(a.spawnedBy, a.id, "spawned");
  for (const t of s.spans ?? []) {
    for (const w of t.wokeBy) {
      if (w === t.agentId) continue;
      if (ids.has(w) || w === "operator" || w === "runs") add(w, t.agentId, "woke");
    }
  }
  for (const e of s.activity ?? []) {
    if (e.kind === "ask" && e.actor && ids.has(e.actor)) add(e.actor, "operator", "asked");
  }
  for (const spawned of counted.values()) {
    if (spawned.kind !== "spawned") continue;
    const key = `woke:${spawned.from}:${spawned.to}`;
    const woke = counted.get(key);
    if (!woke) continue;
    spawned.woke = woke.n;
    counted.delete(key);
  }
  return [...counted.values()].sort((a, b) => b.n - a.n).slice(0, MAX_EDGES);
}

interface Placed {
  id: string;
  label: string;
  cls: string;
  x: number;
  y: number;
}

function place(s: SwarmSummary, graphEdges: readonly Edge[]): Placed[] {
  const depth = new Map<string, number>();
  const byId = new Map(s.agents.map((a) => [a.id, a]));
  const depthOf = (id: string, seen: Set<string>): number => {
    const held = depth.get(id);
    if (held !== undefined) return held;
    const a = byId.get(id);
    if (!a || a.lead) return 0;
    const parent = a.spawnedBy;
    if (!parent || !byId.has(parent) || seen.has(parent)) return 1;
    seen.add(id);
    return depthOf(parent, seen) + 1;
  };
  for (const a of s.agents) depth.set(a.id, depthOf(a.id, new Set()));
  const extras = [
    ...(graphEdges.some((e) => e.from === "operator" || e.to === "operator") ? ["operator"] : []),
    ...(graphEdges.some((e) => e.from === "runs") ? ["runs"] : []),
  ];
  const layers = new Map<number, string[]>();
  const agentsInOrder = [...s.agents].sort(
    (a, b) => (when(a.joinedAt) || 0) - (when(b.joinedAt) || 0) || Number(b.lead) - Number(a.lead),
  );
  for (const a of agentsInOrder) {
    const d = depth.get(a.id) ?? 1;
    layers.set(d, [...(layers.get(d) ?? []), a.id]);
  }
  const top = layers.get(0) ?? [];
  if (extras.includes("operator")) top.unshift("operator");
  if (extras.includes("runs")) top.push("runs");
  layers.set(0, top);

  const placed = new Map<string, Placed>();
  let y = 16;
  for (const d of [...layers.keys()].sort((a, b) => a - b)) {
    const ids = layers.get(d) ?? [];
    if (d > 0) {
      const parentX = (id: string) => placed.get(byId.get(id)?.spawnedBy ?? "")?.x ?? W / 2;
      ids.sort((a, b) => parentX(a) - parentX(b));
    }
    for (let row = 0; row * PER_ROW < ids.length; row++) {
      const chunk = ids.slice(row * PER_ROW, row * PER_ROW + PER_ROW);
      chunk.forEach((id, i) => {
        const a = byId.get(id);
        placed.set(id, {
          id,
          label:
            id === "operator"
              ? "you"
              : id === "runs"
                ? "runs"
                : cut(`@${shortHandle(a?.handle ?? id, s.id)}`, 14),
          cls: a ? (TONE_CLASS[a.tone] ?? "neu") : "neu",
          x: ((i + 1) * W) / (chunk.length + 1),
          y,
        });
      });
      y += row * PER_ROW + PER_ROW < ids.length ? 34 : LAYER;
    }
  }
  return [...placed.values()];
}

function whoWokeWhom(s: SwarmSummary): string {
  const graphEdges = edges(s);
  if (graphEdges.length === 0) {
    return `<section><h2>Who woke whom</h2><p class="note">No agent woke another.</p></section>`;
  }
  const nodes = place(s, graphEdges);
  const at = new Map(nodes.map((n) => [n.id, n]));
  const height = Math.max(...nodes.map((n) => n.y)) + NODE_H + 18;
  const parts: string[] = [
    `<defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arrow" d="M0 0L8 4L0 8z"/></marker></defs>`,
  ];
  for (const e of graphEdges) {
    const a = at.get(e.from);
    const b = at.get(e.to);
    if (!a || !b) continue;
    const x1 = a.x;
    const y1 = a.y + NODE_H / 2;
    const x2 = b.x;
    const y2 = b.y + NODE_H / 2;
    if (!ok(x1, y1, x2, y2)) continue;
    const width = e.kind === "spawned" ? 1.2 : 1 + Math.min(3, Math.log2(e.n));
    const label =
      e.kind === "spawned"
        ? e.woke
          ? `×${e.woke}`
          : ""
        : e.kind === "woke"
          ? `×${e.n}`
          : `asked ×${e.n}`;
    if (e.kind === "spawned") {
      const sy = a.y + NODE_H;
      const ty = b.y;
      parts.push(
        `<line class="edge" x1="${num(x1)}" y1="${num(sy)}" x2="${num(x2)}" y2="${num(ty)}" stroke-width="${num(width)}" marker-end="url(#arrow)"/>`,
        ...(label
          ? [
              `<text class="count" x="${num((x1 + x2) / 2 + 4)}" y="${num((sy + ty) / 2)}">${label}</text>`,
            ]
          : []),
      );
      continue;
    }
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.max(1, Math.hypot(dx, dy));
    const bend = e.from < e.to ? 18 : -18;
    const cx = (x1 + x2) / 2 + (-dy / len) * bend;
    const cy = (y1 + y2) / 2 + (dx / len) * bend;
    const shrink = (x: number, y: number, towardX: number, towardY: number) => {
      const l = Math.max(1, Math.hypot(towardX - x, towardY - y));
      return [
        x + ((towardX - x) / l) * (NODE_W / 2 - 4),
        y + ((towardY - y) / l) * (NODE_H / 2 + 2),
      ];
    };
    const [sx, sy] = shrink(x1, y1, cx, cy);
    const [tx, ty] = shrink(x2, y2, cx, cy);
    if (!ok(sx ?? Number.NaN, sy ?? Number.NaN, tx ?? Number.NaN, ty ?? Number.NaN, cx, cy))
      continue;
    const mx = 0.25 * (sx as number) + 0.5 * cx + 0.25 * (tx as number);
    const my = 0.25 * (sy as number) + 0.5 * cy + 0.25 * (ty as number);
    parts.push(
      `<path class="edge${e.kind === "asked" ? " asked" : ""}" d="M${num(sx as number)} ${num(sy as number)}Q${num(cx)} ${num(cy)} ${num(tx as number)} ${num(ty as number)}" stroke-width="${num(width)}" marker-end="url(#arrow)"/>`,
      `<text class="count" x="${num(mx)}" y="${num(my - 3)}" text-anchor="middle">${label}</text>`,
    );
  }
  for (const n of nodes) {
    parts.push(
      `<rect class="node s-${n.cls}" x="${num(n.x - NODE_W / 2)}" y="${num(n.y)}" width="${NODE_W}" height="${NODE_H}" rx="13"/>`,
      `<text class="nodet" x="${num(n.x)}" y="${num(n.y + NODE_H / 2 + 4)}">${esc(n.label)}</text>`,
    );
  }
  const svg = `<svg viewBox="0 0 ${W} ${num(height)}" role="img" aria-label="Who woke whom">${parts.join("")}</svg>`;
  return `<section><h2>Who woke whom</h2><div class="scroll">${svg}</div><p class="note">A straight arrow is a spawn; a curve counts the turns one side's messages or run updates started (×n); a dashed curve is a question to you. The task's kickoff and idle nudges are left out.</p></section>`;
}

// ---- Spend, runs, and the evidence the agents were given. ----

function spend(s: SwarmSummary): string {
  const rows = s.agents.filter((a) => a.usage);
  if (rows.length === 0) return "";
  const most = Math.max(
    1,
    ...rows.map((a) => (a.usage ? freshTokens(a.usage) + a.usage.cached : 0)),
  );
  const items = rows.map((a) => {
    const u = a.usage as NonNullable<Agent["usage"]>;
    const fresh = freshTokens(u);
    return `<span class="mono c-${TONE_CLASS[a.tone] ?? "neu"}">@${esc(cut(shortHandle(a.handle, s.id), 14))}</span><span class="bar"><i class="fresh" style="width:${num((100 * fresh) / most)}%"></i><i class="cached" style="width:${num((100 * u.cached) / most)}%"></i></span><span class="mono">${tokenCount(fresh)} fresh · ${tokenCount(u.cached)} cached</span>`;
  });
  return `<section><h2>Spend by agent</h2><div class="spend">${items.join("")}</div><p class="note">Fresh tokens, then cached tokens after them in a lighter bar; the two are never summed.</p></section>`;
}

function runBlock(s: SwarmSummary, r: ChildRun): string {
  const took = span(r.startedAt, r.completedAt);
  const rows: [string, string][] = [
    ["for", esc(cut(r.purpose, 300))],
    [
      "worked in",
      r.checkout?.branch
        ? `<code>${esc(cut(r.checkout.branch, 120))}</code>`
        : r.isolated
          ? "an isolated worktree, not yet made"
          : "the live checkout",
    ],
    ...(r.prUrls.length > 0
      ? [
          [
            "pull requests",
            r.prUrls.map((u) => `<code>${esc(cut(u, 120))}</code>`).join("<br>"),
          ] as [string, string],
        ]
      : []),
    [
      "CI",
      r.ci
        ? esc(cut(`${r.ci.verdict}${r.ci.detail ? `: ${r.ci.detail}` : ""}`, 300))
        : "not reported",
    ],
    [
      "steps",
      `${r.nodesDone} done${r.lastNode ? `, last <code>${esc(cut(r.lastNode, 60))}</code>` : ""}`,
    ],
    [
      "took",
      took
        ? `${took}, ${hhmm(r.startedAt)} to ${hhmm(r.completedAt)}`
        : `since ${hhmm(r.startedAt)}`,
    ],
  ];
  const gates = (r.gates ?? []).map((g) => {
    const answer = [...(r.approvals ?? [])]
      .reverse()
      .find((a) => a.nodeId === g.nodeId && a.at >= g.openedAt);
    const who =
      g.by === "swarm"
        ? `answered by the swarm${answer ? ` (${answer.decision === "approve" ? "approved" : "changes asked"} on ${esc(handleOf(s, answer.reviewer.replace(/^@/, "")))}'s review)` : ""}`
        : g.by === "operator"
          ? "answered by you"
          : g.closedAt
            ? "closed when the run ended"
            : "open";
    const why = answer ? `<br><span class="meta">${esc(cut(answer.reason, 300))}</span>` : "";
    return `<code>${esc(cut(g.nodeId, 60))}</code> opened ${hhmm(g.openedAt)}${g.closedAt ? `, closed ${hhmm(g.closedAt)}` : ""}, ${who}${why}`;
  });
  if (gates.length > 0) rows.push(["gates", gates.join("<br>")]);
  const error = r.error ? `<p class="error">${esc(cut(firstLine(r.error, 300), 300))}</p>` : "";
  return `<article class="run"><h3>${esc(cut(r.workflow, 60))} <code>${esc(shortRun(r.runId))}</code><span class="pill">${esc(r.verified ? "verified" : r.status)}</span></h3><dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>${error}</article>`;
}

function runs(s: SwarmSummary): string {
  if (!s.runs?.length) return "";
  return `<section><h2>Runs</h2>${s.runs.map((r) => runBlock(s, r)).join("")}</section>`;
}

function evidence(s: SwarmSummary): string {
  if (!s.context?.length) return "";
  const rows = s.context.map(
    (c) =>
      `<tr><td><code>${esc(cut(c.id, 60))}</code></td><td>${esc(cut(c.kind, 30))}</td><td>${esc(cut(c.title, 120))}</td><td>${c.sourceUrl ? `<code>${esc(cut(c.sourceUrl, 120))}</code>` : "unattributed"}</td><td>${c.retrievedAt ? `${day(c.retrievedAt)} ${hhmm(c.retrievedAt)}` : ""}</td><td>${c.headSha ? `<code>${esc(c.headSha.slice(0, 7))}</code>` : ""}</td></tr>`,
  );
  return `<section><h2>Evidence given</h2><table><thead><tr><th>id</th><th>kind</th><th>title</th><th>source</th><th>retrieved</th><th>at</th></tr></thead><tbody>${rows.join("")}</tbody></table></section>`;
}

function header(s: SwarmSummary): string {
  const took = span(s.startedAt, s.endedAt);
  const facts = [
    LIFECYCLE[s.status].label,
    sizeWord(s),
    plural(s.turnsUsed, "turn"),
    ...(took ? [took] : []),
    modelLabel(s),
    `started ${day(s.startedAt)} ${hhmm(s.startedAt)}`,
    ...(s.rerunOf ? [`reruns ${s.rerunOf}`] : []),
  ];
  return `<header><p class="eyebrow">Swarm ${esc(s.id)} · record</p><h1>${esc(cut(firstLine(s.task, 1000), 160))}</h1><p class="meta">${esc(facts.join(" · "))}</p></header>`;
}

function provenance(s: SwarmSummary, composedAt: Date): string {
  const live = isLive(s.status);
  const window = `${day(s.startedAt)} ${hhmm(s.startedAt)} to ${live ? "now" : hhmm(s.endedAt)}`;
  const at = live ? `, composed ${hhmm(composedAt.toISOString())}` : "";
  return `<footer>From the swarm's summary${at}, covering ${esc(window)}. Marks come from the newest 200 events. Not on this page: the transcript, which is ClickClack's <code>#${esc(s.channelName || `swarm-${s.id}`)}</code>; the lead's report, which has its own page; and prices, which the summary does not carry.</footer>`;
}

export function buildRecord(s: SwarmSummary, composedAt: Date): string {
  const style = `<style>${designTokenCssBlock()}\n${identityCss()}\n${PAGE_CSS}</style>`;
  return `${style}<main>${header(s)}${timeline(s, composedAt)}${whoWokeWhom(s)}${spend(s)}${runs(s)}${evidence(s)}${provenance(s, composedAt)}</main>`;
}

export function buildGoneRecord(id: string): string {
  return `<style>${designTokenCssBlock()}\n${PAGE_CSS}</style><main><p class="eyebrow">Swarm ${esc(id)} · record</p><p>This swarm is no longer in the rib's history.</p></main>`;
}
