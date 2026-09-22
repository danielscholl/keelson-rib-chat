// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StartSwarmInput } from "./tools.ts";

const DIR = "launches";
const ID = /^s[a-z0-9]{4,12}$/;

// What each swarm was started with, context bodies included, so an ended swarm
// can run again. One file per swarm keeps swarms.json small.
export interface LaunchStore {
  save(id: string, input: StartSwarmInput): void;
  load(id: string): StartSwarmInput | undefined;
  has(id: string): boolean;
  // Drops every launch whose swarm the rib no longer knows.
  keepOnly(ids: ReadonlySet<string>): void;
  clear(): void;
}

export function createLaunchStore(dataDir: () => string | undefined): LaunchStore {
  const memory = new Map<string, StartSwarmInput>();
  const dir = (): string | undefined => {
    const root = dataDir();
    return root ? join(root, DIR) : undefined;
  };
  const file = (d: string, id: string) => join(d, `${id}.json`);
  const stored = (): string[] => {
    const d = dir();
    if (!d) return [];
    try {
      return readdirSync(d)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -5))
        .filter((id) => ID.test(id));
    } catch {
      return [];
    }
  };

  return {
    save(id, input) {
      memory.set(id, input);
      const d = dir();
      if (!d || !ID.test(id)) return;
      try {
        mkdirSync(d, { recursive: true });
        const tmp = `${file(d, id)}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(input));
        renameSync(tmp, file(d, id));
      } catch {
        // kept in memory; Run again works until the next restart
      }
    },
    load(id) {
      const held = memory.get(id);
      if (held) return held;
      const d = dir();
      if (!d || !ID.test(id)) return undefined;
      try {
        const input = JSON.parse(readFileSync(file(d, id), "utf8")) as StartSwarmInput;
        if (typeof input?.task !== "string") return undefined;
        memory.set(id, input);
        return input;
      } catch {
        return undefined;
      }
    },
    has(id) {
      return this.load(id) !== undefined;
    },
    keepOnly(ids) {
      for (const id of [...memory.keys()]) if (!ids.has(id)) memory.delete(id);
      const d = dir();
      if (!d) return;
      for (const id of stored()) {
        if (!ids.has(id)) rmSync(file(d, id), { force: true });
      }
    },
    clear() {
      memory.clear();
      const d = dir();
      if (d) rmSync(d, { recursive: true, force: true });
    },
  };
}
