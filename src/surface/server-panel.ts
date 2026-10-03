// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView } from "@keelson/shared";
import { day, hhmm } from "./format.ts";
import { type ServerLine, serverAddress, serverState } from "./parts.ts";

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

// An operation in progress or a failed one is the newest fact.
export function pill(state: ServerPanelState): Pill {
  const { server, op } = state;
  if (op?.phase === "running") return { label: `${DOING[op.verb]}…`, tone: "info" };
  if (op?.phase === "failed") return { label: `${op.verb} failed`, tone: "error" };
  if (!server) return { label: "unknown", tone: "neutral" };
  return {
    label: serverState(server),
    tone: server.running ? "ok" : server.mode === "external" ? "warn" : "neutral",
  };
}

function detailRows(server: ServerLine): Row[] {
  const rows: Row[] = [];
  if (server.url) {
    rows.push({
      text: "Address",
      trailing: serverAddress(server),
      ...(server.running ? { href: `${server.url}/app` } : {}),
    });
  }
  rows.push({
    text: "Mode",
    trailing:
      server.mode === "managed"
        ? "managed · the rib starts, stops and resets it"
        : "external · run by someone else; the rib doesn't start, stop or reset it",
  });
  if (server.mode === "external") {
    if (server.checkedAt) {
      rows.push({
        text: "Last probe",
        trailing: server.running
          ? `answered at ${hhmm(server.checkedAt)}`
          : `no answer at ${hhmm(server.checkedAt)}${server.unreachableSince ? `; unreachable since ${hhmm(server.unreachableSince)}` : ""}`,
      });
    }
    return rows;
  }
  const who = server.operator ? " · started by hand" : server.adopted ? " · adopted" : "";
  rows.push({
    text: "Process",
    trailing: server.pid ? `${server.pid}${who}` : "not running",
  });
  if (server.startedAt) {
    rows.push({ text: "Started", trailing: `${day(server.startedAt)} ${hhmm(server.startedAt)}` });
  }
  if (server.binary) rows.push({ text: "Binary", trailing: server.binary });
  if (server.dataDir) rows.push({ text: "Data directory", trailing: server.dataDir });
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
        hint: "Probes the server again and updates the server line.",
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
  const items = verbs(state);
  return {
    view: "board",
    title: "ClickClack server",
    header: { status: pill(state) },
    sections: [
      state.server
        ? { kind: "rows", boxed: true, items: detailRows(state.server) }
        : { kind: "rows", items: [{ text: "Checking the server…" }] },
      ...(op ? [{ kind: "rows" as const, items: [op] }] : []),
      ...(items.length > 0 ? [{ kind: "actions" as const, wrap: true, items }] : []),
    ],
  };
}
