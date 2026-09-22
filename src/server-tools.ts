// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { type ToolContext, type ToolDefinition, z } from "@keelson/shared";
import type { ManagedServer } from "./server.ts";
import { emitText, guarded } from "./tools.ts";

export type ServerControl = Pick<ManagedServer, "ensure" | "stop" | "reset" | "status">;

// What the rib is pointed at: a ClickClack it owns, or one somebody else runs.
export type ServerTarget =
  | { mode: "managed"; server: ServerControl }
  | { mode: "external"; url: string };

export interface ServerToolDeps {
  target: () => Promise<ServerTarget>;
  // Swarms running or still starting. Stop and reset refuse while it is non-zero.
  liveCount: () => number;
  endedCount: () => number;
  clearEnded: () => void;
  // Called after the server may have started, stopped, or been wiped.
  onServerChange?: () => void;
}

const none = z.object({}).strict();
const resetSchema = z
  .object({
    confirm: z
      .boolean()
      .optional()
      .describe("Must be true to delete. Omitted, the tool reports what it would delete."),
  })
  .strict();

export function makeServerTools(deps: ServerToolDeps): ToolDefinition[] {
  // The mutators act only on a server the rib started itself.
  const managed = async (ctx: ToolContext): Promise<ServerControl | undefined> => {
    const target = await deps.target();
    if (target.mode === "managed") return target.server;
    emitText(ctx, `ClickClack is external (${target.url}); the rib does not manage it.`, true);
    return undefined;
  };
  const busy = (ctx: ToolContext, verb: string): boolean => {
    const live = deps.liveCount();
    if (live === 0) return false;
    emitText(ctx, `${live} swarm(s) live; stop them with chat_swarm_stop before a ${verb}.`, true);
    return true;
  };

  return [
    {
      name: "chat_server_status",
      description:
        "Report the ClickClack server the rib uses: whether the rib manages it or it is external, its URL, whether it is running, and how many swarms are live. Never starts anything.",
      inputSchema: none,
      execute: guarded(async (input, ctx) => {
        none.parse(input);
        const target = await deps.target();
        const detail =
          target.mode === "managed" ? await target.server.status() : { url: target.url };
        emitText(
          ctx,
          JSON.stringify({ mode: target.mode, ...detail, liveSwarms: deps.liveCount() }, null, 1),
        );
      }),
    },
    {
      name: "chat_server_start",
      description:
        "Start the managed ClickClack server, or confirm it is already running. A swarm starts it on demand, so this is for opening the web UI beforehand. Refuses when the rib is pointed at an external server.",
      inputSchema: none,
      state_changing: true,
      execute: guarded(async (input, ctx) => {
        none.parse(input);
        const server = await managed(ctx);
        if (!server) return;
        const { url, pid, adopted } = await server.ensure();
        deps.onServerChange?.();
        emitText(
          ctx,
          `ClickClack running at ${url} (pid ${pid}, ${adopted ? "adopted" : "started"}). Watch at ${url}/app.`,
        );
      }),
    },
    {
      name: "chat_server_stop",
      description:
        "Stop the managed ClickClack server. Its channels and transcripts stay on disk and return with the next start. Refuses while a swarm is live, and when the server is external.",
      inputSchema: none,
      state_changing: true,
      execute: guarded(async (input, ctx) => {
        none.parse(input);
        const server = await managed(ctx);
        if (!server || busy(ctx, "stop")) return;
        const stopped = await server.stop();
        deps.onServerChange?.();
        emitText(ctx, stopped ? "ClickClack stopped." : "ClickClack was not running.");
      }),
    },
    {
      name: "chat_server_reset",
      description:
        "Wipe the managed ClickClack server: stop it, delete every channel, transcript, bot, and session, and start it empty. Irreversible. Without confirm: true it only reports what it would delete. Refuses while a swarm is live, and when the server is external.",
      inputSchema: resetSchema,
      state_changing: true,
      requires_confirmation: true,
      execute: guarded(async (input, ctx) => {
        const args = resetSchema.parse(input);
        const server = await managed(ctx);
        if (!server || busy(ctx, "reset")) return;
        if (args.confirm !== true) {
          const { dataDir } = await server.status();
          return emitText(
            ctx,
            `would stop ClickClack, delete ${dataDir ?? "its data directory"} (every channel, transcript, bot, and session), and forget ${deps.endedCount()} ended swarm(s). Re-issue with confirm: true.`,
          );
        }
        const { url } = await server.reset();
        // Their channels are gone, so their summaries would point at nothing.
        deps.clearEnded();
        deps.onServerChange?.();
        emitText(ctx, `ClickClack reset; running empty at ${url}.`);
      }),
    },
  ];
}
