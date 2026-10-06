// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type {
  CanvasBoardView,
  CanvasGraphSection,
  CanvasTimelineSection,
  CanvasTimelineWindow,
  CanvasTone,
} from "@keelson/shared";
import { missingEvidence } from "../dispatch.ts";
import { freshTokens, modelLabel, tokenCount } from "../labels.ts";
import { type Need, needsYou } from "../needs.ts";
import type { StartSwarmInput } from "../tools.ts";
import {
  type AgentStatus,
  type ChildRun,
  type ChildRunStatus,
  isLive,
  type StartingSwarm,
  type SwarmSummary,
  sizeOf,
} from "../types.ts";
import { forecast, forecastDelta, PACE_WINDOW_MINUTES } from "./forecast.ts";
import {
  activityText,
  actorText,
  channelHref,
  day,
  firstLine,
  hhmm,
  messageLine,
  minutes,
  plain,
  plural,
  prLabel,
  prList,
  shortHandle,
  shortRun,
  span,
  threadHref,
} from "./format.ts";
import { runAgainItem } from "./launch-board.ts";
import {
  causeTitle,
  endsAt,
  gateIdentity,
  healthRows,
  LIFECYCLE,
  livePill,
  messageLead,
  openHint,
  type Request,
  replyAction,
  requestOf,
  type ServerLine,
  sinceClock,
  sizeWord,
  stateLine,
  stopAction,
} from "./parts.ts";
import { buildAgentEdges, buildTimelineModel } from "./record.ts";

type Section = CanvasBoardView["sections"][number];
type Leaf = Exclude<Section, { kind: "columns" }>;
type Card = Extract<Section, { kind: "cards" }>["items"][number];
type Row = Extract<Section, { kind: "rows" }>["items"][number];
type Stat = Extract<Section, { kind: "stats" }>["items"][number];
type Segment = Extract<NonNullable<Row["bar"]>, { segments: unknown }>["segments"][number];

// The conclusion on the board is a preview; the reading pane has all of it.
const PREVIEW_CHARS = 1_200;
// A row's disclosure holds this much; the task tool caps at 8,000.
export const DETAIL_CHARS = 4_000;
export const RECENT_SHOWN = 12;
export const CONVERSATION_SHOWN = 8;
const BENCH_COLUMNS = 4;

export const AGENT_PILL: Record<AgentStatus, NonNullable<Card["pill"]>> = {
  idle: { label: "idle", tone: "neutral" },
  waiting: { label: "waiting", tone: "caution" },
  busy: { label: "busy", tone: "info" },
  capped: { label: "capped", tone: "warn" },
  failed: { label: "failed", tone: "error" },
};

function live(s: SwarmSummary): boolean {
  return isLive(s.status);
}

// ---- Requests: what the operator is asked, one card each. ----

function requestCard(request: Request, need: Need): Card {
  return {
    title: request.title,
    pill: request.pill,
    edge: request.pill.tone,
    fields: [{ value: request.line }, ...sinceClock(need), ...(request.link ? [request.link] : [])],
    actions: [request.primary, ...request.more],
  };
}

// A gate a peer is reviewing is not a request; it is shown so the operator can
// read along or reply, and counted nowhere.
function reviewingCard(s: SwarmSummary, run: ChildRun): Card {
  const gate = run.pendingApproval;
  const thread = threadHref(s, gate?.threadId);
  const reviewer = gate?.reviewer;
  const payload = { id: s.id, runId: run.runId, gateIdentity: gateIdentity(run) };
  return {
    title: `${gate?.nodeId ?? "approval"} · ${run.workflow} ${shortRun(run.runId)}`,
    action: { type: "select-gate", payload },
    pill: { label: "reviewing", tone: "info" },
    fields: [
      {
        value: reviewer
          ? `@${shortHandle(reviewer, s.id)} reviews the plan in its thread, then the lead answers`
          : "a peer reviews the plan in its thread, then the lead answers",
      },
      { value: `opened ${hhmm(gate?.openedAt)}` },
      ...(thread ? [{ value: "thread", href: thread }] : []),
    ],
    footnote: firstLine(gate?.prompt ?? "", 200),
    actions: [
      { type: "select-gate", label: "Read gate", payload },
      {
        type: "open-run",
        label: "Open run",
        hint: "Opens the run beside the tab.",
        binding: { id: s.id, runId: run.runId },
      },
      ...(gate?.threadId
        ? [
            replyAction(
              s,
              { runId: run.runId, gateIdentity: gateIdentity(run) },
              "the approval thread",
            ),
          ]
        : []),
    ],
  };
}

function requests(
  s: SwarmSummary,
  needs: readonly Need[],
  server?: ServerLine,
  includeAsked = true,
): Leaf[] {
  if (!live(s)) return [];
  const asked = includeAsked ? needs.map((n) => requestCard(requestOf(s, n, server), n)) : [];
  const reviewing = (s.runs ?? [])
    .filter(
      (r) =>
        s.conclusion === undefined &&
        r.status === "paused" &&
        r.pendingApproval &&
        r.pendingApproval.answerer !== "operator",
    )
    .filter((r) => !needs.some((n) => n.run?.runId === r.runId))
    .map((r) => reviewingCard(s, r));
  if (asked.length === 0 && reviewing.length === 0) return [];
  return [
    {
      kind: "cards",
      title: asked.length > 0 ? plural(asked.length, "request") : "Approvals in review",
      items: [...asked, ...reviewing],
    },
  ];
}

// ---- Budget while live, result once ended. ----

// Under this much runtime a pace says nothing about how the budget will end.
const FORECAST_AFTER_MS = 2 * 60_000;

export function turnsTile(s: SwarmSummary, now = new Date()): Stat {
  const left = Math.max(0, s.limits.maxTurns - s.turnsUsed);
  const forecasting =
    live(s) &&
    s.conclusion === undefined &&
    (left === 0 || now.getTime() - Date.parse(s.startedAt) >= FORECAST_AFTER_MS);
  return {
    label: "Turns",
    value: s.turnsUsed,
    sub: forecasting
      ? `of ${s.limits.maxTurns} · pace over the last ${PACE_WINDOW_MINUTES} min`
      : `of ${s.limits.maxTurns}`,
    ...(forecasting ? { delta: forecastDelta(forecast(s, now)) } : {}),
    ...(live(s) && left === 0 ? { tone: "warn" as const } : {}),
    ...(s.pace && s.pace.length >= 2 ? { spark: [...s.pace] } : {}),
  };
}

export function timeTile(s: SwarmSummary): Stat {
  const wall = minutes(s.limits.wallClockMs);
  return live(s)
    ? {
        label: "Time",
        clock: { at: endsAt(s), mode: "until" },
        sub: `of ${wall} min · ends ${hhmm(endsAt(s))}`,
      }
    : { label: "Time", value: span(s.startedAt, s.endedAt) || "0 s", sub: `of ${wall} min` };
}

export function tokensTile(s: SwarmSummary): Stat {
  if (!s.usage) {
    return s.turnsUsed === 0
      ? { label: "Tokens", value: 0, sub: "fresh · none yet" }
      : { label: "Tokens", value: null, sub: "the provider reported none" };
  }
  return {
    label: "Tokens",
    value: tokenCount(freshTokens(s.usage)),
    sub:
      s.usage.cached > 0 ? `fresh · ${tokenCount(s.usage.cached)} cached` : "fresh · none cached",
  };
}

function stats(s: SwarmSummary, now: Date): Leaf {
  const isLiveNow = live(s);
  const busy = s.agents.filter((a) => a.status === "busy").length;
  const waiting = s.agents.filter((a) => a.status === "waiting").length;
  const seats = [
    ...(busy > 0 ? [`${busy} busy`] : []),
    ...(waiting > 0 ? [`${waiting} waiting`] : []),
  ];
  const items: Stat[] = [
    turnsTile(s, now),
    timeTile(s),
    ...(isLiveNow
      ? [
          {
            label: "Agents",
            value: `${s.agents.length} of ${s.limits.maxAgents}`,
            ...(seats.length > 0 ? { sub: seats.join(" · ") } : {}),
          },
        ]
      : []),
    ...(!isLiveNow || s.usage ? [tokensTile(s)] : []),
  ];
  if (!isLiveNow) {
    const prs = new Map<string, boolean>();
    const record = (url: string, passing: boolean) =>
      prs.set(url, (prs.get(url) ?? true) && passing);
    for (const run of s.runs ?? []) {
      for (const url of run.prUrls) {
        record(url, run.ci?.verdict === "pass" && run.ci.prUrl === url);
      }
    }
    for (const pr of s.prs ?? []) record(pr.url, pr.ci?.verdict === "pass");
    const writesByPr = (s.writeEnabled || s.agents.some((a) => a.worktree)) && !s.writeLocal;
    if (s.workflows?.length || s.runs?.length || writesByPr || prs.size > 0) {
      items.push({
        label: "Pull requests",
        value: prs.size,
        ...(prs.size > 0
          ? { sub: `${[...prs.values()].filter(Boolean).length} with CI passing` }
          : {}),
      });
    }
    if (s.writeLocal) items.push({ label: "Merged", value: s.merges?.length ?? 0 });
    const runs = s.runs ?? [];
    if (runs.length > 0) {
      const n = runs.filter((r) => r.verified).length;
      items.push({
        label: "Runs verified",
        value: `${n} of ${runs.length}`,
        tone: n === runs.length ? "ok" : "warn",
      });
    }
  }
  return { kind: "stats", title: isLiveNow ? "Budget" : "Result", items };
}

// ---- Reaching the lead, reading the record, and stopping. ----

export const openRecord = (s: SwarmSummary) => ({
  type: "open-record",
  label: "Timeline",
  glyph: "◷",
  hint: "The swarm's timeline, who woke whom, spend, runs, evidence and Activity.",
  payload: { id: s.id },
});

const openDetails = (s: SwarmSummary) => ({
  type: "open-details",
  label: "Details",
  payload: { id: s.id },
});

function controls(s: SwarmSummary): Leaf[] {
  if (!live(s)) return [];
  const items: Extract<Leaf, { kind: "actions" }>["items"] = [];
  items.push(openRecord(s), openDetails(s));
  if (s.status === "running") items.push(stopAction(s, true));
  return [{ kind: "actions", wrap: true, items }];
}

// ---- Ended agents and the live map. ----

function agentCard(
  s: SwarmSummary,
  a: SwarmSummary["agents"][number],
  selectedAgentId?: string,
): Card {
  const pinned = a.model && a.model !== (a.lead ? s.model : (s.workerModel ?? s.model));
  const tokens = a.usage ? `${tokenCount(freshTokens(a.usage))} tokens` : undefined;
  const turns = a.lead
    ? plural(a.turns, "turn")
    : `${a.turns} of ${s.limits.maxTurnsPerAgent} turns`;
  const last = [...(s.activity ?? [])].reverse().find((e) => e.actor === a.id);
  const foot = [
    ...(last
      ? [`last: ${firstLine(actorText(s.id, last.text, a.id), 40)} · ${hhmm(last.at)}`]
      : []),
    ...(a.spawnedBy ? [`spawned by @${shortHandle(a.spawnedBy, s.id)}`] : []),
    ...(a.queued ? [`${plural(a.queued, "message")} waiting`] : []),
    ...(a.servedModel && a.servedModel !== a.model ? [`served by ${a.servedModel}`] : []),
  ];
  return {
    title: shortHandle(a.handle, s.id),
    titleTone: a.tone,
    action: { type: "select-agent", payload: { id: s.id, agentId: a.id } },
    ...(a.id === selectedAgentId ? { selected: true } : {}),
    ...(live(s) ? { pill: AGENT_PILL[a.status] } : {}),
    ...(a.lead
      ? {}
      : { bar: { value: a.turns, total: s.limits.maxTurnsPerAgent, trailing: turns } }),
    fields: [
      { value: firstLine(a.role, 64) },
      ...(a.lead
        ? [{ value: tokens ? `${turns} · ${tokens}` : turns }]
        : tokens
          ? [{ value: tokens }]
          : []),
      ...(pinned ? [{ value: a.model as string }] : []),
    ],
    ...(foot.length > 0 ? { footnote: foot.join(" · ") } : {}),
  };
}

function bench(s: SwarmSummary, selectedAgentId?: string): Leaf {
  const items = s.agents.map((a) => agentCard(s, a, selectedAgentId));
  return {
    kind: "cards",
    title: `Agents · ${s.agents.length}`,
    grid: true,
    columns: BENCH_COLUMNS,
    items: items.length > 0 ? items : [{ title: "No agents recorded" }],
  };
}

const RUN_TONE: Record<ChildRunStatus, CanvasTone> = {
  running: "info",
  paused: "caution",
  succeeded: "ok",
  failed: "error",
  cancelled: "neutral",
};

export function buildAgentMap(s: SwarmSummary, selectedAgentId?: string): CanvasGraphSection {
  const agents = [...s.agents.filter((a) => a.lead), ...s.agents.filter((a) => !a.lead)];
  const allNodes: CanvasGraphSection["nodes"] = [
    {
      id: "you",
      label: "you",
      sublabel:
        s.operatorMessageCount === undefined
          ? "posts not recorded"
          : plural(s.operatorMessageCount, "post"),
      tone: "neutral",
      rank: 0,
    },
    ...agents.map((a) => ({
      id: a.id,
      label: `@${shortHandle(a.handle, s.id)}`,
      sublabel: `${a.lead ? `${a.turns} turns` : `${a.turns} of ${s.limits.maxTurnsPerAgent}`} · ${a.status}`,
      tone: a.tone,
      rank: a.lead ? 1 : 2,
      ...(a.lead || a.worktree ? { badges: [{ text: a.lead ? "lead" : "writer" }] } : {}),
      action: { type: "select-agent", payload: { id: s.id, agentId: a.id } },
      ...(a.id === selectedAgentId ? { selected: true } : {}),
    })),
    ...(s.runs ?? []).map((r) => ({
      id: `run:${r.runId}`,
      label: `${r.workflow} ${shortRun(r.runId)}`,
      sublabel: `${r.status} · ${r.nodesDone} steps`,
      tone: RUN_TONE[r.status],
      rank: 3,
      action: { type: "open-run", payload: { id: s.id, runId: r.runId } },
    })),
  ];
  const allIds = new Set(allNodes.map((n) => n.id));
  const allEdges: (CanvasGraphSection["edges"][number] & { priority: number })[] = buildAgentEdges(
    s,
  )
    .map((e) => ({
      priority: e.kind === "spawned" ? 0 : e.kind === "woke" ? 1 : 2,
      source: e.from === "operator" ? "you" : e.from,
      target: e.to === "operator" ? "you" : e.to,
      label:
        e.kind === "asked" ? `asked ×${e.n}` : `×${e.kind === "spawned" ? (e.woke ?? 0) : e.n}`,
      ...(e.kind === "asked" ? { dashed: true } : {}),
    }))
    .filter((e) => allIds.has(e.source) && allIds.has(e.target));
  const lead = agents.find((a) => a.lead);
  if (lead) {
    for (const r of s.runs ?? []) {
      allEdges.push({ source: `run:${r.runId}`, target: lead.id, label: "updates", priority: 0 });
    }
  }
  const required = allNodes.filter(
    (n) => n.id === "you" || n.rank === 1 || n.id === selectedAgentId,
  );
  const retained = new Set(
    [...required, ...allNodes.filter((n) => !required.includes(n))].slice(0, 48).map((n) => n.id),
  );
  const nodes = allNodes.filter((n) => retained.has(n.id));
  const edges = allEdges
    .sort((a, b) => a.priority - b.priority)
    .filter((e) => retained.has(e.source) && retained.has(e.target))
    .slice(0, 200)
    .map(({ priority, ...edge }) => edge);
  const clipped = [
    ...(nodes.length < allNodes.length
      ? [`showing ${nodes.length} of ${allNodes.length} nodes`]
      : []),
    ...(edges.length < allEdges.length
      ? [`showing ${edges.length} of ${allEdges.length} edges`]
      : []),
  ];
  return {
    kind: "graph",
    title: ["Map", ...clipped].join(" · "),
    columns: ["You", "Lead", "Workers", "Runs"],
    nodes,
    edges,
  };
}

function mapConversation(s: SwarmSummary, selectedAgentId?: string): Leaf[] {
  return [
    buildAgentMap(s, selectedAgentId),
    ...conversation(s),
    ...(s.status === "running" && s.conclusion === undefined
      ? [
          {
            kind: "actions" as const,
            wrap: true,
            items: [{ ...messageLead(s), expanded: true }],
          },
        ]
      : []),
  ];
}

// ---- Spend: each agent's fresh tokens against the swarm's. ----

function spend(s: SwarmSummary): Leaf[] {
  const spent = s.agents
    .map((a) => ({ a, fresh: a.usage ? freshTokens(a.usage) : 0 }))
    .filter((x) => x.fresh > 0);
  // One agent's bar is always full, so the section starts at two.
  if (spent.length < 2) return [];
  const total = spent.reduce((n, x) => n + x.fresh, 0);
  return [
    {
      kind: "bars",
      title: "Spend",
      inline: true,
      items: spent.map(({ a, fresh }) => ({
        label: shortHandle(a.handle, s.id),
        value: fresh,
        total,
        trailing: `${tokenCount(fresh)} · ${Math.round((100 * fresh) / total)}%`,
      })),
    },
  ];
}

// ---- Produced artifacts, in landing order. ----

function evidence(run: ChildRun): Segment[] {
  const settled = run.status !== "running" && run.status !== "paused";
  const ciFailed = run.ci?.verdict === "fail";
  if (!run.isolated) {
    return [
      {
        label: `CI ${run.ci?.verdict ?? "not reported"}`,
        n: 1,
        tone: ciFailed ? "error" : run.ci?.verdict === "pass" ? "ok" : "neutral",
      },
    ];
  }
  const breach = run.error?.includes("isolated worktree") ?? false;
  const worktree = run.checkout?.worktreeEstablished;
  return [
    {
      label: breach ? "worktree breached" : worktree ? "own worktree" : "worktree pending",
      n: 1,
      tone: breach ? "error" : worktree ? "ok" : "neutral",
    },
    {
      label: run.prUrls.length > 0 ? prLabel(run.prUrls[0] ?? "") : "no PR yet",
      n: 1,
      tone: run.prUrls.length > 0 ? "ok" : "neutral",
    },
    {
      label: `CI ${run.ci?.verdict ?? "not reported"}`,
      n: settled && !run.ci ? null : 1,
      tone: ciFailed ? "error" : run.ci?.verdict === "pass" ? "ok" : "neutral",
    },
  ];
}

function runStatus(run: ChildRun): string {
  const steps = `${run.nodesDone} steps done`;
  if (run.status === "paused") {
    return `paused at ${run.pendingApproval?.nodeId ?? run.lastNode ?? "an approval"} · ${steps}`;
  }
  if (run.status === "running") return `running · ${steps}`;
  if (run.status === "succeeded") {
    if (run.verified) return "verified";
    const missing = missingEvidence(run);
    return missing.length > 0 ? `succeeded · lacks ${missing.join(", ")}` : "succeeded";
  }
  return run.status;
}

// A run's row: what it is for and where it worked, then what it made and how
// it ended. The reading pane holds the full error and the CI detail.
function runText(run: ChildRun): string {
  const why =
    (run.status === "failed" || run.status === "cancelled") && run.error
      ? ` · ${firstLine(run.error, 90)}`
      : "";
  return [
    `${run.workflow} ${firstLine(run.purpose, 60)}`,
    ...(run.checkout?.branch ? [run.checkout.branch] : []),
    ...(run.isolated ? [] : ["live checkout"]),
  ]
    .join(" · ")
    .concat(why);
}

function runTrailing(run: ChildRun): string {
  const settled = run.status !== "running" && run.status !== "paused";
  const took = settled ? span(run.startedAt, run.completedAt) : "";
  return [
    ...(run.prUrls.length > 0 ? [prList(run.prUrls)] : []),
    ...(took ? [took] : []),
    runStatus(run),
  ].join(" · ");
}

function runRows(s: SwarmSummary, run: ChildRun): Row[] {
  const href =
    run.status === "paused" ? threadHref(s, run.pendingApproval?.threadId) : run.prUrls[0];
  const row: Row = {
    icon: "▸",
    text: runText(run),
    trailing: runTrailing(run),
    bar: { segments: evidence(run) },
    ...(href ? { href } : {}),
    action: { type: "open-run", payload: { id: s.id, runId: run.runId } },
  };
  const answers: Row[] = (run.approvals ?? []).map((a) => {
    const why = [a.reason, ...(a.feedback ? [`Changes asked: ${a.feedback}`] : [])].join("\n\n");
    const review = threadHref(s, a.review);
    return {
      icon: a.decision === "approve" ? "✓" : "↺",
      glyph: a.decision === "approve" ? "ok" : "warn",
      text: `${a.nodeId} ${a.decision === "approve" ? "approved" : "sent back"} on ${activityText(s.id, a.reviewer)}'s review`,
      trailing: hhmm(a.at),
      ...(why.trim() ? { detail: why.slice(0, DETAIL_CHARS) } : {}),
      ...(review ? { href: review } : {}),
    };
  });
  return [row, ...answers];
}

function writerChip(s: SwarmSummary, handle: string): Row["chip"] {
  const agent = s.agents.find((a) => a.handle === handle);
  return actorChip(s, agent?.id) ?? { label: shortHandle(handle, s.id), tone: "neutral" };
}

function produced(s: SwarmSummary): Leaf[] {
  const groups: { at: string; rows: Row[] }[] = [];
  if (s.report) {
    groups.push({
      at: s.report.at,
      rows: [
        {
          icon: "◧",
          text: s.report.title,
          trailing: `${reportKb(s)} · Open the report`,
          action: { type: openReport(s).type, payload: openReport(s).payload },
        },
      ],
    });
  }
  for (const run of s.runs ?? []) groups.push({ at: run.startedAt, rows: runRows(s, run) });
  for (const m of s.merges ?? []) {
    groups.push({
      at: m.at,
      rows: [
        {
          chip: writerChip(s, m.agent),
          text: m.branch,
          trailing: `merged into ${m.base} · ${m.commit.slice(0, 7)}`,
        },
      ],
    });
  }
  for (const pr of s.prs ?? []) {
    groups.push({
      at: pr.at,
      rows: [
        {
          chip: writerChip(s, pr.agent),
          text: pr.branch,
          trailing: `draft ${prLabel(pr.url)} · CI ${pr.ci?.verdict ?? "not reported"}`,
          href: pr.url,
          ...(pr.ci?.detail ? { detail: detailOf(pr.ci.detail, DETAIL_CHARS).detail } : {}),
        },
      ],
    });
  }
  const start = Date.parse(s.startedAt);
  const landed = (at: string) => {
    const parsed = Date.parse(at);
    return Number.isFinite(parsed) ? parsed : Number.isFinite(start) ? start : 0;
  };
  const items = groups.sort((a, b) => landed(a.at) - landed(b.at)).flatMap((g) => g.rows);
  if (!live(s)) {
    for (const wt of s.worktrees ?? []) {
      const reason = firstLine(wt.reason, 90);
      items.push({
        chip: writerChip(s, wt.agent),
        text: wt.path,
        trailing: reason,
        ...(wt.reason.length > reason.length
          ? { detail: detailOf(wt.reason, DETAIL_CHARS).detail }
          : {}),
      });
    }
  }
  if (items.length === 0) {
    const writers = s.agents
      .filter((a) => a.worktree)
      .map((a) => `@${shortHandle(a.handle, s.id)}`);
    const empty: string[] = [];
    if (s.workflows?.length) {
      empty.push(
        live(s)
          ? `The lead may start ${s.workflows.join(", ")}; none started yet.`
          : `The lead could start ${s.workflows.join(", ")}; none started.`,
      );
    }
    const lands = s.writeLocal
      ? { may: "may have reviewed work merged", none: "none merged" }
      : { may: "may open draft pull requests", none: "none opened" };
    if (writers.length) {
      empty.push(
        live(s)
          ? `Writers ${writers.join(", ")} ${lands.may}; ${lands.none} yet.`
          : `Writers ${writers.join(", ")} ${lands.may.replace("may", "could")}; ${lands.none}.`,
      );
    } else if (s.writeEnabled) {
      const what = s.writeLocal ? "whose reviewed work is merged" : "to open draft pull requests";
      empty.push(
        live(s)
          ? `The lead may spawn writers ${what}; ${lands.none} yet.`
          : `The lead could spawn writers ${what}; ${lands.none}.`,
      );
    }
    if (empty.length === 0) return [];
    items.push({ icon: "·", text: empty.join(" ") });
  }
  return [{ kind: "rows", title: live(s) ? "Produced so far" : "Produced", items }];
}

// The first DETAIL_CHARS of a text for a row's disclosure, and a note when it was cut.
function detailOf(text: string, budget: number): { detail?: string; cut?: string } {
  const cap = Math.min(DETAIL_CHARS, budget);
  const detail = text.length > cap ? text.slice(0, cap).trimEnd() : text;
  return {
    ...(detail.length > 0 ? { detail } : {}),
    ...(text.length > cap
      ? {
          cut: `first ${detail.length.toLocaleString("en-US")} of ${text.length.toLocaleString("en-US")} characters`,
        }
      : {}),
  };
}

// ---- Activity, newest first, repeats counted. ----

// Who an event is by, in the colors the bench gives them.
function actorChip(s: SwarmSummary, actor: string | undefined): Row["chip"] {
  if (actor === "operator") return { label: "you", tone: "neutral" };
  const a = actor ? s.agents.find((x) => x.id === actor) : undefined;
  return a ? { label: shortHandle(a.handle, s.id), tone: a.tone } : undefined;
}

function conversation(s: SwarmSummary): Leaf[] {
  if (!live(s) || !s.recent?.length) return [];
  const entries = s.recent.slice(-CONVERSATION_SHOWN).reverse();
  const href = channelHref(s);
  return [
    {
      kind: "rows",
      title: "Conversation",
      items: [
        ...entries.map((m): Row => {
          const chip = actorChip(s, m.author);
          const href = threadHref(s, m.threadRootId ?? m.id);
          return {
            ...(chip ? { chip } : {}),
            text: `${m.threadRootId ? "↳ " : ""}${messageLine(s.id, m.text)}`,
            trailing: hhmm(m.at),
            ...(href ? { href } : {}),
          };
        }),
        {
          icon: "▤",
          text: `${plural(s.messageCount ?? s.recent.length, "message")} · transcript ↗`,
          ...(href ? { href } : {}),
        },
      ],
    },
  ];
}

function activity(s: SwarmSummary): Leaf[] {
  const all = s.activity ?? [];
  const entries = [...all].reverse().slice(0, RECENT_SHOWN);
  if (entries.length === 0) return [];
  const earlier = all.length - entries.length;
  return [
    {
      kind: "rows",
      title: "Activity",
      items: [
        ...entries.map((e) => {
          const chip = actorChip(s, e.actor);
          return {
            ...(chip ? { chip } : {}),
            text: `${firstLine(actorText(s.id, e.text, chip ? e.actor : undefined), 90)}${e.count && e.count > 1 ? ` ×${e.count}` : ""}`,
            trailing: hhmm(e.at),
          };
        }),
        ...(live(s) && earlier > 0
          ? [
              {
                icon: "▤",
                text: `Read the full log · ${plural(earlier, "earlier event")}`,
                action: { type: "open-record", payload: { id: s.id } },
              },
            ]
          : []),
      ],
    },
  ];
}

// ---- Ended times, health, and the transcript. ----

function about(s: SwarmSummary): Leaf {
  const href = channelHref(s);
  const when = `ran ${day(s.startedAt)} ${hhmm(s.startedAt)} → ${hhmm(s.endedAt)}`;
  return {
    kind: "rows",
    title: "About",
    items: [
      { icon: "◷", text: `${when}${s.project ? ` · on ${s.project.name}` : ""}` },
      ...healthRows(s, { omitCause: s.conclusion === undefined }),
      ...(href ? [{ text: "transcript ↗", href }] : []),
    ],
  };
}

// ---- Outcome: the report, the conclusion, or the cause. ----

function leadHandle(s: SwarmSummary): string {
  return shortHandle(s.agents.find((a) => a.lead)?.handle ?? `${s.id}-lead`, s.id);
}

function reportKb(s: SwarmSummary): string {
  return s.report ? `report ${Math.max(1, Math.round(s.report.bytes / 1024))} KB` : "";
}

export const openReport = (s: SwarmSummary) => ({
  type: "open-report",
  label: "Open the report",
  glyph: "◧",
  tone: "brand" as const,
  payload: { id: s.id },
});

function reportCard(s: SwarmSummary): Card[] {
  if (!s.report) return [];
  return [
    {
      title: s.report.title,
      pill: { label: "report", tone: "brand" },
      footnote: `by @${leadHandle(s)} · ${day(s.report.at)} ${hhmm(s.report.at)} · ${reportKb(s)}`,
      actions: [openReport(s)],
    },
  ];
}

// The conclusion under the report's title when the lead published one: one
// card holds the answer and its page.
function conclusionCard(s: SwarmSummary, conclusion: string): Card {
  const when = s.endedAt ? ` · ${day(s.endedAt)} ${hhmm(s.endedAt)}` : "";
  // Live frames reserve room for the Turns forecast.
  const previewChars = live(s) ? PREVIEW_CHARS - 200 : PREVIEW_CHARS;
  return {
    title: s.report?.title ?? "Conclusion",
    ...(s.report ? { pill: { label: "report", tone: "brand" as const } } : {}),
    prose: true,
    fields: [
      {
        value:
          conclusion.length > previewChars
            ? `${plain(conclusion.slice(0, previewChars)).trimEnd()}…`
            : plain(conclusion),
        copyAction: { type: "copy-conclusion", payload: { id: s.id } },
      },
    ],
    footnote: [
      `by @${leadHandle(s)}${when}`,
      `${conclusion.length.toLocaleString("en-US")} characters`,
      ...(s.report ? [reportKb(s)] : []),
    ].join(" · "),
    ...(s.report ? { actions: [openReport(s)] } : {}),
  };
}

function outcome(s: SwarmSummary): Leaf[] {
  if (live(s) && s.conclusion === undefined) {
    return s.report ? [{ kind: "cards", title: "Outcome", items: reportCard(s) }] : [];
  }
  if (s.conclusion !== undefined) {
    return [{ kind: "cards", title: "Outcome", items: [conclusionCard(s, s.conclusion)] }];
  }
  const life = LIFECYCLE[s.status];
  const cause: Card = {
    title: causeTitle(s),
    pill: { label: life.label, tone: life.tone },
    fields: [{ value: s.error ?? "the swarm ended without a conclusion" }],
    ...(s.draftConclusion
      ? {
          footnote: "The lead's refused draft is in the reading pane.",
          actions: [
            { type: "read-doc", label: "Read the draft", glyph: "▤", payload: { id: s.id } },
          ],
        }
      : {}),
  };
  return [{ kind: "cards", title: "Outcome", items: [...reportCard(s), cause] }];
}

function verbs(s: SwarmSummary, launch: StartSwarmInput | undefined): Leaf[] {
  if (live(s)) return [];
  return [
    {
      kind: "actions",
      wrap: true,
      items: [...(launch ? runAgainItem(s, launch) : []), openRecord(s), openDetails(s)],
    },
  ];
}

export interface BoardOptions {
  // The launch the swarm was started with, when the rib kept it, so it can run again.
  launch?: StartSwarmInput;
  // The ClickClack server, so a connection request can offer to start it.
  server?: ServerLine;
  now?: Date;
  selectedAgentId?: string;
}

export function liveDetails(s: SwarmSummary, selectedAgentId?: string): Leaf[] {
  return [
    ...(!live(s) ? [bench(s, selectedAgentId)] : []),
    ...(live(s) ? spend(s) : []),
    ...produced(s),
    ...activity(s),
    ...(!live(s)
      ? [
          about(s),
          {
            kind: "rows" as const,
            items: [{ icon: "←", text: "Ended swarms", action: { type: "history-open" } }],
          },
        ]
      : []),
  ];
}

function agentStrip(s: SwarmSummary): Leaf {
  const statuses: AgentStatus[] = ["busy", "waiting", "idle", "capped", "failed"];
  const items: Extract<Leaf, { kind: "segments" }>["items"] = [];
  for (const status of statuses) {
    const n = s.agents.filter((a) => a.status === status).length;
    if (n > 0) items.push({ label: status, n, tone: AGENT_PILL[status].tone });
  }
  const open = Math.max(0, s.limits.maxAgents - s.agents.length);
  if (live(s) && open > 0) items.push({ label: plural(open, "open seat"), n: null });
  return { kind: "segments", title: `Agents · ${s.agents.length} of ${s.limits.maxAgents}`, items };
}

function nativeTimeline(s: SwarmSummary): CanvasTimelineSection {
  const model = buildTimelineModel(s);
  const lanes = model.lanes.slice(0, 12).map(({ id, label, tone, group }) => ({
    id,
    label,
    tone,
    ...(group ? { group } : {}),
  }));
  const ids = new Set(lanes.map((lane) => lane.id));
  const spans = model.spans
    .filter((item) => ids.has(item.lane))
    .sort((a, b) => Date.parse(a.from) - Date.parse(b.from))
    .slice(-400)
    .map(({ lane, from, to, tone, hatched, title }) => ({
      lane,
      from,
      ...(to ? { to } : {}),
      ...(tone ? { tone } : {}),
      ...(hatched ? { hatched } : {}),
      title,
    }));
  const marks = model.marks
    .filter((item) => ids.has(item.lane))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .slice(-200)
    .map(({ lane, at, glyph, title }) => ({ lane, at, glyph, title }));
  const clipped = [
    ...(lanes.length < model.lanes.length ? [`${lanes.length}/${model.lanes.length} lanes`] : []),
    ...(spans.length < model.spans.length ? [`${spans.length}/${model.spans.length} spans`] : []),
    ...(marks.length < model.marks.length ? [`${marks.length}/${model.marks.length} marks`] : []),
  ];
  const window: CanvasTimelineWindow = s.endedAt
    ? { from: s.startedAt, to: s.endedAt }
    : {
        from: s.startedAt,
        clock: {
          until: new Date(Date.parse(s.startedAt) + s.limits.wallClockMs).toISOString(),
        },
      };
  return {
    kind: "timeline",
    title: ["Timeline", ...clipped].join(" · "),
    window,
    lanes,
    spans,
    marks,
    legend:
      "Bars are turns in each agent's color, hatched when timed out or failed, open while unfinished. ○ spawned · ? asked you · ▲ you · ▪ report · ● conclusion · ◇ gate opened · ◆ gate answered · ✓ verified. Timeline holds the full retained record.",
  };
}

// A cockpit can hold several live swarms, so the task's disclosure stays short;
// Details keeps the whole text.
const TASK_DETAIL_CHARS = 800;

// The prompt the swarm was started with: its first line, and the text one click
// away, since the card title and header cut it at one line.
function taskRow(s: SwarmSummary): Row {
  const head = firstLine(s.task, 110);
  const whole = s.task.trim();
  if (whole === head) return { icon: "▤", text: `Task · ${head}` };
  const { detail, cut } = detailOf(whole, TASK_DETAIL_CHARS);
  return {
    icon: "▤",
    text: `Task · ${head}${cut ? ` (${cut}; Details has all of it)` : ""}`,
    ...(detail ? { detail } : {}),
  };
}

export function buildCockpit(
  s: SwarmSummary,
  needs: readonly Need[],
  opts: { server?: ServerLine; titled: boolean; now?: Date; selectedAgentId?: string },
): Section[] {
  const people = s.agents.map((a) => ({ name: shortHandle(a.handle, s.id), tone: a.tone }));
  const line = stateLine(s, needs, opts.server);
  const items: Extract<Leaf, { kind: "actions" }>["items"] = [];
  if (s.report) items.push(openReport(s));
  items.push(openRecord(s), openDetails(s));
  if (s.status === "running") items.push(stopAction(s, true));
  return [
    {
      kind: "cards",
      ...(opts.titled ? { title: "Live" } : {}),
      items: [
        {
          title: `${firstLine(s.task)} · ${s.id}`,
          pill: needs.length ? { label: "needs you", tone: "caution" } : livePill(s),
          ...(needs.length ? { edge: "caution" as const } : {}),
          ...(people.length ? { fields: [{ people }] } : {}),
        },
      ],
    },
    {
      kind: "rows",
      items: [
        taskRow(s),
        { icon: "◉", text: line.text, ...(line.warn ? { glyph: "warn" as const } : {}) },
      ],
    },
    ...(s.conclusion !== undefined ? outcome(s) : []),
    ...requests(s, needs, opts.server, false),
    agentStrip(s),
    {
      kind: "stats",
      title: "Budget",
      items: [turnsTile(s, opts.now), timeTile(s), tokensTile(s)],
    },
    ...(live(s) ? [nativeTimeline(s)] : []),
    ...mapConversation(s, opts.selectedAgentId),
    ...liveDetails(s, opts.selectedAgentId),
    { kind: "actions", wrap: true, items },
  ];
}

export function buildSwarmBoard(s: SwarmSummary, opts: BoardOptions = {}): CanvasBoardView {
  const now = opts.now ?? new Date();
  const needs = needsYou(s);
  const isLiveNow = live(s);
  const pill = !isLiveNow
    ? LIFECYCLE[s.status]
    : needs.length > 0
      ? { label: "needs you", tone: "caution" as const }
      : livePill(s);
  const took = span(s.startedAt, s.endedAt);
  const chip = isLiveNow
    ? `${sizeWord(s)} · ${s.turnsUsed} of ${s.limits.maxTurns} turns · ${modelLabel(s)}`
    : `${sizeWord(s)} · ${plural(s.turnsUsed, "turn")}${took ? ` · ${took}` : ""}`;
  const details = liveDetails(s, opts.selectedAgentId);
  return {
    view: "board",
    title: `${firstLine(s.task)} · ${s.id}`,
    header: {
      status: pill,
      chip,
      ...(s.agents.length > 0
        ? { people: s.agents.map((a) => ({ name: shortHandle(a.handle, s.id), tone: a.tone })) }
        : {}),
    },
    sections: isLiveNow
      ? [
          { kind: "rows", items: [taskRow(s)] },
          ...requests(s, needs, opts.server),
          ...outcome(s),
          stats(s, now),
          ...mapConversation(s, opts.selectedAgentId),
          ...controls(s),
          ...details,
        ]
      : [
          ...outcome(s),
          { kind: "rows", items: [taskRow(s)] },
          stats(s, now),
          ...verbs(s, opts.launch),
          ...details,
        ],
  };
}

export function buildStartingBoard(s: StartingSwarm): CanvasBoardView {
  const shape = { ...s, size: sizeOf(s.limits, s.sizeBase), agents: [] };
  return {
    view: "board",
    title: `${firstLine(s.task)} · ${s.id}`,
    header: { status: { label: "starting", tone: "neutral" } },
    sections: [
      {
        kind: "rows",
        items: [
          {
            icon: "◷",
            text: `started ${hhmm(s.startedAt)}${s.project ? ` · on ${s.project.name}` : ""}`,
          },
          { icon: "◫", text: openHint(shape) },
          { icon: "◌", text: "Creating the channel and the lead." },
        ],
      },
    ],
  };
}

// A key that outlived its swarm's record: the channel still has everything.
export function buildGoneBoard(id: string): CanvasBoardView {
  return {
    view: "board",
    title: `Swarm ${id}`,
    sections: [
      {
        kind: "rows",
        items: [
          {
            icon: "◌",
            text: `Swarm ${id} is no longer in the rib's history. Its channel #swarm-${id} keeps the transcript.`,
          },
          { icon: "←", text: "Ended swarms", action: { type: "history-open" } },
        ],
      },
    ],
  };
}
