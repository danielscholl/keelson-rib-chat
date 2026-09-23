// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { RibAction, RibActionResult } from "@keelson/shared";
import type { Swarm } from "../swarm.ts";
import { START_BOUNDS, type StartSwarmInput } from "../tools.ts";
import { BODY_MAX, SWARM_POWERS, SWARM_SIZES, type SwarmPower, type SwarmSize } from "../types.ts";
import { shortHandle } from "./format.ts";
import {
  docKey,
  HISTORY_KEY,
  INDEX_KEY,
  reportKey,
  SERVER_LOG_KEY,
  SURFACE_TAB,
  swarmKey,
} from "./keys.ts";
import { sizesHint } from "./parts.ts";
import type { ServerOps } from "./server-ops.ts";
import type { ServerVerb } from "./server-panel.ts";
import type { SwarmRecord, SwarmsSurface } from "./surface.ts";

export interface ActionDeps {
  surface: SwarmsSurface | undefined;
  find: (id: string) => SwarmRecord;
  live: (id: string) => Swarm | undefined;
  // Admits a start and boots it in the background; a refusal throws.
  begin: (input: StartSwarmInput, origin?: { rerunOf?: string }) => string;
  launchOf: (id: string) => StartSwarmInput | undefined;
  server?: ServerOps;
  hasReport?: (id: string) => boolean;
  // Probes the ClickClack server again and refreshes the footer.
  probe?: () => Promise<void>;
}

const WORKFLOW = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
// A URL, or an issue or PR number, in a task: something agents cannot open.
const LINK = /https?:\/\/\S+|(^|[\s(])#\d+\b/;

export const LINK_REFUSAL =
  "The task names a link agents can't open. Prepare in chat to attach it, or describe it in the task.";

function text(payload: Record<string, unknown>, key: string): string {
  const v = payload[key];
  return typeof v === "string" ? v.trim() : "";
}

function sizeOf(payload: Record<string, unknown>): SwarmSize | undefined {
  const v = text(payload, "size");
  return (SWARM_SIZES as readonly string[]).includes(v) ? (v as SwarmSize) : undefined;
}

function powerOf(payload: Record<string, unknown>): SwarmPower | undefined {
  const v = text(payload, "power");
  return (SWARM_POWERS as readonly string[]).includes(v) ? (v as SwarmPower) : undefined;
}

// The model picker sends its model and the model's provider; both empty is the host default.
function modelOf(payload: Record<string, unknown>): Pick<StartSwarmInput, "model" | "provider"> {
  const model = text(payload, "model");
  const provider = text(payload, "provider");
  return { ...(model ? { model } : {}), ...(provider ? { provider } : {}) };
}

// One form: a swarm with workflows named may dispatch them; one without
// investigates. The form carries no context, so a task that points at a link
// is refused here, before a channel exists.
function startInput(payload: Record<string, unknown>): StartSwarmInput | string {
  const task = text(payload, "task");
  if (!task) return "a swarm needs a task";
  if (task.length > BODY_MAX) return `a task is at most ${BODY_MAX} characters`;
  if (LINK.test(task)) return LINK_REFUSAL;
  const project = text(payload, "project");
  const tools = text(payload, "tools");
  const input: StartSwarmInput = {
    task,
    workTools: tools === "none" ? "none" : "read",
    size: sizeOf(payload) ?? "medium",
    power: powerOf(payload) ?? "balanced",
    ...(project ? { project } : {}),
    ...modelOf(payload),
  };
  const names = [
    ...new Set(
      text(payload, "workflows")
        .split(/[\s,]+/)
        .filter(Boolean),
    ),
  ];
  if (names.length === 0) return input;
  if (!project) return "workflows need a project to run on: pick one, or leave Workflows empty";
  if (names.length > START_BOUNDS.maxWorkflows) {
    return `at most ${START_BOUNDS.maxWorkflows} workflows`;
  }
  const bad = names.find((n) => !WORKFLOW.test(n));
  if (bad) return `'${bad}' is not a workflow name`;
  return { ...input, workflows: names.map((name) => ({ name, isolated: true })) };
}

// A new swarm from an old one's launch, with the size and model the form sent.
function againInput(
  old: StartSwarmInput,
  payload: Record<string, unknown>,
  was: { model?: string; provider?: string },
): StartSwarmInput {
  const { model, provider, workerModel, size, power, ...rest } = old;
  const picked = modelOf(payload);
  const same = picked.model === was.model && picked.provider === was.provider;
  return {
    ...rest,
    size: sizeOf(payload) ?? size ?? "medium",
    power: powerOf(payload) ?? power ?? "balanced",
    ...(same
      ? {
          ...(model ? { model } : {}),
          ...(provider ? { provider } : {}),
          ...(workerModel ? { workerModel } : {}),
        }
      : picked),
  };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// From the header the new card shows on the index; from a drawer, the drawer
// moves to the new swarm.
function started(
  deps: ActionDeps,
  input: StartSwarmInput,
  open: "index" | "drawer",
  origin?: { rerunOf?: string },
): RibActionResult {
  let id: string;
  try {
    id = deps.begin(input, origin);
    deps.surface?.track([id]);
  } catch (e) {
    return fail(errText(e));
  }
  return {
    ok: true,
    data:
      open === "drawer"
        ? { effect: "open-canvas", key: swarmKey(id), title: `Swarm ${id}` }
        : { effect: "open-surface", surfaceId: SURFACE_TAB, regionKey: INDEX_KEY },
  };
}

const ID = /^s[a-z0-9]{4,12}$/;

function payloadOf(action: RibAction): Record<string, unknown> {
  const p = action.payload;
  return typeof p === "object" && p !== null ? (p as Record<string, unknown>) : {};
}

function fail(error: string): RibActionResult {
  return { ok: false, error };
}

// The host shows `message` as the toast in place of the action's type.
function done(message: string): RibActionResult {
  return { ok: true, data: { message } };
}

const SERVER_TOAST = {
  "server-start": "Starting ClickClack",
  "server-stop": "Stopping ClickClack",
  "server-reset": "Resetting ClickClack: a fresh data directory and a new owner session",
} as const;

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
    case "message-lead":
    case "steer": {
      const swarm = id ? deps.live(id) : undefined;
      if (!id || !swarm) return fail(`swarm '${String(raw)}' is not running`);
      if (swarm.summary().conclusion !== undefined) {
        return fail(`swarm ${id} has concluded; the lead would never read it`);
      }
      const note = typeof payload.note === "string" ? payload.note.trim() : "";
      if (!note) return fail("a message needs a note");
      if (note.length > BODY_MAX) return fail(`a message is at most ${BODY_MAX} characters`);
      await swarm.steer(note);
      return done(`Posted in #${swarm.summary().channelName} as you`);
    }
    case "reply": {
      const swarm = id ? deps.live(id) : undefined;
      if (!id || !swarm) return fail(`swarm '${String(raw)}' is not running`);
      const runId = typeof payload.runId === "string" ? payload.runId : "";
      const run = swarm.summary().runs?.find((r) => r.runId === runId);
      if (run?.status !== "paused" || !run.pendingApproval?.threadId) {
        return fail(`run '${runId}' is not waiting at an approval`);
      }
      const note = typeof payload.note === "string" ? payload.note.trim() : "";
      if (!note) return fail("a reply needs a note");
      if (note.length > BODY_MAX) return fail(`a reply is at most ${BODY_MAX} characters`);
      await swarm.replyToGate(runId, note);
      return done(`Replied in the ${run.pendingApproval.nodeId} thread as you`);
    }
    case "reply-ask": {
      const swarm = id ? deps.live(id) : undefined;
      if (!id || !swarm) return fail(`swarm '${String(raw)}' is not running`);
      const messageId = typeof payload.messageId === "string" ? payload.messageId : "";
      const ask = swarm.summary().health?.asks?.find((a) => a.messageId === messageId);
      if (!ask) return fail(`swarm ${id} has no open question '${messageId}'`);
      const note = typeof payload.note === "string" ? payload.note.trim() : "";
      if (!note) return fail("a reply needs a note");
      if (note.length > BODY_MAX) return fail(`a reply is at most ${BODY_MAX} characters`);
      await swarm.replyInThread(ask.threadRootId, note);
      return done(`Replied to @${shortHandle(ask.handle, id)}'s question as you`);
    }
    case "dismiss-ask": {
      const swarm = id ? deps.live(id) : undefined;
      if (!id || !swarm) return fail(`swarm '${String(raw)}' is not running`);
      const messageId = typeof payload.messageId === "string" ? payload.messageId : "";
      const asker = swarm.summary().health?.asks?.find((a) => a.messageId === messageId)?.handle;
      if (!asker || !swarm.dismissAsk(messageId))
        return fail(`swarm ${id} has no open question '${messageId}'`);
      return done(
        `Dismissed @${shortHandle(asker, id)}'s question; the message stays in the channel`,
      );
    }
    case "open-run": {
      const found = id ? deps.find(id) : {};
      const summary = found.live ?? found.ended;
      const runId = typeof payload.runId === "string" ? payload.runId : "";
      const run = summary?.runs?.find((r) => r.runId === runId);
      if (!run) return fail(`run '${runId}' is not one of swarm '${String(raw)}''s runs`);
      return { ok: true, data: { effect: "open-run", runId, workflow: run.workflow } };
    }
    case "stop-swarm": {
      const swarm = id ? deps.live(id) : undefined;
      if (!id || !swarm) return fail(`swarm '${String(raw)}' is not running`);
      void swarm.stop("stopped from the Swarms tab");
      return done(`Stopping swarm ${id}: cancelling its runs and revoking its bots`);
    }
    case "start-swarm": {
      const input = startInput(payload);
      return typeof input === "string" ? fail(input) : started(deps, input, "index");
    }
    case "run-again": {
      const record = id ? deps.find(id) : {};
      const old = id ? deps.launchOf(id) : undefined;
      if (!id || !record.ended || !old) return fail(`swarm '${String(raw)}' can't run again`);
      return started(deps, againInput(old, payload, record.ended), "drawer", { rerunOf: id });
    }
    case "copy-conclusion": {
      const record = id ? deps.find(id) : {};
      const conclusion = (record.live ?? record.ended)?.conclusion;
      if (conclusion === undefined) return fail(`swarm '${String(raw)}' has no conclusion`);
      return { ok: true, data: conclusion };
    }
    case "open-report": {
      if (!id || !known(id) || !deps.hasReport?.(id))
        return fail(`swarm '${String(raw)}' has no report`);
      deps.surface?.track([id]);
      const title = deps.find(id);
      const report = (title.live ?? title.ended)?.report;
      return {
        ok: true,
        data: {
          effect: "open-canvas",
          key: reportKey(id),
          title: report?.title ?? `Swarm ${id} report`,
        },
      };
    }
    case "server-start":
    case "server-stop":
    case "server-reset": {
      if (!deps.server) return fail("this rib can't manage ClickClack here");
      const why = await deps.server.run(action.type.slice("server-".length) as ServerVerb);
      return why ? fail(why) : done(SERVER_TOAST[action.type as keyof typeof SERVER_TOAST]);
    }
    case "server-probe":
      if (!deps.probe) return fail("this rib has no server to probe here");
      await deps.probe();
      return { ok: true };
    case "server-log":
      deps.surface?.logOpened();
      return {
        ok: true,
        data: { effect: "open-canvas", key: SERVER_LOG_KEY, title: "ClickClack log" },
      };
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
