// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { CreateProjectBody, RibAction, RibActionResult, RibContext } from "@keelson/shared";
import type { Swarm } from "../swarm.ts";
import { START_BOUNDS, type StartSwarmInput } from "../tools.ts";
import {
  agentMessageBody,
  agentMessageRefusal,
  BODY_MAX,
  SWARM_POWERS,
  SWARM_SIZES,
  type SwarmPower,
  type SwarmSize,
  type SwarmSummary,
} from "../types.ts";
import { shortHandle } from "./format.ts";
import {
  agentKey,
  askKey,
  detailsKey,
  docKey,
  gateKey,
  HISTORY_KEY,
  INDEX_KEY,
  recordKey,
  reportKey,
  SERVER_KEY,
  SERVER_LOG_KEY,
  SURFACE_TAB,
  swarmKey,
} from "./keys.ts";
import { gateIdentity, sizesHint } from "./parts.ts";
import type { ServerOps } from "./server-ops.ts";
import type { ServerVerb } from "./server-panel.ts";
import type { SwarmRecord, SwarmsSurface } from "./surface.ts";

export interface ActionDeps {
  surface: SwarmsSurface | undefined;
  find: (id: string) => SwarmRecord;
  live: (
    id: string,
  ) =>
    | Pick<
        Swarm,
        | "summary"
        | "steer"
        | "messageAgent"
        | "replyToGate"
        | "replyInThread"
        | "dismissAsk"
        | "stop"
      >
    | undefined;
  // Admits a start and boots it in the background; a refusal throws.
  begin: (input: StartSwarmInput, origin?: { rerunOf?: string }) => string;
  launchOf: (id: string) => StartSwarmInput | undefined;
  server?: ServerOps;
  hasReport?: (id: string) => boolean;
  // Probes the ClickClack server again and refreshes the server line and inspector.
  probe?: () => Promise<void>;
  getToolReachability?: RibContext["getToolReachability"];
  createProject?: RibContext["createProject"];
}

export const WORKFLOW = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
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

function leadToolsOf(value: unknown, deps: ActionDeps): string[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return "lead_tools must be an array";
  if (value.length > START_BOUNDS.maxLeadTools) {
    return `at most ${START_BOUNDS.maxLeadTools} lead tools`;
  }
  const names: string[] = [];
  for (const name of value) {
    if (typeof name !== "string" || !/^[a-z][a-z0-9_]{1,63}$/.test(name)) {
      return "a tool name such as beads_ready";
    }
    if (name.startsWith("chat_")) return "chat_* tools are the swarm's own";
    if (!names.includes(name)) names.push(name);
  }
  if (!deps.getToolReachability || names.length === 0) return [];
  try {
    const results = deps.getToolReachability(names);
    return names.filter(
      (name) => results.find((tool) => tool.name === name)?.status === "reachable",
    );
  } catch (e) {
    return `Could not check lead tool reachability: ${errText(e)}`;
  }
}

// The form carries no context, so links are refused before a channel exists.
function startInput(
  payload: Record<string, unknown>,
  deps: ActionDeps,
  html: boolean,
): { input: StartSwarmInput; creation?: CreateProjectBody } | string {
  const task = text(payload, "task");
  if (!task) return "a swarm needs a task";
  if (task.length > BODY_MAX) return `a task is at most ${BODY_MAX} characters`;
  if (LINK.test(task)) return LINK_REFUSAL;
  const project = text(payload, "project");
  let creation: CreateProjectBody | undefined;
  if (project === "new") {
    if (!html) return "project creation is only available from the launcher";
    const name = text(payload, "name");
    if (!name) return "a new project needs a name";
    if (payload.rootPath !== undefined && typeof payload.rootPath !== "string") {
      return "the project folder must be a string";
    }
    const rootPath = text(payload, "rootPath");
    creation = { name, ...(rootPath ? { rootPath } : {}) };
  }
  const tools = text(payload, "tools");
  if (tools === "write" && !project) {
    return "writing needs a project: pick one, or let agents only read";
  }
  // On defaults the launch records no size, power or model, so the kept launch
  // says what was chosen and Run again repeats a choice rather than a default.
  const adjusted = text(payload, "setup") !== "defaults";
  const size = adjusted ? sizeOf(payload) : undefined;
  const models = adjusted ? modelOf(payload) : {};
  const power = adjusted ? powerOf(payload) : undefined;
  const input: StartSwarmInput = {
    task,
    workTools: creation
      ? "write"
      : tools === "none" || tools === "read" || tools === "write"
        ? tools
        : project
          ? "read"
          : "none",
    ...(size ? { size } : {}),
    ...(power ? { power } : {}),
    ...(project && !creation ? { project } : {}),
    ...models,
  };
  const names = [
    ...new Set(
      text(payload, "workflows")
        .split(/[\s,]+/)
        .filter(Boolean),
    ),
  ];
  if (names.length > 0 && !project)
    return "workflows need a project to run on: pick one, or leave Workflows empty";
  if (names.length > START_BOUNDS.maxWorkflows) {
    return `at most ${START_BOUNDS.maxWorkflows} workflows`;
  }
  const bad = names.find((n) => !WORKFLOW.test(n));
  if (bad) return `'${bad}' is not a workflow name`;
  const leadTools = leadToolsOf(payload.lead_tools, deps);
  if (typeof leadTools === "string") return leadTools;
  if (html && !project && Array.isArray(payload.lead_tools) && payload.lead_tools.length > 0) {
    return "tracker tools need a project: pick one, or leave Use the tracker off";
  }
  return {
    input: {
      ...input,
      ...(names.length ? { workflows: names.map((name) => ({ name, isolated: true })) } : {}),
      ...(leadTools.length ? { leadTools } : {}),
    },
    ...(creation ? { creation } : {}),
  };
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
  const models = same
    ? {
        ...(model ? { model } : {}),
        ...(provider ? { provider } : {}),
        ...(workerModel ? { workerModel } : {}),
      }
    : picked;
  const pickedSize = sizeOf(payload);
  const nextSize = pickedSize === "medium" && size === undefined ? undefined : (pickedSize ?? size);
  return {
    ...rest,
    ...(nextSize ? { size: nextSize } : {}),
    ...(power && (same || !picked.model) ? { power } : {}),
    ...models,
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

function writable(summary: SwarmSummary): boolean {
  return summary.status === "running" && !summary.endedAt && summary.conclusion === undefined;
}

function matchesGate(payload: Record<string, unknown>, identity: string | undefined): boolean {
  return (
    payload.gateIdentity === undefined ||
    (typeof payload.gateIdentity === "string" &&
      payload.gateIdentity.length > 0 &&
      payload.gateIdentity === identity)
  );
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
  const payload = payloadOf(action);
  if (
    action.origin === "canvas-html" &&
    ((action.type !== "start-swarm" && action.type !== "start-in-chat") ||
      typeof payload.nonce !== "string" ||
      payload.nonce.length === 0 ||
      !deps.surface?.acceptsLaunchNonce(payload.nonce))
  ) {
    return fail("the Swarms tab takes actions from its boards only");
  }
  const raw = payload.id;
  const id = typeof raw === "string" && ID.test(raw) ? raw : undefined;
  const known = (swarmId: string) => {
    const r = deps.find(swarmId);
    return Boolean(r.live ?? r.starting ?? r.ended);
  };

  switch (action.type) {
    case "select-swarm": {
      if (!id || !deps.find(id).live) return fail(`swarm '${String(raw)}' is not live`);
      deps.surface?.select(id);
      return { ok: true };
    }
    case "select-agent": {
      const found = id ? deps.find(id) : {};
      const summary = found.live ?? found.ended;
      const agentId = typeof payload.agentId === "string" ? payload.agentId : "";
      const agent = summary?.agents.find((a) => a.id === agentId);
      if (!id || !agent)
        return fail(`agent '${agentId}' does not belong to swarm '${String(raw)}'`);
      if (!deps.surface) return fail("The agent inspector is unavailable; reopen the Swarms tab.");
      try {
        await deps.surface.selectAgent(id, agentId);
      } catch (e) {
        return fail(`Could not publish the agent inspector: ${errText(e)}. Retry the selection.`);
      }
      return {
        ok: true,
        data: {
          effect: "open-canvas",
          key: agentKey(id),
          title: `Agent @${shortHandle(agent.handle, id)} · ${id}`,
          placement: "side",
        },
      };
    }
    case "select-ask": {
      const found = id ? deps.find(id) : {};
      const summary = found.live ?? found.ended;
      const messageId = typeof payload.messageId === "string" ? payload.messageId : "";
      const ask = summary?.health?.asks?.find((a) => a.messageId === messageId);
      if (!id || !messageId || !ask)
        return fail(`swarm '${String(raw)}' has no open question '${messageId}'`);
      if (!deps.surface)
        return fail("The question inspector is unavailable; reopen the Swarms tab.");
      try {
        await deps.surface.selectAsk(id, messageId);
      } catch (e) {
        return fail(
          `Could not publish the question inspector: ${errText(e)}. Retry the selection.`,
        );
      }
      return {
        ok: true,
        data: {
          effect: "open-canvas",
          key: askKey(id),
          title: `Question · ${id}`,
          placement: "side",
        },
      };
    }
    case "select-gate": {
      const found = id ? deps.find(id) : {};
      const summary = found.live ?? found.ended;
      const runId = typeof payload.runId === "string" ? payload.runId : "";
      const run = summary?.runs?.find((r) => r.runId === runId);
      const identity = typeof payload.gateIdentity === "string" ? payload.gateIdentity : "";
      if (!id || !runId || run?.status !== "paused" || !identity || gateIdentity(run) !== identity)
        return fail(`run '${runId}' has no matching gate in swarm '${String(raw)}'`);
      if (!deps.surface) return fail("The gate inspector is unavailable; reopen the Swarms tab.");
      try {
        await deps.surface.selectGate(id, runId, identity);
      } catch (e) {
        return fail(`Could not publish the gate inspector: ${errText(e)}. Retry the selection.`);
      }
      return {
        ok: true,
        data: { effect: "open-canvas", key: gateKey(id), title: `Gate · ${id}`, placement: "side" },
      };
    }
    case "open-details": {
      const found = id ? deps.find(id) : {};
      if (!id || !(found.live ?? found.ended))
        return fail(`swarm '${String(raw)}' has no Details available`);
      if (!deps.surface)
        return fail("The Details inspector is unavailable; reopen the Swarms tab.");
      try {
        await deps.surface.openDetails(id);
      } catch (e) {
        return fail(`Could not publish the Details inspector: ${errText(e)}. Retry the selection.`);
      }
      return {
        ok: true,
        data: {
          effect: "open-canvas",
          key: detailsKey(id),
          title: `Details · ${id}`,
          placement: "side",
        },
      };
    }
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
    case "message-agent": {
      const swarm = id ? deps.live(id) : undefined;
      if (!id || !swarm) return fail(`swarm '${String(raw)}' is not running`);
      const summary = swarm.summary();
      const agentId = typeof payload.agentId === "string" ? payload.agentId : "";
      const agent = summary.agents.find((a) => a.id === agentId);
      if (!agent) return fail(`agent '${agentId}' does not belong to swarm '${id}'`);
      const refusal = agentMessageRefusal(summary, agent);
      if (refusal) return fail(refusal);
      const note = typeof payload.note === "string" ? payload.note.trim() : "";
      try {
        agentMessageBody(agent.handle, note);
        await swarm.messageAgent(agentId, note);
      } catch (e) {
        return fail(`Could not message @${shortHandle(agent.handle, id)}: ${errText(e)}`);
      }
      return done(`Posted to @${shortHandle(agent.handle, id)} in #${summary.channelName} as you`);
    }
    case "reply": {
      const swarm = id ? deps.live(id) : undefined;
      if (!id || !swarm) return fail(`swarm '${String(raw)}' is not running`);
      const summary = swarm.summary();
      if (!writable(summary)) return fail(`swarm ${id} is no longer accepting replies`);
      const runId = typeof payload.runId === "string" ? payload.runId : "";
      const run = summary.runs?.find((r) => r.runId === runId);
      if (run?.status !== "paused" || !run.pendingApproval?.threadId) {
        return fail(`run '${runId}' is not waiting at an approval`);
      }
      if (!matchesGate(payload, gateIdentity(run)))
        return fail(`run '${runId}' is no longer waiting at this gate; reopen the gate inspector`);
      const note = typeof payload.note === "string" ? payload.note.trim() : "";
      if (!note) return fail("a reply needs a note");
      if (note.length > BODY_MAX) return fail(`a reply is at most ${BODY_MAX} characters`);
      try {
        await swarm.replyToGate(runId, note);
      } catch (e) {
        return fail(`Could not reply in the gate thread: ${errText(e)}`);
      }
      return done(`Replied in the ${run.pendingApproval.nodeId} thread as you`);
    }
    case "reply-ask": {
      const swarm = id ? deps.live(id) : undefined;
      if (!id || !swarm) return fail(`swarm '${String(raw)}' is not running`);
      const summary = swarm.summary();
      if (!writable(summary)) return fail(`swarm ${id} is no longer accepting replies`);
      const messageId = typeof payload.messageId === "string" ? payload.messageId : "";
      const ask = summary.health?.asks?.find((a) => a.messageId === messageId);
      if (!ask) return fail(`swarm ${id} has no open question '${messageId}'`);
      if (!ask.threadRootId) return fail(`question '${messageId}' has no recorded thread`);
      const note = typeof payload.note === "string" ? payload.note.trim() : "";
      if (!note) return fail("a reply needs a note");
      if (note.length > BODY_MAX) return fail(`a reply is at most ${BODY_MAX} characters`);
      try {
        await swarm.replyInThread(ask.threadRootId, note);
      } catch (e) {
        return fail(`Could not reply in the question thread: ${errText(e)}`);
      }
      return done(`Replied to @${shortHandle(ask.handle, id)}'s question as you`);
    }
    case "dismiss-ask": {
      const swarm = id ? deps.live(id) : undefined;
      if (!id || !swarm) return fail(`swarm '${String(raw)}' is not running`);
      const summary = swarm.summary();
      if (!writable(summary)) return fail(`swarm ${id} is no longer accepting question actions`);
      const messageId = typeof payload.messageId === "string" ? payload.messageId : "";
      const asker = summary.health?.asks?.find((a) => a.messageId === messageId)?.handle;
      if (!asker) return fail(`swarm ${id} has no open question '${messageId}'`);
      try {
        if (!swarm.dismissAsk(messageId))
          return fail(`swarm ${id} has no open question '${messageId}'`);
      } catch (e) {
        return fail(`Could not dismiss the question: ${errText(e)}`);
      }
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
      if (
        !matchesGate(payload, gateIdentity(run)) ||
        (payload.gateIdentity !== undefined && run.status !== "paused")
      )
        return fail(`run '${runId}' is no longer waiting at this gate; reopen the gate inspector`);
      return { ok: true, data: { effect: "open-run", runId, workflow: run.workflow } };
    }
    case "stop-swarm": {
      const swarm = id ? deps.live(id) : undefined;
      if (!id || !swarm) return fail(`swarm '${String(raw)}' is not running`);
      void swarm.stop("stopped from the Swarms tab");
      return done(`Stopping swarm ${id}: cancelling its runs and revoking its bots`);
    }
    case "start-swarm": {
      const html = action.origin === "canvas-html";
      const project = html ? text(payload, "project") : "";
      if (project === "new" && !deps.createProject) {
        return fail("This Keelson host can't create projects.");
      }
      if (project && project !== "new") {
        let offered: boolean | undefined;
        try {
          offered = deps.surface?.offersLaunchProject(project);
        } catch (e) {
          return fail(`Could not check launcher availability: ${errText(e)}`);
        }
        if (!offered) return fail(`the launcher doesn't offer project '${project}'`);
      }
      const parsed = startInput(
        html
          ? {
              task: payload.task,
              project,
              name: payload.name,
              rootPath: payload.rootPath,
              tools: !project && payload.tools !== "write" ? "none" : payload.tools,
              workflows: payload.workflows,
              lead_tools: payload.lead_tools,
              size: payload.size,
              power: payload.power,
              model: payload.model,
              provider: payload.provider,
            }
          : payload,
        deps,
        html,
      );
      if (typeof parsed === "string") return fail(parsed);
      if (!parsed.creation) return started(deps, parsed.input, "index");
      const creator = deps.createProject;
      if (!creator) return fail("This Keelson host can't create projects.");
      let created: Awaited<ReturnType<typeof creator>>;
      try {
        created = await creator(parsed.creation);
      } catch (e) {
        return fail(errText(e));
      }
      const leadTools = leadToolsOf(payload.lead_tools, deps);
      if (typeof leadTools === "string") return fail(leadTools);
      const { leadTools: _previous, ...input } = parsed.input;
      return started(
        deps,
        {
          ...input,
          project: created.id,
          workTools: "write",
          ...(leadTools.length ? { leadTools } : {}),
        },
        "index",
      );
    }
    case "run-again": {
      const record = id ? deps.find(id) : {};
      const old = id ? deps.launchOf(id) : undefined;
      if (!id || !record.ended || !old) return fail(`swarm '${String(raw)}' can't run again`);
      const leadTools = leadToolsOf(old.leadTools, deps);
      if (typeof leadTools === "string") return fail(leadTools);
      const { leadTools: _previous, ...input } = againInput(old, payload, record.ended);
      return started(deps, { ...input, ...(leadTools.length ? { leadTools } : {}) }, "drawer", {
        rerunOf: id,
      });
    }
    case "copy-conclusion": {
      const record = id ? deps.find(id) : {};
      const conclusion = (record.live ?? record.ended)?.conclusion;
      if (conclusion === undefined) return fail(`swarm '${String(raw)}' has no conclusion`);
      return { ok: true, data: conclusion };
    }
    case "open-record": {
      const found = id ? deps.find(id) : {};
      if (!id || !(found.live ?? found.ended))
        return fail(`swarm '${String(raw)}' has no record yet`);
      deps.surface?.track([id]);
      return {
        ok: true,
        data: { effect: "open-canvas", key: recordKey(id), title: `Record · ${id}` },
      };
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
    case "server-manage":
      void deps.probe?.();
      return {
        ok: true,
        data: {
          effect: "open-canvas",
          key: SERVER_KEY,
          title: "ClickClack server",
          placement: "side",
        },
      };
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
