// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasActionItem, CanvasBoardView } from "@keelson/shared";
import type { ChildRun, GateFileText, OperatorAsk, SwarmSummary } from "../types.ts";
import { shortHandle, shortRun, threadHref } from "./format.ts";
import { askText, dismissAskAction, gateIdentity, replyAction, sinceClock } from "./parts.ts";

type Card = Extract<CanvasBoardView["sections"][number], { kind: "cards" }>["items"][number];

function writable(s: SwarmSummary): boolean {
  return s.status === "running" && !s.endedAt && s.conclusion === undefined;
}

export function buildQuestionInspector(s: SwarmSummary, ask: OperatorAsk): CanvasBoardView {
  const open = s.health?.asks?.some((current) => current.messageId === ask.messageId);
  const actionable = writable(s) && open;
  const href = threadHref(s, ask.threadRootId) ?? threadHref(s, ask.messageId);
  return {
    view: "board",
    title: `Question · ${s.id}`,
    sections: [
      {
        kind: "cards",
        title: "Question",
        items: [
          {
            title: `@${shortHandle(ask.handle, s.id)} asked`,
            prose: true,
            fields: [
              { value: askText(ask.text) },
              { value: `Asked ${ask.at}` },
              ...(actionable ? sinceClock({ kind: "question", since: ask.at, ask }) : []),
            ],
            ...(!actionable
              ? {
                  footnote: open
                    ? "Read-only: the swarm is no longer accepting replies."
                    : "Read-only: this question is no longer open.",
                }
              : {}),
          },
        ],
      },
      {
        kind: "rows",
        title: "Thread",
        items: [
          { text: href ? "thread ↗" : "Thread link not recorded.", ...(href ? { href } : {}) },
        ],
      },
      ...(actionable
        ? [
            {
              kind: "actions" as const,
              title: "Actions",
              wrap: true,
              items: [
                replyAction(
                  s,
                  { threadRootId: ask.threadRootId, messageId: ask.messageId },
                  "the thread",
                ),
                dismissAskAction(s, ask.messageId),
              ],
            },
          ]
        : []),
    ],
  };
}

function gateFileCard(file: GateFileText): Card {
  const notices = [
    ...(file.error ? [`Could not be read: ${file.error}`] : []),
    ...(file.text === undefined && !file.error ? ["File text not recorded."] : []),
    ...(file.text === "" ? [file.truncated ? "No text retained." : "Empty file."] : []),
    ...(file.truncated ? ["Truncated by the host or rib; only retained text is shown."] : []),
  ];
  return {
    title: file.path,
    prose: true,
    ...(file.text !== undefined ? { fields: [{ value: file.text }] } : {}),
    ...(notices.length ? { footnote: notices.join(" ") } : {}),
  };
}

export function buildGateInspector(s: SwarmSummary, run: ChildRun): CanvasBoardView {
  const gate = run.pendingApproval;
  const identity = gateIdentity(run);
  const current = s.runs?.find((current) => current.runId === run.runId);
  const actionable =
    writable(s) &&
    run.status === "paused" &&
    current?.status === "paused" &&
    identity !== undefined &&
    gateIdentity(current) === identity;
  const href = threadHref(s, gate?.threadId);
  const actions: CanvasActionItem[] = [
    ...(actionable && gate?.threadId && identity
      ? [replyAction(s, { runId: run.runId, gateIdentity: identity }, "the gate thread")]
      : []),
    ...(actionable && gate?.answerer === "operator"
      ? [
          {
            type: "open-run",
            label: "Open run",
            hint: "Opens the run beside the tab, where you answer its approval.",
            binding: { id: s.id, runId: run.runId, gateIdentity: identity },
          },
        ]
      : []),
  ];
  return {
    view: "board",
    title: `Gate · ${s.id}`,
    sections: [
      {
        kind: "cards",
        title: "Gate",
        items: [
          {
            title: `${gate?.nodeId ?? "Gate unavailable"} · ${run.workflow} ${shortRun(run.runId)}`,
            prose: true,
            fields: [
              { value: gate?.prompt ?? "Gate prompt not recorded." },
              ...(actionable ? sinceClock({ kind: "decide", since: gate?.openedAt, run }) : []),
            ],
            ...(!actionable ? { footnote: "Read-only: this gate is no longer actionable." } : {}),
          },
        ],
      },
      ...(gate?.files?.length
        ? [{ kind: "cards" as const, title: "Files", items: gate.files.map(gateFileCard) }]
        : [
            { kind: "rows" as const, title: "Files", items: [{ text: "No gate files recorded." }] },
          ]),
      {
        kind: "rows",
        title: "Review",
        items: [
          {
            text: gate?.reviewer
              ? `Reviewer: @${shortHandle(gate.reviewer, s.id)}`
              : "Reviewer not recorded.",
          },
          { text: gate?.openedAt ? `Opened ${gate.openedAt}` : "Gate opening time not recorded." },
          { text: href ? "thread ↗" : "Thread link not recorded.", ...(href ? { href } : {}) },
        ],
      },
      ...(actions.length
        ? [{ kind: "actions" as const, title: "Actions", wrap: true, items: actions }]
        : []),
    ],
  };
}
