// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView } from "@keelson/shared";
import { missingEvidence } from "../dispatch.ts";
import { modelLabel, servedModels, tokenCount, tokensText, tokenTotal } from "../labels.ts";
import { type Need, needsYou } from "../needs.ts";
import { type ChildRun, type StartingSwarm, type SwarmSummary, sizeOf } from "../types.ts";
import {
  activityText,
  channelHref,
  day,
  firstLine,
  hhmm,
  plural,
  prLabel,
  shortHandle,
  shortRun,
  span,
  threadHref,
} from "./format.ts";
import { runAgainItem } from "./launch-board.ts";
import { askGist, endedOutcome, needReason, openHint, sizeDetail } from "./parts.ts";

type Section = CanvasBoardView["sections"][number];
type Leaf = Exclude<Section, { kind: "columns" }>;
type Card = Extract<Section, { kind: "cards" }>["items"][number];
type Row = Extract<Section, { kind: "rows" }>["items"][number];
type Segment = Extract<NonNullable<Row["bar"]>, { segments: unknown }>["segments"][number];

// The conclusion on the board is a preview; the reading pane has all of it.
const PREVIEW_CHARS = 1_200;

// A board field renders text as is, so markdown's emphasis and code marks come off.
function plain(markdown: string): string {
  return markdown.replace(/\*\*|__|`/g, "");
}

const ENDED_TITLE: Record<SwarmSummary["status"], string> = {
  running: "Running",
  done: "Ended without a conclusion",
  stalled: "Stalled",
  exhausted: "Out of budget",
  stopped: "Stopped",
  error: "Failed",
};

const AGENT_GLYPH = { idle: undefined, busy: "info", capped: "warn", failed: "error" } as const;

function live(s: SwarmSummary): boolean {
  return s.status === "running";
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

function vitals(s: SwarmSummary): Leaf {
  const href = channelHref(s);
  const when = live(s)
    ? `started ${hhmm(s.startedAt)} · wall clock ends ${hhmm(new Date(Date.parse(s.startedAt) + s.limits.wallClockMs).toISOString())}`
    : `ran ${day(s.startedAt)} ${hhmm(s.startedAt)} → ${hhmm(s.endedAt)}${s.endedAt ? ` · ${span(s.startedAt, s.endedAt)}` : ""}`;
  const h = s.health;
  const health: Row[] = [
    ...(h?.socketDrops
      ? [
          {
            icon: "!",
            glyph: "warn" as const,
            text: `socket closed ${h.socketDrops} time(s) since it last opened`,
          },
        ]
      : []),
    ...(h?.channelFault
      ? [{ icon: "!", glyph: "warn" as const, text: `ClickClack fault: ${h.channelFault}` }]
      : []),
    ...(h?.lastLeadFailure
      ? [
          {
            icon: "!",
            glyph: "warn" as const,
            text: `the lead's last turn failed (${h.leadFailures ?? 1} in a row): ${h.lastLeadFailure}`,
          },
        ]
      : []),
    ...(h?.nudges
      ? [{ icon: "◌", text: `idle: nudged the lead ${h.nudges} of ${s.limits.maxNudges} times` }]
      : []),
    ...(h?.refusedConclusions
      ? [
          {
            icon: "!",
            glyph: "warn" as const,
            text: `the lead's conclusion was refused ${h.refusedConclusions} time(s) for length`,
          },
        ]
      : []),
    ...(!live(s) && s.error ? [{ icon: "✕", glyph: "error" as const, text: s.error }] : []),
  ];
  return {
    kind: "rows",
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
    ],
  };
}

function contextRows(s: SwarmSummary): Leaf[] {
  if (!s.context?.length) return [];
  return [
    {
      kind: "rows",
      title: "Context",
      items: s.context.map((c) => ({
        icon: "◇",
        text: `${c.kind}: ${c.title}`,
        ...(c.sourceUrl ? { href: c.sourceUrl } : {}),
        trailing: `${(c.chars / 1000).toFixed(1)}k chars`,
      })),
    },
  ];
}

function gateCard(s: SwarmSummary, run: ChildRun, need: Need | undefined): Card {
  const gate = run.pendingApproval;
  const thread = threadHref(s, gate?.threadId);
  const reviewer = s.agents.find((a) => !a.lead && a.status === "busy");
  return {
    title: `${gate?.nodeId ?? "gate"} · ${run.workflow} ${shortRun(run.runId)}`,
    pill: need ? { label: "needs you", tone: "caution" } : { label: "in review", tone: "info" },
    fields: [
      { label: "opened", value: hhmm(gate?.openedAt) },
      ...(thread ? [{ label: "thread", value: "gate thread", href: thread }] : []),
      { label: "run", value: shortRun(run.runId), copyable: true },
    ],
    footnote: firstLine(gate?.prompt ?? "", 200),
    ...(gate?.threadId
      ? {
          actions: [
            {
              type: "reply",
              label: "Reply in thread",
              binding: { id: s.id, runId: run.runId },
              fields: [
                {
                  name: "note",
                  label: "Reply",
                  placeholder: "Posts in the gate thread as you · Enter sends",
                  required: true,
                },
              ],
              submitLabel: "Reply",
            },
          ],
        }
      : {}),
    reason: need
      ? (needReason(s, need) ?? { text: "waiting on you" })
      : {
          label: "reviewing",
          text: reviewer
            ? `@${shortHandle(reviewer.handle, s.id)} is working; the lead answers once a peer has reviewed the plan`
            : "a peer reviews the plan in the gate thread, then the lead answers",
        },
  };
}

function askCard(s: SwarmSummary, need: Need): Card[] {
  const ask = need.ask;
  if (!ask) return [];
  const channel = channelHref(s);
  return [
    {
      title: `@${shortHandle(ask.handle, s.id)} asked you · ${hhmm(ask.at)}`,
      pill: { label: "needs you", tone: "caution" },
      fields: [
        {
          label: "message",
          value: `#${s.channelName}`,
          ...(channel ? { href: channel } : {}),
        },
      ],
      footnote: askGist(ask.text, 300),
      reason: { text: `clears when you post in #${s.channelName} or steer the lead` },
      actions: [
        { type: "read-doc", label: "Read the question", glyph: "▤", payload: { id: s.id } },
      ],
    },
  ];
}

function gateSection(s: SwarmSummary, needs: readonly Need[]): Leaf[] {
  if (!live(s)) return [];
  const gates = (s.runs ?? []).filter((r) => r.status === "paused" && r.pendingApproval);
  const asks = needs.filter((n) => n.kind === "ask").flatMap((n) => askCard(s, n));
  if (gates.length === 0 && asks.length === 0) return [];
  const needFor = (run: ChildRun) => needs.find((n) => n.run?.runId === run.runId);
  const waiting = asks.length > 0 || gates.some((r) => needFor(r));
  return [
    {
      kind: "cards",
      title: waiting ? "Waiting on you" : "Gate",
      items: [...asks, ...gates.map((r) => gateCard(s, r, needFor(r)))],
    },
  ];
}

function controls(s: SwarmSummary): Leaf[] {
  const gated = (s.runs ?? []).some((r) => r.status === "paused" && r.pendingApproval);
  const concluded = s.conclusion !== undefined;
  const items: Extract<Leaf, { kind: "actions" }>["items"] = [];
  if (gated && live(s)) {
    items.push({ type: "read-doc", label: "Read the gate", glyph: "▤", payload: { id: s.id } });
  }
  if (live(s) && !concluded) {
    items.push({
      type: "steer",
      label: "Steer",
      binding: { id: s.id },
      fields: [
        {
          name: "note",
          label: "Steer",
          placeholder: `A note for @${shortHandle(`${s.id}-lead`, s.id)} · Enter sends`,
          required: true,
        },
      ],
      expanded: true,
      submitLabel: "Send",
    });
  }
  if (live(s)) {
    const runs = (s.runs ?? []).filter((r) => r.status === "running" || r.status === "paused");
    items.push({
      type: "stop-swarm",
      label: "Stop swarm…",
      destructive: true,
      inline: true,
      payload: { id: s.id },
      confirm: {
        title: `Stop swarm ${s.id}?`,
        body:
          runs.length > 0
            ? `Its agents stop, and ${runs.length} live run(s) are cancelled: ${runs.map((r) => `${r.workflow} ${shortRun(r.runId)}`).join(", ")}.`
            : "Its agents stop and their tokens are revoked. The channel keeps the transcript.",
        confirmLabel: "Stop swarm",
      },
    });
  }
  return items.length > 0 ? [{ kind: "actions", items }] : [];
}

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
  if (run.status === "paused") {
    return `paused at ${run.pendingApproval?.nodeId ?? run.lastNode ?? "a gate"} · ${run.nodesDone} settled`;
  }
  if (run.status === "running") return `running · ${run.nodesDone} settled`;
  const pr = run.prUrls[0];
  if (run.status === "succeeded") {
    if (run.verified) return `${pr ? `${prLabel(pr)} · ` : ""}verified`;
    const missing = missingEvidence(run);
    return missing.length > 0 ? `succeeded · lacks ${missing.join(", ")}` : "succeeded";
  }
  return run.status;
}

function runRows(s: SwarmSummary): Row[] {
  const runs = s.runs ?? [];
  if (runs.length === 0) return [{ icon: "·", text: "No workflow runs." }];
  return runs.flatMap((run) => {
    const href =
      run.status === "paused" ? threadHref(s, run.pendingApproval?.threadId) : run.prUrls[0];
    const row: Row = {
      icon: "▸",
      text: `${run.workflow} ${firstLine(run.purpose, 60)}${run.isolated ? ", isolated worktree" : ", live checkout"}`,
      trailing: runStatus(run),
      bar: { segments: evidence(run) },
      ...(href ? { href } : {}),
    };
    const answers: Row[] = (run.approvals ?? []).map((a) => ({
      icon: a.decision === "approve" ? "✓" : "↺",
      glyph: a.decision === "approve" ? "ok" : "warn",
      text: `${a.nodeId} ${a.decision === "approve" ? "approved" : "sent back"} on ${a.reviewer}'s review`,
      trailing: hhmm(a.at),
    }));
    return [row, ...answers];
  });
}

function agentRows(s: SwarmSummary): Row[] {
  const lead = s.model;
  const workers = s.workerModel ?? s.model;
  const differ = Boolean(lead || workers) && lead !== workers;
  if (s.agents.length === 0) return [{ icon: "·", text: "No agents yet." }];
  return s.agents.map((a) => {
    const glyph = live(s) ? AGENT_GLYPH[a.status] : undefined;
    const count = a.lead ? plural(a.turns, "turn") : `${a.turns}/${s.limits.maxTurnsPerAgent}`;
    const turns = a.usage ? `${count} · ${tokenCount(tokenTotal(a.usage))} tokens` : count;
    return {
      chip: { label: shortHandle(a.handle, s.id), tone: a.tone },
      text: differ
        ? (a.model ?? a.servedModel ?? (s.power ? `${s.power} power` : "provider default"))
        : firstLine(a.role, 40),
      trailing: live(s) ? `${a.status} · ${turns}` : turns,
      ...(glyph ? { glyph } : {}),
    };
  });
}

function recent(s: SwarmSummary): Leaf[] {
  const entries = [...(s.activity ?? [])].reverse();
  if (entries.length === 0) return [];
  return [
    {
      kind: "rows",
      title: "Recent",
      items: entries.map((e) => ({
        text: firstLine(activityText(s.id, e.text), 90),
        trailing: hhmm(e.at),
      })),
    },
  ];
}

function reportCard(s: SwarmSummary): Card[] {
  if (!s.report) return [];
  const lead = s.agents.find((a) => a.lead);
  return [
    {
      title: s.report.title,
      pill: { label: "report", tone: "brand" },
      footnote: `by @${shortHandle(lead?.handle ?? `${s.id}-lead`, s.id)} · ${day(s.report.at)} ${hhmm(s.report.at)} · ${Math.max(1, Math.round(s.report.bytes / 1024))} KB`,
      actions: [
        {
          type: "open-report",
          label: "Open the report",
          glyph: "◧",
          tone: "brand",
          payload: { id: s.id },
        },
      ],
    },
  ];
}

function outcome(s: SwarmSummary): Leaf[] {
  if (live(s) && s.conclusion === undefined) {
    return s.report ? [{ kind: "cards", title: "Outcome", items: reportCard(s) }] : [];
  }
  const text = s.conclusion ?? s.draftConclusion;
  const byLead = s.agents.find((a) => a.lead);
  const cards: Card[] = [...reportCard(s)];
  if (s.conclusion !== undefined) {
    cards.push({
      title: "Conclusion",
      prose: true,
      fields: [
        {
          value:
            s.conclusion.length > PREVIEW_CHARS
              ? `${plain(s.conclusion.slice(0, PREVIEW_CHARS)).trimEnd()}…`
              : plain(s.conclusion),
          copyAction: { type: "copy-conclusion", payload: { id: s.id } },
        },
      ],
      footnote: `by @${shortHandle(byLead?.handle ?? `${s.id}-lead`, s.id)}${s.endedAt ? ` · ${day(s.endedAt)} ${hhmm(s.endedAt)}` : ""} · ${s.conclusion.length.toLocaleString("en-US")} characters`,
      actions: [{ type: "read-doc", label: "Read in full", glyph: "▤", payload: { id: s.id } }],
    });
  } else {
    cards.push({
      title: ENDED_TITLE[s.status],
      pill: { label: s.status, tone: s.status === "error" ? "error" : "warn" },
      reason: { text: s.error ?? "the swarm ended without a conclusion" },
      ...(text
        ? {
            footnote: "The lead's refused draft is in the reading pane.",
            actions: [
              { type: "read-doc", label: "Read the draft", glyph: "▤", payload: { id: s.id } },
            ],
          }
        : {}),
    });
  }
  return [{ kind: "cards", title: "Outcome", items: cards }];
}

function back(s: SwarmSummary): Leaf[] {
  if (live(s)) return [];
  return [
    {
      kind: "rows",
      items: [
        {
          icon: "←",
          text: "Ended swarms",
          trailing: "back",
          action: { type: "history-open" },
        },
      ],
    },
  ];
}

function rerun(s: SwarmSummary, rerunnable: boolean): Leaf[] {
  if (live(s) || !rerunnable) return [];
  return [{ kind: "actions", items: [runAgainItem(s)] }];
}

export function buildSwarmBoard(
  s: SwarmSummary,
  opts: { rerunnable?: boolean } = {},
): CanvasBoardView {
  const needs = needsYou(s);
  const pill = !live(s)
    ? { label: endedOutcome(s), tone: s.status === "done" ? ("ok" as const) : ("neutral" as const) }
    : needs.length > 0
      ? { label: "needs you", tone: "caution" as const }
      : { label: "running", tone: "info" as const };
  return {
    view: "board",
    title: `${firstLine(s.task)} · ${s.id}`,
    header: {
      status: pill,
      chip: `${s.size} · ${s.turnsUsed}/${s.limits.maxTurns} turns · ${modelLabel(s)}`,
      ...(s.agents.length > 0
        ? { people: s.agents.map((a) => ({ name: shortHandle(a.handle, s.id), tone: a.tone })) }
        : {}),
    },
    sections: [
      ...back(s),
      vitals(s),
      ...contextRows(s),
      ...outcome(s),
      ...rerun(s, opts.rerunnable === true),
      ...gateSection(s, needs),
      ...controls(s),
      {
        kind: "columns",
        columns: [
          { weight: 1.6, sections: [{ kind: "rows", title: "Runs", items: runRows(s) }] },
          {
            weight: 1,
            sections: [
              {
                kind: "rows",
                title: `Agents · ${s.agents.length} of ${s.limits.maxAgents}`,
                items: agentRows(s),
              },
              ...recent(s),
            ],
          },
        ],
      },
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
            text: `Swarm ${id} is no longer in the rib's history. Its channel #swarm-${id} in ClickClack keeps the transcript.`,
          },
          { icon: "←", text: "Ended swarms", trailing: "back", action: { type: "history-open" } },
        ],
      },
    ],
  };
}
