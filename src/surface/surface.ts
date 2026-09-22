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
  type RibViewDescriptor,
  type SnapshotManager,
} from "@keelson/shared";
import type { SwarmChange } from "../swarm.ts";
import type { StartingSwarm, SwarmSummary } from "../types.ts";
import { buildDoc } from "./doc.ts";
import { buildHistory, buildIndex, type SurfaceState } from "./index-board.ts";
import { docKey, HISTORY_KEY, INDEX_KEY, swarmKey } from "./keys.ts";
import { createKeyPublisher, type KeyPublisher } from "./publisher.ts";
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
  dispose(): void;
}

const DOC_KINDS = new Set<SwarmChange>(["start", "gate", "conclusion", "end"]);

function markdown(key: string) {
  return (data: unknown): string => {
    if (typeof data !== "string") throw new Error(`${key} expects markdown text`);
    return data;
  };
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
  const history = createKeyPublisher<CanvasView>(
    sm,
    HISTORY_KEY,
    () => buildHistory(deps.state()),
    expectView(HISTORY_KEY, "board"),
    windowMs,
  );
  const swarms = new Map<string, { board: KeyPublisher; doc: KeyPublisher }>();

  const composeBoard = (id: string): CanvasView => {
    const found = deps.find(id);
    const summary = found.live ?? found.ended;
    if (summary) return buildSwarmBoard(summary);
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
      markdown(docKey(id)),
      windowMs,
    );
    swarms.set(id, { board, doc });
    deps.views.push({ key: docKey(id), canvasKind: "markdown", title: `Swarm ${id}` });
    return true;
  }

  function release(id: string): void {
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
    for (const id of ids) added = register(id) || added;
    if (!added) return;
    trim();
    deps.invalidateManifest?.();
  }

  return {
    track,
    changed(id, kind) {
      track([id]);
      index.schedule();
      const entry = swarms.get(id);
      entry?.board.schedule();
      if (DOC_KINDS.has(kind)) entry?.doc.schedule();
      if (kind === "end") history.schedule();
    },
    refresh() {
      index.schedule();
      history.schedule();
    },
    dispose() {
      for (const id of [...swarms.keys()]) release(id);
      index.release();
      history.release();
    },
  };
}
