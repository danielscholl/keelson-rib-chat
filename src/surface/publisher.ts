// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { SnapshotManager } from "@keelson/shared";

export interface KeyPublisher {
  // Asks for a fresh frame. Calls inside one window coalesce into one compose.
  schedule(): void;
  release(): void;
}

// The composer reads live state, so publishing is asking the host to compose
// again. The host drops a recompose requested while one is in flight, so a
// change that lands mid-compose marks the key dirty and the loop composes once
// more, until the latest state has landed.
export function createKeyPublisher<T>(
  sm: SnapshotManager,
  key: string,
  compose: () => T,
  validate: (data: unknown) => T,
  windowMs = 250,
): KeyPublisher {
  const unregister = sm.register(key, compose, { validate });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let composing = false;
  let dirty = false;
  let released = false;

  const pump = async () => {
    composing = true;
    try {
      do {
        dirty = false;
        await sm.recompose(key).catch(() => undefined);
      } while (dirty && !released);
    } finally {
      composing = false;
    }
  };

  // Seeded at once, so a client that opens the key first reads a frame, not a 204.
  void pump();

  return {
    schedule() {
      if (released) return;
      if (composing) {
        dirty = true;
        return;
      }
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (!released) void pump();
      }, windowMs);
      (timer as { unref?: () => void }).unref?.();
    },
    release() {
      released = true;
      if (timer) clearTimeout(timer);
      unregister();
    },
  };
}
