// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SwarmSummary } from "./types.ts";

const FILE = "swarms.json";
const VERSION = 1;

export interface History {
  // Oldest first.
  ended: SwarmSummary[];
  // Workflows whose gates the host refused to let the chat rib answer.
  refusedApprovals: string[];
}

interface HistoryFile extends History {
  version: number;
}

export function historyPath(dataDir: string): string {
  return join(dataDir, FILE);
}

// A missing, unreadable, or foreign file is an empty history: losing old
// summaries must never stop a swarm from starting.
export function loadHistory(path: string): History {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<HistoryFile>;
    if (raw.version !== VERSION || !Array.isArray(raw.ended)) return empty();
    return {
      ended: raw.ended.filter(
        (s): s is SwarmSummary =>
          typeof s === "object" &&
          s !== null &&
          typeof s.id === "string" &&
          Array.isArray(s.agents),
      ),
      refusedApprovals: Array.isArray(raw.refusedApprovals)
        ? raw.refusedApprovals.filter((w): w is string => typeof w === "string")
        : [],
    };
  } catch {
    return empty();
  }
}

function empty(): History {
  return { ended: [], refusedApprovals: [] };
}

// Written to a sibling file and renamed over, so a crash mid-write leaves the
// previous history rather than half of a new one.
export function saveHistory(path: string, history: History): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const body: HistoryFile = { version: VERSION, ...history };
  writeFileSync(tmp, JSON.stringify(body));
  renameSync(tmp, path);
}
