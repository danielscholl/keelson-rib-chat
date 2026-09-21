// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Rib, RibAuthStatus, RibContext } from "@keelson/shared";
import { ClickClackClient } from "./clickclack.ts";
import { chatDocsSource } from "./docs.ts";
import { Swarm } from "./swarm.ts";
import { ENDED_KEPT, makeChatTools, type StartSwarmInput } from "./tools.ts";
import type { SwarmSummary } from "./types.ts";

const READ_TOOLS = ["Read", "Grep", "Glob"] as const;

// Seams captured in registerTools (the only hook with the full ctx) and cleared
// in dispose.
let runAgentTurn: RibContext["runAgentTurn"];
let registerOp: RibContext["registerOp"];
let getProjects: RibContext["getProjects"];
let getCredential: RibContext["getCredential"];

const swarms = new Map<string, Swarm>();
const ended = new Map<string, SwarmSummary>();

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// The owner session a swarm mints its bots with. A bot token cannot create
// bots, so this must be a human session (`clickclack login --magic-token`).
async function ownerClient(): Promise<ClickClackClient> {
  const url = process.env.CLICKCLACK_URL ?? "http://localhost:8080";
  const token = process.env.CLICKCLACK_TOKEN ?? (await getCredential?.("token"));
  if (!token) {
    throw new Error(
      "no ClickClack owner session: set CLICKCLACK_TOKEN, or store one in the keychain as rib_chat_token",
    );
  }
  return new ClickClackClient(url, token);
}

async function resolveWorkspace(owner: ClickClackClient): Promise<string> {
  const pinned = process.env.CLICKCLACK_WORKSPACE;
  if (pinned) return pinned;
  const workspaces = await owner.listWorkspaces();
  const first = workspaces[0];
  if (workspaces.length === 1 && first) return first.id;
  if (workspaces.length === 0) throw new Error("the ClickClack session has no workspace");
  throw new Error(
    `several workspaces are visible; set CLICKCLACK_WORKSPACE to one of: ${workspaces.map((w) => `${w.id} (${w.name})`).join(", ")}`,
  );
}

async function startSwarm(input: StartSwarmInput): Promise<{ swarm: Swarm; opId?: string }> {
  if (!runAgentTurn) throw new Error("this keelson host cannot run agent turns for a rib");
  let cwd: string | undefined;
  if (input.project) {
    const project = getProjects?.().find((p) => p.id === input.project || p.name === input.project);
    if (!project) throw new Error(`no registered project '${input.project}'`);
    cwd = project.rootPath;
  }
  const owner = await ownerClient();
  await owner.ready();
  const workspaceId = await resolveWorkspace(owner);

  // Registered before the swarm boots so its startup is on the record too.
  let swarm: Swarm | undefined;
  const pendingSteers: string[] = [];
  const op = registerOp?.({
    kind: "chat_swarm",
    title: input.task.replace(/\s+/g, " ").trim().slice(0, 80),
    onSteer: (note) => {
      if (swarm) void swarm.steer(note);
      else pendingSteers.push(note);
    },
  });

  try {
    swarm = await Swarm.start({
      task: input.task,
      owner,
      workspaceId,
      runAgentTurn,
      limits: {
        ...(input.maxAgents ? { maxAgents: input.maxAgents } : {}),
        ...(input.maxTurns ? { maxTurns: input.maxTurns } : {}),
      },
      // Reading a checkout needs a project to confine it to.
      workTools: input.workTools === "read" && cwd ? READ_TOOLS : [],
      ...(cwd ? { cwd } : {}),
      ...(input.context ? { context: input.context } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.model ? { model: input.model } : {}),
      log: (message, data) => op?.progress(message, data),
    });
  } catch (e) {
    op?.error(`swarm failed to start: ${errText(e)}`);
    throw e;
  }

  const live = swarm;
  swarms.set(live.id, live);
  for (const note of pendingSteers) void live.steer(note);
  op?.signal.addEventListener("abort", () => void live.stop("cancelled"), { once: true });

  void live.finished.then((summary) => {
    swarms.delete(summary.id);
    ended.set(summary.id, summary);
    while (ended.size > ENDED_KEPT) {
      const oldest = ended.keys().next().value;
      if (oldest === undefined) break;
      ended.delete(oldest);
    }
    if (summary.status === "error") op?.error(summary.error ?? "swarm failed");
    else op?.done(summary);
  });

  return { swarm: live, ...(op ? { opId: op.id } : {}) };
}

const rib: Rib = {
  id: "chat",
  displayName: "Chat",

  contributeDocs: () => [chatDocsSource()],

  registerTools: (ctx: RibContext) => {
    runAgentTurn = ctx.runAgentTurn;
    registerOp = ctx.registerOp;
    getProjects = ctx.getProjects;
    getCredential = ctx.getCredential;
    return makeChatTools({ swarms, ended, startSwarm });
  },

  async authStatus(ctx: RibContext): Promise<RibAuthStatus> {
    getCredential = ctx.getCredential ?? getCredential;
    try {
      const owner = await ownerClient();
      await owner.ready();
      const me = await owner.me();
      if (me.kind !== "human") {
        return {
          authenticated: false,
          statusMessage: "the ClickClack token is a bot token; a human owner session is required",
        };
      }
      return { authenticated: true, statusMessage: `ClickClack session for ${me.displayName}` };
    } catch (e) {
      return { authenticated: false, statusMessage: errText(e) };
    }
  },

  async dispose(): Promise<void> {
    await Promise.all([...swarms.values()].map((s) => s.stop("keelson is shutting down")));
    swarms.clear();
    runAgentTurn = undefined;
    registerOp = undefined;
    getProjects = undefined;
    getCredential = undefined;
  },
};

export default rib;
