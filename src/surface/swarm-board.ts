// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView } from "@keelson/shared";
import { missingEvidence } from "../dispatch.ts";
import { freshTokens, modelLabel, servedModels, tokenCount, tokensText } from "../labels.ts";
import { type Need, needsYou } from "../needs.ts";
import type { StartSwarmInput } from "../tools.ts";
import {
  type AgentStatus,
  type ChildRun,
  isLive,
  type StartingSwarm,
  type SwarmSummary,
  sizeOf,
} from "../types.ts";
import {
  activityText,
  actorText,
  channelHref,
  day,
  firstLine,
  hhmm,
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
  LIFECYCLE,
  livePill,
  messageLead,
  openHint,
  type Request,
  requestOf,
  type ServerLine,
  sinceClock,
  sizeDetail,
  sizeWord,
  stopAction,
  verifiedText,
} from "./parts.ts";

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
// Context disclosures on one board, in total, so a swarm with twenty items
// does not ship eighty thousand characters in every frame.
const CONTEXT_DETAIL_BUDGET = 24_000;
export const RECENT_SHOWN = 12;
const BENCH_COLUMNS = 4;

const AGENT_PILL: Record<AgentStatus, Card["pill"]> = {
  idle: { label: "idle", tone: "neutral" },
  waiting: { label: "waiting", tone: "caution" },
  busy: { label: "busy", tone: "info" },
  capped: { label: "capped", tone: "warn" },
  failed: { label: "failed", tone: "error" },
};

function live(s: SwarmSummary): boolean {
  return isLive(s.status);
}

function modelRow(s: SwarmSummary): string {
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
  return {
    title: `${gate?.nodeId ?? "approval"} · ${run.workflow} ${shortRun(run.runId)}`,
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
      {
        type: "open-run",
        label: "Open run",
        hint: "Opens the run beside the tab.",
        binding: { id: s.id, runId: run.runId },
      },
      ...(gate?.threadId
        ? [
            {
              type: "reply",
              label: "Reply",
              binding: { id: s.id, runId: run.runId },
              fields: [
                {
                  name: "note",
                  label: "Reply",
                  placeholder:
                    "Posts in the approval thread as you · does not approve; the lead answers · Enter sends",
                  required: true,
                },
              ],
              submitLabel: "Reply",
            },
          ]
        : []),
    ],
  };
}

function requests(s: SwarmSummary, needs: readonly Need[], server?: ServerLine): Leaf[] {
  if (!live(s)) return [];
  const asked = needs.map((n) => requestCard(requestOf(s, n, server), n));
  const reviewing = (s.runs ?? [])
    .filter(
      (r) =>
        r.status === "paused" && r.pendingApproval && r.pendingApproval.answerer !== "operator",
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

function stats(s: SwarmSummary): Leaf {
  const isLiveNow = live(s);
  const left = Math.max(0, s.limits.maxTurns - s.turnsUsed);
  const busy = s.agents.filter((a) => a.status === "busy").length;
  const waiting = s.agents.filter((a) => a.status === "waiting").length;
  const seats = [
    ...(busy > 0 ? [`${busy} busy`] : []),
    ...(waiting > 0 ? [`${waiting} waiting`] : []),
  ];
  const wall = minutes(s.limits.wallClockMs);
  const items: Stat[] = [
    {
      label: "Turns",
      value: isLiveNow ? `${s.turnsUsed} of ${s.limits.maxTurns}` : s.turnsUsed,
      sub: isLiveNow ? `${left} remaining` : `of ${s.limits.maxTurns}`,
      ...(isLiveNow && left === 0 ? { tone: "warn" as const } : {}),
      ...(s.pace && s.pace.length >= 2 ? { spark: [...s.pace] } : {}),
    },
    isLiveNow
      ? {
          label: "Time",
          clock: { at: endsAt(s), mode: "until" as const },
          sub: `of ${wall} min · ends ${hhmm(endsAt(s))}`,
        }
      : { label: "Time", value: span(s.startedAt, s.endedAt) || "0 s", sub: `of ${wall} min` },
    {
      label: "Agents",
      value: `${s.agents.length} of ${s.limits.maxAgents}`,
      ...(isLiveNow && seats.length > 0 ? { sub: seats.join(" · ") } : {}),
    },
    ...(s.usage
      ? [
          {
            label: "Tokens",
            value: tokenCount(freshTokens(s.usage)),
            sub:
              s.usage.cached > 0
                ? `fresh · ${tokenCount(s.usage.cached)} cached`
                : "fresh · none cached",
          },
        ]
      : []),
  ];
  const verified = verifiedText(s);
  if (!isLiveNow && verified) {
    const runs = s.runs ?? [];
    const n = runs.filter((r) => r.verified).length;
    items.push({
      label: "Runs verified",
      value: `${n} of ${runs.length}`,
      tone: n === runs.length ? "ok" : "warn",
    });
  }
  return { kind: "stats", title: isLiveNow ? "Budget" : "Result", items };
}

// ---- Reaching the lead, reading the record, and stopping. ----

const openRecord = (s: SwarmSummary) => ({
  type: "open-record",
  label: "Open the record",
  glyph: "◷",
  hint: "The swarm's timeline, who woke whom, spend, runs and evidence.",
  payload: { id: s.id },
});

function controls(s: SwarmSummary): Leaf[] {
  if (!live(s)) return [];
  const items: Extract<Leaf, { kind: "actions" }>["items"] = [];
  if (s.status === "running" && s.conclusion === undefined) {
    items.push({ ...messageLead(s), expanded: true });
  }
  items.push(openRecord(s));
  if (s.status === "running") items.push(stopAction(s, true));
  return [{ kind: "actions", wrap: true, items }];
}

// ---- The bench: one card per agent, a ghost per open seat. ----

function agentCard(s: SwarmSummary, a: SwarmSummary["agents"][number]): Card {
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
    mono: true,
    ...(live(s) ? { pill: AGENT_PILL[a.status] } : {}),
    ...(a.lead
      ? {}
      : { bar: { value: a.turns, total: s.limits.maxTurnsPerAgent, trailing: turns } }),
    stacked: true,
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

function bench(s: SwarmSummary): Leaf {
  const open = live(s) ? Math.max(0, s.limits.maxAgents - s.agents.length) : 0;
  const items: Card[] = [
    ...s.agents.map((a) => agentCard(s, a)),
    ...Array.from({ length: open }, () => ({ title: "open seat", ghost: true })),
  ];
  return {
    kind: "cards",
    title: `Agents · ${s.agents.length} of ${s.limits.maxAgents}`,
    grid: true,
    columns: BENCH_COLUMNS,
    items: items.length > 0 ? items : [{ title: "No agents yet", ghost: true }],
  };
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

// ---- Runs, present only when the launch named workflows. ----

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

function runRows(s: SwarmSummary): Row[] {
  const runs = s.runs ?? [];
  if (runs.length === 0) {
    const may = s.workflows?.length ? s.workflows.join(", ") : "workflows";
    return [
      {
        icon: "·",
        text: live(s)
          ? `The lead may start ${may}; none started yet.`
          : `The lead could start ${may}; none started.`,
      },
    ];
  }
  return runs.flatMap((run) => {
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
  });
}

function runs(s: SwarmSummary): Leaf[] {
  if (!s.workflows?.length && !s.runs?.length) return [];
  return [{ kind: "rows", title: "Runs", items: runRows(s) }];
}

// ---- The task and the evidence the agents were given, disclosed in place. ----

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

function taskAndContext(s: SwarmSummary): Leaf[] {
  const task = s.task.trim();
  const head = firstLine(task, 80);
  const disclosed = task.length > head.length ? detailOf(task, DETAIL_CHARS) : {};
  const rows: Row[] = [
    {
      icon: "▤",
      text: `Task: ${head}`,
      ...(disclosed.detail ? { detail: disclosed.detail } : {}),
      ...(disclosed.cut ? { trailing: disclosed.cut } : {}),
    },
  ];
  let budget = CONTEXT_DETAIL_BUDGET;
  for (const c of s.context ?? []) {
    const excerpt = c.excerpt && budget > 0 ? detailOf(c.excerpt, budget) : {};
    budget -= excerpt.detail?.length ?? 0;
    const shown = excerpt.detail?.length ?? 0;
    const meta = [
      c.id,
      ...(c.retrievedAt ? [`retrieved ${day(c.retrievedAt)} ${hhmm(c.retrievedAt)}`] : []),
      ...(c.headSha ? [`at ${c.headSha.slice(0, 7)}`] : []),
      shown > 0 && shown < c.chars
        ? `first ${shown.toLocaleString("en-US")} of ${c.chars.toLocaleString("en-US")} chars`
        : `${c.chars.toLocaleString("en-US")} chars`,
    ];
    rows.push({
      icon: "◇",
      text: `${c.kind}: ${c.title}`,
      trailing: meta.join(" · "),
      ...(c.sourceUrl && !excerpt.detail ? { href: c.sourceUrl } : {}),
      ...(excerpt.detail ? { detail: excerpt.detail } : {}),
    });
  }
  return [{ kind: "rows", title: "Task and context", items: rows }];
}

// ---- Activity, newest first, repeats counted. ----

// Who an event is by, in the colors the bench gives them.
function actorChip(s: SwarmSummary, actor: string | undefined): Row["chip"] {
  if (actor === "operator") return { label: "you", tone: "neutral" };
  const a = actor ? s.agents.find((x) => x.id === actor) : undefined;
  return a ? { label: shortHandle(a.handle, s.id), tone: a.tone } : undefined;
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
        ...(earlier > 0
          ? [
              {
                icon: "▤",
                text: `Read the full log · ${plural(earlier, "earlier event")}`,
                action: { type: "read-doc", payload: { id: s.id } },
              },
            ]
          : []),
      ],
    },
  ];
}

// ---- About: where it talks, what it runs on, what went wrong. ----

function about(s: SwarmSummary): Leaf {
  const href = channelHref(s);
  const when = live(s)
    ? `started ${hhmm(s.startedAt)}`
    : `ran ${day(s.startedAt)} ${hhmm(s.startedAt)} → ${hhmm(s.endedAt)}`;
  const h = s.health;
  const warn = (text: string): Row => ({ icon: "!", glyph: "warn", text });
  const health: Row[] = [
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
    ...(!live(s) && s.error ? [{ icon: "✕", glyph: "error" as const, text: s.error }] : []),
  ];
  return {
    kind: "rows",
    title: "About",
    items: [
      {
        icon: "↗",
        text: `#${s.channelName || `swarm-${s.id}`} in ClickClack`,
        ...(href ? { href } : {}),
      },
      { icon: "◷", text: `${when}${s.project ? ` · on ${s.project.name}` : ""}` },
      { icon: "◫", text: sizeDetail(s) },
      { icon: "◆", text: modelRow(s) },
      ...(s.usage ? [{ icon: "∑", text: `${tokensText(s.usage)} tokens` }] : []),
      ...health,
      ...(live(s) ? [] : [{ icon: "←", text: "Ended swarms", action: { type: "history-open" } }]),
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

const openReport = (s: SwarmSummary) => ({
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
// card holds the answer, its page, and the way into the channel.
function conclusionCard(s: SwarmSummary, conclusion: string): Card {
  const href = channelHref(s);
  const when = s.endedAt ? ` · ${day(s.endedAt)} ${hhmm(s.endedAt)}` : "";
  return {
    title: s.report?.title ?? "Conclusion",
    ...(s.report ? { pill: { label: "report", tone: "brand" as const } } : {}),
    prose: true,
    fields: [
      {
        value:
          conclusion.length > PREVIEW_CHARS
            ? `${plain(conclusion.slice(0, PREVIEW_CHARS)).trimEnd()}…`
            : plain(conclusion),
        copyAction: { type: "copy-conclusion", payload: { id: s.id } },
      },
      ...(href ? [{ value: `↗ #${s.channelName || `swarm-${s.id}`} in ClickClack`, href }] : []),
    ],
    footnote: [
      `by @${leadHandle(s)}${when}`,
      `${conclusion.length.toLocaleString("en-US")} characters`,
      ...(s.report ? [reportKb(s)] : []),
    ].join(" · "),
    actions: [
      ...(s.report ? [openReport(s)] : []),
      { type: "read-doc", label: "Read the conclusion", glyph: "▤", payload: { id: s.id } },
    ],
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
      items: [...(launch ? [runAgainItem(s, launch)] : []), openRecord(s)],
    },
  ];
}

export interface BoardOptions {
  // The launch the swarm was started with, when the rib kept it, so it can run again.
  launch?: StartSwarmInput;
  // The ClickClack server, so a connection request can offer to start it.
  server?: ServerLine;
}

export function buildSwarmBoard(s: SwarmSummary, opts: BoardOptions = {}): CanvasBoardView {
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
    : `${sizeWord(s)} · ${plural(s.turnsUsed, "turn")}${took ? ` · ${took}` : ""} · ${modelLabel(s)}`;
  const details: Leaf[] = [
    bench(s),
    ...spend(s),
    ...runs(s),
    ...taskAndContext(s),
    ...activity(s),
    about(s),
  ];
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
      ? [...requests(s, needs, opts.server), ...outcome(s), stats(s), ...controls(s), ...details]
      : [...outcome(s), stats(s), ...verbs(s, opts.launch), ...details],
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
            text: `Swarm ${id} is no longer in the rib's history. Its channel #swarm-${id} in ClickClack keeps the transcript.`,
          },
          { icon: "←", text: "Ended swarms", action: { type: "history-open" } },
        ],
      },
    ],
  };
}
