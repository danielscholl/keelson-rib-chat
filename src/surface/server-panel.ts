// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView } from "@keelson/shared";
import { day, hhmm } from "./format.ts";
import type { ServerLine } from "./parts.ts";

type Section = CanvasBoardView["sections"][number];
type Row = Extract<Section, { kind: "rows" }>["items"][number];
type Item = Extract<Section, { kind: "actions" }>["items"][number];
type Pill = NonNullable<NonNullable<CanvasBoardView["header"]>["status"]>;

export type ServerVerb = "start" | "stop" | "reset";

export interface ServerOp {
  verb: ServerVerb;
  phase: "running" | "done" | "failed";
  at: string;
  error?: string;
}

export interface ServerPanelState {
  server?: ServerLine;
  op?: ServerOp;
  // Swarms live or starting; stop and reset wait for them.
  live: number;
}

export const LOG_LINES = 200;

const DOING: Record<ServerVerb, string> = {
  start: "starting",
  stop: "stopping",
  reset: "resetting",
};

function opRow(op: ServerOp): Row | undefined {
  if (op.phase === "running") return undefined;
  if (op.phase === "failed") {
    return { icon: "!", glyph: "error", text: `${op.verb} failed: ${op.error ?? "unknown error"}` };
  }
  return { icon: "✓", glyph: "ok", text: `${op.verb} finished ${hhmm(op.at)}` };
}

// The head is visible while the footer is folded, so an operation in progress
// or a failed one reports there, not in the body the operator folded away.
export function pill(state: ServerPanelState): Pill {
  const { server, op } = state;
  if (op?.phase === "running") return { label: `${DOING[op.verb]}…`, tone: "info" };
  if (op?.phase === "failed") return { label: `${op.verb} failed`, tone: "error" };
  if (!server) return { label: "unknown", tone: "neutral" };
  if (server.mode === "external") {
    if (server.running) return { label: "reachable", tone: "ok" };
    const since = server.unreachableSince ? ` since ${hhmm(server.unreachableSince)}` : "";
    return { label: `unreachable${since}`, tone: "warn" };
  }
  return server.running ? { label: "running", tone: "ok" } : { label: "stopped", tone: "neutral" };
}

function detailRows(server: ServerLine): Row[] {
  const rows: Row[] = [];
  if (server.url) {
    rows.push({
      icon: "↗",
      text: server.url.replace(/^https?:\/\//, ""),
      ...(server.running ? { href: `${server.url}/app` } : {}),
      trailing: server.mode,
    });
  }
  if (server.mode === "external") {
    rows.push({ icon: "◌", text: "Run by someone else; the rib doesn't start, stop or reset it." });
    if (server.checkedAt) {
      rows.push({
        icon: server.running ? "✓" : "!",
        glyph: server.running ? "ok" : "warn",
        text: server.running
          ? `answered the last probe at ${hhmm(server.checkedAt)}`
          : `did not answer at ${hhmm(server.checkedAt)}${server.unreachableSince ? `; unreachable since ${hhmm(server.unreachableSince)}` : ""}`,
      });
    }
    return rows;
  }
  if (server.pid) {
    const since = server.startedAt
      ? ` · up since ${day(server.startedAt)} ${hhmm(server.startedAt)}`
      : "";
    const who = server.operator ? " · started by hand" : server.adopted ? " · adopted" : "";
    rows.push({ icon: "◷", text: `process ${server.pid}${since}${who}` });
  }
  if (server.binary) rows.push({ icon: "▣", text: server.binary });
  if (server.dataDir) rows.push({ icon: "▤", text: server.dataDir });
  return rows;
}

function verbs(state: ServerPanelState): Item[] {
  const { server, op, live } = state;
  if (server?.mode === "external") {
    return [
      {
        type: "server-probe",
        label: "Retry",
        glyph: "↻",
        hint: "Probes the server again and updates the footer.",
      },
    ];
  }
  if (server?.mode !== "managed") return [];
  const busy = op?.phase === "running" ? `A ${op.verb} is still running.` : undefined;
  const waits =
    live > 0 ? `${live} swarm${live === 1 ? " is" : "s are"} live; stop them first.` : undefined;
  const gate = (reason: string | undefined) => (reason ? { disabled: true, reason } : {});
  const items: Item[] = [];
  if (!server.running) {
    items.push({
      type: "server-start",
      label: "Start",
      glyph: "▶",
      hint: "Starts the managed server. A swarm also starts it on demand.",
      ...gate(busy),
    });
  } else {
    items.push({
      type: "server-stop",
      label: "Stop",
      glyph: "■",
      hint: "Stops the server. Channels and transcripts stay on disk.",
      ...gate(busy ?? waits),
    });
  }
  items.push(
    {
      type: "server-reset",
      label: "Reset…",
      glyph: "↺",
      destructive: true,
      inline: true,
      hint: "Deletes every channel, transcript, bot and session, and starts the server empty.",
      confirm: {
        irreversible: true,
        subject: "reset",
        title: "Reset ClickClack?",
        body: "This deletes every channel, transcript, bot and session, and forgets the ended swarms on this tab. It can't be undone.",
        confirmLabel: "Reset",
      },
      ...gate(busy ?? waits),
    },
    {
      type: "server-log",
      label: "Log",
      glyph: "▤",
      hint: `Opens the last ${LOG_LINES} lines of the server log.`,
    },
  );
  return items;
}

export function buildServerPanel(state: ServerPanelState): CanvasBoardView {
  const op = state.op ? opRow(state.op) : undefined;
  const rows = [
    ...(state.server ? detailRows(state.server) : [{ icon: "◌", text: "Checking the server…" }]),
    ...(op ? [op] : []),
  ];
  const items = verbs(state);
  return {
    view: "board",
    title: "ClickClack",
    header: { status: pill(state) },
    sections: [
      { kind: "rows", items: rows },
      ...(items.length > 0 ? [{ kind: "actions" as const, wrap: true, items }] : []),
    ],
  };
}
