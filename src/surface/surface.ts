// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import {
  type CanvasView,
  DEFAULT_PROJECT_NAME,
  expectView,
  type RibSurfaceBadge,
  type RibViewDescriptor,
  type SnapshotManager,
} from "@keelson/shared";
import type { SwarmReport } from "../report.ts";
import type { SwarmChange } from "../swarm.ts";
import type { StartSwarmInput } from "../tools.ts";
import type { ChildRun, OperatorAsk, StartingSwarm, SwarmSummary } from "../types.ts";
import { buildAgentInspector } from "./agent-inspector.ts";
import { buildDoc } from "./doc.ts";
import { buildBadge, buildHistory, buildIndex, type SurfaceState } from "./index-board.ts";
import { buildDetailsInspector, buildGateInspector, buildQuestionInspector } from "./inspectors.ts";
import {
  agentKey,
  askKey,
  BADGE_KEY,
  detailsKey,
  docKey,
  gateKey,
  HISTORY_KEY,
  INDEX_KEY,
  LAUNCH_KEY,
  recordKey,
  reportKey,
  SERVER_KEY,
  SERVER_LOG_KEY,
  swarmKey,
} from "./keys.ts";
import { buildLaunch, type LaunchState, TRACKER_TOOLS } from "./launch-board.ts";
import { offlineLinks, serverDown } from "./offline.ts";
import { gateIdentity } from "./parts.ts";
import { createKeyPublisher, type KeyPublisher } from "./publisher.ts";
import { buildGoneRecord, buildRecord } from "./record.ts";
import { buildServerPanel, type ServerPanelState } from "./server-panel.ts";
import { buildGoneBoard, buildStartingBoard, buildSwarmBoard } from "./swarm-board.ts";

// Keys outlive their swarm, since a client that gets a 404 on a key stops
// listening for good. Past this many swarms the oldest ended ones are released.
export const MAX_SWARM_KEYS = 100;

export interface SwarmRecord {
  live?: SwarmSummary;
  starting?: StartingSwarm;
  ended?: SwarmSummary;
}

export interface SurfaceDeps {
  sm: SnapshotManager;
  state: () => SurfaceState;
  find: (id: string) => SwarmRecord;
  projects: () => LaunchState["projects"];
  launch: () => LaunchState;
  server: () => ServerPanelState;
  readLog: () => Promise<string>;
  report: (id: string) => SwarmReport | undefined;
  // An ended swarm's launch, when the rib kept it, so it can run again.
  launchOf: (id: string) => StartSwarmInput | undefined;
  // The rib's own views array; the host re-reads it on a manifest refresh.
  views: RibViewDescriptor[];
  invalidateManifest?: () => void;
  windowMs?: number;
}

export const STOPPED_LOG_NOTE = "ClickClack is not running. These lines are from its last run.";

export interface SwarmsSurface {
  acceptsLaunchNonce(nonce: string): boolean;
  // A start from the launcher frame succeeded: republish it empty.
  launched(): void;
  offersLaunchProject(id: string): boolean;
  track(ids: readonly string[]): void;
  select(id: string): void;
  selectAgent(id: string, agentId: string): Promise<void>;
  selectAsk(id: string, messageId: string): Promise<void>;
  selectGate(id: string, runId: string, identity: string): Promise<void>;
  openDetails(id: string): Promise<void>;
  changed(id: string, kind: SwarmChange): void;
  // Recompose the index and history, for a change no swarm reports: the server
  // row, or history cleared by a reset.
  refresh(): void;
  // Release forgotten swarms' keys and recompose the index and history.
  forget(ids: readonly string[]): void;
  // Reads the server log afresh for the log pane.
  logOpened(): void;
  dispose(): void;
}

const DOC_KINDS = new Set<SwarmChange>([
  "start",
  "turn",
  "gate",
  "run",
  "conclusion",
  "health",
  "activity",
  "end",
]);

// A record reloads its frame on every new document, so it redraws when the
// swarm's course changes, at most this often.
const RECORD_WINDOW_MS = 5_000;
const RECORD_KINDS = new Set<SwarmChange>([
  "activity",
  "health",
  "turn",
  "agent",
  "run",
  "gate",
  "conclusion",
  "report",
  "end",
]);

function text(key: string) {
  return (data: unknown): string => {
    if (typeof data !== "string") throw new Error(`${key} expects text`);
    return data;
  };
}

function badgeOf(data: unknown): RibSurfaceBadge {
  const count = (data as RibSurfaceBadge | null)?.count;
  if (!Number.isInteger(count) || (count as number) < 0) {
    throw new Error(`${BADGE_KEY} expects a whole count`);
  }
  return data as RibSurfaceBadge;
}

export function createSwarmsSurface(deps: SurfaceDeps): SwarmsSurface {
  const { sm, windowMs } = deps;
  let selected: string | undefined;
  let disposed = false;
  const selectedAgents = new Map<string, string>();
  const selectedAsks = new Map<string, OperatorAsk>();
  const selectedGates = new Map<string, ChildRun>();
  type InspectorKind = "agent" | "ask" | "gate" | "details";
  const inspectors = new Map<string, Partial<Record<InspectorKind, KeyPublisher>>>();
  const index = createKeyPublisher<CanvasView>(
    sm,
    INDEX_KEY,
    () => {
      const op = deps.server().op;
      return buildIndex({
        ...deps.state(),
        ...(op ? { op } : {}),
        ...(selected ? { selected } : {}),
        selectedAgents,
      });
    },
    expectView(INDEX_KEY, "board"),
    windowMs,
  );
  const badge = createKeyPublisher<RibSurfaceBadge>(
    sm,
    BADGE_KEY,
    () => buildBadge(deps.state()),
    badgeOf,
    windowMs,
  );
  const history = createKeyPublisher<CanvasView>(
    sm,
    HISTORY_KEY,
    () => buildHistory(deps.state()),
    expectView(HISTORY_KEY, "board"),
    windowMs,
  );
  const launchNonce = crypto.randomUUID();
  // Bumped per launcher start so the frame reloads empty instead of keeping the sent draft.
  let launchGeneration = 0;
  let launchInputs: string | undefined;
  function launchState(): LaunchState {
    const state = deps.launch();
    const swarms = deps.state();
    return {
      hasSwarms: swarms.live.length > 0 || swarms.ended.length > 0,
      canCreateProject: Boolean(state.canCreateProject),
      canInitTracker: Boolean(state.canInitTracker),
      projects: state.projects
        .filter((p) => p.name !== DEFAULT_PROJECT_NAME)
        .map(({ id, name, rootPath }) => ({ id, name, rootPath })),
      provider: state.provider,
      ...(state.toolReachability
        ? {
            toolReachability: TRACKER_TOOLS.map((name) => ({
              name,
              status:
                state.toolReachability?.find((tool) => tool.name === name)?.status ??
                "unregistered",
            })),
          }
        : {}),
      ...(state.toolReachabilityError
        ? { toolReachabilityError: state.toolReachabilityError }
        : {}),
      refused: [...new Set(state.refused ?? [])].sort(),
      ...(state.dispatchBlocked ? { dispatchBlocked: state.dispatchBlocked } : {}),
      classes: (state.classes ?? []).map(({ provider, defaultModel, classes }) => ({
        provider,
        ...(defaultModel ? { defaultModel } : {}),
        ...(classes
          ? { classes: { fast: classes.fast, balanced: classes.balanced, deep: classes.deep } }
          : {}),
      })),
    };
  }
  const launch = createKeyPublisher<string>(
    sm,
    LAUNCH_KEY,
    () => {
      const state = launchState();
      const html = buildLaunch(state, launchNonce, launchGeneration);
      launchInputs = JSON.stringify(state);
      return html;
    },
    (data: unknown) => {
      if (typeof data !== "string" || data.length === 0) {
        throw new Error(`${LAUNCH_KEY} expects a non-empty html page`);
      }
      return data;
    },
    windowMs,
  );
  deps.views.push({ key: LAUNCH_KEY, canvasKind: "html", title: "Start a swarm" });
  function refreshLaunch(): void {
    if (!disposed && JSON.stringify(launchState()) !== launchInputs) launch.schedule();
  }
  const server = createKeyPublisher<CanvasView>(
    sm,
    SERVER_KEY,
    () => buildServerPanel(deps.server()),
    expectView(SERVER_KEY, "board"),
    windowMs,
  );
  const log = createKeyPublisher<string>(
    sm,
    SERVER_LOG_KEY,
    async () => {
      const text = await deps.readLog();
      const line = deps.server().server;
      return line?.mode === "managed" && !line.running ? `${STOPPED_LOG_NOTE}\n\n${text}` : text;
    },
    text(SERVER_LOG_KEY),
    windowMs,
  );
  deps.views.push({ key: SERVER_LOG_KEY, canvasKind: "log", title: "ClickClack log" });
  const swarms = new Map<string, { board: KeyPublisher; doc: KeyPublisher }>();
  let serverWasDown = serverDown(deps.state().server);

  const composeBoard = (id: string): CanvasView => {
    const found = deps.find(id);
    const summary = found.live ?? found.ended;
    if (summary) {
      const launch = found.ended ? deps.launchOf(id) : undefined;
      const current = deps.state().server;
      const server = found.live ? current : undefined;
      return offlineLinks(
        buildSwarmBoard(summary, {
          ...(launch ? { launch } : {}),
          ...(server ? { server } : {}),
          selectedAgentId: selectedAgents.get(id),
        }),
        current,
      );
    }
    if (found.starting) return buildStartingBoard(found.starting);
    return buildGoneBoard(id);
  };

  function register(id: string): boolean {
    if (swarms.has(id)) return false;
    const board = createKeyPublisher<CanvasView>(
      sm,
      swarmKey(id),
      () => composeBoard(id),
      expectView(swarmKey(id), "board"),
      windowMs,
    );
    const doc = createKeyPublisher<string>(
      sm,
      docKey(id),
      () => {
        const found = deps.find(id);
        return buildDoc(found.live ?? found.ended, id, !serverDown(deps.state().server));
      },
      text(docKey(id)),
      windowMs,
    );
    swarms.set(id, { board, doc });
    deps.views.push({ key: docKey(id), canvasKind: "markdown", title: `Swarm ${id}` });
    return true;
  }

  const reports = new Map<string, KeyPublisher>();

  // A report key exists only once the lead has published one.
  function ensureReport(id: string, republish = false): boolean {
    const held = reports.get(id);
    if (held) {
      if (republish) held.schedule();
      return false;
    }
    const page = deps.report(id);
    if (!page) return false;
    const key = reportKey(id);
    reports.set(
      id,
      createKeyPublisher<string>(
        sm,
        key,
        () => deps.report(id)?.html ?? "",
        (data: unknown) => {
          if (typeof data !== "string" || data.length === 0) {
            throw new Error(`${key} expects a non-empty html page`);
          }
          return data;
        },
        windowMs,
      ),
    );
    deps.views.push({ key, canvasKind: "html", title: page.title });
    return true;
  }

  const records = new Map<string, KeyPublisher>();

  // Registered with the swarm's other keys, since the host must know a key is
  // html before an action opens it. An ended swarm's record composes once.
  function ensureRecord(id: string): boolean {
    if (records.has(id)) return false;
    const found = deps.find(id);
    if (!found.live && !found.ended) return false;
    const key = recordKey(id);
    records.set(
      id,
      createKeyPublisher<string>(
        sm,
        key,
        () => {
          const now = deps.find(id);
          const summary = now.live ?? now.ended;
          return summary ? buildRecord(summary, new Date()) : buildGoneRecord(id);
        },
        (data: unknown) => {
          if (typeof data !== "string" || data.length === 0) {
            throw new Error(`${key} expects a non-empty html page`);
          }
          return data;
        },
        windowMs ?? RECORD_WINDOW_MS,
      ),
    );
    deps.views.push({ key, canvasKind: "html", title: `Record · ${id}` });
    return true;
  }

  function release(id: string, keepInspectors = false): void {
    if (!keepInspectors) {
      for (const publisher of Object.values(inspectors.get(id) ?? {})) publisher.release();
      inspectors.delete(id);
      selectedAgents.delete(id);
      selectedAsks.delete(id);
      selectedGates.delete(id);
    }
    const record = records.get(id);
    if (record) {
      record.release();
      records.delete(id);
      const at = deps.views.findIndex((v) => v.key === recordKey(id));
      if (at >= 0) deps.views.splice(at, 1);
    }
    const report = reports.get(id);
    if (report) {
      report.release();
      reports.delete(id);
      const at = deps.views.findIndex((v) => v.key === reportKey(id));
      if (at >= 0) deps.views.splice(at, 1);
    }
    const entry = swarms.get(id);
    if (!entry) return;
    entry.board.release();
    entry.doc.release();
    swarms.delete(id);
    const at = deps.views.findIndex((v) => v.key === docKey(id));
    if (at >= 0) deps.views.splice(at, 1);
  }

  function trim(keepInspectors?: string): boolean {
    let released = false;
    for (const id of swarms.keys()) {
      if (swarms.size <= MAX_SWARM_KEYS) break;
      const found = deps.find(id);
      if (!found.live && !found.starting) {
        release(id, id === keepInspectors);
        released = true;
      }
    }
    for (const id of inspectors.keys()) {
      if (swarms.has(id) || id === keepInspectors) continue;
      const found = deps.find(id);
      if (!found.live && !found.starting) {
        release(id);
        released = true;
      }
    }
    return released;
  }

  function track(ids: readonly string[], keepInspectors?: string): void {
    if (disposed) return;
    let added = false;
    for (const id of ids) {
      added = register(id) || added;
      added = ensureReport(id) || added;
      added = ensureRecord(id) || added;
    }
    const trimmed = trim(keepInspectors);
    if (!added && !trimmed) return;
    if (trimmed) index.schedule();
    deps.invalidateManifest?.();
  }

  function summaryOf(id: string): SwarmSummary | undefined {
    const found = deps.find(id);
    return found.live ?? found.ended;
  }

  function assertAvailable(): void {
    if (disposed) throw new Error("The Swarms surface has been disposed.");
  }

  function unavailable(id: string, title: string): CanvasView {
    return {
      view: "board",
      title: `${title} · ${id}`,
      sections: [
        {
          kind: "rows",
          title,
          items: [
            { text: `Read-only: the selected ${title.toLowerCase()} is no longer available.` },
          ],
        },
      ],
    };
  }

  async function publishInspector(
    id: string,
    kind: InspectorKind,
    key: string,
    compose: () => CanvasView,
  ): Promise<void> {
    const entry = inspectors.get(id) ?? {};
    let publisher = entry[kind];
    if (!publisher) {
      publisher = createKeyPublisher<CanvasView>(
        sm,
        key,
        () => {
          const view = compose();
          return view.view === "board" ? offlineLinks(view, deps.state().server) : view;
        },
        expectView(key, "board"),
        windowMs,
      );
      entry[kind] = publisher;
      inspectors.set(id, entry);
    }
    await publisher.flush();
  }

  return {
    acceptsLaunchNonce: (nonce) => !disposed && nonce === launchNonce,
    launched() {
      if (disposed) return;
      launchGeneration++;
      launch.schedule();
    },
    offersLaunchProject: (id) =>
      !disposed && deps.projects().some((p) => p.id === id && p.name !== DEFAULT_PROJECT_NAME),
    track,
    select(id) {
      selected = id;
      index.schedule();
    },
    async selectAgent(id, agentId) {
      assertAvailable();
      const summary = summaryOf(id);
      if (!summary?.agents.some((a) => a.id === agentId)) {
        throw new Error(`Agent ${agentId} does not belong to swarm ${id}.`);
      }
      track([id], id);
      selectedAgents.set(id, agentId);
      await publishInspector(id, "agent", agentKey(id), () => {
        const summary = summaryOf(id);
        const agent = summary?.agents.find((a) => a.id === selectedAgents.get(id));
        return summary && agent ? buildAgentInspector(summary, agent) : unavailable(id, "Agent");
      });
      index.schedule();
      swarms.get(id)?.board.schedule();
    },
    async selectAsk(id, messageId) {
      assertAvailable();
      const ask = summaryOf(id)?.health?.asks?.find((a) => a.messageId === messageId);
      if (!ask) throw new Error(`Swarm ${id} has no open question '${messageId}'.`);
      track([id], id);
      selectedAsks.set(id, structuredClone(ask));
      await publishInspector(id, "ask", askKey(id), () => {
        const summary = summaryOf(id);
        const selected = selectedAsks.get(id);
        if (!summary || !selected) return unavailable(id, "Question");
        const current = summary.health?.asks?.find((a) => a.messageId === selected.messageId);
        return buildQuestionInspector(summary, current ?? selected);
      });
    },
    async selectGate(id, runId, identity) {
      assertAvailable();
      const run = summaryOf(id)?.runs?.find((r) => r.runId === runId);
      if (run?.status !== "paused" || !identity || gateIdentity(run) !== identity) {
        throw new Error(`Run '${runId}' has no matching gate in swarm ${id}.`);
      }
      track([id], id);
      selectedGates.set(id, structuredClone(run));
      await publishInspector(id, "gate", gateKey(id), () => {
        const summary = summaryOf(id);
        const selected = selectedGates.get(id);
        if (!summary || !selected) return unavailable(id, "Gate");
        const current = summary.runs?.find(
          (r) => r.runId === selected.runId && gateIdentity(r) === gateIdentity(selected),
        );
        return buildGateInspector(summary, current ?? selected);
      });
    },
    async openDetails(id) {
      assertAvailable();
      if (!summaryOf(id)) throw new Error(`Swarm ${id} has no Details available.`);
      track([id], id);
      await publishInspector(id, "details", detailsKey(id), () => {
        const summary = summaryOf(id);
        return summary ? buildDetailsInspector(summary) : unavailable(id, "Details");
      });
    },
    changed(id, kind) {
      refreshLaunch();
      track([id]);
      for (const publisher of Object.values(inspectors.get(id) ?? {})) publisher.schedule();
      if (kind === "message") {
        index.schedule();
        swarms.get(id)?.board.schedule();
        return;
      }
      if (kind === "report" && ensureReport(id, true)) deps.invalidateManifest?.();
      index.schedule();
      badge.schedule();
      const entry = swarms.get(id);
      entry?.board.schedule();
      if (DOC_KINDS.has(kind)) entry?.doc.schedule();
      if (RECORD_KINDS.has(kind)) records.get(id)?.schedule();
      if (kind === "end") history.schedule();
      if (kind === "gate" || kind === "start" || kind === "end") {
        server.schedule();
      }
    },
    forget(ids) {
      if (selected && ids.includes(selected)) selected = undefined;
      for (const id of ids) release(id);
      deps.invalidateManifest?.();
      index.schedule();
      badge.schedule();
      history.schedule();
      refreshLaunch();
    },
    refresh() {
      const down = serverDown(deps.state().server);
      if (down !== serverWasDown) {
        serverWasDown = down;
        for (const { board, doc } of swarms.values()) {
          board.schedule();
          doc.schedule();
        }
      }
      for (const entry of inspectors.values()) {
        for (const publisher of Object.values(entry)) publisher.schedule();
      }
      index.schedule();
      badge.schedule();
      history.schedule();
      refreshLaunch();
      server.schedule();
    },
    logOpened() {
      log.schedule();
    },
    dispose() {
      disposed = true;
      for (const id of [...swarms.keys(), ...records.keys(), ...inspectors.keys()]) release(id);
      index.release();
      badge.release();
      history.release();
      launch.release();
      server.release();
      log.release();
      const at = deps.views.findIndex((v) => v.key === SERVER_LOG_KEY);
      if (at >= 0) deps.views.splice(at, 1);
      const launcherAt = deps.views.findIndex((v) => v.key === LAUNCH_KEY);
      if (launcherAt >= 0) deps.views.splice(launcherAt, 1);
    },
  };
}
