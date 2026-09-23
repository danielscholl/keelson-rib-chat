// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { ServerTarget } from "../server-tools.ts";
import type { ServerOp, ServerVerb } from "./server-panel.ts";

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
