// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView } from "@keelson/shared";
import { freshTokens, tokenCount } from "../labels.ts";
import { agentMessageRefusal, isLive, type SwarmSummary, type TurnSpan } from "../types.ts";
import {
  channelHref,
  day,
  firstLine,
  hhmm,
  messageLine,
  plain,
  prLabel,
  shortHandle,
  span,
  threadHref,
} from "./format.ts";
import { turnMeter } from "./parts.ts";
import { AGENT_PILL, DETAIL_CHARS, openRecord } from "./swarm-board.ts";

type Section = CanvasBoardView["sections"][number];
type Row = Extract<Section, { kind: "rows" }>["items"][number];
type Agent = SwarmSummary["agents"][number];

export const INSPECTOR_TURNS_SHOWN = 40;

function wakeSources(s: SwarmSummary, t: TurnSpan): string {
  const labels: Record<string, string> = {
    operator: "you",
    rib: "kickoff / rib notice",
    runs: "run updates",
    nudge: "idle nudge",
  };
  return (
    [...new Set(t.wokeBy)]
      .map((id) => {
        const a = s.agents.find((a) => a.id === id);
        return a
          ? `@${shortHandle(a.handle, s.id)}`
          : (labels[id] ?? `unknown source ${firstLine(id, 64)}`);
      })
      .join(", ") || "not recorded"
  );
}

function turnText(s: SwarmSummary, t: TurnSpan): string {
  const active = isLive(s.status) && !s.endedAt && !t.endedAt;
  return `Turn ${t.n} · ${day(t.startedAt)} ${hhmm(t.startedAt)} → ${t.endedAt ? hhmm(t.endedAt) : active ? "in progress" : "end not recorded"} · ${t.outcome ?? (active ? "running" : "outcome not recorded")}${t.endedAt ? ` · took ${span(t.startedAt, t.endedAt)}` : ""}`;
}

export function buildAgentInspector(s: SwarmSummary, a: Agent): CanvasBoardView {
  const turns = (s.spans ?? [])
    .filter((t) => t.agentId === a.id)
    .slice()
    .reverse();
  const current = turns.find((t) => !t.endedAt) ?? turns[0];
  const clock =
    current && !current.endedAt && isLive(s.status) && !s.endedAt && a.status === "busy";
  const parent = s.agents.find((parent) => parent.id === a.spawnedBy);
  const pr = (s.prs ?? []).find((p) => p.agent === a.handle && (!a.prUrl || p.url === a.prUrl));
  const prUrl = a.prUrl ?? pr?.url;
  const href = channelHref(s);
  const refusal = agentMessageRefusal(s, a);
  const writableSwarm = s.status === "running" && !s.endedAt && s.conclusion === undefined;
  const facts: Row[] = [
    ...(current
      ? [{ text: turnText(s, current) }, { text: `Woken by ${wakeSources(s, current)}` }]
      : [{ text: "No turn spans recorded." }]),
    {
      text: a.usage
        ? `${tokenCount(freshTokens(a.usage))} fresh tokens · ${tokenCount(a.usage.cached)} cached`
        : "Token usage not reported.",
    },
    {
      text: `Served model: ${a.servedModel ?? "not reported"} · provider: ${a.providerId ?? "not reported"}`,
    },
    {
      text: a.lead
        ? `Lead · started with the swarm at ${day(s.startedAt)} ${hhmm(s.startedAt)}`
        : a.spawnedBy
          ? `Spawned by ${parent ? `@${shortHandle(parent.handle, s.id)}` : `${firstLine(a.spawnedBy, 64)} (parent not recorded)`}`
          : "Spawn provenance not recorded.",
      ...(a.joinedAt ? { trailing: `joined ${day(a.joinedAt)} ${hhmm(a.joinedAt)}` } : {}),
    },
    ...(!a.joinedAt ? [{ text: "Join time not recorded." }] : []),
    ...(a.worktree
      ? [{ text: `Worktree: ${a.worktree.path}` }, { text: `Branch: ${a.worktree.branch}` }]
      : pr
        ? [{ text: "Worktree not recorded." }, { text: `Branch: ${pr.branch}` }]
        : []),
    ...(prUrl
      ? [
          {
            text: `Draft ${prLabel(prUrl)} · CI ${pr?.ci?.verdict ?? "not reported"}`,
            href: prUrl,
            ...(pr?.ci?.detail ? { detail: firstLine(pr.ci.detail, DETAIL_CHARS) } : {}),
          },
          { text: "Open PR", href: prUrl },
        ]
      : []),
  ];
  const said = (s.recent ?? [])
    .filter((m) => m.author === a.id)
    .slice()
    .reverse();
  return {
    view: "board",
    title: `Agent @${shortHandle(a.handle, s.id)} · ${s.id}`,
    sections: [
      {
        kind: "cards",
        items: [
          {
            title: `@${shortHandle(a.handle, s.id)}`,
            titleTone: a.tone,
            pill: AGENT_PILL[a.status],
            bar: a.lead
              ? turnMeter(s)
              : {
                  value: a.turns,
                  total: s.limits.maxTurnsPerAgent,
                  label: "Worker turns used",
                  trailing: `${a.turns} of ${s.limits.maxTurnsPerAgent}`,
                },
            fields: [
              { value: firstLine(a.role, DETAIL_CHARS) },
              ...(a.lead
                ? [
                    {
                      value: `${a.turns} agent turns · no worker cap; meter shows the swarm budget`,
                    },
                  ]
                : []),
              ...(current ? [{ value: turnText(s, current) }] : []),
              ...(clock && current
                ? [
                    {
                      label: "on this turn",
                      clock: { at: current.startedAt, mode: "since" as const },
                    },
                  ]
                : []),
            ],
          },
        ],
      },
      { kind: "rows", title: "Facts", items: facts },
      {
        kind: "rows",
        title: "Said · recent messages only",
        items: said.length
          ? said.map((m) => {
              const href = threadHref(s, m.threadRootId ?? m.id);
              return {
                text: messageLine(s.id, m.text),
                detail: plain(m.text).slice(0, DETAIL_CHARS),
                trailing: hhmm(m.at),
                ...(href ? { href } : {}),
              };
            })
          : [{ text: "No messages by this agent in the recent buffer." }],
      },
      {
        kind: "rows",
        title:
          turns.length > INSPECTOR_TURNS_SHOWN
            ? `Turns · newest ${INSPECTOR_TURNS_SHOWN} of ${turns.length}`
            : "Turns",
        items: turns.length
          ? turns
              .slice(0, INSPECTOR_TURNS_SHOWN)
              .map((t) => ({ text: turnText(s, t), detail: `Woken by ${wakeSources(s, t)}` }))
          : [{ text: "No turn spans recorded." }],
      },
      ...(turns.length > INSPECTOR_TURNS_SHOWN
        ? [
            {
              kind: "actions" as const,
              items: [
                { ...openRecord(s), hint: "All recorded turns are on the record's timeline." },
              ],
            },
          ]
        : []),
      ...(writableSwarm
        ? [
            {
              kind: "actions" as const,
              wrap: true,
              items: [
                {
                  type: "message-agent",
                  label: `Message @${shortHandle(a.handle, s.id)}`,
                  expanded: true,
                  binding: { id: s.id, agentId: a.id },
                  fields: [
                    {
                      name: "note",
                      label: "Message",
                      required: true,
                      placeholder: "posts as you, wakes this agent, spends a turn",
                    },
                  ],
                  submitLabel: "Send",
                  pendingLabel: "Sending...",
                  ...(refusal ? { disabled: true, reason: refusal } : {}),
                },
              ],
            },
          ]
        : []),
      ...(refusal ? [{ kind: "rows" as const, items: [{ text: refusal }] }] : []),
      { kind: "rows", items: [{ text: "its messages · transcript ↗", ...(href ? { href } : {}) }] },
    ],
  };
}
