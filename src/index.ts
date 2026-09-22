// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Rib, RibAuthStatus, RibContext } from "@keelson/shared";
import { ClickClackClient, ClickClackError } from "./clickclack.ts";
import { chatDocsSource } from "./docs.ts";
import { ManagedServer, realServerDeps } from "./server.ts";
import { makeServerTools } from "./server-tools.ts";
import { Swarm } from "./swarm.ts";
import { ENDED_KEPT, makeChatTools, type StartSwarmInput } from "./tools.ts";
import type { ChatMessage, SwarmSummary } from "./types.ts";

const READ_TOOLS = ["Read", "Grep", "Glob"] as const;
const DEFAULT_URL = "http://localhost:8080";
// keelson stop escalates to a signal after 12 s; the server's own stop takes up to 8.
const SWARM_STOP_BUDGET_MS = 3_000;

// Seams captured in registerTools (the only hook with the full ctx) and cleared
// in dispose.
let runAgentTurn: RibContext["runAgentTurn"];
let registerOp: RibContext["registerOp"];
let getProjects: RibContext["getProjects"];
let getCredential: RibContext["getCredential"];
let getDataDir: RibContext["getDataDir"];

let server: ManagedServer | undefined;
// Swarms between the start call and the registry, so stop and reset see them too.
let starting = 0;
let disposed = false;

const swarms = new Map<string, Swarm>();
const ended = new Map<string, SwarmSummary>();

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// The rib manages a local ClickClack only when nothing points at one: no URL
// and no owner session. Anything else is a server somebody else runs.
type Target =
  | { mode: "managed"; server: ManagedServer }
  | { mode: "external"; url: string; token?: string };

async function target(): Promise<Target> {
  const url = process.env.CLICKCLACK_URL;
  const token = process.env.CLICKCLACK_TOKEN || (await getCredential?.("token")) || undefined;
  if (url || token)
    return { mode: "external", url: url || DEFAULT_URL, ...(token ? { token } : {}) };
  server ??= new ManagedServer(realServerDeps(() => getDataDir?.()));
  return { mode: "managed", server };
}

// The owner session a swarm mints its bots with. A bot token cannot create
// bots, so this must be a human session (`clickclack login --magic-token`).
async function ownerClient(): Promise<ClickClackClient> {
  const t = await target();
  if (t.mode === "managed") {
    const { url } = await t.server.ensure();
    return new ClickClackClient(url, await t.server.ownerSession());
  }
  if (!t.token) {
    throw new Error(
      "no ClickClack owner session: set CLICKCLACK_TOKEN, or store one in the keychain as rib_chat_token",
    );
  }
  const owner = new ClickClackClient(t.url, t.token);
  await owner.ready();
  return owner;
}

// Reads never start a managed server: a stopped one has to be started on purpose.
async function readerClient(): Promise<ClickClackClient> {
  const t = await target();
  if (t.mode === "managed") {
    const status = await t.server.status();
    if (!status.running) {
      throw new Error("the managed ClickClack is stopped; start it with chat_server_start");
    }
    return new ClickClackClient(status.url, await t.server.ownerSession());
  }
  return ownerClient();
}

// Bot tokens a swarm could not revoke when it ended, usually because ClickClack
// was down. Each swarm start retries them.
const pendingRevocations = new Set<string>();

function retryRevocations(owner: ClickClackClient): void {
  for (const tokenId of pendingRevocations) {
    void owner.revokeBotToken(tokenId).then(
      () => pendingRevocations.delete(tokenId),
      (e) => {
        if (e instanceof ClickClackError && e.status === 404) pendingRevocations.delete(tokenId);
      },
    );
  }
}

async function readChannel(channelId: string, threadId?: string): Promise<ChatMessage[]> {
  const owner = await readerClient();
  if (!threadId) return owner.channelTranscript(channelId);
  const thread = await owner.getThread(threadId);
  if (thread[0] && thread[0].channelId !== channelId) {
    throw new Error(`thread ${threadId} is not in this swarm's channel`);
  }
  return thread;
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

async function startSwarm(
  input: StartSwarmInput,
): Promise<{ swarm: Swarm; opId?: string; url: string }> {
  starting++;
  try {
    return await launchSwarm(input);
  } finally {
    starting--;
  }
}

async function launchSwarm(
  input: StartSwarmInput,
): Promise<{ swarm: Swarm; opId?: string; url: string }> {
  if (!runAgentTurn) throw new Error("this keelson host cannot run agent turns for a rib");
  let cwd: string | undefined;
  if (input.project) {
    const project = getProjects?.().find((p) => p.id === input.project || p.name === input.project);
    if (!project) throw new Error(`no registered project '${input.project}'`);
    cwd = project.rootPath;
  }
  const owner = await ownerClient();
  retryRevocations(owner);
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
        ...(input.maxTurnsPerAgent ? { maxTurnsPerAgent: input.maxTurnsPerAgent } : {}),
        ...(input.turnTimeoutMs ? { turnTimeoutMs: input.turnTimeoutMs } : {}),
        ...(input.wallClockMs ? { wallClockMs: input.wallClockMs } : {}),
      },
      // Reading a checkout needs a project to confine it to.
      workTools: input.workTools === "read" && cwd ? READ_TOOLS : [],
      ...(cwd ? { cwd } : {}),
      ...(input.context ? { context: input.context } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.workerModel ? { workerModel: input.workerModel } : {}),
      log: (message, data) => op?.progress(message, data),
    });
  } catch (e) {
    op?.error(`swarm failed to start: ${errText(e)}`);
    throw e;
  }

  const live = swarm;
  if (disposed) {
    // Shutdown overtook the start: nothing would ever stop this swarm or revoke its bots.
    await live.stop("keelson is shutting down");
    op?.error("keelson is shutting down");
    throw new Error("keelson is shutting down");
  }
  swarms.set(live.id, live);
  for (const note of pendingSteers) void live.steer(note);
  op?.signal.addEventListener("abort", () => void live.stop("cancelled"), { once: true });

  void live.finished.then((summary) => {
    for (const tokenId of live.unrevokedTokens()) pendingRevocations.add(tokenId);
    swarms.delete(summary.id);
    ended.set(summary.id, summary);
    while (ended.size > ENDED_KEPT) {
      const oldest = ended.keys().next().value;
      if (oldest === undefined) break;
      ended.delete(oldest);
    }
    // The run succeeds when the swarm delivered an answer, or the operator stopped
    // it. Anything else failed at its job, and the run says so; the summary stays
    // on the record as the last progress frame.
    if (summary.conclusion !== undefined || summary.status === "stopped") {
      op?.done(summary);
    } else {
      op?.progress(`swarm ${summary.status}`, summary);
      op?.error(`swarm ${summary.id} ${summary.status}: ${summary.error ?? "no conclusion"}`);
    }
  });

  return { swarm: live, url: owner.baseUrl, ...(op ? { opId: op.id } : {}) };
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
    getDataDir = ctx.getDataDir;
    disposed = false;
    return [
      ...makeChatTools({ swarms, ended, startSwarm, readChannel }),
      ...makeServerTools({
        target,
        liveCount: () => swarms.size + starting,
        clearEnded: () => ended.clear(),
        endedCount: () => ended.size,
      }),
    ];
  },

  async authStatus(ctx: RibContext): Promise<RibAuthStatus> {
    getCredential = ctx.getCredential ?? getCredential;
    getDataDir = ctx.getDataDir ?? getDataDir;
    try {
      const t = await target();
      if (t.mode === "managed") {
        // Never starts the server and never mints a session: doctor polls this.
        const why = t.server.unavailable();
        if (why) return { authenticated: false, statusMessage: why };
        const status = await t.server.status();
        return {
          authenticated: true,
          statusMessage: status.running
            ? `managed ClickClack running at ${status.url}`
            : `managed ClickClack starts with the first swarm (${status.binary})`,
        };
      }
      const owner = await ownerClient();
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
    disposed = true;
    // Swarms first: revoking their bots needs the server still up.
    if (swarms.size > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all([...swarms.values()].map((s) => s.stop("keelson is shutting down"))),
        new Promise((resolve) => {
          timer = setTimeout(resolve, SWARM_STOP_BUDGET_MS);
        }),
      ]);
      clearTimeout(timer);
    }
    swarms.clear();
    await server?.dispose().catch(() => undefined);
    server = undefined;
    runAgentTurn = undefined;
    registerOp = undefined;
    getProjects = undefined;
    getCredential = undefined;
    getDataDir = undefined;
  },
};

export default rib;
