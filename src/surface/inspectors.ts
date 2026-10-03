// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView } from "@keelson/shared";
import type { OperatorAsk, SwarmSummary } from "../types.ts";
import { shortHandle, threadHref } from "./format.ts";
import { askText, dismissAskAction, replyAction, sinceClock } from "./parts.ts";

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
