// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { Rib, RibAuthStatus, RibContext, RibViewDescriptor } from "@keelson/shared";
import { ClickClackClient, ClickClackError } from "./clickclack.ts";
import type { WorkflowDispatcher } from "./dispatch.ts";
import { chatDocsSource } from "./docs.ts";
import { historyPath, loadHistory, saveHistory } from "./history.ts";
import { isReport, REPORT_DIR, type SwarmReport } from "./report.ts";
import { ManagedServer, realServerDeps } from "./server.ts";
import { makeServerTools } from "./server-tools.ts";
import { createSwarmFileStore } from "./store.ts";
import { handleSwarmsAction } from "./surface/actions.ts";
import type { SurfaceState } from "./surface/index-board.ts";
import { BADGE_KEY, INDEX_KEY, LAUNCH_KEY, SERVER_KEY, SURFACE_ID } from "./surface/keys.ts";
import { type LaunchState, sizesByline } from "./surface/launch-board.ts";
import type { ServerLine } from "./surface/parts.ts";
import { createServerOps } from "./surface/server-ops.ts";
import { LOG_LINES, type ServerPanelState } from "./surface/server-panel.ts";
import { createSwarmsSurface, type SwarmRecord, type SwarmsSurface } from "./surface/surface.ts";
import {
  type ApprovalRefusals,
  newSwarmId,
  Swarm,
  type SwarmChange,
  SwarmStartError,
} from "./swarm.ts";
import { ENDED_KEPT, makeChatTools, type StartSwarmInput } from "./tools.ts";
import {
  type ChatMessage,
  SIZE_PRESETS,
  type StartingSwarm,
  type SwarmLimits,
  type SwarmProject,
  type SwarmSummary,
  sizeOf,
} from "./types.ts";

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
let getProviders: RibContext["getProviders"];
let startWorkflow: RibContext["startWorkflow"];
let getRunStatus: RibContext["getRunStatus"];
let cancelRun: RibContext["cancelRun"];
let respondToRun: RibContext["respondToRun"];

let server: ManagedServer | undefined;
// Swarms between the start call and the registry, so stop and reset see them too.
const starting = new Map<string, StartingSwarm>();
let disposed = false;

const swarms = new Map<string, Swarm>();
const ended = new Map<string, SwarmSummary>();
const refusedApprovals = new Set<string>();
const approvalRefusals: ApprovalRefusals = {
  has: (workflow) => refusedApprovals.has(workflow),
  set: (workflow, refused) => {
    if (refused === refusedApprovals.has(workflow)) return;
    if (refused) refusedApprovals.add(workflow);
    else refusedApprovals.delete(workflow);
    persistHistory();
  },
};

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

// The host's workflow and stub providers cannot run an agent's turns; refusing
// here costs nothing, where the swarm would otherwise fail its lead three times.
const NOT_AGENT_PROVIDERS = new Set(["workflow", "stub"]);

function checkProvider(provider: string | undefined): void {
  if (!provider) return;
  if (NOT_AGENT_PROVIDERS.has(provider)) {
    throw new Error(`provider '${provider}' cannot run agent turns`);
  }
  const known = getProviders?.().filter((p) => !NOT_AGENT_PROVIDERS.has(p.id));
  if (known && !known.some((p) => p.id === provider)) {
    throw new Error(
      `no registered provider '${provider}'; registered: ${known.map((p) => p.id).join(", ") || "none"}`,
    );
  }
}

// Unique across live, starting, and remembered swarms, since the id names the
// channel and every key the tab shows.
function mintId(): string {
  for (;;) {
    const id = newSwarmId();
    if (!swarms.has(id) && !starting.has(id) && !ended.has(id)) return id;
  }
}

function overrides(input: StartSwarmInput): Partial<SwarmLimits> {
  return {
    ...(input.maxAgents ? { maxAgents: input.maxAgents } : {}),
    ...(input.maxTurns ? { maxTurns: input.maxTurns } : {}),
    ...(input.maxTurnsPerAgent ? { maxTurnsPerAgent: input.maxTurnsPerAgent } : {}),
    ...(input.turnTimeoutMs ? { turnTimeoutMs: input.turnTimeoutMs } : {}),
    ...(input.wallClockMs ? { wallClockMs: input.wallClockMs } : {}),
  };
}

// The Swarms tab. Its markdown reading panes are declared per swarm, so the
// views array grows and shrinks with the keys the surface holds.
const views: RibViewDescriptor[] = [];
let surface: SwarmsSurface | undefined;
let serverLine: ServerLine | undefined;
let serverPoll: ReturnType<typeof setInterval> | undefined;
const SERVER_POLL_MS = 60_000;

function surfaceState(): SurfaceState {
  return {
    live: [...swarms.values()].map((s) => s.summary()),
    starting: [...starting.values()],
    ended: [...ended.values()],
    ...(serverLine ? { server: serverLine } : {}),
  };
}

function findSwarm(id: string): SwarmRecord {
  const live = swarms.get(id)?.summary();
  const pending = starting.get(id);
  const done = ended.get(id);
  return {
    ...(live ? { live } : {}),
    ...(pending ? { starting: pending } : {}),
    ...(done ? { ended: done } : {}),
  };
}

function changed(id: string, kind: SwarmChange): void {
  surface?.changed(id, kind);
  if (kind === "start" || kind === "end") void refreshServer();
}

// The ClickClack row reads a cached status: probed on swarm start and end, after
// the server tools, and every minute while a swarm is live.
async function refreshServer(): Promise<void> {
  if (!surface) return;
  try {
    const t = await target();
    if (t.mode === "managed") {
      const { url, running, pid, adopted, operator, binary, dataDir, startedAt } =
        await t.server.status();
      serverLine = {
        mode: "managed",
        url,
        running,
        ...(pid ? { pid } : {}),
        ...(adopted ? { adopted } : {}),
        ...(operator ? { operator } : {}),
        ...(binary ? { binary } : {}),
        ...(dataDir ? { dataDir } : {}),
        ...(startedAt ? { startedAt } : {}),
      };
    } else {
      serverLine = { mode: "external", url: t.url, running: true };
    }
  } catch {
    serverLine = undefined;
  }
  surface?.refresh();
  if (swarms.size + starting.size > 0 && !serverPoll) {
    serverPoll = setInterval(() => {
      if (swarms.size + starting.size === 0) {
        clearInterval(serverPoll);
        serverPoll = undefined;
      }
      void refreshServer();
    }, SERVER_POLL_MS);
    (serverPoll as { unref?: () => void }).unref?.();
  }
}

function remember(summary: SwarmSummary): void {
  ended.set(summary.id, summary);
  while (ended.size > ENDED_KEPT) {
    const oldest = ended.keys().next().value;
    if (oldest === undefined) break;
    ended.delete(oldest);
  }
  pruneLaunches();
  persistHistory();
  changed(summary.id, "end");
}

const isLaunch = (v: unknown): v is StartSwarmInput =>
  typeof v === "object" && v !== null && typeof (v as StartSwarmInput).task === "string";
const launches = createSwarmFileStore(() => getDataDir?.(), "launches", isLaunch);
const reports = createSwarmFileStore<SwarmReport>(() => getDataDir?.(), REPORT_DIR, isReport);

function pruneLaunches(): void {
  const known = new Set([...swarms.keys(), ...starting.keys(), ...ended.keys()]);
  launches.keepOnly(known);
  reports.keepOnly(known);
}

function launchState(): LaunchState {
  const projects = (getProjects?.() ?? []).map((p) => ({ id: p.id, name: p.name }));
  const canDispatch = Boolean(startWorkflow && getRunStatus && cancelRun);
  const classes = (getProviders?.() ?? []).flatMap((p) =>
    p.modelClasses && !NOT_AGENT_PROVIDERS.has(p.id)
      ? [{ provider: p.id, classes: p.modelClasses }]
      : [],
  );
  return {
    projects,
    live: swarms.size + starting.size,
    ...(classes.length > 0 ? { classes } : {}),
    ...(canDispatch
      ? {}
      : { dispatchBlocked: "This Keelson host can't start workflows for a rib." }),
  };
}

function clearEnded(): void {
  ended.clear();
  launches.clear();
  reports.clear();
  persistHistory();
  surface?.refresh();
}

const serverOps = createServerOps({
  target,
  liveCount: () => swarms.size + starting.size,
  clearEnded,
  changed: () => void refreshServer(),
});

function serverPanel(): ServerPanelState {
  return {
    ...(serverLine ? { server: serverLine } : {}),
    ...(serverOps.current() ? { op: serverOps.current() } : {}),
    live: swarms.size + starting.size,
    refused: [...refusedApprovals],
  };
}

async function readServerLog(): Promise<string> {
  try {
    const t = await target();
    if (t.mode !== "managed") return "This ClickClack is external, so the rib has no log for it.";
    return t.server.readLog?.(LOG_LINES) || "(no server log yet)";
  } catch (e) {
    return `could not read the server log: ${errText(e)}`;
  }
}

function persistHistory(): void {
  const dir = getDataDir?.();
  if (!dir) return;
  try {
    saveHistory(historyPath(dir), {
      ended: [...ended.values()],
      refusedApprovals: [...refusedApprovals],
    });
  } catch {
    // the in-memory history still answers; the next end retries the write
  }
}

// A start that failed after its id was minted, kept so the failure has a record.
function failedStart(record: StartingSwarm, error: string): SwarmSummary {
  return {
    id: record.id,
    task: record.task,
    status: "error",
    channelId: "",
    channelName: `swarm-${record.id}`,
    startedAt: record.startedAt,
    endedAt: new Date().toISOString(),
    turnsUsed: 0,
    limits: record.limits,
    size: sizeOf(record.limits, record.sizeBase),
    sizeBase: record.sizeBase,
    ...(record.provider ? { provider: record.provider } : {}),
    ...(record.model ? { model: record.model } : {}),
    ...(record.workerModel ? { workerModel: record.workerModel } : {}),
    ...(record.power ? { power: record.power } : {}),
    ...(record.project ? { project: record.project } : {}),
    ...(record.opId ? { opId: record.opId } : {}),
    agents: [],
    error,
  };
}

interface Launch {
  cwd?: string;
  project?: SwarmProject;
  dispatcher?: WorkflowDispatcher;
}

// Everything that can refuse a start before it has an id: a refusal here is an
// answer to the caller, not a swarm that failed.
function prepare(input: StartSwarmInput): Launch {
  if (!runAgentTurn) throw new Error("this keelson host cannot run agent turns for a rib");
  checkProvider(input.provider);
  let cwd: string | undefined;
  let project: SwarmProject | undefined;
  if (input.project) {
    const found = getProjects?.().find((p) => p.id === input.project || p.name === input.project);
    if (!found) throw new Error(`no registered project '${input.project}'`);
    cwd = found.rootPath;
    project = { id: found.id, name: found.name };
  }
  let dispatcher: WorkflowDispatcher | undefined;
  if (input.workflows?.length) {
    if (!project) throw new Error("workflows need a project to run on");
    if (!startWorkflow || !getRunStatus || !cancelRun) {
      throw new Error("this keelson host cannot start workflows for a rib");
    }
    const start = startWorkflow;
    const status = getRunStatus;
    const cancel = cancelRun;
    const respond = respondToRun;
    const onProject = project.id;
    dispatcher = {
      start: (name, inputs) => start(name, inputs, { projectId: onProject }),
      status: (runId) => status(runId),
      cancel: (runId) => cancel(runId),
      ...(respond
        ? {
            respond: (runId: string, nodeId: string, text: string, pauseId?: string) =>
              respond(runId, nodeId, text, pauseId),
          }
        : {}),
    };
  }
  return {
    ...(cwd ? { cwd } : {}),
    ...(project ? { project } : {}),
    ...(dispatcher ? { dispatcher } : {}),
  };
}

type Booted = { swarm: Swarm; opId?: string; url: string };

// Checks and admits a start, then boots it in the background. A refusal throws
// here, before the swarm has an id; a failure after that is an ended error row.
function beginSwarm(input: StartSwarmInput): { id: string; booted: Promise<Booted> } {
  const launch = prepare(input);
  const sizeBase = input.size ?? "medium";
  const record: StartingSwarm = {
    id: mintId(),
    task: input.task,
    startedAt: new Date().toISOString(),
    limits: { ...SIZE_PRESETS[sizeBase], ...overrides(input) },
    sizeBase,
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.workerModel ? { workerModel: input.workerModel } : {}),
    power: input.power ?? "balanced",
    ...(launch.project ? { project: launch.project } : {}),
  };
  starting.set(record.id, record);
  launches.save(record.id, input);
  changed(record.id, "start");
  const booted = (async () => {
    try {
      return await launchSwarm(record, input, launch);
    } catch (e) {
      remember(e instanceof SwarmStartError ? e.summary : failedStart(record, errText(e)));
      throw e;
    } finally {
      starting.delete(record.id);
      changed(record.id, "start");
    }
  })();
  return { id: record.id, booted };
}

function startSwarm(input: StartSwarmInput): Promise<Booted> {
  try {
    return beginSwarm(input).booted;
  } catch (e) {
    return Promise.reject(e);
  }
}

async function launchSwarm(
  record: StartingSwarm,
  input: StartSwarmInput,
  launch: Launch,
): Promise<{ swarm: Swarm; opId?: string; url: string }> {
  const agentTurn = runAgentTurn;
  if (!agentTurn) throw new Error("this keelson host cannot run agent turns for a rib");
  const { cwd, project, dispatcher } = launch;
  const owner = await ownerClient();
  retryRevocations(owner);
  const workspaceId = await resolveWorkspace(owner);

  // Registered before the swarm boots so its startup is on the record too.
  let swarm: Swarm | undefined;
  const pendingSteers: string[] = [];
  const op = registerOp?.({
    kind: "chat_swarm",
    title: input.task.replace(/\s+/g, " ").trim().slice(0, 80),
    ...(project ? { projectId: project.id } : {}),
    onSteer: (note) => {
      if (swarm) void swarm.steer(note);
      else pendingSteers.push(note);
    },
  });
  if (op) record.opId = op.id;

  try {
    swarm = await Swarm.start({
      id: record.id,
      task: input.task,
      owner,
      workspaceId,
      runAgentTurn: agentTurn,
      size: record.sizeBase,
      limits: overrides(input),
      // Reading a checkout needs a project to confine it to.
      workTools: input.workTools === "read" && cwd ? READ_TOOLS : [],
      ...(cwd ? { cwd } : {}),
      ...(project ? { project } : {}),
      ...(op ? { opId: op.id } : {}),
      approvalRefusals,
      ...(input.context ? { context: input.context } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.workerModel ? { workerModel: input.workerModel } : {}),
      ...(record.power ? { power: record.power } : {}),
      ...(dispatcher && input.workflows
        ? { dispatch: { grants: input.workflows, dispatcher } }
        : {}),
      log: (message, data) => op?.progress(message, data),
      onChange: (kind) => {
        const page = kind === "report" ? swarm?.reportPage() : undefined;
        if (page) reports.save(record.id, page);
        changed(record.id, kind);
      },
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
    remember(summary);
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

  views,
  surfaces: [
    {
      id: SURFACE_ID,
      title: "Swarms",
      hideRegionActions: true,
      badgeKey: BADGE_KEY,
      layout: {
        header: { key: LAUNCH_KEY, collapsible: true, byline: sizesByline() },
        rows: [{ columns: [{ key: INDEX_KEY, live: true }] }],
        footer: { key: SERVER_KEY, collapsible: true, collapsed: true },
      },
    },
  ],

  onAction: (action) =>
    handleSwarmsAction(action, {
      surface,
      find: findSwarm,
      live: (id) => swarms.get(id),
      begin: (input) => {
        const { id, booted } = beginSwarm(input);
        booted.catch(() => undefined);
        return id;
      },
      launchOf: (id) => launches.load(id),
      server: serverOps,
      hasReport: (id) => reports.has(id),
    }),

  // Delivered for runs this rib started; the swarm that owns the run re-reads it.
  onRunEvent: (event) => {
    for (const swarm of swarms.values()) swarm.onRunEvent(event.runId);
  },

  registerTools: (ctx: RibContext) => {
    runAgentTurn = ctx.runAgentTurn;
    registerOp = ctx.registerOp;
    getProjects = ctx.getProjects;
    getCredential = ctx.getCredential;
    getDataDir = ctx.getDataDir;
    getProviders = ctx.getProviders;
    startWorkflow = ctx.startWorkflow;
    getRunStatus = ctx.getRunStatus;
    cancelRun = ctx.cancelRun;
    respondToRun = ctx.respondToRun;
    disposed = false;
    const dir = getDataDir?.();
    if (dir && ended.size === 0) {
      const history = loadHistory(historyPath(dir));
      for (const summary of history.ended.slice(-ENDED_KEPT)) ended.set(summary.id, summary);
      for (const workflow of history.refusedApprovals) refusedApprovals.add(workflow);
    }
    const sm = ctx.getSnapshotManager?.();
    if (sm && !surface) {
      surface = createSwarmsSurface({
        sm,
        state: surfaceState,
        find: findSwarm,
        launch: launchState,
        rerunnable: (id) => ended.has(id) && launches.has(id),
        server: serverPanel,
        report: (id) => reports.load(id),
        readLog: readServerLog,
        views,
        ...(ctx.invalidateManifest ? { invalidateManifest: ctx.invalidateManifest } : {}),
      });
      surface.track([...ended.keys()]);
      void refreshServer();
    }
    return [
      ...makeChatTools({ swarms, starting, ended, startSwarm, readChannel }),
      ...makeServerTools({
        target,
        liveCount: () => swarms.size + starting.size,
        clearEnded,
        endedCount: () => ended.size,
        onServerChange: () => void refreshServer(),
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
    surface?.dispose();
    surface = undefined;
    views.length = 0;
    serverLine = undefined;
    if (serverPoll) clearInterval(serverPoll);
    serverPoll = undefined;
    // Kept on disk, so the next activation reads it back.
    if (getDataDir?.()) {
      ended.clear();
      refusedApprovals.clear();
    }
    await server?.dispose().catch(() => undefined);
    server = undefined;
    runAgentTurn = undefined;
    registerOp = undefined;
    getProjects = undefined;
    getCredential = undefined;
    getDataDir = undefined;
    getProviders = undefined;
  },
};

export default rib;
