// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { RibAction, RibActionResult } from "@keelson/shared";
import type { Swarm } from "../swarm.ts";
import { BODY_MAX } from "../types.ts";
import { sizesHint } from "./index-board.ts";
import { docKey, HISTORY_KEY, swarmKey } from "./keys.ts";
import type { SwarmRecord, SwarmsSurface } from "./surface.ts";

export interface ActionDeps {
  surface: SwarmsSurface | undefined;
  find: (id: string) => SwarmRecord;
  live: (id: string) => Swarm | undefined;
}

const ID = /^s[a-z0-9]{4,12}$/;

function payloadOf(action: RibAction): Record<string, unknown> {
  const p = action.payload;
  return typeof p === "object" && p !== null ? (p as Record<string, unknown>) : {};
}

function fail(error: string): RibActionResult {
  return { ok: false, error };
}

// The system prompt for a chat that gathers context and then starts a swarm.
export function startInChatPrompt(): string {
  return [
    "You help the operator start a Keelson chat swarm: agents that work a task together in a ClickClack channel.",
    "First ask what the swarm should work out, unless the operator already said. When the task names an issue or a pull request, fetch its full body, diff, reviews, and check results, and pass them as `context` items: swarm agents cannot fetch anything themselves.",
    `Pick a size from the task: ${sizesHint()}. Medium suits most investigations; small suits a question or one review; large suits several dispatched runs or wide reading.`,
    "Pass `project` when the work concerns a registered Keelson project, so agents can read its checkout. Pass `workflows` only when the operator wants the swarm to make changes through a workflow such as fix-issue.",
    "Leave `model` unset unless the operator names one.",
    "Confirm the task, size, project, and context in one short message, then call chat_swarm_start. Report the swarm id and channel, and say the Swarms tab shows its progress.",
  ].join("\n\n");
}

export async function handleSwarmsAction(
  action: RibAction,
  deps: ActionDeps,
): Promise<RibActionResult> {
  if (action.origin === "canvas-html")
    return fail("the Swarms tab takes actions from its boards only");
  const payload = payloadOf(action);
  const raw = payload.id;
  const id = typeof raw === "string" && ID.test(raw) ? raw : undefined;
  const known = (swarmId: string) => {
    const r = deps.find(swarmId);
    return Boolean(r.live ?? r.starting ?? r.ended);
  };

  switch (action.type) {
    case "swarm-open": {
      if (!id || !known(id)) return fail(`no swarm '${String(raw)}'`);
      deps.surface?.track([id]);
      return { ok: true, data: { effect: "open-canvas", key: swarmKey(id), title: `Swarm ${id}` } };
    }
    case "history-open":
      return { ok: true, data: { effect: "open-canvas", key: HISTORY_KEY, title: "Ended swarms" } };
    case "read-doc": {
      if (!id || !known(id)) return fail(`no swarm '${String(raw)}'`);
      deps.surface?.track([id]);
      return { ok: true, data: { effect: "open-canvas", key: docKey(id), title: `Swarm ${id}` } };
    }
    case "steer": {
      const swarm = id ? deps.live(id) : undefined;
      if (!id || !swarm) return fail(`swarm '${String(raw)}' is not running`);
      if (swarm.summary().conclusion !== undefined) {
        return fail(`swarm ${id} has concluded; a steer would never be read`);
      }
      const note = typeof payload.note === "string" ? payload.note.trim() : "";
      if (!note) return fail("a steer needs a note");
      if (note.length > BODY_MAX) return fail(`a steer is at most ${BODY_MAX} characters`);
      await swarm.steer(note);
      return { ok: true };
    }
    case "stop-swarm": {
      const swarm = id ? deps.live(id) : undefined;
      if (!id || !swarm) return fail(`swarm '${String(raw)}' is not running`);
      void swarm.stop("stopped from the Swarms tab");
      return { ok: true };
    }
    case "start-in-chat":
      return {
        ok: true,
        data: {
          effect: "open-chat",
          seed: { name: "Start a swarm", systemPrompt: startInChatPrompt() },
        },
      };
    default:
      return fail(`unknown action '${action.type}'`);
  }
}
