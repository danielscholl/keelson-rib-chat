// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ID = /^s[a-z0-9]{4,12}$/;

// One JSON file per swarm under a directory of the rib's data directory, for
// what is too large for swarms.json. Held in memory when there is no data dir.
export interface SwarmFileStore<T> {
  save(id: string, value: T): void;
  load(id: string): T | undefined;
  has(id: string): boolean;
  // Drops every entry whose swarm the rib no longer knows.
  keepOnly(ids: ReadonlySet<string>): void;
  clear(): void;
}

export function createSwarmFileStore<T>(
  dataDir: () => string | undefined,
  name: string,
  valid: (value: unknown) => value is T,
): SwarmFileStore<T> {
  const memory = new Map<string, T>();
  const dir = (): string | undefined => {
    const root = dataDir();
    return root ? join(root, name) : undefined;
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
    save(id, value) {
      memory.set(id, value);
      const d = dir();
      if (!d || !ID.test(id)) return;
      try {
        mkdirSync(d, { recursive: true });
        const tmp = `${file(d, id)}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(value));
        renameSync(tmp, file(d, id));
      } catch {
        // kept in memory until the next restart
      }
    },
    load(id) {
      const held = memory.get(id);
      if (held) return held;
      const d = dir();
      if (!d || !ID.test(id)) return undefined;
      try {
        const value: unknown = JSON.parse(readFileSync(file(d, id), "utf8"));
        if (!valid(value)) return undefined;
        memory.set(id, value);
        return value;
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
