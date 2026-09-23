// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import {
  type CanvasView,
  expectView,
  type RibSurfaceBadge,
  type RibViewDescriptor,
  type SnapshotManager,
} from "@keelson/shared";
import type { SwarmReport } from "../report.ts";
import type { SwarmChange } from "../swarm.ts";
import type { StartSwarmInput } from "../tools.ts";
import type { StartingSwarm, SwarmSummary } from "../types.ts";
import { buildDoc } from "./doc.ts";
import { buildBadge, buildHistory, buildIndex, type SurfaceState } from "./index-board.ts";
import {
  BADGE_KEY,
  docKey,
  HISTORY_KEY,
  INDEX_KEY,
  LAUNCH_KEY,
  recordKey,
  reportKey,
  SERVER_KEY,
  SERVER_LOG_KEY,
  swarmKey,
} from "./keys.ts";
import { buildLaunch, type LaunchState } from "./launch-board.ts";
import { createKeyPublisher, type KeyPublisher } from "./publisher.ts";
import { buildGoneRecord, buildRecord } from "./record.ts";
import { buildServerPanel, type ServerPanelState } from "./server-panel.ts";
import { buildGoneBoard, buildStartingBoard, buildSwarmBoard } from "./swarm-board.ts";

// Keys outlive their swarm, since a client that gets a 404 on a key stops
// listening for good. Past this many swarms the oldest ended ones are released.
export const MAX_SWARM_KEYS = 100;

export interface SwarmRecord {
  live?: SwarmSummary;
  starting?: StartingSwarm;
  ended?: SwarmSummary;
}

export interface SurfaceDeps {
  sm: SnapshotManager;
  state: () => SurfaceState;
  find: (id: string) => SwarmRecord;
  launch: () => LaunchState;
  server: () => ServerPanelState;
  readLog: () => Promise<string>;
  report: (id: string) => SwarmReport | undefined;
  // An ended swarm's launch, when the rib kept it, so it can run again.
  launchOf: (id: string) => StartSwarmInput | undefined;
  // The rib's own views array; the host re-reads it on a manifest refresh.
  views: RibViewDescriptor[];
  invalidateManifest?: () => void;
  windowMs?: number;
}

export interface SwarmsSurface {
  track(ids: readonly string[]): void;
  changed(id: string, kind: SwarmChange): void;
  // Recompose the index and history, for a change no swarm reports: the server
  // row, or history cleared by a reset.
  refresh(): void;
  // Reads the server log afresh for the log pane.
  logOpened(): void;
  dispose(): void;
}

const DOC_KINDS = new Set<SwarmChange>([
  "start",
  "turn",
  "gate",
  "run",
  "conclusion",
  "health",
  "activity",
  "end",
]);

// A record reloads its frame on every new document, so it redraws when the
// swarm's course changes, at most this often.
const RECORD_WINDOW_MS = 5_000;
const RECORD_KINDS = new Set<SwarmChange>([
  "turn",
  "agent",
  "run",
  "gate",
  "conclusion",
  "report",
  "end",
]);

function text(key: string) {
  return (data: unknown): string => {
    if (typeof data !== "string") throw new Error(`${key} expects text`);
    return data;
  };
}

function badgeOf(data: unknown): RibSurfaceBadge {
  const count = (data as RibSurfaceBadge | null)?.count;
  if (!Number.isInteger(count) || (count as number) < 0) {
    throw new Error(`${BADGE_KEY} expects a whole count`);
  }
  return data as RibSurfaceBadge;
}

export function createSwarmsSurface(deps: SurfaceDeps): SwarmsSurface {
  const { sm, windowMs } = deps;
  const index = createKeyPublisher<CanvasView>(
    sm,
    INDEX_KEY,
    () => buildIndex(deps.state()),
    expectView(INDEX_KEY, "board"),
    windowMs,
  );
  const badge = createKeyPublisher<RibSurfaceBadge>(
    sm,
    BADGE_KEY,
    () => buildBadge(deps.state()),
    badgeOf,
    windowMs,
  );
  const history = createKeyPublisher<CanvasView>(
    sm,
    HISTORY_KEY,
    () => buildHistory(deps.state()),
    expectView(HISTORY_KEY, "board"),
    windowMs,
  );
  const launch = createKeyPublisher<CanvasView>(
    sm,
    LAUNCH_KEY,
    () => buildLaunch(deps.launch()),
    expectView(LAUNCH_KEY, "board"),
    windowMs,
  );
  const server = createKeyPublisher<CanvasView>(
    sm,
    SERVER_KEY,
    () => buildServerPanel(deps.server()),
    expectView(SERVER_KEY, "board"),
    windowMs,
  );
  const log = createKeyPublisher<string>(
    sm,
    SERVER_LOG_KEY,
    () => deps.readLog(),
    text(SERVER_LOG_KEY),
    windowMs,
  );
  deps.views.push({ key: SERVER_LOG_KEY, canvasKind: "log", title: "ClickClack log" });
  const swarms = new Map<string, { board: KeyPublisher; doc: KeyPublisher }>();

  const composeBoard = (id: string): CanvasView => {
    const found = deps.find(id);
    const summary = found.live ?? found.ended;
    if (summary) {
      const launch = found.ended ? deps.launchOf(id) : undefined;
      const server = found.live ? deps.state().server : undefined;
      return buildSwarmBoard(summary, {
        ...(launch ? { launch } : {}),
        ...(server ? { server } : {}),
      });
    }
    if (found.starting) return buildStartingBoard(found.starting);
    return buildGoneBoard(id);
  };

  function register(id: string): boolean {
    if (swarms.has(id)) return false;
    const board = createKeyPublisher<CanvasView>(
      sm,
      swarmKey(id),
      () => composeBoard(id),
      expectView(swarmKey(id), "board"),
      windowMs,
    );
    const doc = createKeyPublisher<string>(
      sm,
      docKey(id),
      () => {
        const found = deps.find(id);
        return buildDoc(found.live ?? found.ended, id);
      },
      text(docKey(id)),
      windowMs,
    );
    swarms.set(id, { board, doc });
    deps.views.push({ key: docKey(id), canvasKind: "markdown", title: `Swarm ${id}` });
    return true;
  }

  const reports = new Map<string, KeyPublisher>();

  // A report key exists only once the lead has published one.
  function ensureReport(id: string, republish = false): boolean {
    const held = reports.get(id);
    if (held) {
      if (republish) held.schedule();
      return false;
    }
    const page = deps.report(id);
    if (!page) return false;
    const key = reportKey(id);
    reports.set(
      id,
      createKeyPublisher<string>(
        sm,
        key,
        () => deps.report(id)?.html ?? "",
        (data: unknown) => {
          if (typeof data !== "string" || data.length === 0) {
            throw new Error(`${key} expects a non-empty html page`);
          }
          return data;
        },
        windowMs,
      ),
    );
    deps.views.push({ key, canvasKind: "html", title: page.title });
    return true;
  }

  const records = new Map<string, KeyPublisher>();

  // Registered with the swarm's other keys, since the host must know a key is
  // html before an action opens it. An ended swarm's record composes once.
  function ensureRecord(id: string): boolean {
    if (records.has(id)) return false;
    const found = deps.find(id);
    if (!found.live && !found.ended) return false;
    const key = recordKey(id);
    records.set(
      id,
      createKeyPublisher<string>(
        sm,
        key,
        () => {
          const now = deps.find(id);
          const summary = now.live ?? now.ended;
          return summary ? buildRecord(summary, new Date()) : buildGoneRecord(id);
        },
        (data: unknown) => {
          if (typeof data !== "string" || data.length === 0) {
            throw new Error(`${key} expects a non-empty html page`);
          }
          return data;
        },
        windowMs ?? RECORD_WINDOW_MS,
      ),
    );
    deps.views.push({ key, canvasKind: "html", title: `Record · ${id}` });
    return true;
  }

  function release(id: string): void {
    const record = records.get(id);
    if (record) {
      record.release();
      records.delete(id);
      const at = deps.views.findIndex((v) => v.key === recordKey(id));
      if (at >= 0) deps.views.splice(at, 1);
    }
    const report = reports.get(id);
    if (report) {
      report.release();
      reports.delete(id);
      const at = deps.views.findIndex((v) => v.key === reportKey(id));
      if (at >= 0) deps.views.splice(at, 1);
    }
    const entry = swarms.get(id);
    if (!entry) return;
    entry.board.release();
    entry.doc.release();
    swarms.delete(id);
    const at = deps.views.findIndex((v) => v.key === docKey(id));
    if (at >= 0) deps.views.splice(at, 1);
  }

  function trim(): void {
    for (const id of swarms.keys()) {
      if (swarms.size <= MAX_SWARM_KEYS) return;
      const found = deps.find(id);
      if (!found.live && !found.starting) release(id);
    }
  }

  function track(ids: readonly string[]): void {
    let added = false;
    for (const id of ids) {
      added = register(id) || added;
      added = ensureReport(id) || added;
      added = ensureRecord(id) || added;
    }
    if (!added) return;
    trim();
    deps.invalidateManifest?.();
  }

  return {
    track,
    changed(id, kind) {
      track([id]);
      if (kind === "report" && ensureReport(id, true)) deps.invalidateManifest?.();
      index.schedule();
      badge.schedule();
      const entry = swarms.get(id);
      entry?.board.schedule();
      if (DOC_KINDS.has(kind)) entry?.doc.schedule();
      if (RECORD_KINDS.has(kind)) records.get(id)?.schedule();
      if (kind === "end") history.schedule();
      if (kind === "start" || kind === "end") launch.schedule();
      if (kind === "gate" || kind === "start" || kind === "end") {
        server.schedule();
        launch.schedule();
      }
    },
    refresh() {
      index.schedule();
      badge.schedule();
      history.schedule();
      launch.schedule();
      server.schedule();
    },
    logOpened() {
      log.schedule();
    },
    dispose() {
      for (const id of [...swarms.keys(), ...records.keys()]) release(id);
      index.release();
      badge.release();
      history.release();
      launch.release();
      server.release();
      log.release();
      const at = deps.views.findIndex((v) => v.key === SERVER_LOG_KEY);
      if (at >= 0) deps.views.splice(at, 1);
    },
  };
}
