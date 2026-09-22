// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CanvasBoardView } from "@keelson/shared";
import type { ServerTarget } from "../server-tools.ts";
import { day, hhmm } from "./format.ts";
import type { ServerLine } from "./index-board.ts";

type Section = CanvasBoardView["sections"][number];
type Row = Extract<Section, { kind: "rows" }>["items"][number];
type Item = Extract<Section, { kind: "actions" }>["items"][number];

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
  // Workflows whose gates the host keeps for the operator.
  refused: readonly string[];
}

export const LOG_LINES = 200;

const DOING: Record<ServerVerb, string> = {
  start: "starting",
  stop: "stopping",
  reset: "resetting",
};

function opRow(op: ServerOp): Row {
  if (op.phase === "running") return { icon: "◌", glyph: "info", text: `${DOING[op.verb]}…` };
  if (op.phase === "failed") {
    return { icon: "!", glyph: "error", text: `${op.verb} failed: ${op.error ?? "unknown error"}` };
  }
  return { icon: "✓", glyph: "ok", text: `${op.verb} finished ${hhmm(op.at)}` };
}

function pill(server: ServerLine | undefined): { label: string; tone: "ok" | "neutral" | "warn" } {
  if (!server) return { label: "unknown", tone: "neutral" };
  if (server.running) return { label: "running", tone: "ok" };
  return server.mode === "managed"
    ? { label: "stopped", tone: "neutral" }
    : { label: "unreachable", tone: "warn" };
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
  const rows = [
    ...(state.server ? detailRows(state.server) : [{ icon: "◌", text: "Checking the server…" }]),
    ...(state.op ? [opRow(state.op)] : []),
  ];
  const items = verbs(state);
  return {
    view: "board",
    title: "ClickClack",
    header: { status: pill(state.server) },
    sections: [
      { kind: "rows", items: rows },
      ...(state.refused.length > 0
        ? [
            {
              kind: "rows" as const,
              title: "Gates the host keeps for you",
              items: state.refused.map((w) => ({
                icon: "!",
                glyph: "warn" as const,
                text: w,
                trailing: "answer in the Workflows tab",
              })),
            },
          ]
        : []),
      ...(items.length > 0 ? [{ kind: "actions" as const, wrap: true, items }] : []),
    ],
  };
}

export interface ServerOpsDeps {
  target: () => Promise<ServerTarget>;
  liveCount: () => number;
  // Reset wipes the channels, so the ended swarms that point at them go too.
  clearEnded: () => void;
  changed: () => void;
  now?: () => string;
}

export interface ServerOps {
  current(): ServerOp | undefined;
  // Checks the verb can run and starts it in the background; returns why not.
  run(verb: ServerVerb): Promise<string | undefined>;
}

export function createServerOps(deps: ServerOpsDeps): ServerOps {
  let op: ServerOp | undefined;
  const now = deps.now ?? (() => new Date().toISOString());
  return {
    current: () => op,
    async run(verb) {
      if (op?.phase === "running") return `a ${op.verb} is still running`;
      const target = await deps.target();
      if (target.mode !== "managed") {
        return `ClickClack is external (${target.url}); the rib does not manage it`;
      }
      const live = deps.liveCount();
      if (verb !== "start" && live > 0) return `${live} swarm(s) live; stop them before a ${verb}`;
      const server = target.server;
      op = { verb, phase: "running", at: now() };
      deps.changed();
      void (async () => {
        try {
          if (verb === "start") await server.ensure();
          else if (verb === "stop") await server.stop();
          else {
            await server.reset();
            deps.clearEnded();
          }
          op = { verb, phase: "done", at: now() };
        } catch (e) {
          op = {
            verb,
            phase: "failed",
            at: now(),
            error: e instanceof Error ? e.message : String(e),
          };
        }
        deps.changed();
      })();
      return undefined;
    },
  };
}
