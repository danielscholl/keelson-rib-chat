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

interface HistoryFile {
  version: number;
  ended: SwarmSummary[];
}

export function historyPath(dataDir: string): string {
  return join(dataDir, FILE);
}

// Oldest first. A missing, unreadable, or foreign file is an empty history:
// losing old summaries must never stop a swarm from starting.
export function loadHistory(path: string): SwarmSummary[] {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<HistoryFile>;
    if (raw.version !== VERSION || !Array.isArray(raw.ended)) return [];
    return raw.ended.filter(
      (s): s is SwarmSummary =>
        typeof s === "object" && s !== null && typeof s.id === "string" && Array.isArray(s.agents),
    );
  } catch {
    return [];
  }
}

// Written to a sibling file and renamed over, so a crash mid-write leaves the
// previous history rather than half of a new one.
export function saveHistory(path: string, ended: Iterable<SwarmSummary>): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const body: HistoryFile = { version: VERSION, ended: [...ended] };
  writeFileSync(tmp, JSON.stringify(body));
  renameSync(tmp, path);
}
