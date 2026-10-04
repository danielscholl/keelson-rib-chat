import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CanvasBoardView,
  expectView,
  type RibViewDescriptor,
  ribClientEffectSchema,
  ribSurfaceBadgeSchema,
  ribSurfaceDescriptorSchema,
  type SnapshotFrame,
  type SnapshotManager,
} from "@keelson/shared";
import { CONTEXT_BOUNDS, type ContextIndexEntry, EXCERPT_CHARS } from "../src/context.ts";
import { applyStatus } from "../src/dispatch.ts";
import rib from "../src/index.ts";
import { needsYou } from "../src/needs.ts";
import { createSwarmFileStore } from "../src/store.ts";
import { type ActionDeps, handleSwarmsAction, LINK_REFUSAL } from "../src/surface/actions.ts";
import { buildAgentInspector, INSPECTOR_TURNS_SHOWN } from "../src/surface/agent-inspector.ts";
import { buildDoc } from "../src/surface/doc.ts";
import type { forecastDelta } from "../src/surface/forecast.ts";
import {
  channelHref,
  day,
  dayHeading,
  gist,
  hhmm,
  messageLine,
  shortRun,
  threadHref,
} from "../src/surface/format.ts";
import {
  buildBadge,
  buildHistory,
  buildIndex,
  endedRow,
  type SurfaceState,
} from "../src/surface/index-board.ts";
import {
  buildDetailsInspector,
  buildGateInspector,
  buildQuestionInspector,
} from "../src/surface/inspectors.ts";
import {
  agentKey,
  askKey,
  detailsKey,
  docKey,
  gateKey,
  HISTORY_KEY,
  INDEX_KEY,
  LAUNCH_KEY,
  recordKey,
  SERVER_KEY,
  SERVER_LOG_KEY,
  swarmKey,
} from "../src/surface/keys.ts";
import { buildLaunch, launchByline } from "../src/surface/launch-board.ts";
import {
  askText,
  dismissAskAction,
  gateIdentity,
  healthRows,
  modelRow,
  replyAction,
  requestOf,
  type ServerLine,
  selectSwarm,
  serverAddress,
  serverState,
  setupRows,
  sizeDetail,
  stateLine,
} from "../src/surface/parts.ts";
import { createKeyPublisher } from "../src/surface/publisher.ts";
import { buildAgentEdges, buildRecord } from "../src/surface/record.ts";
import { createServerOps } from "../src/surface/server-ops.ts";
import {
  buildServerPanel,
  type ServerOp,
  type ServerPanelState,
} from "../src/surface/server-panel.ts";
import {
  createSwarmsSurface,
  MAX_SWARM_KEYS,
  type SwarmRecord,
  type SwarmsSurface,
} from "../src/surface/surface.ts";
import {
  buildAgentMap,
  buildCockpit,
  buildGoneBoard,
  buildStartingBoard,
  buildSwarmBoard,
  CONVERSATION_SHOWN,
  tokensTile,
} from "../src/surface/swarm-board.ts";
import { ACTIVITY_KEPT, type Swarm } from "../src/swarm.ts";
import type { StartSwarmInput } from "../src/tools.ts";
import {
  type ChildRun,
  MESSAGE_CHARS,
  MESSAGES_KEPT,
  type OperatorAsk,
  SIZE_PRESETS,
  type StartingSwarm,
  type SwarmAgent,
  type SwarmSummary,
  type TurnSpan,
  WORKER_TONES,
} from "../src/types.ts";

const T0 = "2026-09-22T14:00:00.000Z";

function leaves(sections: CanvasBoardView["sections"]) {
  return sections.flatMap((s) =>
    s.kind === "columns" ? s.columns.flatMap((c) => c.sections) : [s],
  );
}

const serverFixtures = {
  managedRunning: {
    mode: "managed",
    url: "http://127.0.0.1:18080",
    running: true,
    pid: 4242,
    binary: "/usr/local/bin/clickclack",
    dataDir: "/data/clickclack",
    startedAt: T0,
  },
  managedStopped: { mode: "managed", url: "http://127.0.0.1:18080", running: false },
  externalDown: {
    mode: "external",
    url: "https://cc.example",
    running: false,
    checkedAt: "2026-09-22T14:10:00.000Z",
    unreachableSince: "2026-09-22T13:40:00.000Z",
  },
} satisfies Record<string, ServerLine>;

function agent(
  id: string,
  i: number,
  patch: Partial<SwarmAgent> = {},
): SwarmSummary["agents"][number] {
  const lead = i === 0;
  return {
    id: `${id}-${lead ? "lead" : `w${i}`}`,
    handle: `${id}-${lead ? "lead" : `w${i}`}`,
    displayName: lead ? "lead" : `w${i}`,
    role: lead ? "Lead: owns the outcome" : "reads the build logs and reports the slowest step",
    lead,
    tone: lead ? "brand" : (WORKER_TONES[i - 1] ?? "neutral"),
    botUserId: `u${i}`,
    turns: 3,
    status: "idle",
    ...patch,
  };
}

function run(id: string, patch: Partial<ChildRun> = {}): ChildRun {
  return {
    runId: `${id}0000-1111-2222`,
    workflow: "fix-issue",
    purpose: "Fix issue #27: README undercounts frontend-mix nodes",
    inputs: { issue: "27" },
    status: "running",
    startedAt: T0,
    isolated: true,
    checkout: { path: `/wt/${id}`, branch: `keelson/${id}`, worktreeEstablished: true },
    nodesDone: 4,
    prUrls: [],
    verified: false,
    ...patch,
  };
}

function gate(answerer: "swarm" | "operator"): NonNullable<ChildRun["pendingApproval"]> {
  return {
    nodeId: "approve-plan",
    prompt: "Plan: set the README node count to 12.\n\nApprove?",
    threadId: "msg_0042",
    openedAt: "2026-09-22T14:31:00.000Z",
    answerer,
  };
}

function swarm(id: string, patch: Partial<SwarmSummary> = {}): SwarmSummary {
  return {
    id,
    task: "Fix issue #27: README undercounts frontend-mix nodes\n\nMore detail below.",
    status: "running",
    channelId: `ch_${id}`,
    channelName: `swarm-${id}`,
    startedAt: T0,
    turnsUsed: 11,
    limits: SIZE_PRESETS.medium,
    size: "medium",
    sizeBase: "medium",
    provider: "copilot",
    model: "gpt-5.6-sol",
    project: { id: "p1", name: "keelson-sample" },
    opId: "op-1",
    clickclack: { url: "http://127.0.0.1:18080", workspaceId: "ws_1" },
    agents: [agent(id, 0), agent(id, 1)],
    ...patch,
  };
}

function turnSpans(id: string, minutes: readonly number[]): TurnSpan[] {
  return minutes.map((minute, i) => ({
    agentId: `${id}-lead`,
    n: i + 1,
    startedAt: new Date(Date.parse(T0) + minute * 60_000).toISOString(),
    messages: 1,
    wokeBy: ["rib"],
  }));
}

const starting: StartingSwarm = {
  id: "s0new",
  task: "Summarize open deploy issues",
  startedAt: T0,
  limits: SIZE_PRESETS.small,
  sizeBase: "small",
};

const fixtures: Record<string, SwarmSummary> = {
  running: swarm("s9hjx", {
    messageCount: 23,
    recent: Array.from({ length: 10 }, (_, i) => ({
      id: `msg_${i}`,
      at: new Date(Date.parse(T0) + i * 60_000).toISOString(),
      author: i === 9 ? "operator" : i === 8 ? "s9hjx-w1" : "s9hjx-lead",
      text:
        i === 7
          ? "<img src=x onerror=alert(1)> [click](javascript:alert(1)) **bold**"
          : `message ${i} for @s9hjx-lead`,
      ...(i === 8 ? { threadRootId: "msg_1" } : {}),
    })),
  }),
  twoBusy: swarm("s2bsy", {
    agents: [
      agent("s2bsy", 0, { status: "busy" }),
      agent("s2bsy", 1, { status: "busy" }),
      agent("s2bsy", 2, { status: "waiting", queued: 1 }),
    ],
    spans: [
      { agentId: "s2bsy-lead", n: 1, startedAt: T0, endedAt: T0, messages: 1, wokeBy: [] },
      {
        agentId: "s2bsy-lead",
        n: 3,
        startedAt: "2026-09-22T14:05:00.000Z",
        messages: 1,
        wokeBy: [],
      },
      { agentId: "s2bsy-w1", n: 2, startedAt: "2026-09-22T14:07:00.000Z", messages: 2, wokeBy: [] },
    ],
    pace: [1, 2, 0],
    usage: { input: 200, output: 50, cached: 100 },
  }),
  concluded: swarm("s4end", {
    conclusion: "Done",
    activity: [
      { at: T0, text: "concluded", kind: "conclusion" },
      { at: T0, text: "later turn", kind: "turn" },
    ],
  }),
  leadFailure: swarm("s5bad", { health: { lastLeadFailure: "timeout" } }),
  review: swarm("s9hjy", {
    runs: [run("r1", { status: "paused", pendingApproval: gate("swarm") })],
  }),
  onlyYou: swarm("s7k1p", {
    size: "large",
    sizeBase: "large",
    limits: SIZE_PRESETS.large,
    model: "gpt-6-astra",
    workflows: ["fix-issue"],
    runs: [run("r2", { status: "paused", pendingApproval: gate("operator") })],
  }),
  asked: swarm("s6ask", {
    health: {
      asks: [
        {
          agentId: "s6ask-w1",
          handle: "s6ask-w1",
          messageId: "msg_0101",
          threadRootId: "msg_0100",
          text: "@operator which retry cap, 30 s or 60 s?",
          at: "2026-09-22T14:20:00.000Z",
        },
      ],
    },
    runs: [run("r5", { status: "paused", pendingApproval: gate("operator") })],
  }),
  waiting: swarm("s3wai", {
    agents: [
      agent("s3wai", 0, { status: "busy" }),
      agent("s3wai", 1, { status: "waiting", queued: 2 }),
    ],
    pace: [1, 3, 2, 0, 1],
    activity: [{ at: T0, text: "@s3wai-lead turn 3 ok", count: 2 }],
  }),
  stopping: swarm("s2stp", { status: "stopping", error: "stopped from the Swarms tab" }),
  dispatchIdle: swarm("s1dis", { workflows: ["fix-issue", "docs-check"] }),
  quiet: swarm("s5c07", {
    health: { quietSince: "2026-09-22T14:40:00.000Z" },
    runs: [run("r3", { status: "paused", pendingApproval: gate("swarm") })],
  }),
  gone: swarm("s4n4x", {
    health: {
      socketDrops: 2,
      disconnectedAt: "2026-09-22T12:50:00.000Z",
      channelFault: "fetch failed",
    },
  }),
  done: swarm("s8pln", {
    status: "done",
    endedAt: "2026-09-22T14:29:00.000Z",
    model: "gpt-6-astra",
    workerModel: "gpt-5.6-sol",
    conclusion: `Verified. ${"x".repeat(3000)}`,
    runs: [
      run("r4", {
        status: "succeeded",
        prUrls: ["https://github.com/o/r/pull/28"],
        ci: { verdict: "pass" },
        verified: true,
        approvals: [
          {
            nodeId: "approve-plan",
            decision: "approve",
            reason: "r",
            review: "msg_1",
            reviewer: "@s8pln-w1",
            at: T0,
          },
        ],
      }),
    ],
  }),
  stalled: swarm("s5tcx", {
    status: "stalled",
    endedAt: "2026-09-22T14:40:00.000Z",
    error: "the swarm went idle without a conclusion",
    draftConclusion: "a draft",
    health: { nudges: 2, refusedConclusions: 1 },
  }),
  bootFailed: {
    ...swarm("s1bad", {
      status: "error",
      channelId: "",
      endedAt: T0,
      error: "ClickClack is not reachable",
    }),
    agents: [],
    turnsUsed: 0,
  },
};

const producedFixtures = (() => {
  const id = "s8art";
  const at = (minute: number) => new Date(Date.parse(T0) + minute * 60_000).toISOString();
  const wt = { path: "/repo/.worktrees/swarm-s8art-w1", branch: "writer/feature", base: "main" };
  const writer = agent(id, 1, { id: "bot-writer", worktree: wt });
  const mixed = swarm(id, {
    status: "done",
    endedAt: at(8),
    writeEnabled: true,
    workflows: ["fix-issue"],
    agents: [agent(id, 0), writer],
    report: { title: "Produced report", at: at(3), bytes: 4096 },
    runs: [
      run("later", {
        startedAt: at(4),
        status: "failed",
        completedAt: at(7),
        error: "build failed",
      }),
      run("early", {
        startedAt: at(2),
        status: "succeeded",
        completedAt: at(6),
        prUrls: ["https://github.com/o/r/pull/91"],
        ci: { verdict: "pass" },
        verified: true,
        approvals: [
          {
            nodeId: "approve-plan",
            decision: "approve",
            reason: "Plan reviewed",
            reviewer: `@${writer.handle}`,
            review: "msg_review",
            at: at(5),
          },
        ],
      }),
    ],
    prs: [
      {
        agent: writer.handle,
        branch: wt.branch,
        url: "https://github.com/o/r/pull/90",
        at: at(1),
        ci: { verdict: "running", detail: "build queued" },
      },
    ],
    worktrees: [
      { agent: writer.handle, path: wt.path, branch: wt.branch, reason: "1 commit not pushed" },
    ],
  });
  return {
    writer: { ...mixed, report: undefined, runs: undefined, workflows: undefined },
    dispatch: {
      ...mixed,
      report: undefined,
      prs: undefined,
      worktrees: undefined,
      writeEnabled: undefined,
      agents: [agent(id, 0), agent(id, 1)],
    },
    mixed,
  } satisfies Record<string, SwarmSummary>;
})();

const endedFixtures = (() => {
  const id = "sended";
  const common = swarm(id, {
    status: "done",
    endedAt: "2026-09-22T14:20:00.000Z",
    task: "Review the ended board\n\nFull task destination sentinel.",
    context: [
      {
        id: "evidence",
        kind: "note",
        title: "Context destination",
        chars: 29,
        excerpt: "Context destination sentinel.",
      },
    ],
    conclusion: `## Result\n\n${"Complete markdown evidence.\n".repeat(80)}Final conclusion sentinel.`,
    usage: { input: 400, output: 100, cached: 200 },
    agents: [
      agent(id, 0, { usage: { input: 300, output: 50, cached: 150 } }),
      agent(id, 1, { usage: { input: 100, output: 50, cached: 50 } }),
    ],
  });
  const activity = Array.from({ length: 15 }, (_, i) => ({
    at: new Date(Date.parse(T0) + i * 60_000).toISOString(),
    text: `@${id}-w1 retained event ${i}`,
    actor: `${id}-w1`,
    ...(i === 14 ? { count: 2 } : {}),
  }));
  const chat = { ...common };
  const mixed = producedFixtures.mixed;
  return {
    reportAndConclusion: {
      ...common,
      writeEnabled: true,
      report: { title: "Ended report", at: T0, bytes: 4096 },
      activity,
      health: { socketDrops: 2 },
    },
    conclusionOnly: chat,
    conclusionWithoutUsage: { ...chat, usage: undefined },
    dispatchWithoutPRs: { ...common, workflows: ["fix-issue"], runs: [] },
    stoppedWithArtifacts: {
      ...mixed,
      task: common.task,
      context: common.context,
      status: "stopped",
      conclusion: undefined,
      report: undefined,
      error: "stopped from the Swarms tab",
      draftConclusion: "## Refused draft\n\nDraft sentinel.",
      activity: activity.map((event) => ({ ...event, actor: mixed.agents[1]!.id })),
      runs: mixed.runs!.map((r) => ({
        ...r,
        status: r.verified ? "succeeded" : "cancelled",
        error: undefined,
        ...(r.verified ? { ci: { verdict: "pass", prUrl: r.prUrls[0] } } : {}),
      })),
    },
  } satisfies Record<string, SwarmSummary>;
})();

const state = (patch: Partial<SurfaceState> = {}): SurfaceState => ({
  live: [],
  starting: [],
  ended: [],
  ...patch,
});

const board = (key: string, view: unknown) =>
  expect(() => expectView(key, "board")(view)).not.toThrow();

describe("shared inspector keys and presentation", () => {
  test("keys stay in the per-swarm native inspector namespaces", () => {
    expect(askKey("s1")).toBe("rib:chat:ask:s1");
    expect(gateKey("s1")).toBe("rib:chat:gate:s1");
    expect(detailsKey("s1")).toBe("rib:chat:details:s1");
  });

  test("question actions are shared without changing their board payloads", () => {
    const s = fixtures.asked!;
    const ask = s.health!.asks![0]!;
    const request = requestOf(s, needsYou(s).find((n) => n.kind === "question")!);
    expect(request.more).toEqual([
      replyAction(s, { threadRootId: ask.threadRootId, messageId: ask.messageId }, "the thread"),
      dismissAskAction(s, ask.messageId),
    ]);
    expect(request.more[0]!.binding).toEqual({
      id: s.id,
      threadRootId: ask.threadRootId,
      messageId: ask.messageId,
    });
    expect(request.more[1]!.payload).toEqual({ id: s.id, messageId: ask.messageId });
    expect(replyAction(s, { runId: "r1" }, "the approval thread").type).toBe("reply");
  });

  test("shared setup and health rows are available in Details instead of live About", () => {
    const s = swarm("shelp", {
      workerModel: "worker-model",
      usage: { input: 200, output: 50, cached: 100 },
      health: {
        socketDrops: 2,
        channelFault: "offline",
        leadFailures: 3,
        lastLeadFailure: "timeout",
        nudges: 1,
        refusedConclusions: 2,
        cancelFault: "could not cancel",
      },
    });
    expect(modelRow(s)).toBe("copilot · lead gpt-5.6-sol · workers worker-model");
    expect(setupRows(s)).toEqual([
      { icon: "◫", text: sizeDetail(s) },
      { icon: "◆", text: "copilot · lead gpt-5.6-sol · workers worker-model" },
      { icon: "∑", text: "200 in · 50 out · 100 cached tokens" },
    ]);
    expect(healthRows(s).map((row) => row.text)).toEqual([
      "socket closed 2 time(s) since it last opened",
      "ClickClack fault: offline",
      "the lead's last turn failed (3 in a row): timeout",
      "idle: nudged the lead 1 of 2 times",
      "the lead's conclusion was refused 2 time(s) for length",
      "could not cancel",
    ]);
    expect(leaves(buildSwarmBoard(s).sections).some((section) => section.title === "About")).toBe(
      false,
    );
    const health = buildDetailsInspector(s).sections.find((section) => section.title === "Health");
    expect(health?.kind === "rows" ? health.items : []).toEqual(healthRows(s));
    expect(healthRows({ ...s, status: "error", error: "fatal" }).at(-1)).toEqual({
      icon: "✕",
      glyph: "error",
      text: "fatal",
    });
    expect(healthRows(swarm("sclean"))).toEqual([]);
  });
});

describe("the shared server text", () => {
  test("state words distinguish managed processes from external reachability", () => {
    expect(serverState({ mode: "managed", running: true })).toBe("running");
    expect(serverState({ mode: "managed", running: false })).toBe("stopped");
    expect(serverState({ mode: "external", running: true })).toBe("reachable");
    expect(serverState({ mode: "external", running: false })).toBe("unreachable");
    expect(serverState({ mode: "external", running: false, unreachableSince: T0 })).toBe(
      `unreachable since ${hhmm(T0)}`,
    );
  });

  test("addresses omit only the HTTP scheme and preserve unknown addresses", () => {
    expect(serverAddress({ mode: "managed", running: true, url: "http://127.0.0.1:18080" })).toBe(
      "127.0.0.1:18080",
    );
    expect(serverAddress({ mode: "external", running: false, url: "https://cc.example" })).toBe(
      "cc.example",
    );
    expect(serverAddress({ mode: "managed", running: false })).toBeUndefined();
  });
});

describe("the shared state line", () => {
  test("requests use the request title, its time, and the remaining count", () => {
    const s = fixtures.onlyYou!;
    expect(stateLine(s, needsYou(s))).toEqual({
      text: `waits on you: review the plan for Fix issue #27: README undercounts frontend-mix nodes since ${hhmm(gate("operator").openedAt)}`,
      warn: false,
    });
    const asked = fixtures.asked!;
    expect(stateLine(asked, needsYou(asked)).text).toContain(" (+1 more)");
    expect(stateLine({ ...asked, runs: [] }, needsYou({ ...asked, runs: [] })).text).toStartWith(
      "waits on you: @w1 asked:",
    );
    expect(stateLine(fixtures.quiet!, needsYou(fixtures.quiet!)).text).toBe(
      `waits on you: no agent has worked since ${hhmm("2026-09-22T14:40:00.000Z")}`,
    );
  });

  test("busy turns use the latest open span and waiting agents name their queues", () => {
    const s = fixtures.twoBusy!;
    expect(stateLine(s, []).text).toBe(
      `@lead is on turn 3 since ${hhmm(s.spans?.[1]?.startedAt)} · @w1 is on turn 2 since ${hhmm(s.spans?.[2]?.startedAt)} · @w2 waits with 1 message`,
    );
    expect(stateLine({ ...s, spans: [] }, []).text).toStartWith("@lead is on a turn");
  });

  test("a swarm-answerable pause names its gate and reviewer without repeating a need", () => {
    const s = swarm("s3rev", {
      runs: [
        run("r1", {
          status: "paused",
          pendingApproval: { ...gate("swarm"), reviewer: "s3rev-w1" },
        }),
      ],
    });
    expect(stateLine(s, []).text).toBe(
      `fix-issue r10000-1 paused at approve-plan since ${hhmm(gate("swarm").openedAt)}, with @w1 reviewing`,
    );
    const quiet = { ...s, health: { quietSince: T0 } };
    expect(stateLine(quiet, needsYou(quiet)).text).not.toContain("paused at");
  });

  test("conclusion precedes activity, with and without a recorded time", () => {
    const s = fixtures.concluded!;
    expect(stateLine(s, []).text).toBe(`concluded at ${hhmm(T0)}; turns in flight finish`);
    expect(stateLine({ ...s, activity: [] }, []).text).toBe(
      "the lead concluded; turns in flight finish",
    );
  });

  test("the fallback is the latest activity or the first-turn wait", () => {
    expect(stateLine(fixtures.running!, []).text).toBe("waiting for the lead's first turn");
    expect(stateLine(fixtures.waiting!, []).text).toBe(
      "@lead is on a turn · @w1 waits with 2 messages",
    );
    const s = swarm("s5act", { activity: [{ at: T0, text: "@s5act-lead turn 3 ok" }] });
    expect(stateLine(s, []).text).toBe(`${hhmm(T0)} @lead turn 3 ok`);
  });

  test("stopping short-circuits work, but health appends and warns", () => {
    const s = swarm("s6stp", {
      status: "stopping",
      conclusion: "done",
      agents: [agent("s6stp", 0, { status: "busy" })],
      health: {
        socketDrops: 1,
        channelFault: "fetch failed",
        lastLeadFailure: "timeout",
        nudges: 1,
      },
    });
    expect(stateLine(s, [])).toEqual({
      text: `stopping: cancelling runs and revoking tokens · ClickClack socket closed 1 time · ClickClack fault: fetch failed · the lead's last turn failed · nudged the lead 1 of ${s.limits.maxNudges} times`,
      warn: true,
    });
    const gone = fixtures.gone!;
    expect(stateLine(gone, needsYou(gone)).text).not.toContain("socket closed");
    expect(stateLine(gone, needsYou(gone)).warn).toBe(true);
  });

  test("busy and waiting clauses are bounded and the line stays within 240 characters", () => {
    const s = swarm("s7cap", {
      agents: Array.from({ length: 8 }, (_, i) =>
        agent("s7cap", i, { status: i < 4 ? "busy" : "waiting", queued: 1 }),
      ),
    });
    const line = stateLine(s, []).text;
    expect(line).toContain("+1 more on turns");
    expect(line).toContain("+1 more waiting");
    expect(line.length).toBeLessThanOrEqual(240);
    expect(stateLine({ ...s, health: { channelFault: "x".repeat(1000) } }, []).text.length).toBe(
      240,
    );
  });

  test("selectSwarm points down to the index selection and retains the setup hint", () => {
    expect(selectSwarm(fixtures.running!, "brand")).toMatchObject({
      type: "select-swarm",
      label: "Open swarm",
      glyph: "↓",
      tone: "brand",
      payload: { id: fixtures.running!.id },
    });
    expect(selectSwarm(fixtures.running!).hint).toContain("medium:");
  });
});

describe("message lines", () => {
  test("shortens handles and strips only emphasis and code, leaving links and HTML literal", () => {
    const text = "<img src=x onerror=alert(1)> [click](javascript:alert(1))";
    expect(messageLine("s1", `${text} **bold** __under__ \`code\`\nsecond line`)).toBe(
      `${text} bold under code`,
    );
    expect(messageLine("s1", "@s1-lead asked @s1-w")).toBe("@lead asked @w");
    expect(messageLine("s1", "x".repeat(100))).toBe(`${"x".repeat(89)}…`);
    expect(messageLine("s1", "x".repeat(20), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

describe("the agent map", () => {
  const graph = (s: SwarmSummary, selected?: string) => {
    const map = buildAgentMap(s, selected);
    board(swarmKey(s.id), { view: "board", sections: [map] });
    return map;
  };

  test("columns, identity tones, status figures and non-agent actions are explicit", () => {
    const s = swarm("s1", {
      operatorMessageCount: 25,
      agents: [agent("s1", 0), agent("s1", 1), agent("s1", 2), agent("s1", 3)],
      runs: [run("r1", { status: "paused" })],
    });
    const map = graph(s, "s1-w2");
    expect(map.columns).toEqual(["You", "Lead", "Workers", "Runs"]);
    expect(map.nodes.map((n) => n.rank)).toEqual([0, 1, 2, 2, 2, 3]);
    expect(map.nodes.map((n) => n.tone)).toEqual([
      "neutral",
      "brand",
      "id-blue",
      "id-amber",
      "id-teal",
      "caution",
    ]);
    expect(map.nodes[0]).toMatchObject({ id: "you", sublabel: "25 posts" });
    expect(map.nodes[0]?.action).toBeUndefined();
    expect(map.nodes[1]?.sublabel).toBe("3 turns · idle");
    expect(map.nodes[2]?.sublabel).toBe("3 of 12 · idle");
    expect(map.nodes[3]).toMatchObject({
      selected: true,
      action: { type: "select-agent", payload: { id: "s1", agentId: "s1-w2" } },
    });
    expect(map.nodes[5]).toMatchObject({
      sublabel: "paused · 4 steps",
      action: { type: "open-run", payload: { id: "s1", runId: s.runs![0]!.runId } },
    });
    expect(graph({ ...s, operatorMessageCount: 0 }).nodes[0]?.sublabel).toBe("0 posts");
    expect(graph({ ...s, operatorMessageCount: undefined }).nodes[0]?.sublabel).toBe(
      "posts not recorded",
    );
    for (const [status, tone] of [
      ["running", "info"],
      ["succeeded", "ok"],
      ["failed", "error"],
      ["cancelled", "neutral"],
    ] as const) {
      expect(graph({ ...s, runs: [run("r1", { status })] }).nodes.at(-1)?.tone).toBe(tone);
    }
  });

  test("spawn wakes fold, grandchildren stay workers and run updates have no invented counts", () => {
    const s = swarm("s1", {
      agents: [
        agent("s1", 0),
        agent("s1", 1, { spawnedBy: "s1-lead" }),
        agent("s1", 2, { spawnedBy: "s1-w1" }),
        agent("s1", 3, { spawnedBy: "s1-lead" }),
      ],
      spans: [
        {
          agentId: "s1-w1",
          n: 1,
          startedAt: T0,
          messages: 3,
          wokeBy: ["s1-lead", "s1-lead", "operator"],
        },
        {
          agentId: "s1-lead",
          n: 2,
          startedAt: T0,
          messages: 3,
          wokeBy: ["s1-w2", "runs", "missing", "s1-lead"],
        },
      ],
      activity: [{ at: T0, text: "question", kind: "ask", actor: "s1-w2", count: 4 }],
      runs: [run("r1"), run("r2")],
    });
    const map = graph(s);
    expect(map.nodes.find((n) => n.id === "s1-w2")?.rank).toBe(2);
    for (const edge of [
      { source: "s1-lead", target: "s1-w1", label: "×1" },
      { source: "s1-lead", target: "s1-w3", label: "×0" },
      { source: "you", target: "s1-w1", label: "×1" },
      { source: "s1-w2", target: "s1-lead", label: "×1" },
      { source: "s1-w2", target: "you", label: "asked ×4", dashed: true },
      ...s.runs!.map((r) => ({ source: `run:${r.runId}`, target: "s1-lead", label: "updates" })),
    ])
      expect(map.edges).toContainEqual(edge);
    expect(map.edges.some((e) => e.source === "runs")).toBe(false);
    expect(graph({ ...s, spans: [...s.spans!].reverse() }).nodes).toEqual(map.nodes);
  });

  test("synthetic overflow retains selection, clips exact counts and never dangles", () => {
    const agents = Array.from({ length: 55 }, (_, i) => agent("s1", i));
    const s = swarm("s1", {
      agents,
      spans: agents.map((a) => ({
        agentId: a.id,
        n: 1,
        startedAt: T0,
        messages: agents.length,
        wokeBy: agents.map((source) => source.id),
      })),
    });
    const map = graph(s, "s1-w54");
    expect(map.nodes).toHaveLength(48);
    expect(map.edges).toHaveLength(200);
    expect(map.title).toBe("Map · showing 48 of 56 nodes · showing 200 of 2970 edges");
    expect(map.nodes.some((n) => n.id === "s1-w54" && n.selected)).toBe(true);
    expect(map.nodes.some((n) => n.id === "s1-lead")).toBe(true);
    const ids = new Set(map.nodes.map((n) => n.id));
    expect(map.edges.every((e) => ids.has(e.source) && ids.has(e.target))).toBe(true);
    expect(graph(s, "s1-w54")).toEqual(map);
    const dense = graph({ ...s, agents: agents.slice(0, 16) });
    expect(dense.nodes).toHaveLength(17);
    expect(dense.edges).toHaveLength(200);
    expect(dense.title).toBe("Map · showing 200 of 240 edges");
    const nodesOnly = graph({ ...s, spans: [] }, "s1-w54");
    expect(nodesOnly.nodes).toHaveLength(48);
    expect(nodesOnly.edges).toHaveLength(0);
    expect(nodesOnly.title).toBe("Map · showing 48 of 56 nodes");
    expect(nodesOnly.nodes.filter((n) => n.selected).map((n) => n.id)).toEqual(["s1-w54"]);
    expect(graph(swarm("s0", { agents: [] })).nodes).toHaveLength(1);
  });

  test("dense maps retain spawn and run updates before wakes, and wakes before questions", () => {
    const agents = Array.from({ length: 16 }, (_, i) =>
      agent("s1", i, i === 15 ? { spawnedBy: "s1-lead" } : {}),
    );
    const s = swarm("s1", {
      agents,
      spans: agents.map((a) => ({
        agentId: a.id,
        n: 1,
        startedAt: T0,
        messages: agents.length,
        wokeBy: agents.map((source) => source.id),
      })),
      activity: agents.map((a) => ({
        at: T0,
        text: "question",
        kind: "ask" as const,
        actor: a.id,
        count: 100,
      })),
      runs: [run("r1")],
    });
    expect(buildAgentEdges(s).filter((e) => e.kind === "woke").length).toBeGreaterThan(200);
    const map = graph(s);
    expect(map.edges).toHaveLength(200);
    expect(map.edges.slice(0, 2)).toEqual([
      { source: "s1-lead", target: "s1-w15", label: "×1" },
      { source: `run:${s.runs![0]!.runId}`, target: "s1-lead", label: "updates" },
    ]);
    expect(map.edges.every((e) => !e.dashed)).toBe(true);
    expect(map.title).toBe("Map · showing 200 of 257 edges");
    const sparse = graph({ ...s, spans: [] });
    expect(sparse.edges.slice(0, 2)).toEqual([
      { source: "s1-lead", target: "s1-w15", label: "×0" },
      { source: `run:${s.runs![0]!.runId}`, target: "s1-lead", label: "updates" },
    ]);
    expect(sparse.edges.slice(2).every((e) => e.dashed)).toBe(true);
  });
});

describe("the question inspector", () => {
  const ask = fixtures.asked!.health!.asks![0]!;
  const inspect = (s: SwarmSummary, selected: OperatorAsk = ask) => {
    const view = buildQuestionInspector(s, selected);
    board(askKey(s.id), view);
    return view;
  };

  test("keeps a complete 8,000-character multiline question with native prose", () => {
    const text = `@operator: **Full question**\n\n${"q".repeat(7900)}\nFinal sentence?`.padEnd(
      8000,
      "?",
    );
    const selected = { ...ask, text };
    const s = { ...fixtures.asked!, health: { asks: [selected] } };
    const view = inspect(s, selected);
    const question = view.sections[0];
    expect(question?.kind).toBe("cards");
    if (question?.kind !== "cards") throw new Error("missing question");
    expect(question.title).toBe("Question");
    expect(question.items[0]).toMatchObject({
      title: "@w1 asked",
      prose: true,
      fields: [
        { value: askText(text) },
        { value: `Asked ${ask.at}` },
        { label: "asked", clock: { at: ask.at, mode: "since" } },
      ],
    });
    expect(question.items[0]!.fields![0]!.value).toContain("\nFinal sentence?");
    expect(question.items[0]!.fields![0]!.value).toContain("**Full question**");
    const actions = view.sections.find((section) => section.kind === "actions");
    if (actions?.kind !== "actions") throw new Error("missing actions");
    expect(actions.title).toBe("Actions");
    expect(actions.items.map((item) => item.type)).toEqual(["reply-ask", "dismiss-ask"]);
    expect(actions.items[0]!.binding).toEqual({
      id: s.id,
      messageId: selected.messageId,
      threadRootId: selected.threadRootId,
    });
    expect(actions.items[0]!.fields![0]!.placeholder).toContain("as you");
    expect(actions.items[0]!.fields![0]!.placeholder).toContain("does not approve");
    expect(actions.items[1]!.payload).toEqual({ id: s.id, messageId: selected.messageId });
  });

  test("links to the authoritative thread root, not the question message", () => {
    const s = fixtures.asked!;
    const view = inspect(s);
    expect(view.sections[1]).toEqual({
      kind: "rows",
      title: "Thread",
      items: [{ text: "thread ↗", href: threadHref(s, ask.threadRootId) }],
    });
    expect(JSON.stringify(view.sections[1])).not.toContain(ask.messageId);
    const topLevel = { ...ask, threadRootId: ask.messageId };
    expect(JSON.stringify(inspect(s, topLevel).sections[1])).toContain(
      threadHref(s, ask.messageId)!,
    );
    expect(JSON.stringify(inspect(s, { ...ask, threadRootId: "" }).sections[1])).toContain(
      threadHref(s, ask.messageId)!,
    );
  });

  test("missing link metadata is explicit without inventing a URL", () => {
    const s = { ...fixtures.asked!, clickclack: undefined };
    const view = inspect(s);
    expect(view.sections[1]).toEqual({
      kind: "rows",
      title: "Thread",
      items: [{ text: "Thread link not recorded." }],
    });
    expect(view.sections.some((section) => section.kind === "actions")).toBe(true);
  });

  test("ended, stopping, concluded and disappeared questions are read-only without clocks", () => {
    const s = fixtures.asked!;
    const snapshots: SwarmSummary[] = [
      ...(["done", "stopped", "stalled", "exhausted", "error", "stopping"] as const).map(
        (status) => ({ ...s, status }),
      ),
      { ...s, endedAt: T0 },
      { ...s, conclusion: "" },
      { ...s, health: { asks: [] } },
      { ...s, health: undefined },
    ];
    for (const snapshot of snapshots) {
      const view = inspect(snapshot);
      expect(view.sections.some((section) => section.kind === "actions")).toBe(false);
      expect(JSON.stringify(view)).not.toContain('"clock"');
      expect(JSON.stringify(view)).toContain("Read-only:");
      const question = view.sections[0];
      if (question?.kind !== "cards") throw new Error("missing question");
      expect(question.items[0]!.fields![0]!.value).toBe(askText(ask.text));
    }
  });
});

describe("the gate inspector", () => {
  const inspect = (s: SwarmSummary, selected: ChildRun = s.runs![0]!) => {
    const view = buildGateInspector(s, selected);
    board(gateKey(s.id), view);
    return view;
  };
  const peer = () => {
    const approval = { ...gate("swarm"), pauseId: "pause-1", reviewer: "sgate-w1" };
    return swarm("sgate", {
      runs: [run("r1", { status: "paused", pendingApproval: approval })],
    });
  };
  const actions = (view: CanvasBoardView) => {
    const section = view.sections.find((section) => section.kind === "actions");
    return section?.kind === "actions" ? section.items : [];
  };

  test("peer reviews keep complete prose, reviewer and thread, with Reply but no approval", () => {
    const s = peer();
    const selected = s.runs![0]!;
    selected.pendingApproval!.prompt = `**Plan**\n\n${"p".repeat(8000)}\nLast prompt line.`;
    selected.pendingApproval!.files = [
      { path: "plan.md", text: `# Plan\n\n${"f".repeat(12000)}\nFinal file line.\n` },
      { path: "config.ts", text: "const retry = 30;\n\nexport { retry };\n" },
      { path: "empty.txt", text: "" },
    ];
    const view = inspect(s);
    expect(view.sections.map((section) => section.title)).toEqual([
      "Gate",
      "Files",
      "Review",
      "Actions",
    ]);
    const prompt = view.sections[0];
    if (prompt?.kind !== "cards") throw new Error("missing prompt");
    expect(prompt.items[0]).toMatchObject({
      prose: true,
      fields: [
        { value: selected.pendingApproval!.prompt },
        { label: "opened", clock: { at: selected.pendingApproval!.openedAt, mode: "since" } },
      ],
    });
    const files = view.sections[1];
    if (files?.kind !== "cards") throw new Error("missing files");
    expect(files.items).toHaveLength(3);
    for (const [i, file] of selected.pendingApproval!.files.entries()) {
      expect(files.items[i]).toMatchObject({
        title: file.path,
        prose: true,
        fields: [{ value: file.text }],
      });
    }
    expect(files.items[2]!.footnote).toBe("Empty file.");
    expect(view.sections[2]).toMatchObject({
      kind: "rows",
      items: [
        { text: "Reviewer: @w1" },
        { text: `Opened ${selected.pendingApproval!.openedAt}` },
        { text: "thread ↗", href: threadHref(s, selected.pendingApproval!.threadId) },
      ],
    });
    expect(actions(view).map((item) => item.type)).toEqual(["reply"]);
    expect(actions(view)[0]!.binding).toEqual({
      id: s.id,
      runId: selected.runId,
      gateIdentity: gateIdentity(selected),
    });
    expect(actions(view)[0]!.fields![0]!.placeholder).toContain("as you");
    expect(actions(view)[0]!.fields![0]!.placeholder).toContain("does not approve");
  });

  test("operator-only gates offer Open run without an approval composer", () => {
    const s = fixtures.onlyYou!;
    expect(actions(inspect(s)).map((item) => item.type)).toEqual(["reply", "open-run"]);
    expect(actions(inspect(s))[1]!.binding).toEqual({
      id: s.id,
      runId: s.runs![0]!.runId,
      gateIdentity: gateIdentity(s.runs![0]!),
    });
    const noThread = swarm(s.id, {
      runs: [
        run("r2", {
          status: "paused",
          pendingApproval: { ...gate("operator"), threadId: undefined },
        }),
      ],
    });
    expect(actions(inspect(noThread)).map((item) => item.type)).toEqual(["open-run"]);
  });

  test("missing reviewer, thread, files and opening time are stated honestly", () => {
    const s = swarm("slegacy", {
      clickclack: undefined,
      runs: [
        run("r1", {
          status: "paused",
          pendingApproval: { ...gate("swarm"), threadId: undefined, openedAt: undefined },
        }),
      ],
    });
    const view = inspect(s);
    expect(view.sections[1]).toEqual({
      kind: "rows",
      title: "Files",
      items: [{ text: "No gate files recorded." }],
    });
    expect(view.sections[2]).toEqual({
      kind: "rows",
      title: "Review",
      items: [
        { text: "Reviewer not recorded." },
        { text: "Gate opening time not recorded." },
        { text: "Thread link not recorded." },
      ],
    });
    expect(actions(view)).toEqual([]);
    const withThread = peer();
    expect(
      actions(inspect({ ...withThread, clickclack: undefined })).map((item) => item.type),
    ).toEqual(["reply"]);
  });

  test("read errors and host or rib truncation do not hide retained or empty files", () => {
    const s = peer();
    s.runs![0]!.pendingApproval!.files = [
      { path: "unreadable.md", error: "permission denied" },
      { path: "host-cut.md", text: "first retained\nlast retained", truncated: true },
      { path: "rib-cut.md", text: "", truncated: true },
      { path: "missing.md" },
      { path: "partial.md", text: "partial evidence", error: "read interrupted" },
    ];
    const files = inspect(s).sections[1];
    if (files?.kind !== "cards") throw new Error("missing files");
    expect(files.items).toHaveLength(5);
    expect(files.items[0]!.footnote).toBe("Could not be read: permission denied");
    expect(files.items[1]!.fields![0]!.value).toBe("first retained\nlast retained");
    expect(files.items[1]!.footnote).toContain("Truncated by the host or rib");
    expect(files.items[2]!.fields![0]!.value).toBe("");
    expect(files.items[2]!.footnote).toContain("No text retained.");
    expect(files.items[2]!.footnote).toContain("Truncated by the host or rib");
    expect(files.items[3]!.footnote).toBe("File text not recorded.");
    expect(files.items[4]!.fields![0]!.value).toBe("partial evidence");
    expect(files.items[4]!.footnote).toBe("Could not be read: read interrupted");
  });

  test("gate identity binds repeated pauses and legacy node, time and thread evidence", () => {
    const s = peer();
    const selected = s.runs![0]!;
    const identity = gateIdentity(selected);
    expect(
      gateIdentity({
        ...selected,
        pendingApproval: { ...selected.pendingApproval!, prompt: "updated prompt" },
      }),
    ).toBe(identity);
    const later = {
      ...selected,
      pendingApproval: { ...selected.pendingApproval!, pauseId: "pause-2" },
    };
    expect(gateIdentity(later)).not.toBe(identity);
    expect(actions(inspect({ ...s, runs: [later] }, selected))).toEqual([]);
    const legacy = {
      ...selected,
      pendingApproval: { ...selected.pendingApproval!, pauseId: undefined },
    };
    for (const patch of [
      { nodeId: "approve-code" },
      { openedAt: "2026-09-22T14:32:00.000Z" },
      { threadId: "new-thread" },
    ]) {
      expect(
        gateIdentity({ ...legacy, pendingApproval: { ...legacy.pendingApproval!, ...patch } }),
      ).not.toBe(gateIdentity(legacy));
    }
    expect(gateIdentity({ ...selected, runId: "another-run" })).not.toBe(identity);
    expect(gateIdentity({ ...selected, pendingApproval: undefined })).toBeUndefined();
  });

  test("ended, stopping, concluded, resumed and missing gates are read-only", () => {
    const s = peer();
    const selected = s.runs![0]!;
    const snapshots: SwarmSummary[] = [
      ...(["done", "stopped", "stalled", "exhausted", "error", "stopping"] as const).map(
        (status) => ({ ...s, status }),
      ),
      { ...s, endedAt: T0 },
      { ...s, conclusion: "" },
      { ...s, runs: [] },
      { ...s, runs: [{ ...selected, status: "running" }] },
      { ...s, runs: [{ ...selected, pendingApproval: undefined }] },
    ];
    for (const snapshot of snapshots) {
      const view = inspect(snapshot, selected);
      expect(actions(view)).toEqual([]);
      expect(JSON.stringify(view)).not.toContain('"clock"');
      expect(JSON.stringify(view)).toContain("Read-only:");
    }
    expect(JSON.stringify(inspect(s, { ...selected, pendingApproval: undefined }))).toContain(
      "Gate prompt not recorded.",
    );
  });
});

describe("the details inspector", () => {
  const inspect = (s: SwarmSummary) => {
    const view = buildDetailsInspector(s);
    board(detailsKey(s.id), view);
    return view;
  };
  const rows = (view: CanvasBoardView, title: string) => {
    const section = view.sections.find((section) => section.title === title);
    if (section?.kind !== "rows") throw new Error(`missing ${title} rows`);
    return section.items;
  };

  test("reconstructs the full 8,000-character task with bounded numbered disclosures", () => {
    for (const length of [1, 4000, 4001, 8000]) {
      const task = ` \n${"t".repeat(3994)} \n\n  **Task**\n`.padEnd(8000, " ").slice(0, length);
      const view = inspect(swarm("sfull", { task }));
      const disclosures = rows(view, "Task and context").filter((row) => row.detail !== undefined);
      expect(disclosures.map((row) => row.detail).join("")).toBe(task);
      expect(disclosures).toHaveLength(Math.ceil(length / EXCERPT_CHARS));
      expect(disclosures.every((row) => row.detail!.length <= 4000)).toBe(true);
      expect(disclosures.map((row) => row.text)).toEqual(
        disclosures.map((_, i) => `Task · part ${i + 1} of ${disclosures.length}`),
      );
    }
  });

  test("three distinct context disclosures retain their text and complete provenance", () => {
    const context: ContextIndexEntry[] = [
      {
        id: "issue-27",
        kind: "issue",
        title: "Original issue",
        chars: 4000,
        excerpt: `Issue body\n${"i".repeat(3989)}`,
        sourceUrl: "https://github.com/o/r/issues/27",
        retrievedAt: T0,
      },
      {
        id: "diff-27",
        kind: "diff",
        title: "Proposed diff",
        chars: 5000,
        excerpt: `Diff body\n${"d".repeat(3990)}`,
        sourceUrl: "https://github.com/o/r/pull/27/files",
        retrievedAt: "2026-09-22T14:10:00.000Z",
        headSha: "abcdef1234567890abcdef1234567890abcdef12",
        baseSha: "1234567890abcdef1234567890abcdef12345678",
      },
      {
        id: "checks-27",
        kind: "checks",
        title: "CI checks",
        chars: 8000,
        excerpt: `Checks body\n${"c".repeat(3988)}`,
        sourceUrl: "https://github.com/o/r/actions/runs/27",
        retrievedAt: "2026-09-22T14:15:00.000Z",
        headSha: "abcdef1234567890abcdef1234567890abcdef12",
      },
    ];
    const view = inspect(swarm("sctx", { context }));
    const entries = rows(view, "Task and context");
    for (const c of context) {
      expect(entries).toContainEqual(
        expect.objectContaining({
          text: `${c.id} · ${c.kind}: ${c.title}`,
          detail: c.excerpt,
        }),
      );
      expect(entries).toContainEqual({ text: `Source: ${c.sourceUrl}`, href: c.sourceUrl });
      expect(entries).toContainEqual({
        text: `Retrieved: ${c.retrievedAt} · Head SHA: ${c.headSha ?? "not recorded"} · Base SHA: ${c.baseSha ?? "not recorded"}`,
      });
      expect(entries.find((row) => row.detail === c.excerpt)?.trailing).toContain(
        c.chars.toLocaleString("en-US"),
      );
    }
    expect(entries.find((row) => row.detail === context[1]!.excerpt)?.trailing).toContain(
      "Excerpt truncated",
    );
  });

  test("keeps every context entry at the retained maximum without a shared preview budget", () => {
    const context: ContextIndexEntry[] = Array.from(
      { length: CONTEXT_BOUNDS.maxItems },
      (_, i) => ({
        id: `context-${i}`,
        kind: "note",
        title: `Context ${i}`,
        chars: 12000,
        excerpt: `${i}\n`.padEnd(EXCERPT_CHARS, String(i % 10)),
      }),
    );
    const s = swarm("smax", { task: "t".repeat(8000), context });
    const entries = rows(inspect(s), "Task and context");
    const disclosures = entries.filter((row) => row.detail !== undefined);
    expect(disclosures).toHaveLength(22);
    expect(disclosures.reduce((total, row) => total + row.detail!.length, 0)).toBe(88000);
    for (const c of context)
      expect(entries.find((row) => row.text.startsWith(`${c.id} ·`))?.detail).toBe(c.excerpt);
  });

  test("names all custom limits, requested role settings, overrides, served models and effort", () => {
    const s = swarm("ssetup", {
      size: "custom",
      sizeBase: "small",
      limits: {
        maxAgents: 7,
        maxTurns: 31,
        maxTurnsPerAgent: 9,
        maxConcurrent: 2,
        wallClockMs: 1234567,
        turnTimeoutMs: 654321,
        maxNudges: 4,
      },
      provider: "requested-provider",
      model: "requested-lead",
      workerModel: "requested-worker",
      power: "deep",
      effort: "xhigh",
      usage: { input: 100, output: 20, cached: 0 },
      agents: [
        agent("ssetup", 0, {
          model: "requested-lead",
          servedModel: "served-lead",
          providerId: "served-provider",
        }),
        agent("ssetup", 1, {
          model: "individual-override",
          servedModel: "served-worker",
          providerId: "worker-provider",
        }),
      ],
    });
    const setup = rows(inspect(s), "Setup").map((row) => row.text);
    expect(setup).toEqual([
      "Size: small, adjusted",
      "Effective limits: 7 agents · 31 total turns · 9 turns per worker · 2 concurrent turns",
      "Wall-clock limit: 1234567 ms · Turn timeout: 654321 ms · Idle nudge limit: 4",
      "Requested provider: requested-provider",
      "Requested lead model: requested-lead",
      "Requested worker model: requested-worker (worker role override)",
      "Requested power: deep",
      "Recorded reasoning effort: xhigh",
      "Requested model for @lead (lead): requested-lead",
      "Served model for @lead (lead): served-lead · provider: served-provider",
      "Requested model for @w1 (worker): individual-override (overrides role setting requested-worker)",
      "Served model for @w1 (worker): served-worker · provider: worker-provider",
      "100 in · 20 out tokens",
    ]);
  });

  test("legacy missing settings and power requests never masquerade as served evidence", () => {
    const s = swarm("slegacy", {
      provider: undefined,
      model: undefined,
      workerModel: undefined,
      power: "fast",
      effort: undefined,
      agents: [
        agent("slegacy", 0, { servedModel: "actual-model", providerId: "actual-provider" }),
        agent("slegacy", 1),
      ],
    });
    const setup = rows(inspect(s), "Setup").map((row) => row.text);
    expect(setup).toContain("Requested provider: host default; no explicit provider recorded");
    expect(setup).toContain("Requested lead model: fast power; no explicit model recorded");
    expect(setup).toContain(
      "Requested worker model: fast power; no explicit model recorded (inherits lead setting)",
    );
    expect(setup).toContain("Recorded reasoning effort: not recorded");
    expect(setup).toContain(
      "Served model for @lead (lead): actual-model · provider: actual-provider",
    );
    expect(setup).toContain("Served model for @w1 (worker): not reported · provider: not reported");
    expect(setup.filter((text) => text.startsWith("Requested")).join(" ")).not.toContain(
      "actual-model",
    );
    expect(setup.filter((text) => text.startsWith("Requested")).join(" ")).not.toContain(
      "actual-provider",
    );
    expect(
      rows(inspect({ ...s, power: undefined, agents: [] }), "Setup").map((row) => row.text),
    ).toContain("Requested lead model: host default; no explicit model recorded");
    expect(rows(inspect({ ...s, agents: [] }), "Setup").map((row) => row.text)).toContain(
      "Served models and per-agent requests not recorded.",
    );
    const inherited = rows(inspect({ ...s, model: "explicit-lead" }), "Setup").map(
      (row) => row.text,
    );
    expect(inherited).toContain("Requested worker model: explicit-lead (inherits lead setting)");
  });

  test("missing legacy excerpts, empty bodies and source truncation remain explicit", () => {
    const s = swarm("smissing", {
      task: "",
      context: [
        { id: "legacy", kind: "issue", title: "Legacy issue", chars: 6000 },
        {
          id: "partial",
          kind: "note",
          title: "Partial excerpt",
          chars: 9000,
          excerpt: "retained\nexcerpt",
        },
        { id: "empty", kind: "note", title: "Empty legacy body", chars: 0, excerpt: "" },
      ],
    });
    const entries = rows(inspect(s), "Task and context");
    expect(entries[0]!.text).toBe("Task text not recorded.");
    expect(entries[1]!.trailing).toBe("6,000 characters · excerpt not recorded (legacy summary)");
    expect(entries[1]!.detail).toBeUndefined();
    expect(entries[2]!.text).toBe("Source: not recorded");
    expect(entries[3]!.text).toBe(
      "Retrieved: not recorded · Head SHA: not recorded · Base SHA: not recorded",
    );
    expect(entries[4]!.detail).toBe("retained\nexcerpt");
    expect(entries[4]!.trailing).toContain("full source body is not retained here");
    expect(entries[7]!.trailing).toBe("0 characters · retained 0 characters (empty)");
    expect(entries[7]!.detail).toBeUndefined();
  });

  test("reuses health rows, provides exactly one transcript row and never offers a composer", () => {
    const s = swarm("shealth", {
      health: {
        socketDrops: 3,
        disconnectedAt: T0,
        channelFault: "offline",
        lastLeadFailure: "timeout",
        nudges: 1,
        refusedConclusions: 2,
        cancelFault: "cancel failed",
        quietSince: T0,
      },
    });
    for (const snapshot of [
      s,
      { ...s, status: "stopping" as const },
      { ...s, status: "done" as const, endedAt: T0, error: "ended" },
    ]) {
      const view = inspect(snapshot);
      expect(view.sections.map((section) => section.title)).toEqual([
        "Task and context",
        "Setup",
        "Health",
        "Transcript",
      ]);
      expect(rows(view, "Health")).toEqual([
        ...healthRows(snapshot),
        { text: `Disconnected since ${T0}` },
        { text: `Quiet since ${T0}` },
      ]);
      expect(rows(view, "Transcript")).toEqual([
        { text: "transcript ↗", href: channelHref(snapshot) },
      ]);
      expect(view.sections.some((section) => section.kind === "actions")).toBe(false);
      expect(JSON.stringify(view)).not.toContain('"fields"');
      expect(JSON.stringify(view)).not.toContain('"clock"');
    }
    const legacy = inspect(swarm("snolink", { clickclack: undefined }));
    expect(rows(legacy, "Transcript")).toEqual([{ text: "Transcript link not recorded." }]);
    expect(rows(legacy, "Health")).toEqual([{ text: "No health faults recorded." }]);
    expect(rows(legacy, "Task and context").at(-1)!.text).toBe("No task context recorded.");
  });
});

describe("the agent inspector", () => {
  const inspect = (s: SwarmSummary, index = 1) => {
    const view = buildAgentInspector(s, s.agents[index]!);
    board(`agent-${s.id}`, view);
    return view;
  };
  const writer = () =>
    swarm("s1", {
      agents: [
        agent("s1", 0),
        agent("s1", 1, {
          status: "busy",
          joinedAt: T0,
          spawnedBy: "s1-lead",
          model: "requested",
          servedModel: "served",
          providerId: "copilot",
          usage: { input: 1000, output: 2000, cached: 4000 },
          worktree: { path: "/repo/.worktrees/w1", branch: "writer/w1", base: "main" },
          prUrl: "https://github.com/o/r/pull/42",
        }),
      ],
      spans: [
        {
          agentId: "s1-w1",
          n: 1,
          startedAt: T0,
          endedAt: "2026-09-22T14:00:30.000Z",
          outcome: "timeout",
          messages: 1,
          wokeBy: ["rib"],
        },
        { agentId: "s1-lead", n: 1, startedAt: T0, messages: 1, wokeBy: ["rib"] },
        {
          agentId: "s1-w1",
          n: 2,
          startedAt: T0,
          messages: 4,
          wokeBy: ["s1-lead", "operator", "runs", "nudge", "rib"],
        },
      ],
      prs: [
        {
          agent: "s1-w2",
          url: "https://github.com/o/r/pull/42",
          branch: "other",
          at: T0,
          ci: { verdict: "fail" },
        },
        {
          agent: "s1-w1",
          url: "https://github.com/o/r/pull/42",
          branch: "writer/w1",
          at: T0,
          ci: { verdict: "running", detail: "build queued" },
        },
      ],
      recent: [
        { id: "m1", author: "s1-w1", at: T0, text: "**First**", threadRootId: "root" },
        { id: "m2", author: "s1-lead", at: T0, text: "Not the worker's message" },
        { id: "m3", author: "s1-w1", at: T0, text: "`Latest` @s1-lead" },
      ],
    });

  test("writer facts, real model, usage, provenance, recent threads and turns are native", () => {
    const s = writer();
    const view = inspect(s);
    const text = JSON.stringify(view);
    expect(view.sections[0]).toMatchObject({
      kind: "cards",
      items: [
        {
          title: "@w1",
          titleTone: "id-blue",
          pill: { label: "busy" },
          bar: { value: 3, total: 12 },
        },
      ],
    });
    expect(text).toContain(`"clock":{"at":"${T0}","mode":"since"}`);
    expect(text).toContain("3k fresh tokens · 4k cached");
    expect(text).toContain("Served model: served · provider: copilot");
    expect(text).not.toContain("requested");
    expect(text).toContain("Spawned by @lead");
    expect(text).toContain("joined");
    expect(text).toContain("/repo/.worktrees/w1");
    expect(text).toContain("Branch: writer/w1");
    expect(text).toContain("Draft PR #42 · CI running");
    expect(text).toContain("Open PR");
    expect(text).toContain("Woken by @lead, you, run updates, idle nudge, kickoff / rib notice");
    const said = view.sections.find((x) => x.kind === "rows" && x.title?.startsWith("Said"));
    expect(said?.kind === "rows" ? said.items.map((r) => r.text) : []).toEqual([
      "Latest @lead",
      "First",
    ]);
    expect(said?.kind === "rows" ? said.items[1]?.href : "").toBe(threadHref(s, "root"));
    const turns = view.sections.find((x) => x.title === "Turns");
    expect(turns?.kind === "rows" ? turns.items.length : 0).toBe(2);
    expect(text).toContain("took 30 s");
    const composer = view.sections.find((x) => x.kind === "actions");
    expect(composer).toMatchObject({
      items: [
        {
          type: "message-agent",
          label: "Message @w1",
          binding: { id: "s1", agentId: "s1-w1" },
          fields: [{ placeholder: "posts as you, wakes this agent, spends a turn" }],
        },
      ],
    });
    expect(view.sections.at(-1)).toMatchObject({
      items: [{ text: "its messages · transcript ↗", href: channelHref(s) }],
    });
  });

  test("lead meters use swarm budget and missing legacy evidence is honest", () => {
    const s = swarm("s1", { agents: [agent("s1", 0, { turns: 20 }), agent("s1", 1)] });
    const lead = inspect(s, 0);
    expect(lead.sections[0]).toMatchObject({ items: [{ bar: { value: 11, total: 40 } }] });
    expect(JSON.stringify(lead)).toContain("20 agent turns · no worker cap");
    expect(JSON.stringify(lead)).toContain("started with the swarm");
    const text = JSON.stringify(inspect(s));
    for (const missing of [
      "Token usage not reported",
      "Served model: not reported",
      "provider: not reported",
      "Spawn provenance not recorded",
      "Join time not recorded",
      "No turn spans recorded",
      "No messages by this agent",
    ])
      expect(text).toContain(missing);
    const zero = inspect({
      ...s,
      agents: [s.agents[0]!, { ...s.agents[1]!, usage: { input: 0, output: 0, cached: 0 } }],
    });
    expect(JSON.stringify(zero)).toContain("0 fresh tokens · 0 cached");
  });

  test("concentrated lead history stays under budget and links to all recorded turns", () => {
    const agents = Array.from({ length: 12 }, (_, i) =>
      agent("s9big", i, {
        handle: `s9big-${String(i).padStart(2, "0")}${"w".repeat(18)}`,
        role: "r".repeat(2000),
        turns: i === 0 ? 189 : 1,
      }),
    );
    const s = swarm("s9big", {
      agents,
      turnsUsed: 200,
      limits: { ...SIZE_PRESETS.large, maxAgents: 12, maxTurns: 200 },
      spans: Array.from({ length: 200 }, (_, i) => ({
        agentId: agents[i < 189 ? 0 : i - 188]!.id,
        n: i + 1,
        startedAt: T0,
        endedAt: T0,
        outcome: "ok" as const,
        messages: 11,
        wokeBy: agents.slice(1).map((a) => a.id),
      })),
      recent: Array.from({ length: MESSAGES_KEPT }, (_, i) => ({
        id: `msg_${i}`,
        author: agents[0]!.id,
        at: T0,
        text: "m".repeat(MESSAGE_CHARS),
      })),
    });
    for (const summary of [s, { ...s, status: "done" as const, endedAt: T0 }]) {
      const view = inspect(summary, 0);
      expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThan(48_000);
      const turns = view.sections.find((x) => x.title?.startsWith("Turns"));
      expect(turns?.title).toBe(`Turns · newest ${INSPECTOR_TURNS_SHOWN} of 189`);
      expect(turns?.kind === "rows" ? turns.items : []).toHaveLength(INSPECTOR_TURNS_SHOWN);
      if (turns?.kind !== "rows") throw new Error("expected turns");
      expect(turns.items[0]?.text).toStartWith("Turn 189");
      expect(turns.items.at(-1)?.text).toStartWith(`Turn ${190 - INSPECTOR_TURNS_SHOWN}`);
      expect(view.sections).toContainEqual({
        kind: "actions",
        items: [
          {
            type: "open-record",
            label: "Open the record",
            glyph: "◷",
            hint: "All recorded turns are on the record's timeline.",
            payload: { id: s.id },
          },
        ],
      });
      expect(buildRecord(summary, new Date(T0))).toContain("turn 1 · ok");
      expect(summary.spans).toHaveLength(200);
    }
    const short = inspect({ ...s, spans: s.spans!.slice(0, INSPECTOR_TURNS_SHOWN) }, 0);
    const turns = short.sections.find((x) => x.title === "Turns");
    expect(turns?.kind === "rows" ? turns.items.at(-1)?.text : "").toStartWith("Turn 1");
    expect(JSON.stringify(short)).not.toContain('"type":"open-record"');
  });

  test("all states render and retired workers cannot request another turn", () => {
    for (const status of ["busy", "idle", "waiting", "capped", "failed"] as const) {
      const s = writer();
      const view = inspect({ ...s, agents: [s.agents[0]!, { ...s.agents[1]!, status }] });
      const composer = view.sections.find((x) => x.kind === "actions");
      const item = composer?.kind === "actions" ? composer.items[0] : undefined;
      expect(item?.disabled ?? false).toBe(status === "capped" || status === "failed");
      if (item?.disabled) expect(item.reason).toContain("cannot take another turn");
    }
  });

  test("ended legacy spans have no clock or composer; stopping and concluded are read-only", () => {
    const s = writer();
    for (const status of [
      "done",
      "stopped",
      "stalled",
      "exhausted",
      "error",
      "stopping",
    ] as const) {
      const view = inspect({ ...s, status, endedAt: T0 });
      const text = JSON.stringify(view);
      expect(text).not.toContain('"clock"');
      expect(text).not.toContain('"type":"message-agent"');
      expect(text).toContain("messaging is read-only");
    }
    const legacy = inspect({ ...s, status: "done", endedAt: undefined });
    expect(JSON.stringify(legacy)).not.toContain('"clock"');
    expect(JSON.stringify(legacy)).toContain("end not recorded");
    expect(
      inspect({ ...s, conclusion: "finished" }).sections.some((x) => x.kind === "actions"),
    ).toBe(false);
    expect(JSON.stringify(inspect({ ...s, conclusion: "finished" }))).toContain("no new turns");
  });

  test("writer CI never borrows another owner or replaces missing evidence", () => {
    for (const verdict of ["pass", "fail", "unknown", "running", undefined] as const) {
      const s = writer();
      const pr = s.prs![1]!;
      const view = inspect({ ...s, prs: [{ ...pr, ci: verdict ? { verdict } : undefined }] });
      expect(JSON.stringify(view)).toContain(`CI ${verdict ?? "not reported"}`);
    }
    const s = writer();
    expect(JSON.stringify(inspect({ ...s, prs: [s.prs![0]!] }))).toContain("CI not reported");
  });

  test("legacy writer branch evidence and latest closed turn stay accessible without a live clock", () => {
    const s = writer();
    const view = inspect({
      ...s,
      agents: [
        s.agents[0]!,
        { ...s.agents[1]!, worktree: undefined, servedModel: undefined, providerId: undefined },
      ],
      spans: [
        {
          agentId: "s1-w1",
          n: 1,
          startedAt: T0,
          endedAt: T0,
          outcome: "ok",
          messages: 1,
          wokeBy: ["missing"],
        },
        {
          agentId: "s1-w1",
          n: 2,
          startedAt: T0,
          endedAt: T0,
          outcome: "error",
          messages: 0,
          wokeBy: [],
        },
      ],
      prs: [s.prs![1]!],
    });
    const text = JSON.stringify(view);
    expect(text).toContain("Branch: writer/w1");
    expect(text).toContain("Worktree not recorded");
    expect(text).toContain("Served model: not reported · provider: not reported");
    expect(text).toContain("unknown source missing");
    expect(text).toContain("Woken by not recorded");
    expect(text).not.toContain('"clock"');
    expect(view.sections[0]).toMatchObject({
      items: [{ fields: [{}, { value: expect.stringContaining("Turn 2") }] }],
    });
  });
});

describe("the live cockpit", () => {
  const sections = (s: SwarmSummary, now?: Date) => {
    const sections = buildCockpit(s, needsYou(s), { titled: true, now });
    board(INDEX_KEY, { view: "board", title: "Swarms", sections });
    return sections;
  };

  test("the head, state, agent strip and budget precede Map, conversation, composer, details and verbs", () => {
    const s = fixtures.running!;
    const cockpit = sections(s);
    expect(cockpit.map((x) => x.kind)).toEqual([
      "cards",
      "rows",
      "segments",
      "stats",
      "graph",
      "rows",
      "actions",
      "actions",
    ]);
    expect(cockpit[0]).toMatchObject({
      kind: "cards",
      title: "Live",
      items: [
        { title: `${s.task.split("\n")[0]} · ${s.id}`, pill: { label: "running", tone: "info" } },
      ],
    });
    const head = cockpit[0]?.kind === "cards" ? cockpit[0].items[0] : undefined;
    expect(head).not.toHaveProperty("chip");
    expect(head?.footnote).toBeUndefined();
    expect(head?.fields?.[0]?.people).toHaveLength(2);
    expect(cockpit.some((x) => x.kind === "columns")).toBe(false);
    expect(cockpit.at(-1)).toMatchObject({
      kind: "actions",
      wrap: true,
      items: [
        { type: "open-record" },
        { type: "open-details", label: "Details", payload: { id: s.id } },
        { type: "stop-swarm", inline: true, align: "end" },
      ],
    });
    expect(buildCockpit(s, [], { titled: false })[0]?.title).toBeUndefined();
  });

  test("Map owns a top-level row before Conversation and the eligible composer on every live surface", () => {
    for (const status of ["running", "stopping"] as const) {
      for (const conclusion of [undefined, "Done"]) {
        for (const recent of [undefined, [], fixtures.running!.recent]) {
          const s = { ...fixtures.running!, status, conclusion, recent };
          const selectedAgentId = s.agents[1]!.id;
          const index = buildIndex(
            state({ live: [s], selectedAgents: new Map([[s.id, selectedAgentId]]) }),
          );
          const perSwarm = buildSwarmBoard(s, { selectedAgentId });
          board(INDEX_KEY, index);
          board(swarmKey(s.id), perSwarm);
          for (const raw of [
            buildCockpit(s, needsYou(s), { titled: true, selectedAgentId }),
            index.sections,
            perSwarm.sections,
          ]) {
            expect(raw.some((section) => section.kind === "columns")).toBe(false);
            const mapAt = raw.findIndex((section) => section.kind === "graph");
            expect(mapAt).toBeGreaterThanOrEqual(0);
            expect(raw[mapAt]).toEqual(buildAgentMap(s, selectedAgentId));
            const conversationAt = raw.findIndex((section) => section.title === "Conversation");
            expect(conversationAt).toBe(recent?.length ? mapAt + 1 : -1);
            const composerAt = raw.findIndex(
              (section) =>
                section.kind === "actions" &&
                section.items.some((item) => item.type === "message-lead" && item.expanded),
            );
            expect(composerAt).toBe(
              status === "running" && conclusion === undefined
                ? mapAt + (recent?.length ? 2 : 1)
                : -1,
            );
          }
        }
      }
    }
  });

  test("report, concluding and stopping verbs match their lifecycle", () => {
    const s = swarm("s1rpt", { report: { title: "Progress", at: T0, bytes: 200 } });
    const types = (s: SwarmSummary) => {
      const actions = sections(s).at(-1);
      return actions?.kind === "actions" ? actions.items.map((x) => x.type) : [];
    };
    expect(types(s)).toEqual(["open-report", "open-record", "open-details", "stop-swarm"]);
    expect(types({ ...s, conclusion: "Done" })).toEqual([
      "open-report",
      "open-record",
      "open-details",
      "stop-swarm",
    ]);
    expect(types({ ...s, status: "stopping" })).toEqual([
      "open-report",
      "open-record",
      "open-details",
    ]);
    const composer = (s: SwarmSummary) =>
      sections(s).find((x) => x.kind === "actions" && x.items[0]?.type === "message-lead");
    expect(composer(s)).toMatchObject({
      kind: "actions",
      wrap: true,
      items: [{ type: "message-lead", expanded: true }],
    });
    expect(composer({ ...s, conclusion: "Done" })).toBeUndefined();
    expect(composer({ ...s, status: "stopping" })).toBeUndefined();
  });

  test("peer review opens its gate from the cockpit without becoming or duplicating a request", () => {
    const peer = fixtures.review!;
    expect(needsYou(peer)).toEqual([]);
    expect(buildBadge(state({ live: [peer] }))).toEqual({ count: 0 });
    const index = buildIndex(state({ live: [peer] }));
    board(INDEX_KEY, index);
    expect(index.sections.some((section) => section.title === "Needs you")).toBe(false);
    const reviewing = index.sections.find((section) => section.title === "Approvals in review");
    if (reviewing?.kind !== "cards") throw new Error("missing peer gate");
    const card = reviewing.items[0]!;
    const payload = {
      id: peer.id,
      runId: peer.runs![0]!.runId,
      gateIdentity: gateIdentity(peer.runs![0]!),
    };
    expect(card.action).toEqual({ type: "select-gate", payload });
    expect(card.actions?.[0]).toEqual({ type: "select-gate", label: "Read gate", payload });
    expect(card.actions?.find((action) => action.type === "reply")?.binding).toEqual(payload);
    expect(
      sections({ ...peer, conclusion: "Done" }).some(
        (section) => section.title === "Approvals in review",
      ),
    ).toBe(false);
    const operator = buildIndex(state({ live: [fixtures.onlyYou!] }));
    const operatorCards = leaves(operator.sections).flatMap((section) =>
      section.kind === "cards" ? section.items : [],
    );
    expect(
      operatorCards.filter((card) =>
        card.actions?.some((action) => action.label === "Review plan"),
      ),
    ).toHaveLength(1);
  });

  test("quiet peer gates retain Read gate on the index and per-swarm board", () => {
    for (const threadId of ["msg_0042", undefined]) {
      const current = run("rquiet", {
        status: "paused",
        pendingApproval: { ...gate("swarm"), threadId },
      });
      const s = swarm("squiet", { health: { quietSince: T0 }, runs: [current] });
      expect(needsYou(s).map((need) => need.kind)).toEqual(["quiet"]);
      const payload = { id: s.id, runId: current.runId, gateIdentity: gateIdentity(current) };
      for (const view of [buildIndex(state({ live: [s] })), buildSwarmBoard(s)]) {
        const cards = leaves(view.sections).flatMap((section) =>
          section.kind === "cards" ? section.items : [],
        );
        const quiet = cards.find((card) => card.pill?.label === "quiet");
        expect(quiet?.actions?.[0]?.type).toBe("message-lead");
        expect(quiet?.actions?.find((action) => action.type === "select-gate")).toEqual({
          type: "select-gate",
          label: "Read gate",
          payload,
        });
        expect(quiet?.actions?.find((action) => action.type === "reply")?.binding).toEqual(
          threadId ? payload : undefined,
        );
      }
    }
  });

  test("Conversation shows the eight newest messages with authors, threads, times and transcript", () => {
    const s = fixtures.running!;
    const cockpit = sections(s);
    const at = cockpit.findIndex((x) => x.title === "Conversation");
    const conversation = cockpit[at];
    if (conversation?.kind !== "rows") throw new Error("expected Conversation rows");
    expect(conversation.items).toHaveLength(CONVERSATION_SHOWN + 1);
    const messages = s.recent!.slice(-CONVERSATION_SHOWN).reverse();
    for (const [i, m] of messages.entries()) {
      expect(conversation.items[i]).toEqual({
        chip:
          m.author === "operator"
            ? { label: "you", tone: "neutral" }
            : m.author.endsWith("-w1")
              ? { label: "w1", tone: "id-blue" }
              : { label: "lead", tone: "brand" },
        text: `${m.threadRootId ? "↳ " : ""}${messageLine(s.id, m.text)}`,
        trailing: hhmm(m.at),
        href: threadHref(s, m.threadRootId ?? m.id),
      });
    }
    expect(conversation.items.at(-1)).toEqual({
      icon: "▤",
      text: "23 messages · transcript ↗",
      href: channelHref(s),
    });
    expect(JSON.stringify(conversation)).not.toContain("ClickClack");
    expect(cockpit[at + 1]).toMatchObject({
      kind: "actions",
      wrap: true,
      items: [{ type: "message-lead", expanded: true }],
    });
    const markup = conversation.items[2]!;
    expect(markup.text).toBe("<img src=x onerror=alert(1)> [click](javascript:alert(1)) bold");
    expect(markup.href).toBe(threadHref(s, "msg_7"));
    expect(markup.action).toBeUndefined();
    const liveBoard = buildSwarmBoard(s);
    board(swarmKey(s.id), liveBoard);
    expect(leaves(liveBoard.sections).find((x) => x.title === "Conversation")).toEqual(
      conversation,
    );
  });

  test("Conversation is absent without messages or after ending, but remains while stopping", () => {
    const s = fixtures.running!;
    for (const patch of [
      { recent: undefined },
      { recent: [] },
      { status: "done" as const, endedAt: T0 },
    ]) {
      expect(sections({ ...s, ...patch }).some((x) => x.title === "Conversation")).toBe(false);
      const view = buildSwarmBoard({ ...s, ...patch });
      board(swarmKey(s.id), view);
      expect(leaves(view.sections).some((x) => x.title === "Conversation")).toBe(false);
    }
    expect(sections({ ...s, status: "stopping" }).some((x) => x.title === "Conversation")).toBe(
      true,
    );
    const ended = buildSwarmBoard({
      ...s,
      status: "done",
      endedAt: T0,
      activity: [{ at: T0, text: "completed", kind: "conclusion" }],
    });
    expect(ended.sections.some((x) => x.title === "Activity")).toBe(true);
  });

  test("Conversation omits unknown chips and absent links, falling back to its kept count", () => {
    const s = {
      ...fixtures.running!,
      clickclack: undefined,
      messageCount: undefined,
      recent: [{ id: "msg_lone", at: T0, author: "unknown", text: "[link](https://other)" }],
    };
    const conversation = sections(s).find((x) => x.title === "Conversation");
    if (conversation?.kind !== "rows") throw new Error("expected Conversation rows");
    expect(conversation.items).toEqual([
      { text: "[link](https://other)", trailing: hhmm(T0) },
      { icon: "▤", text: "1 message · transcript ↗" },
    ]);
  });

  test("a live conclusion is readable from the cockpit", () => {
    const cockpit = sections(swarm("s1done", { conclusion: "Completed result" }));
    const outcome = cockpit.find((x) => x.kind === "cards" && x.title === "Outcome");
    const conclusion = outcome?.kind === "cards" ? outcome.items[0] : undefined;
    expect(conclusion?.title).toBe("Conclusion");
    expect(conclusion?.fields?.[0]?.value).toBe("Completed result");
    expect(conclusion?.actions).toContainEqual({
      type: "read-doc",
      label: "Read the conclusion",
      glyph: "▤",
      payload: { id: "s1done" },
    });
  });

  test("agent segments tone nonzero states and hatch the open seats", () => {
    const s = fixtures.twoBusy!;
    expect(sections(s)[2]).toEqual({
      kind: "segments",
      title: "Agents · 3 of 5",
      items: [
        { label: "busy", n: 2, tone: "info" },
        { label: "waiting", n: 1, tone: "caution" },
        { label: "2 open seats", n: null },
      ],
    });
    const full = swarm("s3seg", {
      limits: { ...SIZE_PRESETS.medium, maxAgents: 3 },
      agents: [
        agent("s3seg", 0, { status: "idle" }),
        agent("s3seg", 1, { status: "capped" }),
        agent("s3seg", 2, { status: "failed" }),
      ],
    });
    expect(sections(full)[2]).toMatchObject({
      items: [
        { label: "idle", n: 1, tone: "neutral" },
        { label: "capped", n: 1, tone: "warn" },
        { label: "failed", n: 1, tone: "error" },
      ],
    });
    expect(sections(swarm("s0seg", { agents: [], turnsUsed: 0 }))[2]).toMatchObject({
      items: [{ label: "5 open seats", n: null }],
    });
  });

  test("the budget always has Turns, Time and fresh Tokens with cached in the sub", () => {
    const s = fixtures.twoBusy!;
    const now = new Date("2026-09-22T14:21:00.000Z");
    expect(sections(s, now)[3]).toMatchObject({
      kind: "stats",
      title: "Budget",
      items: [
        {
          label: "Turns",
          value: 11,
          sub: "of 40 · pace over the last 5 min",
          spark: [1, 2, 0],
          delta: {
            text: "29 left · no turn in 5 min",
            direction: "flat",
          },
        },
        { label: "Time", clock: { mode: "until" } },
        { label: "Tokens", value: "250", sub: "fresh · 100 cached" },
      ],
    });
    expect(sections(fixtures.running!)[3]).toMatchObject({
      items: [{}, {}, { label: "Tokens", value: null, sub: "the provider reported none" }],
    });
  });

  test("the index uses its compose clock for the cockpit's turn forecast", () => {
    const s = swarm("s1for", {
      turnsUsed: 32,
      pace: [2, 1, 2, 1, 2],
      spans: turnSpans("s1for", [17, 17, 18, 19, 19, 20, 21, 21]),
    });
    const now = new Date("2026-09-22T14:21:00.000Z");
    const view = buildIndex(state({ live: [s] }), now);
    board(INDEX_KEY, view);
    const budget = view.sections.find((x) => x.kind === "stats" && x.title === "Budget");
    expect(budget?.kind === "stats" ? budget.items[0] : undefined).toMatchObject({
      label: "Turns",
      sub: "of 40 · pace over the last 5 min",
      delta: {
        text: `8 left · out about ${hhmm("2026-09-22T14:26:00.000Z")}, before the clock`,
        direction: "down",
        tone: "warn",
      },
    });
  });

  test("needs tone the head and health warnings tone the state row", () => {
    expect(sections(fixtures.onlyYou!)[0]).toMatchObject({
      items: [{ pill: { label: "needs you", tone: "caution" }, edge: "caution" }],
    });
    expect(sections(fixtures.leadFailure!)[1]).toMatchObject({
      items: [
        { glyph: "warn", text: "waiting for the lead's first turn · the lead's last turn failed" },
      ],
    });
  });
});

describe("Swarms boards", () => {
  test("all five live forecast deltas pass the host schema on both boards", () => {
    const now = new Date("2026-09-22T14:21:00.000Z");
    const readings = [
      {
        turnsUsed: 32,
        pace: [2, 1, 2, 1, 2],
        delta: {
          text: `8 left · out about ${hhmm("2026-09-22T14:26:00.000Z")}, before the clock`,
          direction: "down",
          tone: "warn",
        },
      },
      {
        turnsUsed: 18,
        pace: [1, 1, 1, 1, 2],
        delta: {
          text: `22 left · about 11 unused at ${hhmm("2026-09-22T14:30:00.000Z")}`,
          direction: "flat",
          tone: "caution",
        },
      },
      {
        turnsUsed: 18,
        pace: [2, 2, 2, 2, 3],
        delta: { text: "22 left · pace fits the clock", direction: "flat" },
      },
      {
        turnsUsed: 18,
        pace: [0, 0, 0, 0, 0],
        delta: { text: "22 left · no turn in 5 min", direction: "flat" },
      },
      {
        turnsUsed: 40,
        pace: [2, 2, 2, 2, 2],
        delta: { text: "none left · agents finish their turns", direction: "down", tone: "warn" },
      },
    ] satisfies (Pick<SwarmSummary, "turnsUsed" | "pace"> & {
      delta: ReturnType<typeof forecastDelta>;
    })[];
    for (const { turnsUsed, pace, delta } of readings) {
      const s = swarm("s5for", {
        turnsUsed,
        pace,
        spans: turnSpans(
          "s5for",
          pace.flatMap((n, i) => Array.from({ length: n }, () => 17 + i)),
        ),
      });
      const index = buildIndex(state({ live: [s] }), now);
      const drawer = buildSwarmBoard(s, { now });
      board(INDEX_KEY, index);
      board(swarmKey(s.id), drawer);
      for (const view of [index, drawer]) {
        const budget = view.sections.find((x) => x.kind === "stats" && x.title === "Budget");
        const tile = budget?.kind === "stats" ? budget.items[0] : undefined;
        expect(tile?.delta).toEqual(delta);
        expect(tile?.value).toBe(turnsUsed);
        expect(tile?.sub).toBe("of 40 · pace over the last 5 min");
        expect(tile?.tone).toBe(turnsUsed === 40 ? "warn" : undefined);
      }
    }
  });

  test.each(["running", "stopping"] as const)(
    "both boards count the full recent window across start-aligned buckets while %s",
    (status) => {
      const s = swarm("s6for", {
        status,
        turnsUsed: 5,
        pace: [0, 1, 1, 1, 1, 1, 0],
        spans: turnSpans("s6for", [1.75, 2.75, 3.75, 4.75, 5.75]),
      });
      const now = new Date("2026-09-22T14:06:30.000Z");
      const index = buildIndex(state({ live: [s] }), now);
      const drawer = buildSwarmBoard(s, { now });
      for (const view of [index, drawer]) {
        const budget = view.sections.find((x) => x.kind === "stats" && x.title === "Budget");
        const tile = budget?.kind === "stats" ? budget.items[0] : undefined;
        expect(tile?.delta).toEqual({
          text: `35 left · about 12 unused at ${hhmm("2026-09-22T14:30:00.000Z")}`,
          direction: "flat",
          tone: "caution",
        });
        expect(tile?.spark).toEqual([0, 1, 1, 1, 1, 1, 0]);
      }
    },
  );

  test("an ended Turns tile keeps its spent count and spark but has no forecast", () => {
    const s = { ...fixtures.done!, pace: [1, 3, 2, 0, 1] };
    const view = buildSwarmBoard(s, { now: new Date("2026-09-22T14:21:00.000Z") });
    board(swarmKey(s.id), view);
    const result = view.sections.find((x) => x.kind === "stats" && x.title === "Result");
    const tile = result?.kind === "stats" ? result.items[0] : undefined;
    expect(tile).toEqual({ label: "Turns", value: 11, sub: "of 40", spark: s.pace });
    expect(tile?.delta).toBeUndefined();
    expect(tile).not.toHaveProperty("delta");
  });

  test("a live three-of-twenty Turns tile has a numeric value and the total in its sub", () => {
    const s = swarm("s3for", { turnsUsed: 3, limits: SIZE_PRESETS.small, spans: [] });
    const now = new Date("2026-09-22T14:03:00.000Z");
    for (const view of [buildIndex(state({ live: [s] }), now), buildSwarmBoard(s, { now })]) {
      const budget = view.sections.find((section) => section.title === "Budget");
      expect(budget?.kind === "stats" ? budget.items[0] : undefined).toEqual({
        label: "Turns",
        value: 3,
        sub: "of 20 · pace over the last 5 min",
        delta: { text: "17 left · no turn in 5 min", direction: "flat" },
      });
    }
  });

  test("the shared Tokens tile distinguishes no turns from unreported usage", () => {
    expect(tokensTile(swarm("s0tok", { turnsUsed: 0 }))).toEqual({
      label: "Tokens",
      value: 0,
      sub: "fresh · none yet",
    });
    expect(tokensTile(fixtures.running!)).toEqual({
      label: "Tokens",
      value: null,
      sub: "the provider reported none",
    });
    const s = swarm("s1tok", { usage: { input: 200, output: 50, cached: 100 } });
    expect(tokensTile(s)).toEqual({ label: "Tokens", value: "250", sub: "fresh · 100 cached" });
    const stats = buildSwarmBoard(s).sections.find((x) => x.kind === "stats");
    expect(stats?.kind === "stats" ? stats.items[3] : undefined).toEqual(tokensTile(s));
  });

  test("every fixture composes a frame the host accepts", () => {
    board(INDEX_KEY, buildIndex(state()));
    board(INDEX_KEY, buildIndex(state({ server: { mode: "managed", running: false } })));
    const all = Object.values(fixtures);
    const live = all.filter((s) => s.status === "running");
    const ended = all.filter((s) => s.status !== "running");
    board(
      INDEX_KEY,
      buildIndex(
        state({
          live,
          starting: [starting],
          ended,
          server: { mode: "managed", url: "http://127.0.0.1:18080", running: true },
        }),
      ),
    );
    board(HISTORY_KEY, buildHistory(state({ ended })));
    board(HISTORY_KEY, buildHistory(state()));
    for (const s of all) board(swarmKey(s.id), buildSwarmBoard(s));
    for (const s of all.filter((s) => s.status === "running" || s.status === "stopping")) {
      board(INDEX_KEY, buildIndex(state({ live: [s] })));
    }
    board(swarmKey(starting.id), buildStartingBoard(starting));
    board(swarmKey("s0old"), buildGoneBoard("s0old"));
  });

  const cardsOf = (view: ReturnType<typeof buildIndex>) => {
    board(INDEX_KEY, view);
    const cards = view.sections.find((s) => s.kind === "cards");
    return cards?.kind === "cards" ? cards.items : [];
  };

  test("the index puts requests first, expands the oldest needing swarm, then folds the rest", () => {
    const view = buildIndex(
      state({
        live: [fixtures.running!, fixtures.quiet!, fixtures.onlyYou!],
        starting: [starting],
      }),
    );
    expect(view.header?.status).toEqual({ label: "2 need you", tone: "caution" });
    expect(view.header?.segments).toEqual([
      { label: "needs you", n: 2, tone: "caution" },
      { label: "running", n: 1, tone: "info" },
      { label: "starting", n: 1, tone: "neutral" },
    ]);
    expect(cardsOf(view).map((c) => c.title)).toEqual([
      "Review the plan for Fix issue #27: README undercounts frontend-mix nodes",
      `No agent has worked since ${hhmm("2026-09-22T14:40:00.000Z")}`,
    ]);
    const head = view.sections[2];
    expect(head?.kind === "cards" ? head.items[0]?.title : "").toEndWith(" · s7k1p");
    const folded = view.sections.find((s) => s.kind === "cards" && s.title === "Also live");
    expect(folded?.kind === "cards" ? folded.items.map((c) => c.title) : []).toEqual([
      "Fix issue #27: README undercounts frontend-mix nodes · s5c07",
      "Fix issue #27: README undercounts frontend-mix nodes · s9hjx",
      "Summarize open deploy issues · s0new",
    ]);
  });

  test("the live selection strip marks one expanded swarm and stale choices fall back", () => {
    const live = [fixtures.running!, fixtures.waiting!];
    for (const selected of [fixtures.waiting!.id, "s0old", undefined]) {
      const view = buildIndex(state({ live, selected }));
      board(INDEX_KEY, view);
      const strip = view.sections[0];
      const items = strip?.kind === "actions" ? strip.items : [];
      const expanded = selected === fixtures.waiting!.id ? live[1]! : live[0]!;
      expect(strip).toMatchObject({ kind: "actions", title: "Live · 2", wrap: true });
      expect(strip?.kind === "actions" ? strip.tabs : undefined).toBeUndefined();
      expect(items.map((x) => x.type)).toEqual(["select-swarm", "select-swarm"]);
      expect(items.filter((x) => x.selected)).toHaveLength(1);
      expect(items.find((x) => x.selected)?.payload).toEqual({ id: expanded.id });
      const head = view.sections[1];
      expect(head?.kind === "cards" ? head.items[0]?.title : "").toEndWith(` · ${expanded.id}`);
      const folded = view.sections.find((x) => x.kind === "cards" && x.title === "Also live");
      expect(folded?.kind === "cards" ? folded.items : []).toHaveLength(1);
    }
    const single = buildIndex(state({ live: [live[0]!] }));
    board(INDEX_KEY, single);
    expect(single.sections.slice(0, -1)).toEqual(buildCockpit(live[0]!, [], { titled: true }));
  });

  test("Needs you combines all request kinds, one card per request with task and id", () => {
    const question = { ...fixtures.asked!, runs: [] };
    const live = [fixtures.onlyYou!, question, fixtures.gone!, fixtures.quiet!];
    const view = buildIndex(state({ live }));
    const cards = cardsOf(view);
    expect(view.sections[0]?.title).toBe("Needs you");
    expect(cards.map((c) => c.pill?.label)).toEqual(["connection", "question", "decide", "quiet"]);
    const ordered = [fixtures.gone!, question, fixtures.onlyYou!, fixtures.quiet!];
    const undated = { ...fixtures.gone!, health: { socketDrops: 2 } };
    const last = cardsOf(buildIndex(state({ live: [fixtures.onlyYou!, undated] })));
    expect(last.map((c) => c.pill?.label)).toEqual(["decide", "connection"]);
    for (const [i, card] of cards.entries()) {
      expect(card.footnote).toEndWith(` · ${ordered[i]!.id}`);
      expect(card.reason).toBeUndefined();
      expect(JSON.stringify(card)).not.toContain("more request");
      expect(card.bar).toBeUndefined();
      expect(card.fields?.some((f) => f.people)).toBe(false);
      expect(card.actions?.some((a) => a.type === "swarm-open" || a.type === "stop-swarm")).toBe(
        false,
      );
      expect(card.actions?.filter((a) => a.type === "select-swarm")).toHaveLength(1);
    }
    const strip = view.sections[1];
    expect(strip?.kind === "actions" ? strip.items.every((x) => x.tone === "caution") : false).toBe(
      true,
    );
  });

  test("Needs you caps the cross-swarm list at the oldest twelve requests", () => {
    const live = Array.from({ length: 2 }, (_, i) =>
      swarm(`s0cap${i}`, {
        runs: Array.from({ length: 8 }, (_, j) =>
          run(`r${i}${j}`, {
            status: "paused",
            pendingApproval: {
              ...gate("operator"),
              openedAt: new Date(Date.parse(T0) + (i * 8 + j) * 60_000).toISOString(),
            },
          }),
        ),
      }),
    );
    const view = buildIndex(state({ live: live.reverse() }));
    const cards = cardsOf(view);
    expect(view.sections[0]?.title).toBe("Needs you · 16 · oldest 12 shown");
    expect(cards).toHaveLength(12);
    expect(cards[0]?.fields?.[1]?.clock?.at).toBe(T0);
    expect(cards[11]?.fields?.[1]?.clock?.at).toBe("2026-09-22T14:11:00.000Z");
  });

  test("folding and expanding a swarm preserves its state line", () => {
    const live = [fixtures.running!, fixtures.twoBusy!];
    const foldedView = buildIndex(state({ live, selected: fixtures.running!.id }));
    const expandedView = buildIndex(state({ live, selected: fixtures.twoBusy!.id }));
    board(INDEX_KEY, foldedView);
    board(INDEX_KEY, expandedView);
    const folded = foldedView.sections.find((x) => x.kind === "cards" && x.title === "Also live");
    const row = expandedView.sections[2];
    expect(folded?.kind === "cards" ? folded.items[0]?.fields?.[0]?.value : undefined).toBe(
      row?.kind === "rows" ? row.items[0]?.text : undefined,
    );
    expect(row?.kind === "rows" ? row.items[0]?.text : "").toContain("@w2 waits with 1 message");
  });

  test("a connection request starts a stopped managed server and links the transcript", () => {
    const down = { mode: "managed" as const, running: false };
    const card = cardsOf(buildIndex(state({ live: [fixtures.gone!], server: down })))[0];
    expect(card?.pill).toEqual({ label: "connection", tone: "error" });
    expect(card?.title).toBe("ClickClack stopped answering");
    expect(card?.actions?.[0]?.label).toBe("Start ClickClack");
    expect(card?.fields?.[0]?.value).toContain("the managed server is not running");
    expect(card?.fields?.[1]).toEqual({
      label: "since",
      clock: { at: "2026-09-22T12:50:00.000Z", mode: "since" },
    });
    expect(card?.fields?.[2]).toEqual({
      value: "transcript ↗",
      href: "http://127.0.0.1:18080/app/ws_1/ch_s4n4x",
    });
    expect(card?.actions?.map((a) => a.type)).toEqual(["server-start", "select-swarm"]);
    const up = { mode: "managed" as const, running: true, url: "http://127.0.0.1:18080" };
    const retrying = cardsOf(buildIndex(state({ live: [fixtures.gone!], server: up })))[0];
    expect(retrying?.fields?.[0]?.value).toContain("the swarm retries every 2 seconds");
    expect(retrying?.actions?.map((a) => a.type)).toEqual(["select-swarm"]);
    const view = buildSwarmBoard(fixtures.gone!, { server: down });
    board(swarmKey("s4n4x"), view);
    const request = view.sections.find((s) => s.kind === "cards");
    expect(request?.kind === "cards" ? request.items[0]?.actions?.[0]?.type : "").toBe(
      "server-start",
    );
  });

  test("a request card leads with the decision, its verb, and no meter", () => {
    const card = cardsOf(buildIndex(state({ live: [fixtures.onlyYou!] })))[0];
    expect(card?.pill).toEqual({ label: "decide", tone: "caution" });
    expect(card?.edge).toBe("caution");
    expect(card?.bar).toBeUndefined();
    expect(card?.fields).toEqual([
      {
        value:
          "fix-issue r20000-1 paused at approve-plan · only you can approve fix-issue on this host",
      },
      { label: "opened", clock: { at: "2026-09-22T14:31:00.000Z", mode: "since" } },
    ]);
    expect(card?.footnote).toBe("Fix issue #27: README undercounts frontend-mix nodes · s7k1p");
    expect(card?.reason).toBeUndefined();
    expect(card?.actions?.map((a) => a.label)).toEqual([
      "Review plan",
      "Read gate",
      "Reply",
      "Open swarm",
    ]);
    expect(card?.actions?.[0]).toMatchObject({ type: "open-run", tone: "brand" });
    expect(card?.actions?.[1]).toMatchObject({
      type: "select-gate",
      payload: {
        id: fixtures.onlyYou!.id,
        runId: fixtures.onlyYou!.runs![0]!.runId,
        gateIdentity: gateIdentity(fixtures.onlyYou!.runs![0]!),
      },
    });
    expect(card?.actions?.[3]?.hint).toBe(
      "large: up to 8 agents · 80 turns, 16 per worker · 4 at once · 5 min a turn. Model: gpt-6-astra.",
    );
  });

  test("two requests from one swarm are two cards, oldest first", () => {
    const cards = cardsOf(buildIndex(state({ live: [fixtures.asked!] })));
    expect(cards).toHaveLength(2);
    const question = cards[0];
    expect(question?.title).toBe("@w1 asked: which retry cap, 30 s or 60 s?");
    expect(question?.pill).toEqual({ label: "question", tone: "caution" });
    expect(question?.fields?.some((field) => field.href)).toBe(false);
    expect(JSON.stringify(question)).not.toContain("in ClickClack");
    expect(question?.actions?.[0]).toMatchObject({
      type: "select-ask",
      label: "Read question",
      payload: { id: fixtures.asked!.id, messageId: fixtures.asked!.health!.asks![0]!.messageId },
    });
    expect(cards[1]?.title).toBe(
      "Review the plan for Fix issue #27: README undercounts frontend-mix nodes",
    );
    expect(cards.every((c) => c.reason === undefined)).toBe(true);
  });

  test("a running card names the activity, then the budget as a named meter", () => {
    const view = buildIndex(
      state({ live: [fixtures.running!, fixtures.waiting!], selected: fixtures.running!.id }),
    );
    board(INDEX_KEY, view);
    const folded = view.sections.find((s) => s.kind === "cards" && s.title === "Also live");
    const card = folded?.kind === "cards" ? folded.items[0] : undefined;
    expect(card?.pill).toEqual({ label: "running", tone: "info" });
    expect(card?.edge).toBeUndefined();
    expect(card?.bar).toEqual({
      value: 11,
      total: 40,
      label: "Turn budget used",
      trailing: "11 of 40 · 29 remaining",
    });
    expect(card?.fields?.[0]?.value).toBe(stateLine(fixtures.waiting!, []).text);
    expect(card?.fields?.[1]).toEqual({
      label: "time",
      clock: { at: "2026-09-22T14:30:00.000Z", mode: "until" },
    });
    expect(card?.footnote).toBe(
      `keelson-sample · medium · gpt-5.6-sol · 2 agents · started ${hhmm(T0)}`,
    );
    expect(card?.actions?.[0]).toMatchObject({ type: "select-swarm", label: "Open swarm" });
    const stopping = cardsOf(buildIndex(state({ live: [fixtures.stopping!] })))[0];
    expect(stopping?.pill).toEqual({ label: "stopping", tone: "neutral" });
  });

  test("an empty tab shows the journey, not a placeholder row", () => {
    const view = buildIndex(state());
    board(INDEX_KEY, view);
    expect(view.sections.map((x) => x.kind)).toEqual(["journey", "rows"]);
    const journey = view.sections[0];
    expect(journey?.kind === "journey" ? journey.items[1] : undefined).toEqual({
      title: "Agents work it out",
      text: "The lead spawns workers, and they talk it through in #swarm-<id>.",
    });
    expect(view.sections.at(-1)).toEqual({
      kind: "rows",
      items: [
        {
          text: "Server · ClickClack checking…",
          trailing: "Manage ›",
          action: { type: "server-manage" },
        },
      ],
    });
    expect(view.header).toBeUndefined();
  });

  test("the server row reflects the current op instead of stale server state", () => {
    const server = { mode: "managed" as const, url: "http://127.0.0.1:18080", running: true };
    const failed = { verb: "reset" as const, phase: "failed" as const, at: T0, error: "boom" };
    const view = buildIndex(state({ server, op: failed, live: [] }));
    expect(view.sections.at(-1)).toMatchObject({
      kind: "rows",
      items: [
        {
          chip: { label: "reset failed", tone: "error" },
          text: "Server · ClickClack reset failed on 127.0.0.1:18080 · managed",
          trailing: "Manage ›",
          action: { type: "server-manage" },
        },
      ],
    });
  });

  test("ended rows lead with the outcome, group by day, and keep eight", () => {
    const now = new Date(T0);
    const ago = (days: number) => new Date(Date.parse(T0) - days * 86_400_000).toISOString();
    const ended = Array.from({ length: 11 }, (_, i) =>
      swarm(`s${String(i).padStart(4, "0")}`, {
        status: "done",
        endedAt: i < 5 ? ago(7) : i < 8 ? ago(1) : T0,
        conclusion: "The count is twelve. The README said eleven.",
      }),
    );
    const view = buildIndex(state({ ended }), now);
    const days = view.sections.filter((x) => x.kind === "rows" && x.title);
    expect(days.map((x) => x.title)).toEqual(["Today", "Yesterday", dayHeading(ago(7), now)]);
    const today = days[0]?.kind === "rows" ? days[0].items : [];
    expect(today).toHaveLength(3);
    expect(today[0]).toEqual({
      icon: "✓",
      text: "The count is twelve. · for: Fix issue #27: README undercounts frontend-mix nodes",
      trailing: `gpt-5.6-sol · 11 turns · 0 s · ${hhmm(T0)}`,
      action: { type: "swarm-open", payload: { id: "s0010" } },
    });
    const last = days[2]?.kind === "rows" ? days[2].items : [];
    expect(last.map((r) => r.text.slice(0, 5))).toEqual(["The c", "The c", "3 ear"]);
    expect(last.at(-1)).toMatchObject({ icon: "…", action: { type: "history-open" } });
    const history = buildHistory(state({ ended }), now).sections;
    expect(history.map((x) => (x.kind === "rows" ? x.items.length : 0))).toEqual([3, 3, 5]);

    const done = fixtures.done!;
    expect(endedRow(done).trailing).toBe(
      `gpt-6-astra · workers gpt-5.6-sol · 11 turns · 29 min · ${hhmm(done.endedAt)} · 1 of 1 run verified`,
    );
  });

  test("an ended row names the report, a rerun, or why it stopped, and stays short", () => {
    const again = endedRow(
      swarm("s2rer", {
        status: "done",
        endedAt: T0,
        rerunOf: "s1old",
        conclusion: "## Summary\n\n**Raise the wait** to 90 s. PR #41 does it.",
        report: { title: "Cold start timeout fix", at: T0, bytes: 3000 },
      }),
    );
    expect(again.text).toBe(
      "↻ Cold start timeout fix · for: Fix issue #27: README undercounts frontend-mix nodes",
    );
    expect(again.trailing?.endsWith("· ◧ report")).toBe(true);
    const said = endedRow(
      swarm("s2say", {
        status: "done",
        endedAt: T0,
        conclusion: "## Summary\n\n**Raise the wait** to 90 s. PR #41 does it.",
      }),
    );
    expect(said.text.startsWith("Raise the wait to 90 s. · for: ")).toBe(true);
    const stopped = endedRow(
      swarm("s2stp", { status: "stopped", endedAt: T0, error: "stopped from the Swarms tab" }),
    );
    expect(stopped).toMatchObject({
      chip: { label: "stopped", tone: "neutral" },
      text: "Stopped by you · for: Fix issue #27: README undercounts frontend-mix nodes",
    });
    expect(stopped.icon).toBeUndefined();
    const long = endedRow(
      swarm("s2lng", {
        status: "done",
        endedAt: T0,
        task: "word ".repeat(80),
        conclusion: `${"long ".repeat(40)}end.`,
      }),
    );
    expect(long.text.length).toBeLessThanOrEqual(90);
    expect(gist("Linking dominates the build, and disabled caching makes every run pay.", 60)).toBe(
      "Linking dominates the build, and disabled caching makes…",
    );
  });

  test("day headings read today, yesterday, then the weekday and date", () => {
    const now = new Date(2026, 8, 22, 9, 0);
    expect(dayHeading(new Date(2026, 8, 22, 0, 5).toISOString(), now)).toBe("Today");
    expect(dayHeading(new Date(2026, 8, 21, 23, 55).toISOString(), now)).toBe("Yesterday");
    expect(dayHeading(new Date(2026, 8, 15, 12, 0).toISOString(), now)).toBe("Tue Sep 15");
  });

  test("the drawer spells out the size and names the models per role", () => {
    const view = buildSwarmBoard(fixtures.done!);
    expect(view.header?.status).toEqual({ label: "done", tone: "ok" });
    expect(view.header?.chip).toBe(
      "medium · 11 turns · 29 min · gpt-6-astra · workers gpt-5.6-sol",
    );
    const text = JSON.stringify(view);
    const details = JSON.stringify(buildDetailsInspector(fixtures.done!));
    expect(details).toContain(
      "Effective limits: 5 agents · 40 total turns · 12 turns per worker · 3 concurrent turns",
    );
    expect(details).toContain("Requested lead model: gpt-6-astra");
    expect(details).toContain("Requested worker model: gpt-5.6-sol");
    expect(text).not.toContain('"type":"steer"');
    expect(text).toContain('"label":"Runs verified","value":"1 of 1","tone":"ok"');
    expect(JSON.stringify(buildIndex(state({ ended: [fixtures.done!] })))).toContain(
      `· ${hhmm(fixtures.done!.endedAt)} · 1 of 1 run verified`,
    );
  });

  test("ended PR totals do not apply a run's passing CI to unrelated PR URLs", () => {
    const first = "https://github.com/o/r/pull/1";
    const unrelated = "https://github.com/o/r/pull/2";
    const child = run("ci");
    applyStatus(child, {
      runId: child.runId,
      workflowName: child.workflow,
      status: "succeeded",
      startedAt: T0,
      checkout: child.checkout!,
      nodes: [
        {
          nodeId: "await-ci",
          status: "succeeded",
          output: `Related PR: ${unrelated}\nCI_STATUS: PASS - ${first}`,
        },
      ],
    });
    expect(child.prUrls).toEqual([unrelated, first]);
    const view = buildSwarmBoard(swarm("ci", { status: "done", endedAt: T0, runs: [child] }));
    const tile = view.sections
      .flatMap((section) => (section.kind === "stats" ? section.items : []))
      .find((item) => item.label === "Pull requests");
    expect(tile).toEqual({ label: "Pull requests", value: 2, sub: "1 with CI passing" });
  });

  test("ended Result orders tiles and shows zero PRs only when the swarm could open them", () => {
    const id = "sresult";
    const base = swarm(id, {
      status: "done",
      endedAt: "2026-09-22T14:05:00.000Z",
      pace: [1, 2, 3],
    });
    const tiles = (s: SwarmSummary) => {
      const view = buildSwarmBoard(s, { now: new Date(T0) });
      board(swarmKey(id), view);
      const result = view.sections.find((section) => section.kind === "stats");
      if (result?.kind !== "stats") throw new Error("missing Result");
      expect(result.title).toBe("Result");
      return result.items;
    };
    const chat = tiles(base);
    expect(chat.map((tile) => tile.label)).toEqual(["Turns", "Time", "Tokens"]);
    expect(chat[0]).toEqual({ label: "Turns", value: 11, sub: "of 40", spark: [1, 2, 3] });
    expect(chat[1]).toEqual({ label: "Time", value: "5 min", sub: "of 30 min" });
    expect(chat[2]).toEqual({ label: "Tokens", value: null, sub: "the provider reported none" });
    expect(tiles({ ...base, turnsUsed: 0 })[2]).toEqual({
      label: "Tokens",
      value: 0,
      sub: "fresh · none yet",
    });
    expect(tiles({ ...base, usage: { input: 200, output: 50, cached: 100 } })[2]).toEqual({
      label: "Tokens",
      value: "250",
      sub: "fresh · 100 cached",
    });
    expect(tiles({ ...base, workflows: [], runs: [], prs: [], writeEnabled: false })).toEqual(chat);
    for (const patch of [
      { writeEnabled: true },
      { workflows: ["fix-issue"] },
      {
        agents: [
          agent(id, 0),
          agent(id, 1, { worktree: { path: "/wt/w1", branch: "writer", base: "main" } }),
        ],
      },
      { writeEnabled: true, runs: [] },
      { workflows: ["fix-issue"], runs: [] },
    ] satisfies Partial<SwarmSummary>[]) {
      const result = tiles({ ...base, ...patch });
      expect(result.map((tile) => tile.label)).toEqual([
        "Turns",
        "Time",
        "Tokens",
        "Pull requests",
      ]);
      expect(result[3]).toEqual({ label: "Pull requests", value: 0, sub: "0 with CI passing" });
    }
    const dispatch = tiles({
      ...base,
      workflows: ["fix-issue"],
      runs: [run("empty", { status: "succeeded", verified: true })],
    });
    expect(dispatch.map((tile) => tile.label)).toEqual([
      "Turns",
      "Time",
      "Tokens",
      "Pull requests",
      "Runs verified",
    ]);
    expect(dispatch[3]).toEqual({ label: "Pull requests", value: 0, sub: "0 with CI passing" });
    expect(dispatch[4]).toEqual({ label: "Runs verified", value: "1 of 1", tone: "ok" });
  });

  test("ended PR totals count distinct URLs and require every owner to explicitly pass", () => {
    const id = "s8cnt";
    const url = (n: number) => `https://github.com/o/r/pull/${n}`;
    const writerPr = (n: number, ci?: NonNullable<SwarmSummary["prs"]>[number]["ci"]) => ({
      agent: `${id}-w1`,
      branch: `writer/${n}`,
      at: T0,
      url: url(n),
      ...(ci ? { ci } : {}),
    });
    const tile = (s: SwarmSummary) => {
      const view = buildSwarmBoard(s);
      board(swarmKey(id), view);
      const items = view.sections.flatMap((section) =>
        section.kind === "stats" ? section.items : [],
      );
      if (s.status !== "running" && s.status !== "stopping") {
        expect(items.map((item) => item.label)).toEqual([
          "Turns",
          "Time",
          "Tokens",
          ...(s.prs?.length || s.runs?.some((r) => r.prUrls.length) ? ["Pull requests"] : []),
          ...(s.runs?.length ? ["Runs verified"] : []),
        ]);
      }
      return items.find((item) => item.label === "Pull requests");
    };
    const base = swarm(id, { status: "done", endedAt: T0 });
    const writers = [
      writerPr(1, { verdict: "pass" }),
      writerPr(2, { verdict: "fail" }),
      writerPr(3, { verdict: "unknown" }),
      writerPr(4, { verdict: "running" }),
      writerPr(5),
    ];
    expect(tile({ ...base, prs: writers })).toEqual({
      label: "Pull requests",
      value: 5,
      sub: "1 with CI passing",
    });
    expect(tile({ ...base, prs: [writerPr(1)] })).toEqual({
      label: "Pull requests",
      value: 1,
      sub: "0 with CI passing",
    });
    const runs = [
      run("ra", {
        prUrls: [url(1), url(6), url(7)],
        ci: { verdict: "pass", prUrl: url(7) },
        verified: false,
      }),
      run("rb", { prUrls: [url(8)], verified: true }),
    ];
    expect(tile({ ...base, runs })).toEqual({
      label: "Pull requests",
      value: 4,
      sub: "1 with CI passing",
    });
    expect(tile({ ...base, runs, prs: writers })).toEqual({
      label: "Pull requests",
      value: 8,
      sub: "1 with CI passing",
    });
    expect(tile({ ...base, runs, prs: [writerPr(1), writerPr(6, { verdict: "pass" })] })).toEqual({
      label: "Pull requests",
      value: 4,
      sub: "1 with CI passing",
    });
    expect(
      tile({
        ...base,
        runs: [...runs, run("rc", { prUrls: [url(7), url(7)], ci: { verdict: "fail" } })],
      }),
    ).toEqual({ label: "Pull requests", value: 4, sub: "0 with CI passing" });
    expect(
      tile({
        ...base,
        runs: [run("rd", { prUrls: [url(1)], ci: { verdict: "pass", prUrl: url(1) } })],
        prs: [writerPr(1, { verdict: "pass" })],
      }),
    ).toEqual({ label: "Pull requests", value: 1, sub: "1 with CI passing" });
    expect(
      tile({
        ...base,
        runs: [run("re", { prUrls: [url(1)], ci: { verdict: "pass" } })],
      }),
    ).toEqual({ label: "Pull requests", value: 1, sub: "0 with CI passing" });
    for (const status of ["running", "stopping"] as const) {
      expect(tile({ ...base, status, runs, prs: writers })).toBeUndefined();
    }
    expect(tile(base)).toBeUndefined();
  });

  test("a custom size says which preset it was adjusted from", () => {
    const view = buildSwarmBoard(
      swarm("s2cus", { size: "custom", limits: { ...SIZE_PRESETS.medium, maxTurns: 60 } }),
    );
    expect(view.header?.chip).toBe("medium, adjusted · 11 of 60 turns · gpt-5.6-sol");
    expect(
      JSON.stringify(
        buildDetailsInspector(
          swarm("s2cus", {
            size: "custom",
            limits: { ...SIZE_PRESETS.medium, maxTurns: 60 },
          }),
        ),
      ),
    ).toContain("Effective limits: 5 agents · 60 total turns");
  });

  test("an ended swarm leads with its cause, shows how long it ran, and no agent status", () => {
    const stopped = swarm("s3stp", {
      status: "stopped",
      endedAt: "2026-09-22T14:00:23.000Z",
      error: "stopped from the Swarms tab",
      agents: [agent("s3stp", 0, { turns: 1 }), agent("s3stp", 1, { status: "busy" })],
    });
    const view = buildSwarmBoard(stopped);
    const text = JSON.stringify(view);
    expect(view.header?.status).toEqual({ label: "stopped", tone: "neutral" });
    expect(view.header?.chip).toBe("medium · 11 turns · 23 s · gpt-5.6-sol");
    expect(text).toContain('"title":"Stopped by you at 14:00"');
    expect(text).toContain('"value":"1 turn"');
    expect(text).not.toContain('"pill":{"label":"busy"');
    expect(view.sections.map((x) => x.kind)).toEqual([
      "cards",
      "stats",
      "actions",
      "cards",
      "rows",
      "rows",
    ]);
    const row = JSON.stringify(buildIndex({ live: [], starting: [], ended: [stopped] }));
    expect(row).toContain('"chip":{"label":"stopped","tone":"neutral"}');
    expect(row).toContain("· 11 turns · 23 s · ");
    const out = buildSwarmBoard(
      swarm("s4out", { status: "exhausted", endedAt: T0, error: "turn budget of 40 spent" }),
    );
    expect(JSON.stringify(out)).toContain('"title":"Out of turns at 40"');
  });

  test("a live board runs requests, budget, Map, conversation, controls, then the details", () => {
    const view = buildSwarmBoard({ ...fixtures.review!, recent: fixtures.running!.recent });
    expect(view.sections.map((x) => x.kind)).toEqual([
      "cards",
      "stats",
      "graph",
      "rows",
      "actions",
      "actions",
      "rows",
    ]);
    const actions = leaves(view.sections).filter((s) => s.kind === "actions");
    expect(actions).toHaveLength(2);
    const items = actions[0]?.kind === "actions" ? actions[0].items : [];
    expect(items.map((i) => i.type)).toEqual(["message-lead"]);
    expect(items[0]).toMatchObject({ label: "Message the lead", expanded: true });
    expect(items[0]?.fields?.[0]?.placeholder).toBe("posts as you, wakes the lead");
    expect(actions[1]?.items[0]).toMatchObject({
      label: "Open the record",
      payload: { id: "s9hjy" },
    });
    expect(actions[1]?.items[1]).toMatchObject({
      type: "open-details",
      label: "Details",
      payload: { id: "s9hjy" },
    });
    expect(actions[1]?.items[2]).toMatchObject({ inline: true, align: "end" });
    const review = view.sections[0];
    expect(review?.kind === "cards" ? review.title : "").toBe("Approvals in review");
    expect(JSON.stringify(review)).toContain('"pill":{"label":"reviewing","tone":"info"}');
    expect(JSON.stringify(review)).toContain("a peer reviews the plan");
    const named = buildSwarmBoard({
      ...fixtures.review!,
      runs: [
        run("r1", {
          status: "paused",
          pendingApproval: { ...gate("swarm"), reviewer: "s9hjy-w1" },
        }),
      ],
    });
    expect(JSON.stringify(named.sections[0])).toContain("@w1 reviews the plan in its thread");
  });

  test("live agents use the map and ended cards select agents without ghosts", () => {
    const now = new Date("2026-09-22T14:21:00.000Z");
    const view = buildSwarmBoard(fixtures.waiting!, { now });
    board(swarmKey(fixtures.waiting!.id), view);
    expect(view.sections.some((x) => x.kind === "cards" && x.title?.startsWith("Agents"))).toBe(
      false,
    );
    const map = leaves(view.sections).find((x) => x.kind === "graph");
    expect(map?.kind === "graph" ? map.nodes.length : 0).toBe(3);
    const stats = view.sections.find((x) => x.kind === "stats");
    const tiles = stats?.kind === "stats" ? stats.items : [];
    expect(tiles[0]).toMatchObject({
      label: "Turns",
      value: 11,
      sub: "of 40 · pace over the last 5 min",
      spark: [1, 3, 2, 0, 1],
      delta: {
        text: `29 left · about 13 unused at ${hhmm("2026-09-22T14:30:00.000Z")}`,
        direction: "flat",
        tone: "caution",
      },
    });
    expect(tiles[1]).toEqual({
      label: "Time",
      clock: { at: "2026-09-22T14:30:00.000Z", mode: "until" },
      sub: `of 30 min · ends ${hhmm("2026-09-22T14:30:00.000Z")}`,
    });
    expect(tiles[2]).toMatchObject({ label: "Agents", value: "2 of 5", sub: "1 busy · 1 waiting" });
    expect(JSON.stringify(view)).toContain('"text":"@lead turn 3 ok ×2"');
    const ended = buildSwarmBoard(fixtures.done!, {
      selectedAgentId: fixtures.done!.agents[1]!.id,
    });
    const endedBench = ended.sections.find(
      (x) => x.kind === "cards" && x.title?.startsWith("Agents"),
    );
    const cards = endedBench?.kind === "cards" ? endedBench.items : [];
    expect(cards).toHaveLength(2);
    for (const [i, card] of cards.entries()) {
      expect(card.titleTone).toBe(fixtures.done!.agents[i]!.tone);
      expect(card).not.toHaveProperty("mono");
      expect(card).not.toHaveProperty("stacked");
      expect(card).not.toHaveProperty("ghost");
      expect(card.action).toEqual({
        type: "select-agent",
        payload: { id: fixtures.done!.id, agentId: fixtures.done!.agents[i]!.id },
      });
    }
    expect(cards[1]?.selected).toBe(true);
  });

  test("Produced so far names permitted workflows while none ran", () => {
    const titles = (s: SwarmSummary) =>
      leaves(buildSwarmBoard(s).sections).flatMap((x) =>
        x.kind === "rows" && x.title ? [x.title] : [],
      );
    expect(titles(fixtures.running!)).toEqual(["Conversation"]);
    expect(titles(fixtures.dispatchIdle!)).toEqual(["Produced so far"]);
    expect(JSON.stringify(buildSwarmBoard(fixtures.dispatchIdle!))).toContain(
      "The lead may start fix-issue, docs-check; none started yet.",
    );
    expect(JSON.stringify(buildSwarmBoard(fixtures.done!))).toContain(
      '"trailing":"PR #28 · verified"',
    );
    expect(JSON.stringify(buildSwarmBoard(fixtures.review!))).toContain("4 steps done");
  });

  test("boards relocate full task, context and setup to Details", () => {
    const s = swarm("s8ctx", {
      task: `Fix issue #27

${"detail ".repeat(1000)}`,
      context: [
        {
          id: "issue-27",
          kind: "issue",
          title: "README count",
          sourceUrl: "https://github.com/o/r/issues/27",
          retrievedAt: "2026-09-22T13:00:00.000Z",
          chars: 5000,
          excerpt: "x".repeat(4000),
        },
        { id: "note-1", kind: "note", title: "a note", chars: 12, excerpt: "twelve chars" },
      ],
    });
    for (const snapshot of [s, { ...s, status: "done" as const, endedAt: T0 }]) {
      const view = buildSwarmBoard(snapshot);
      board(swarmKey(s.id), view);
      const frame = JSON.stringify(view);
      expect(frame).not.toContain("Task and context");
      expect(frame).not.toContain("twelve chars");
      expect(frame).not.toContain("x".repeat(4000));
      expect(frame).not.toContain("detail ".repeat(100));
      expect(frame).not.toContain("up to 5 agents");
      expect(frame).toContain('"type":"open-details","label":"Details","payload":{"id":"s8ctx"}');
    }
    const cockpit = JSON.stringify(buildCockpit(s, [], { titled: true }));
    expect(cockpit).not.toContain("Task and context");
    expect(cockpit).not.toContain('"title":"About"');
    expect(cockpit).toContain('"type":"open-details"');
    const inspector = buildDetailsInspector(s);
    board(detailsKey(s.id), inspector);
    expect(JSON.stringify(inspector)).toContain("twelve chars");
  });

  test("activity lists the newest first, and the running card carries the last line", () => {
    const activity = Array.from({ length: 12 }, (_, i) => ({
      at: `2026-09-22T14:${String(10 + i).padStart(2, "0")}:00.000Z`,
      text: `@s7act-lead turn ${i + 1} ok`,
    }));
    const s = swarm("s7act", { activity });
    const drawer = buildSwarmBoard(s);
    expect(() => expectView(swarmKey("s7act"), "board")(drawer)).not.toThrow();
    const recent = JSON.stringify(drawer).match(/"title":"Activity","items":(\[.*?\])/)?.[1];
    const items = JSON.parse(recent ?? "[]");
    expect(items).toHaveLength(12);
    expect(items[0]).toMatchObject({ text: "@lead turn 12 ok", trailing: "14:21" });
    const index = JSON.stringify(buildIndex(state({ live: [s] })));
    expect(index).toContain(`"text":"${hhmm(activity.at(-1)?.at)} @lead turn 12 ok"`);
  });

  test("live conclusion previews reserve forecast room without truncating the full record", () => {
    const conclusion = "c".repeat(2_000);
    const s = swarm("s9pre", { conclusion });
    const preview = (s: SwarmSummary) => {
      const view = buildSwarmBoard(s);
      board(swarmKey(s.id), view);
      const outcome = view.sections.find((x) => x.kind === "cards" && x.title === "Outcome");
      return outcome?.kind === "cards" ? outcome.items[0]?.fields?.[0]?.value : undefined;
    };
    expect(preview(s)).toBe(`${"c".repeat(1_000)}…`);
    expect(preview({ ...s, status: "done", endedAt: T0 })).toBe(`${"c".repeat(1_200)}…`);
    expect(buildDoc(s, s.id)).toContain(conclusion);
  });

  test("frames stay inside their budgets at the limits", () => {
    const agents = Array.from({ length: 12 }, (_, i) => agent("s9big", i));
    const runs = Array.from({ length: 12 }, (_, i) =>
      run(`r${i}`, { status: "paused", pendingApproval: gate(i % 2 ? "swarm" : "operator") }),
    );
    const big = swarm("s9big", {
      agents,
      runs,
      limits: { ...SIZE_PRESETS.large, maxAgents: 12, maxTurns: 200, maxTurnsPerAgent: 50 },
      task: "t".repeat(8000),
      conclusion: "c".repeat(20_000),
      messageCount: 500,
      recent: Array.from({ length: MESSAGES_KEPT }, (_, i) => ({
        id: `msg_${i}`,
        at: T0,
        author: agents[i % agents.length]?.id ?? "operator",
        text: "<img src=x onerror=alert(1)> [click](javascript:alert(1)) **bold**".padEnd(
          MESSAGE_CHARS,
          "x",
        ),
        ...(i % 2 ? { threadRootId: "msg_0" } : {}),
      })),
      activity: Array.from({ length: ACTIVITY_KEPT }, (_, i) => ({
        at: T0,
        text: "a".repeat(400),
        kind: "turn" as const,
        actor: agents[i % agents.length]?.id,
      })),
      spans: Array.from({ length: 200 }, (_, i) => ({
        agentId: agents[i % agents.length]?.id ?? "",
        n: i,
        startedAt: T0,
        endedAt: T0,
        outcome: "ok" as const,
        messages: 3,
        wokeBy: ["s9big-lead", "operator"],
      })),
      pace: Array.from({ length: 30 }, (_, i) => i),
      usage: { input: 9_000_000, output: 400_000, cached: 7_000_000 },
    });
    const many = Array.from({ length: 50 }, (_, i) =>
      swarm(`s${String(i).padStart(4, "0")}`, {
        status: "done",
        endedAt: T0,
        task: "t".repeat(8000),
        conclusion: "c".repeat(20_000),
        report: { title: "r".repeat(200), at: T0, bytes: 512_000 },
      }),
    );
    const live = Array.from({ length: 6 }, (_, i) => ({ ...big, id: `s9bi${i}` }));
    const now = new Date("2026-09-22T14:21:00.000Z");
    for (const selected of [undefined, live[5]!.id]) {
      const view = buildIndex(
        state({
          live,
          ended: many,
          selected,
          selectedAgents: new Map(live.map((s) => [s.id, agents[11]!.id])),
        }),
        now,
      );
      board(INDEX_KEY, view);
      const produced = view.sections.find(
        (x) => x.kind === "rows" && x.title === "Produced so far",
      );
      expect(produced?.kind === "rows" ? produced.items.length : 0).toBe(12);
      expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThan(48_000);
      console.info(
        `Conversation index (six live, selected ${selected ?? "default"}): ${Buffer.byteLength(JSON.stringify(view))} bytes`,
      );
    }
    const artifacts: SwarmSummary = {
      ...big,
      report: { title: "Progress", at: T0, bytes: 512_000 },
      prs: [
        {
          agent: agents[1]!.handle,
          branch: "keelson/swarm/s9big/w1",
          url: "https://github.com/o/r/pull/100",
          at: T0,
          ci: { verdict: "unknown", detail: "check state not recognized" },
        },
      ],
    };
    const single = buildIndex(state({ live: [artifacts], ended: many }), now);
    board(INDEX_KEY, single);
    const inventory = single.sections.find(
      (x) => x.kind === "rows" && x.title === "Produced so far",
    );
    expect(inventory?.kind === "rows" ? inventory.items.length : 0).toBe(14);
    const bytes = Buffer.byteLength(JSON.stringify(single));
    expect(bytes).toBeLessThan(48_000);
    console.info(`Conversation index (one live, 20 recent messages): ${bytes} bytes`);
    const drawer = buildSwarmBoard(artifacts, { now });
    board(swarmKey(big.id), drawer);
    expect(Buffer.byteLength(JSON.stringify(drawer))).toBeLessThan(48_000);
    console.info(
      `Map per-swarm board (12 agents, 200 turns): ${Buffer.byteLength(JSON.stringify(drawer))} bytes`,
    );
    const produced = drawer.sections.find(
      (x) => x.kind === "rows" && x.title === "Produced so far",
    );
    expect(produced?.kind === "rows" ? produced.items.length : 0).toBe(14);
    expect(buildDoc(big, big.id).length).toBeLessThan(128_000);
    const ended = buildSwarmBoard(
      { ...artifacts, status: "done", endedAt: now.toISOString() },
      { now, launch: oldLaunch },
    );
    board(swarmKey(big.id), ended);
    expect(Buffer.byteLength(JSON.stringify(ended))).toBeLessThan(48_000);
    const endedActivity = ended.sections.find((section) => section.title === "Activity");
    expect(endedActivity?.kind === "rows" ? endedActivity.items : []).toHaveLength(12);
  });
});

describe("ended board contract", () => {
  const now = new Date("2026-09-22T14:30:00.000Z");
  test.each(["done", "stalled", "exhausted", "stopped", "error", "running", "stopping"] as const)(
    "a run-only legacy summary keeps result tiles ended-only for %s",
    (status) => {
      for (const workflows of [undefined, []]) {
        const s = {
          ...endedFixtures.conclusionOnly,
          status,
          workflows,
          writeEnabled: false,
          prs: [],
          runs: [run("legacy", { status: "cancelled" })],
        };
        const view = buildSwarmBoard(s, { now });
        board(swarmKey(s.id), view);
        const result = view.sections.find((section) => section.kind === "stats");
        if (result?.kind !== "stats") throw new Error("missing stats");
        const pr = result.items.find((tile) => tile.label === "Pull requests");
        const verified = result.items.find((tile) => tile.label === "Runs verified");
        if (status === "running" || status === "stopping") {
          expect(pr).toBeUndefined();
          expect(verified).toBeUndefined();
        } else {
          expect(result.items.map((tile) => tile.label)).toEqual([
            "Turns",
            "Time",
            "Tokens",
            "Pull requests",
            "Runs verified",
          ]);
          expect(pr).toEqual({ label: "Pull requests", value: 0, sub: "0 with CI passing" });
          expect(verified).toEqual({ label: "Runs verified", value: "0 of 1", tone: "warn" });
        }
      }
    },
  );

  test.each(Object.entries(endedFixtures))("%s composes the complete ended layout", (_name, s) => {
    const view = buildSwarmBoard(s, { now, launch: { ...oldLaunch, task: s.task } });
    board(swarmKey(s.id), view);
    const produced = view.sections.find((section) => section.title === "Produced so far");
    const activity = view.sections.find((section) => section.title === "Activity");
    expect(view.sections.map((section) => section.title ?? section.kind)).toEqual([
      "Outcome",
      "Result",
      "actions",
      `Agents · ${s.agents.length} of ${s.limits.maxAgents}`,
      ...(s.report || s.writeEnabled || s.workflows?.length ? ["Produced so far"] : []),
      ...(s.activity?.length ? ["Activity"] : []),
      "About",
      "rows",
    ]);
    const outcome = view.sections[0];
    if (outcome?.kind !== "cards") throw new Error("missing Outcome");
    expect(outcome.items).toHaveLength(1);
    expect(JSON.stringify(outcome)).not.toContain(s.channelId);
    expect(JSON.stringify(outcome)).not.toContain(s.channelName);
    if (s.conclusion) {
      expect(outcome.items[0]?.title).toBe(s.report?.title ?? "Conclusion");
      expect(outcome.items[0]?.fields?.[0]?.copyAction).toEqual({
        type: "copy-conclusion",
        payload: { id: s.id },
      });
      expect(outcome.items[0]?.actions?.map((action) => action.type)).toEqual([
        ...(s.report ? ["open-report"] : []),
        "read-doc",
      ]);
      expect(buildDoc(s, s.id)).toContain(s.conclusion);
    } else {
      expect(outcome.items[0]?.title).toBe(`Stopped by you at ${hhmm(s.endedAt)}`);
      expect(outcome.items[0]?.fields).toEqual([{ value: s.error }]);
      expect(outcome.items[0]?.actions?.[0]?.label).toBe("Read the draft");
      expect(buildDoc(s, s.id)).toContain(s.draftConclusion!);
    }
    const result = view.sections[1];
    if (result?.kind !== "stats") throw new Error("missing Result");
    expect(result.items.map((tile) => tile.label)).toEqual([
      "Turns",
      "Time",
      "Tokens",
      ...(s.writeEnabled || s.workflows?.length ? ["Pull requests"] : []),
      ...(s.runs?.length ? ["Runs verified"] : []),
    ]);
    expect(result.items[0]?.value).toBe(s.turnsUsed);
    expect(result.items[0]?.delta).toBeUndefined();
    expect(result.items[2]).toEqual(tokensTile(s));
    const pr = result.items.find((tile) => tile.label === "Pull requests");
    if (s.runs?.length) {
      expect(pr).toEqual({ label: "Pull requests", value: 2, sub: "1 with CI passing" });
      expect(result.items.at(-1)).toEqual({
        label: "Runs verified",
        value: "1 of 2",
        tone: "warn",
      });
    } else if (s.writeEnabled || s.workflows?.length) {
      expect(pr).toEqual({ label: "Pull requests", value: 0, sub: "0 with CI passing" });
    } else expect(pr).toBeUndefined();
    const verbs = view.sections[2];
    if (verbs?.kind !== "actions") throw new Error("missing actions");
    expect(verbs.items.map((action) => action.label)).toEqual([
      "Run again",
      "Open the record",
      "Details",
    ]);
    const bench = view.sections[3];
    if (bench?.kind !== "cards") throw new Error("missing Agents");
    expect(bench.columns).toBe(4);
    expect(bench.items).toHaveLength(s.agents.length);
    for (const [i, card] of bench.items.entries()) {
      const a = s.agents[i]!;
      expect(card.titleTone).toBe(a.tone);
      expect(card.action).toEqual({ type: "select-agent", payload: { id: s.id, agentId: a.id } });
      for (const property of ["mono", "stacked", "ghost", "pill"])
        expect(card).not.toHaveProperty(property);
      for (const field of card.fields ?? []) expect(field).not.toHaveProperty("mono");
      const inspector = buildAgentInspector(s, a);
      board(agentKey(s.id), inspector);
      expect(JSON.stringify(inspector)).not.toContain("message-agent");
    }
    if (s.activity?.length) {
      if (activity?.kind !== "rows") throw new Error("missing Activity");
      expect(activity.items).toHaveLength(12);
      expect(activity.items[0]?.trailing).toBe(hhmm(s.activity.at(-1)?.at));
      expect(activity.items[0]?.text).toEndWith("retained event 14 ×2");
      expect(activity.items[0]?.chip?.label).toBe("w1");
      expect(activity.items.every((row) => !row.action)).toBe(true);
    }
    if (s.report) expect(JSON.stringify(produced)).toContain('"type":"open-report"');
    if (s.runs?.length) {
      if (produced?.kind !== "rows") throw new Error("missing Produced so far");
      expect(produced.items).toHaveLength(5);
      const runs = produced.items.filter((row) => row.action?.type === "open-run");
      expect(runs).toHaveLength(2);
      expect(runs[0]?.trailing).toContain("verified");
      expect(runs[1]?.trailing).toContain("cancelled");
      expect(runs.every((row) => row.bar && "segments" in row.bar)).toBe(true);
      expect(JSON.stringify(produced)).toContain("approve-plan approved on @w1's review");
      expect(produced.items.filter((row) => row.trailing?.startsWith("draft PR"))).toHaveLength(1);
      expect(produced.items.at(-1)).toMatchObject({
        text: s.worktrees![0]!.path,
        trailing: s.worktrees![0]!.reason,
      });
    }
    const about = view.sections.at(-2);
    if (about?.kind !== "rows") throw new Error("missing About");
    expect(about.title).toBe("About");
    expect(about.items.slice(1, -1)).toEqual(healthRows(s));
    expect(about.items.at(-1)).toEqual({ text: "transcript ↗", href: channelHref(s) });
    expect(view.sections.at(-1)).toEqual({
      kind: "rows",
      items: [{ icon: "←", text: "Ended swarms", action: { type: "history-open" } }],
    });
    const frame = JSON.stringify(view);
    for (const removed of [
      '"title":"Spend"',
      "Read the full log",
      "Full task destination sentinel.",
      "Context destination sentinel.",
      "Effective limits:",
      "Requested lead model:",
    ])
      expect(frame).not.toContain(removed);
    const details = buildDetailsInspector(s);
    board(detailsKey(s.id), details);
    expect(details.sections.map((section) => section.title)).toEqual([
      "Task and context",
      "Setup",
      "Health",
      "Transcript",
    ]);
    const detailText = JSON.stringify(details);
    for (const retained of [
      "Full task destination sentinel.",
      "Context destination sentinel.",
      "Effective limits:",
      "Requested lead model:",
    ])
      expect(detailText).toContain(retained);
  });

  test("legacy records omit unavailable launch and transcript without inventing data", () => {
    const s = { ...endedFixtures.conclusionOnly, clickclack: undefined };
    const view = buildSwarmBoard(s, { now });
    board(swarmKey(s.id), view);
    const verbs = view.sections[2];
    expect(verbs?.kind === "actions" ? verbs.items.map((action) => action.label) : []).toEqual([
      "Open the record",
      "Details",
    ]);
    expect(JSON.stringify(view)).not.toContain("transcript ↗");
    const details = buildDetailsInspector(s);
    board(detailsKey(s.id), details);
    expect(JSON.stringify(details)).toContain("Transcript link not recorded.");
    const empty = buildSwarmBoard({ ...s, agents: [] }, { now });
    board(swarmKey(s.id), empty);
    expect(empty.sections[3]?.kind === "cards" ? empty.sections[3].items : []).toEqual([
      { title: "No agents recorded" },
    ]);
  });
});

describe("the details", () => {
  const rowsTitled = (view: ReturnType<typeof buildSwarmBoard>, title: string) => {
    const section = view.sections.find((x) => x.kind === "rows" && x.title === title);
    return section?.kind === "rows" ? section.items : [];
  };

  test("writer, two-run and mixed inventories agree across cockpit, index and ended board", () => {
    for (const ended of Object.values(producedFixtures)) {
      const original = JSON.stringify(ended);
      const endedBoard = buildSwarmBoard(ended);
      board(swarmKey(ended.id), endedBoard);
      const endedRows = rowsTitled(endedBoard, "Produced so far");
      for (const status of ["running", "stopping"] as const) {
        const s = { ...ended, status, endedAt: undefined };
        const view = buildSwarmBoard(s);
        const cockpit = { ...view, sections: buildCockpit(s, needsYou(s), { titled: true }) };
        const index = buildIndex(state({ live: [s] }));
        board(swarmKey(s.id), view);
        board(INDEX_KEY, cockpit);
        board(INDEX_KEY, index);
        const rows = rowsTitled(view, "Produced so far");
        expect(rowsTitled(cockpit, "Produced so far")).toEqual(rows);
        expect(rowsTitled(index, "Produced so far")).toEqual(rows);
        expect(rows).toEqual(endedRows.filter((row) => row.text !== ended.worktrees?.[0]?.path));
        expect(
          rows.some((row) => row.text.includes("none started") || row.text.includes("none opened")),
        ).toBe(false);
      }
      expect(JSON.stringify(ended)).toBe(original);
    }
    const mixed = producedFixtures.mixed;
    const rows = rowsTitled(buildSwarmBoard(mixed), "Produced so far");
    expect(
      rows.map((row) => row.action?.type ?? (row.href?.includes("/pull/90") ? "writer" : row.text)),
    ).toEqual([
      "writer",
      "open-run",
      "approve-plan approved on @w1's review",
      "open-report",
      "open-run",
      mixed.worktrees![0]!.path,
    ]);
    expect(rows[1]?.action?.payload).toEqual({ id: mixed.id, runId: mixed.runs![1]!.runId });
    expect(rows[2]).toMatchObject({
      icon: "✓",
      glyph: "ok",
      detail: "Plan reviewed",
      trailing: "14:05",
      href: "http://127.0.0.1:18080/app/ws_1/msg_review",
    });
    expect(rows[4]?.text).toContain("build failed");
  });

  test("equal and absent legacy landing timestamps preserve stable groups and gate adjacency", () => {
    const mixed = producedFixtures.mixed;
    for (const at of [T0, "", "invalid date"]) {
      const s: SwarmSummary = {
        ...mixed,
        report: { ...mixed.report!, at },
        runs: mixed.runs!.map((r) => ({ ...r, startedAt: at })),
        prs: mixed.prs!.map((pr) => ({ ...pr, at })),
      };
      const view = buildSwarmBoard(s);
      board(swarmKey(s.id), view);
      const rows = rowsTitled(view, "Produced so far");
      expect(rows[0]?.action?.type).toBe("open-report");
      expect(rows[1]?.action?.payload).toEqual({ id: mixed.id, runId: mixed.runs![0]!.runId });
      expect(rows[2]?.action?.payload).toEqual({ id: mixed.id, runId: mixed.runs![1]!.runId });
      expect(rows[3]?.text).toStartWith("approve-plan approved");
      expect(rows[4]?.text).toBe(mixed.prs![0]!.branch);
      expect(rows[5]?.text).toBe(mixed.worktrees![0]!.path);
    }
  });

  test("produced rows preserve report actions, writer identities, CI states and kept paths", () => {
    const id = "s8prd";
    const writer = agent(id, 1, {
      id: "bot-writer",
      worktree: { path: "/wt/w1", branch: "writer/branch", base: "main" },
    });
    const base = swarm(id, {
      agents: [agent(id, 0), writer],
      report: { title: "The report", at: T0, bytes: 3072 },
      prs: [
        {
          agent: writer.handle,
          branch: "writer/branch",
          url: "https://github.com/o/r/pull/81",
          at: T0,
        },
      ],
      worktrees: [
        {
          agent: writer.handle,
          path: "/wt/kept",
          branch: "writer/branch",
          reason: "2 commits not pushed",
        },
      ],
    });
    for (const verdict of [undefined, "pass", "fail", "running", "unknown"] as const) {
      const s = {
        ...base,
        prs: base.prs!.map((pr) => ({
          ...pr,
          ...(verdict ? { ci: { verdict, detail: "observed checks" } } : {}),
        })),
      };
      const view = buildSwarmBoard(s);
      board(swarmKey(id), view);
      const rows = rowsTitled(view, "Produced so far");
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({
        icon: "◧",
        text: "The report",
        trailing: "report 3 KB · Open the report",
        action: { type: "open-report", payload: { id } },
      });
      expect(rows[1]).toEqual({
        chip: { label: "w1", tone: "id-blue" },
        text: "writer/branch",
        trailing: `draft PR #81 · CI ${verdict ?? "not reported"}`,
        href: "https://github.com/o/r/pull/81",
        ...(verdict ? { detail: "observed checks" } : {}),
      });
      const ended = buildSwarmBoard({ ...s, status: "done", endedAt: T0 });
      board(swarmKey(id), ended);
      expect(rowsTitled(ended, "Produced so far").at(-1)).toEqual({
        chip: { label: "w1", tone: "id-blue" },
        text: "/wt/kept",
        trailing: "2 commits not pushed",
      });
    }
    const legacy = buildSwarmBoard({
      ...base,
      agents: [],
      status: "done",
      endedAt: T0,
      prs: base.prs!.map((pr) => ({
        ...pr,
        ci: { verdict: "unknown", detail: "x".repeat(5_000) },
      })),
      worktrees: base.worktrees!.map((wt) => ({ ...wt, reason: "r".repeat(5_000) })),
    });
    board(swarmKey(id), legacy);
    const rows = rowsTitled(legacy, "Produced so far");
    expect(rows[1]?.chip).toEqual({ label: "w1", tone: "neutral" });
    expect(rows[1]?.detail).toHaveLength(4_000);
    expect(rows[2]?.detail).toHaveLength(4_000);
    expect(rows[2]?.action).toBeUndefined();
  });

  test("empty inventory describes write capability and omits chat-only swarms", () => {
    const id = "s8emp";
    const beforeWriter = swarm(id, { writeEnabled: true });
    for (const status of ["running", "stopping", "done"] as const) {
      const s = { ...beforeWriter, status };
      const view = buildSwarmBoard(s);
      board(swarmKey(id), view);
      expect(rowsTitled(view, "Produced so far")[0]?.text).toContain(
        `The lead ${status === "done" ? "could" : "may"} spawn writers`,
      );
    }
    const writer = agent(id, 1, { worktree: { path: "/wt/w1", branch: "w1", base: "main" } });
    const named = buildSwarmBoard(
      swarm(id, { agents: [agent(id, 0), writer], workflows: ["fix-issue"] }),
    );
    expect(rowsTitled(named, "Produced so far")[0]?.text).toContain("Writers @w1 may open");
    expect(rowsTitled(named, "Produced so far")[0]?.text).toContain("fix-issue");
    expect(rowsTitled(buildSwarmBoard(swarm(id)), "Produced so far")).toHaveLength(0);
    const report = buildSwarmBoard(swarm(id, { report: { title: "Published", at: T0, bytes: 1 } }));
    expect(rowsTitled(report, "Produced so far")).toHaveLength(1);
    expect(JSON.stringify(rowsTitled(report, "Produced so far"))).not.toContain("none");
  });

  test.each(["running", "stopping", "done", "stopped"] as const)(
    "activity shows the newest twelve and points at the full log only while live (%s)",
    (status) => {
      const s = swarm("s7log", {
        status,
        endedAt: status === "running" || status === "stopping" ? undefined : T0,
        activity: Array.from({ length: 15 }, (_, i) => ({ at: T0, text: `event ${i}` })),
      });
      const view = buildSwarmBoard(s);
      board(swarmKey(s.id), view);
      const rows = rowsTitled(view, "Activity");
      const live = status === "running" || status === "stopping";
      expect(rows).toHaveLength(live ? 13 : 12);
      expect(rows[0]?.text).toBe("event 14");
      expect(rows.slice(0, 12).map((row) => row.text)).toEqual(
        Array.from({ length: 12 }, (_, i) => `event ${14 - i}`),
      );
      if (live)
        expect(rows.at(-1)).toMatchObject({
          text: "Read the full log · 3 earlier events",
          action: { type: "open-record", payload: { id: "s7log" } },
        });
      else {
        expect(rows.every((row) => !row.action)).toBe(true);
        expect(JSON.stringify(view)).not.toContain("Read the full log");
      }
      const record = buildRecord(s, new Date(T0));
      expect(record).toContain("<h2>Activity</h2>");
      expect(record).toContain("<td>event 0</tbody>");
      const short = buildSwarmBoard({ ...s, activity: [{ at: T0, text: "one" }] });
      expect(rowsTitled(short, "Activity").map((r) => r.text)).toEqual(["one"]);
      expect(rowsTitled(buildSwarmBoard({ ...s, activity: [] }), "Activity")).toHaveLength(0);
      const cockpitRows = leaves(buildCockpit(s, [], { titled: false })).find(
        (section) => section.title === "Activity",
      );
      if (live) expect(cockpitRows?.kind === "rows" ? cockpitRows.items : []).toEqual(rows);
      const action = leaves(view.sections)
        .flatMap((section) => (section.kind === "actions" ? section.items : []))
        .find((item) => item.type === "open-record");
      expect(action?.hint).toContain("Activity");
    },
  );

  test("ended About contains only times, health and one transcript with navigation separate", () => {
    for (const s of [fixtures.done!, { ...fixtures.done!, health: { socketDrops: 2 } }]) {
      const view = buildSwarmBoard(s);
      board(swarmKey(s.id), view);
      const rows = rowsTitled(view, "About");
      expect(rows[0]?.text).not.toContain("ClickClack");
      expect(rows[0]?.text).not.toContain("#swarm-");
      const transcript = {
        text: "transcript ↗",
        href: `http://127.0.0.1:18080/app/ws_1/${s.channelId}`,
      };
      expect(rows.at(-1)).toEqual(transcript);
      expect(rows.slice(1, -1)).toEqual(healthRows(s));
      expect(rows.filter((row) => row.text === "transcript ↗")).toHaveLength(1);
      expect(view.sections.at(-1)).toEqual({
        kind: "rows",
        items: [{ icon: "←", text: "Ended swarms", action: { type: "history-open" } }],
      });
    }
    expect(
      rowsTitled(buildSwarmBoard({ ...fixtures.done!, clickclack: undefined }), "About").some(
        (row) => row.text === "transcript ↗",
      ),
    ).toBe(false);
    const gone = buildGoneBoard("s0old");
    board(swarmKey("s0old"), gone);
    expect(gone.sections[0]?.kind === "rows" ? gone.sections[0].items[0]?.text : "").toBe(
      "Swarm s0old is no longer in the rib's history. Its channel #swarm-s0old keeps the transcript.",
    );
  });

  test("one outcome card holds only the report and conclusion, not channel chrome", () => {
    const s = swarm("s8out", {
      status: "done",
      endedAt: T0,
      conclusion: "The count is twelve.",
      report: { title: "README count", at: T0, bytes: 3072 },
    });
    const view = buildSwarmBoard(s);
    board(swarmKey(s.id), view);
    const outcome = view.sections.find((x) => x.kind === "cards" && x.title === "Outcome");
    const cards = outcome?.kind === "cards" ? outcome.items : [];
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      title: "README count",
      pill: { label: "report", tone: "brand" },
      footnote: `by @lead · ${day(T0)} ${hhmm(T0)} · 20 characters · report 3 KB`,
    });
    expect(cards[0]?.fields).toEqual([
      {
        value: "The count is twelve.",
        copyAction: { type: "copy-conclusion", payload: { id: s.id } },
      },
    ]);
    expect(cards[0]?.actions?.map((a) => a.label)).toEqual([
      "Open the report",
      "Read the conclusion",
    ]);
    const plainCard = buildSwarmBoard({ ...s, report: undefined }).sections.find(
      (x) => x.kind === "cards" && x.title === "Outcome",
    );
    const only = plainCard?.kind === "cards" ? plainCard.items[0] : undefined;
    expect(only?.title).toBe("Conclusion");
    expect(only?.pill).toBeUndefined();
    expect(only?.actions?.map((a) => a.label)).toEqual(["Read the conclusion"]);
  });

  test("run rows name the branch, every PR, how long, and why a run failed", () => {
    const s = swarm("s8run", {
      status: "done",
      endedAt: T0,
      runs: [
        run("ra", {
          status: "succeeded",
          prUrls: ["https://github.com/o/r/pull/41", "https://github.com/o/r/pull/42"],
          ci: { verdict: "pass" },
          verified: true,
          completedAt: "2026-09-22T14:07:00.000Z",
        }),
        run("rb", {
          status: "failed",
          isolated: false,
          error: "node build failed: tsc exited 2\nsrc/a.ts(1,1): error TS1005",
          ci: { verdict: "fail", detail: "2 checks failed" },
          completedAt: "2026-09-22T14:03:00.000Z",
        }),
      ],
    });
    const rows = rowsTitled(buildSwarmBoard(s), "Produced so far");
    expect(rows[0]).toMatchObject({
      text: "fix-issue Fix issue #27: README undercounts frontend-mix nodes · keelson/ra",
      trailing: "PR #41, #42 · 7 min · verified",
      href: "https://github.com/o/r/pull/41",
    });
    expect(rows[1]).toMatchObject({
      text: "fix-issue Fix issue #27: README undercounts frontend-mix nodes · keelson/rb · live checkout · node build failed: tsc exited 2",
      trailing: "3 min · failed",
    });
    const record = buildRecord(s, new Date(T0));
    expect(record).toContain(`<code>${shortRun("rb0000-1111-2222")}</code>`);
    expect(record).toContain("https://github.com/o/r/pull/42");
    expect(record).toContain("node build failed: tsc exited 2");
    expect(record).toContain("fail: 2 checks failed");
    expect(buildDoc(s, s.id)).not.toContain("## Runs");
  });

  test.each(["running", "stopping", "done", "stopped"] as const)(
    "spend bars each agent's fresh tokens against the swarm's only while live (%s)",
    (status) => {
      const s = swarm("s8spd", {
        status,
        endedAt: status === "running" || status === "stopping" ? undefined : T0,
        agents: [
          agent("s8spd", 0, { usage: { input: 3000, output: 1000, cached: 9000 } }),
          agent("s8spd", 1, { usage: { input: 900, output: 100, cached: 0 } }),
          agent("s8spd", 2),
        ],
      });
      const view = buildSwarmBoard(s);
      board(swarmKey(s.id), view);
      const expected = {
        kind: "bars",
        title: "Spend",
        inline: true,
        items: [
          { label: "lead", value: 4000, total: 5000, trailing: "4k · 80%" },
          { label: "w1", value: 1000, total: 5000, trailing: "1k · 20%" },
        ],
      } satisfies CanvasBoardView["sections"][number];
      if (status === "running" || status === "stopping") {
        expect(view.sections.find((x) => x.kind === "bars")).toEqual(expected);
        expect(
          leaves(buildCockpit(s, [], { titled: false })).find((x) => x.kind === "bars"),
        ).toEqual(expected);
      } else {
        expect(view.sections.some((x) => x.title === "Spend")).toBe(false);
        expect(buildRecord(s, new Date(T0))).toContain("Spend by agent");
        expect(buildRecord(s, new Date(T0))).toContain("4k fresh · 9k cached");
        expect(buildRecord(s, new Date(T0))).toContain("1k fresh · 0 cached");
      }
      const one = swarm("s8one", {
        agents: [agent("s8one", 0, { usage: { input: 10, output: 1, cached: 0 } })],
      });
      expect(buildSwarmBoard(one).sections.some((x) => x.kind === "bars")).toBe(false);
    },
  );

  test("activity rows chip their actor, and the bench names each agent's last event", () => {
    const at = (m: number) => `2026-09-22T14:0${m}:00.000Z`;
    const s = swarm("s7chp", {
      status: "done",
      endedAt: at(6),
      pace: [1, 3, 2],
      activity: [
        {
          at: at(1),
          text: "@s7chp-lead spawned @s7chp-w1: reads logs",
          kind: "spawn",
          actor: "s7chp-lead",
          subject: "s7chp-w1",
        },
        { at: at(2), text: "@s7chp-w1 turn 1 ok · 42 s · 1 new", kind: "turn", actor: "s7chp-w1" },
        {
          at: at(3),
          text: "you posted in #swarm-s7chp: keep going",
          kind: "operator",
          actor: "operator",
        },
        { at: at(4), text: "swarm s7chp done", kind: "end" },
        { at: at(5), text: "@s7chp-lead turn 3 ok" },
      ],
    });
    const view = buildSwarmBoard(s);
    board(swarmKey(s.id), view);
    expect(rowsTitled(view, "Activity")).toEqual([
      { text: "@lead turn 3 ok", trailing: hhmm(at(5)) },
      { text: "swarm s7chp done", trailing: hhmm(at(4)) },
      {
        chip: { label: "you", tone: "neutral" },
        text: "posted in #swarm-s7chp: keep going",
        trailing: hhmm(at(3)),
      },
      {
        chip: { label: "w1", tone: "id-blue" },
        text: "turn 1 ok · 42 s · 1 new",
        trailing: hhmm(at(2)),
      },
      {
        chip: { label: "lead", tone: "brand" },
        text: "spawned @w1: reads logs",
        trailing: hhmm(at(1)),
      },
    ]);
    const bench = view.sections.find((x) => x.kind === "cards" && x.title?.startsWith("Agents"));
    const cards = bench?.kind === "cards" ? bench.items : [];
    expect(cards[0]?.footnote).toBe(`last: spawned @w1: reads logs · ${hhmm(at(1))}`);
    expect(cards[1]?.footnote).toBe(`last: turn 1 ok · 42 s · 1 new · ${hhmm(at(2))}`);
    const turns = view.sections.find((x) => x.kind === "stats");
    expect(turns?.kind === "stats" ? turns.items[0]?.spark : undefined).toEqual([1, 3, 2]);
  });

  test("an answered approval names its reviewer and discloses the reason", () => {
    const rows = rowsTitled(buildSwarmBoard(fixtures.done!), "Produced so far");
    expect(rows[1]).toMatchObject({
      text: "approve-plan approved on @w1's review",
      detail: "r",
      href: "http://127.0.0.1:18080/app/ws_1/msg_1",
    });
  });
});

describe("the reading pane", () => {
  test("metadata retains the transcript but question and gate threads belong to inspectors", () => {
    for (const s of [fixtures.done!, fixtures.stalled!, fixtures.asked!]) {
      const doc = buildDoc(s, s.id);
      expect(doc).toContain(`· [transcript ↗](http://127.0.0.1:18080/app/ws_1/${s.channelId})`);
      expect(doc).not.toContain("in ClickClack");
      expect(doc).not.toContain(`[#${s.channelName}]`);
      const unlinked = buildDoc({ ...s, clickclack: undefined }, s.id);
      expect(unlinked).not.toContain("transcript ↗");
      expect(unlinked).not.toContain(" · *");
    }
    const asked = buildDoc(fixtures.asked!, fixtures.asked!.id);
    expect(asked).not.toContain("msg_0100");
    expect(asked).not.toContain("msg_0042");
    expect(asked).toContain("Open questions and gates in the tab's inspectors.");
    expect(
      JSON.stringify(buildQuestionInspector(fixtures.asked!, fixtures.asked!.health!.asks![0]!)),
    ).toContain("http://127.0.0.1:18080/app/ws_1/msg_0100");
    expect(
      JSON.stringify(buildGateInspector(fixtures.asked!, fixtures.asked!.runs![0]!)),
    ).toContain("http://127.0.0.1:18080/app/ws_1/msg_0042");
    expect(buildDoc(fixtures.running!, fixtures.running!.id)).toContain(
      "is working in #swarm-s9hjx.",
    );
    expect(buildDoc(undefined, "s0old")).toContain(
      "Its channel `#swarm-s0old` keeps the transcript.",
    );
  });

  test("gate files move to the inspector with complete literal prose and explicit failures", () => {
    const withFiles = swarm("s9fil", {
      runs: [
        run("r7", {
          status: "paused",
          pendingApproval: {
            nodeId: "approve-plan",
            prompt: "Approve?",
            files: [
              { path: "plan.md", text: "## Steps\n\n1. Count the nodes." },
              { path: "diff.patch", text: "+12 nodes", truncated: true },
              { path: "notes.txt", error: "not found" },
            ],
          },
        }),
      ],
    });
    const inspector = buildGateInspector(withFiles, withFiles.runs![0]!);
    board(gateKey(withFiles.id), inspector);
    const files = inspector.sections.find((section) => section.title === "Files");
    if (files?.kind !== "cards") throw new Error("missing files");
    expect(files.items).toEqual([
      { title: "plan.md", prose: true, fields: [{ value: "## Steps\n\n1. Count the nodes." }] },
      {
        title: "diff.patch",
        prose: true,
        fields: [{ value: "+12 nodes" }],
        footnote: "Truncated by the host or rib; only retained text is shown.",
      },
      { title: "notes.txt", prose: true, footnote: "Could not be read: not found" },
    ]);
    const doc = buildDoc(withFiles, withFiles.id);
    for (const text of [
      "Approve?",
      "plan.md",
      "Count the nodes.",
      "+12 nodes",
      "notes.txt",
      "not found",
    ])
      expect(doc).not.toContain(text);
  });

  test("the board's conclusion preview drops markdown marks; the pane keeps them", () => {
    const md = swarm("s8mdn", {
      status: "done",
      endedAt: T0,
      conclusion: "**Show all 12.** Drop `RECENT_SHOWN`.",
    });
    const drawer = JSON.stringify(buildSwarmBoard(md));
    expect(drawer).toContain('"value":"Show all 12. Drop RECENT_SHOWN."');
    expect(buildDoc(md, "s8mdn")).toContain("**Show all 12.** Drop `RECENT_SHOWN`.");
  });

  test.each([true, false])(
    "the conclusion's copy button reveals the whole conclusion (report: %s)",
    async (withReport) => {
      const conclusion = `# Complete result\n\n${"- **Evidence** with `code`.\n".repeat(500)}\nFinal conclusion sentinel.\n`;
      const task = `${"Full task details.\n".repeat(400)}Final task sentinel.`;
      const done = {
        ...fixtures.done!,
        task,
        conclusion,
        report: withReport ? { title: "Report", at: T0, bytes: 4096 } : undefined,
      };
      const doc = buildDoc(done, done.id);
      expect(doc).toContain(`\n\n${conclusion}\n\n## Task\n\n${task}\n`);
      const drawer = JSON.stringify(buildSwarmBoard(done));
      expect(drawer).toContain('"copyAction":{"type":"copy-conclusion","payload":{"id":"s8pln"}}');
      expect(drawer).not.toContain("Final conclusion sentinel.");
      const deps = {
        surface: undefined,
        find: (id: string) => (id === "s8pln" ? { ended: done } : {}),
        live: () => undefined,
        begin: () => "s0",
        launchOf: () => undefined,
      };
      const copy = (id: string) =>
        handleSwarmsAction({ type: "copy-conclusion", payload: { id } }, deps);
      expect(await copy("s8pln")).toEqual({ ok: true, data: done.conclusion });
      expect((await copy("s0non")).ok).toBe(false);
      expect(
        (
          await handleSwarmsAction(
            { type: "copy-conclusion", payload: { id: done.id } },
            { ...deps, find: () => ({ ended: { ...done, conclusion: undefined } }) },
          )
        ).ok,
      ).toBe(false);
    },
  );

  test("shows the whole conclusion or refused draft, but not gate prompts", () => {
    expect(buildDoc(fixtures.done, "s8pln")).toContain("x".repeat(3000));
    expect(buildDoc(fixtures.stalled, "s5tcx")).toContain("a draft");
    const gated = buildDoc(fixtures.review, "s9hjy");
    expect(gated).not.toContain("Plan: set the README node count to 12.");
    expect(gated).not.toContain("http://127.0.0.1:18080/app/ws_1/msg_0042");
    expect(
      JSON.stringify(buildGateInspector(fixtures.review!, fixtures.review!.runs![0]!)),
    ).toContain("Plan: set the README node count to 12.");
    expect(buildDoc(undefined, "s0old")).toContain("no longer in the rib's history");
  });

  test("keeps the full task for every lifecycle and omits questions, gates, context, runs and activity", () => {
    const task = `${"t".repeat(7_980)}Final task sentence.`;
    const base: SwarmSummary = {
      ...fixtures.asked!,
      task,
      activity: [{ at: T0, text: "retained activity sentinel" }],
      context: [
        {
          id: "c1",
          kind: "note",
          title: "context sentinel",
          chars: 16,
          excerpt: "excerpt sentinel",
        },
      ],
    };
    for (const status of [
      "running",
      "stopping",
      "done",
      "stopped",
      "stalled",
      "exhausted",
      "error",
    ] as const) {
      for (const conclusion of [undefined, "**Complete outcome**\n\nFinal conclusion sentence."]) {
        const s = {
          ...base,
          status,
          conclusion,
          draftConclusion: "**Refused draft**",
          ...(status !== "running" && status !== "stopping" ? { endedAt: T0 } : {}),
        };
        const doc = buildDoc(s, s.id);
        expect(doc).toContain(`## Task\n\n${task}\n`);
        expect(doc).toContain(`Swarm ${s.id}`);
        expect(doc).toContain(status);
        expect(doc).not.toContain("which retry cap");
        for (const removed of [
          "## Runs",
          "## Activity",
          "asked you",
          "approve-plan",
          "Plan: set",
          "context sentinel",
          "excerpt sentinel",
          "retained activity sentinel",
        ])
          expect(doc).not.toContain(removed);
        if (conclusion) {
          expect(doc).toContain(conclusion);
          expect(doc).not.toContain("**Refused draft**");
        } else {
          expect(doc).toContain("**Refused draft**");
        }
      }
    }
    const spaced = " \nFull task\n\nwith whitespace.  ";
    expect(buildDoc({ ...base, task: spaced }, base.id)).toContain(`## Task\n\n${spaced}\n`);
  });
});

class FakeSnapshots implements SnapshotManager {
  composers = new Map<string, { compose: () => unknown; validate?: (d: unknown) => unknown }>();
  frames = new Map<string, unknown[]>();
  inFlight = 0;
  gate: Promise<void> | undefined;
  failures = new Map<string, Error>();

  register<T>(key: string, compose: () => T | Promise<T>, opts?: { validate?: (d: unknown) => T }) {
    if (this.composers.has(key)) throw new Error(`duplicate key ${key}`);
    this.composers.set(key, { compose, ...(opts?.validate ? { validate: opts.validate } : {}) });
    return () => void this.composers.delete(key);
  }
  async recompose<T = unknown>(key: string): Promise<SnapshotFrame<T> | undefined> {
    const c = this.composers.get(key);
    if (!c) return undefined;
    this.inFlight++;
    try {
      if (this.gate) await this.gate;
      const failure = this.failures.get(key);
      if (failure) throw failure;
      const data = await c.compose();
      c.validate?.(data);
      this.frames.set(key, [...(this.frames.get(key) ?? []), data]);
      return {
        type: "snapshot_update",
        key,
        version: this.frames.get(key)!.length,
        composedAt: new Date().toISOString(),
        data: data as T,
      };
    } finally {
      this.inFlight--;
    }
  }
  latest() {
    return undefined;
  }
  keys() {
    return [...this.composers.keys()];
  }
  async dispose() {}
}

describe("publishing", () => {
  const inspectorHarness = (summary = swarm("s1")) => {
    const sm = new FakeSnapshots();
    const views: RibViewDescriptor[] = [];
    const summaries = new Map([[summary.id, summary]]);
    const surface = createSwarmsSurface({
      sm,
      views,
      state: () =>
        state({
          live: [...summaries.values()].filter(
            (s) => s.status === "running" || s.status === "stopping",
          ),
          ended: [...summaries.values()].filter(
            (s) => s.status !== "running" && s.status !== "stopping",
          ),
        }),
      find: (id) => {
        const s = summaries.get(id);
        return !s
          ? {}
          : s.status === "running" || s.status === "stopping"
            ? { live: s }
            : { ended: s };
      },
      launch: () => ({ projects: [], live: 1, ended: 0 }),
      launchOf: () => undefined,
      server: () => ({ live: 1 }),
      readLog: async () => "log",
      report: () => undefined,
      windowMs: 1,
    });
    return { sm, views, summaries, surface };
  };

  const inspectable = (id = "s1", patch: Partial<SwarmSummary> = {}) =>
    swarm(id, {
      health: {
        asks: ["first", "second"].map((messageId) => ({
          ...fixtures.asked!.health!.asks![0]!,
          agentId: `${id}-w1`,
          handle: `${id}-w1`,
          messageId,
          text: `${messageId} question?`,
        })),
      },
      runs: ["first", "second"].map((id) =>
        run(id, {
          status: "paused",
          pendingApproval: { ...gate("swarm"), pauseId: id, prompt: `${id} gate` },
        }),
      ),
      ...patch,
    });
  const inspectorKinds = [
    {
      key: askKey,
      open: (surface: SwarmsSurface, s: SwarmSummary, n = 0) =>
        surface.selectAsk(s.id, s.health!.asks![n]!.messageId),
    },
    {
      key: gateKey,
      open: (surface: SwarmsSurface, s: SwarmSummary, n = 0) =>
        surface.selectGate(s.id, s.runs![n]!.runId, gateIdentity(s.runs![n]!)!),
    },
    {
      key: detailsKey,
      open: (surface: SwarmsSurface, s: SwarmSummary) => surface.openDetails(s.id),
    },
  ];

  test("question, gate and Details selections wait for blocked first publication and retry failures", async () => {
    for (const { key, open } of inspectorKinds) {
      const s = inspectable();
      const { sm, surface } = inspectorHarness(s);
      let unblock = () => {};
      try {
        sm.gate = new Promise<void>((resolve) => {
          unblock = resolve;
        });
        let complete = false;
        const pending = open(surface, s).then(() => {
          complete = true;
        });
        await Bun.sleep(2);
        expect(complete).toBe(false);
        expect(sm.frames.has(key(s.id))).toBe(false);
        unblock();
        sm.gate = undefined;
        await pending;
        expectView(key(s.id), "board")(sm.frames.get(key(s.id))?.at(-1));
        sm.failures.set(key(s.id), new Error("publication failed"));
        await expect(open(surface, s)).rejects.toThrow("publication failed");
        sm.failures.delete(key(s.id));
        await open(surface, s);
        expect(sm.keys().filter((k) => k === key(s.id))).toHaveLength(1);
      } finally {
        unblock();
        surface.dispose();
      }
    }
  });

  test("rapid question and gate reselection shares per-kind keys independently of agent and swarm selection", async () => {
    const s = inspectable();
    const { sm, surface, summaries } = inspectorHarness(s);
    let unblock = () => {};
    try {
      summaries.set("s2", swarm("s2"));
      surface.track(["s1", "s2"]);
      surface.select("s2");
      await surface.selectAgent("s1", "s1-w1");
      sm.gate = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      const pending = inspectorKinds.flatMap(({ open }) => [
        open(surface, s, 0),
        open(surface, s, 1),
      ]);
      unblock();
      sm.gate = undefined;
      await Promise.all(pending);
      expect(JSON.stringify(sm.frames.get(askKey("s1"))?.at(-1))).toContain("second question?");
      expect(JSON.stringify(sm.frames.get(gateKey("s1"))?.at(-1))).toContain("second gate");
      expect(sm.frames.get(agentKey("s1"))?.at(-1)).toMatchObject({ title: "Agent @w1 · s1" });
      await Bun.sleep(10);
      const index = expectView(INDEX_KEY, "board")(sm.frames.get(INDEX_KEY)?.at(-1));
      if (index.view !== "board") throw new Error("expected board");
      const strip = index.sections.find((section) => section.kind === "actions");
      expect(
        strip?.kind === "actions" ? strip.items.find((i) => i.selected)?.payload : undefined,
      ).toEqual({ id: "s2" });
      const drawer = expectView(swarmKey("s1"), "board")(sm.frames.get(swarmKey("s1"))?.at(-1));
      if (drawer.view !== "board") throw new Error("expected board");
      const map = leaves(drawer.sections).find((section) => section.kind === "graph");
      expect(
        map?.kind === "graph"
          ? map.nodes.filter((node) => node.selected).map((node) => node.id)
          : [],
      ).toEqual(["s1-w1"]);
      for (const { key } of inspectorKinds)
        expect(sm.keys().filter((k) => k === key("s1"))).toHaveLength(1);
    } finally {
      unblock();
      surface.dispose();
    }
  });

  test("invalid question, gate and Details selections allocate no keys", async () => {
    const s = inspectable();
    const { sm, surface } = inspectorHarness(s);
    try {
      const before = sm.keys();
      for (const open of [
        () => surface.selectAsk("s1", "unknown"),
        () => surface.selectAsk("s2", "first"),
        () => surface.selectGate("s1", s.runs![0]!.runId, "stale"),
        () => surface.selectGate("s1", "foreign-run", gateIdentity(s.runs![0]!)!),
        () => surface.openDetails("s2"),
      ]) {
        await expect(open()).rejects.toThrow();
        expect(sm.keys()).toEqual(before);
      }
    } finally {
      surface.dispose();
    }
  });

  test("all opened inspectors refresh relevant changes and resolved targets stay read-only without retargeting", async () => {
    const s = inspectable();
    const { sm, surface, summaries } = inspectorHarness(s);
    try {
      for (const { open } of inspectorKinds) await open(surface, s);
      summaries.set("s1", { ...s, task: "Task after global refresh" });
      surface.refresh();
      await Bun.sleep(10);
      expect(JSON.stringify(sm.frames.get(detailsKey("s1"))?.at(-1))).toContain(
        "Task after global refresh",
      );
      for (const kind of ["health", "gate", "run", "agent", "turn", "conclusion", "end"] as const) {
        const counts = inspectorKinds.map(({ key }) => sm.frames.get(key("s1"))!.length);
        summaries.set("s1", { ...summaries.get("s1")!, task: `task after ${kind}` });
        surface.changed("s1", kind);
        await Bun.sleep(10);
        inspectorKinds.forEach(({ key }, i) => {
          expect(sm.frames.get(key("s1"))!.length).toBeGreaterThan(counts[i]!);
        });
        expect(JSON.stringify(sm.frames.get(detailsKey("s1"))?.at(-1))).toContain(
          `task after ${kind}`,
        );
      }
      const current = summaries.get("s1")!;
      current.health!.asks = [current.health!.asks![1]!];
      current.runs![0]!.pendingApproval!.pauseId = "next-pause";
      current.runs![0]!.pendingApproval!.prompt = "new pause must not replace selected gate";
      surface.changed("s1", "gate");
      await Bun.sleep(10);
      for (const key of [askKey, gateKey]) {
        const frame = sm.frames.get(key("s1"))?.at(-1);
        expect(JSON.stringify(frame)).toContain("Read-only");
        expect(JSON.stringify(frame)).not.toContain('"kind":"actions"');
        expect(JSON.stringify(frame)).not.toContain('"clock"');
      }
      expect(JSON.stringify(sm.frames.get(askKey("s1"))?.at(-1))).toContain("first question?");
      expect(JSON.stringify(sm.frames.get(gateKey("s1"))?.at(-1))).toContain("first gate");
      expect(JSON.stringify(sm.frames.get(gateKey("s1"))?.at(-1))).not.toContain("new pause");
      summaries.delete("s1");
      surface.changed("s1", "health");
      await Bun.sleep(10);
      for (const { key } of inspectorKinds)
        expect(JSON.stringify(sm.frames.get(key("s1"))?.at(-1))).toContain("no longer available");
      surface.forget(["s1"]);
      for (const { key } of inspectorKinds) expect(sm.keys()).not.toContain(key("s1"));
    } finally {
      surface.dispose();
    }
    expect(sm.keys()).toEqual([]);
  });

  test("ended, stopping and concluded inspectors have no composer and Details reads the latest summary", async () => {
    for (const patch of [
      { status: "done" as const, endedAt: T0 },
      { status: "stopping" as const },
      { conclusion: "Finished" },
    ]) {
      const s = inspectable("s1", patch);
      const { sm, surface, summaries } = inspectorHarness(s);
      try {
        for (const { open } of inspectorKinds) await open(surface, s);
        for (const key of [askKey, gateKey]) {
          const frame = JSON.stringify(sm.frames.get(key("s1"))?.at(-1));
          expect(frame).toContain("Read-only");
          expect(frame).not.toContain('"kind":"actions"');
        }
        summaries.set("s1", { ...s, task: "Latest task" });
        await surface.openDetails("s1");
        expect(JSON.stringify(sm.frames.get(detailsKey("s1"))?.at(-1))).toContain("Latest task");
      } finally {
        surface.dispose();
      }
    }
  });

  test("forget and disposal reject pending publication of each inspector kind", async () => {
    for (const { key, open } of inspectorKinds) {
      for (const disposal of [false, true]) {
        const s = inspectable();
        const { sm, surface } = inspectorHarness(s);
        let unblock = () => {};
        try {
          sm.gate = new Promise<void>((resolve) => {
            unblock = resolve;
          });
          const pending = open(surface, s);
          if (disposal) surface.dispose();
          else surface.forget(["s1"]);
          await expect(pending).rejects.toThrow("released");
          expect(sm.keys()).not.toContain(key("s1"));
          if (disposal) await expect(open(surface, s)).rejects.toThrow("disposed");
        } finally {
          unblock();
          sm.gate = undefined;
          surface.dispose();
        }
      }
    }
  });

  test("retention trimming releases every kind including inspector-only selections at a full live budget", async () => {
    const { sm, surface, summaries } = inspectorHarness();
    try {
      const ids = Array.from({ length: MAX_SWARM_KEYS }, (_, i) => `s${i + 1}`);
      for (const id of ids) summaries.set(id, swarm(id));
      surface.track(ids);
      for (let i = 0; i < 3; i++) {
        const s = inspectable(`ended${i}`, { status: "done", endedAt: T0 });
        summaries.set(s.id, s);
        await surface.selectAgent(s.id, `${s.id}-w1`);
        for (const { open } of inspectorKinds) await open(surface, s);
        expect(sm.keys()).not.toContain(swarmKey(s.id));
        for (const key of [agentKey, askKey, gateKey, detailsKey])
          expect(sm.keys()).toContain(key(s.id));
        if (i % 2) summaries.delete(s.id);
        surface.track([]);
        for (const key of [agentKey, askKey, gateKey, detailsKey])
          expect(sm.keys()).not.toContain(key(s.id));
      }
      summaries.clear();
      const ended = Array.from({ length: MAX_SWARM_KEYS + 1 }, (_, i) =>
        inspectable(`ended${i}`, { status: "done", endedAt: T0 }),
      );
      for (const s of ended) summaries.set(s.id, s);
      for (const { open } of inspectorKinds) await open(surface, ended[0]!);
      surface.track(ended.map((s) => s.id));
      for (const { key } of inspectorKinds) expect(sm.keys()).not.toContain(key(ended[0]!.id));
    } finally {
      surface.dispose();
    }
    expect(sm.keys()).toEqual([]);
  });

  test("agent selection awaits a fresh frame and highlights both boards without changing swarm selection", async () => {
    const { sm, summaries, surface } = inspectorHarness();
    summaries.set("s2", swarm("s2"));
    try {
      surface.track(["s1", "s2"]);
      surface.select("s2");
      await surface.selectAgent("s1", "s1-w1");
      const view = expectView(agentKey("s1"), "board")(sm.frames.get(agentKey("s1"))?.at(-1));
      if (view.view !== "board") throw new Error("expected inspector board");
      expect(view.title).toBe("Agent @w1 · s1");
      await Bun.sleep(10);
      const index = expectView(INDEX_KEY, "board")(sm.frames.get(INDEX_KEY)?.at(-1));
      if (index.view !== "board") throw new Error("expected board");
      const strip = index.sections.find((s) => s.kind === "actions" && s.title === "Live · 2");
      expect(
        strip?.kind === "actions" ? strip.items.find((i) => i.selected)?.payload : undefined,
      ).toEqual({ id: "s2" });
      const drawer = expectView(swarmKey("s1"), "board")(sm.frames.get(swarmKey("s1"))?.at(-1));
      if (drawer.view !== "board") throw new Error("expected board");
      expect(leaves(drawer.sections).find((s) => s.kind === "graph")).toMatchObject({
        nodes: [{}, {}, { id: "s1-w1", selected: true }],
      });
      surface.select("s1");
      await Bun.sleep(10);
      const selectedIndex = expectView(INDEX_KEY, "board")(sm.frames.get(INDEX_KEY)?.at(-1));
      if (selectedIndex.view !== "board") throw new Error("expected board");
      expect(leaves(selectedIndex.sections).find((s) => s.kind === "graph")).toMatchObject({
        nodes: [{}, {}, { id: "s1-w1", selected: true }],
      });
      await surface.selectAgent("s1", "s1-lead");
      expect(sm.keys().filter((key) => key.startsWith("rib:chat:agent:"))).toEqual([
        agentKey("s1"),
      ]);
    } finally {
      surface.dispose();
    }
  });

  test("rapid selection during the first compose leaves the latest inspector and highlight", async () => {
    const { sm, surface } = inspectorHarness();
    let unblock!: () => void;
    sm.gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const a = surface.selectAgent("s1", "s1-lead");
    const b = surface.selectAgent("s1", "s1-w1");
    unblock();
    sm.gate = undefined;
    try {
      await Promise.all([a, b]);
      expect(sm.frames.get(agentKey("s1"))?.at(-1)).toMatchObject({ title: "Agent @w1 · s1" });
      await Bun.sleep(10);
      const index = expectView(INDEX_KEY, "board")(sm.frames.get(INDEX_KEY)?.at(-1));
      if (index.view !== "board") throw new Error("expected board");
      const map = leaves(index.sections).find((s) => s.kind === "graph");
      expect(
        map?.kind === "graph" ? map.nodes.filter((n) => n.selected).map((n) => n.id) : [],
      ).toEqual(["s1-w1"]);
    } finally {
      surface.dispose();
    }
  });

  test("existing inspectors refresh messages, turns, run CI, activity and end, then release on forget", async () => {
    const { sm, views, summaries, surface } = inspectorHarness();
    try {
      await surface.selectAgent("s1", "s1-w1");
      for (const kind of ["message", "turn", "agent", "run", "activity", "end"] as const) {
        const count = sm.frames.get(agentKey("s1"))!.length;
        summaries.set("s1", {
          ...summaries.get("s1")!,
          recent: [{ id: "m", at: T0, author: "s1-w1", text: kind }],
          ...(kind === "end" ? { status: "done", endedAt: T0 } : {}),
        });
        surface.changed("s1", kind);
        await Bun.sleep(10);
        expect(sm.frames.get(agentKey("s1"))!.length).toBeGreaterThan(count);
        expect(JSON.stringify(sm.frames.get(agentKey("s1"))?.at(-1))).toContain(`"text":"${kind}"`);
      }
      expect(JSON.stringify(sm.frames.get(agentKey("s1"))?.at(-1))).not.toContain("message-agent");
      surface.forget(["s1"]);
      expect(sm.keys()).not.toContain(agentKey("s1"));
      expect(views.some((v) => v.key === agentKey("s1"))).toBe(false);
      surface.track(["s1"]);
      await Bun.sleep(10);
      const drawer = expectView(swarmKey("s1"), "board")(sm.frames.get(swarmKey("s1"))?.at(-1));
      expect(JSON.stringify(drawer)).not.toContain('"selected":true');
      await surface.selectAgent("s1", "s1-lead");
    } finally {
      surface.dispose();
    }
    expect(sm.keys()).toEqual([]);
    expect(views).toEqual([]);
    await expect(surface.selectAgent("s1", "s1-w1")).rejects.toThrow("disposed");
  });

  test("disposal releases an inspector created after its ended swarm is trimmed", async () => {
    const { sm, views, summaries, surface } = inspectorHarness(
      swarm("s1", { status: "done", endedAt: T0 }),
    );
    try {
      const liveIds = Array.from({ length: MAX_SWARM_KEYS }, (_, i) => {
        const id = `s${i + 2}`;
        summaries.set(id, swarm(id));
        return id;
      });
      surface.track(liveIds);
      expect(sm.keys()).not.toContain(swarmKey("s1"));
      await surface.selectAgent("s1", "s1-w1");
      expect(sm.keys()).not.toContain(swarmKey("s1"));
      expect(sm.keys()).not.toContain(recordKey("s1"));
      expect(sm.keys()).toContain(agentKey("s1"));
      expect(sm.frames.get(agentKey("s1"))?.at(-1)).toMatchObject({ title: "Agent @w1 · s1" });
    } finally {
      surface.dispose();
    }
    expect(sm.keys()).toEqual([]);
    expect(views).toEqual([]);
    expect(await sm.recompose(agentKey("s1"))).toBeUndefined();
  });

  test("tracking at a full live budget releases inspector-only ended selections and highlights", async () => {
    const { sm, summaries, surface } = inspectorHarness();
    try {
      const liveIds = Array.from({ length: MAX_SWARM_KEYS }, (_, i) => {
        const id = `s${i}`;
        summaries.set(id, swarm(id));
        return id;
      });
      surface.track(liveIds);
      const inspectorKeys = () => sm.keys().filter((key) => key.startsWith("rib:chat:agent:"));
      for (let i = 0; i < 6; i++) {
        const id = `ended${i}`;
        summaries.set(id, swarm(id, { status: "done", endedAt: T0 }));
        await surface.selectAgent(id, `${id}-w1`);
        expect(inspectorKeys()).toEqual([agentKey(id)]);
        expect(sm.keys()).not.toContain(swarmKey(id));
        // History expiry does not call forget; track must clean up even with no new keys.
        if (i % 2) summaries.delete(id);
        surface.track(i % 2 ? [] : liveIds);
        expect(inspectorKeys()).toEqual([]);
        expect(await sm.recompose(agentKey(id))).toBeUndefined();
      }
      const id = "ended5";
      summaries.set(id, swarm(id, { status: "done", endedAt: T0 }));
      summaries.delete(liveIds[0]!);
      surface.track([id]);
      await Bun.sleep(10);
      const drawer = expectView(swarmKey(id), "board")(sm.frames.get(swarmKey(id))?.at(-1));
      expect(JSON.stringify(drawer)).not.toContain('"selected":true');
    } finally {
      surface.dispose();
    }
    expect(sm.keys()).toEqual([]);
  });

  test("invalid selections allocate nothing; trimming and release reject pending selection", async () => {
    const { sm, summaries, surface } = inspectorHarness(
      swarm("s1", { status: "done", endedAt: T0 }),
    );
    try {
      for (const [id, agentId] of [
        ["s1", "s2-w1"],
        ["s0", "s1-lead"],
        ["s1", "you"],
      ]) {
        await expect(surface.selectAgent(id!, agentId!)).rejects.toThrow("does not belong");
      }
      expect(sm.keys().some((key) => key.startsWith("rib:chat:agent:"))).toBe(false);
      await surface.selectAgent("s1", "s1-w1");
      for (let i = 0; i < MAX_SWARM_KEYS; i++) {
        const id = `s${i + 2}`;
        summaries.set(id, swarm(id, { status: "done", endedAt: T0 }));
      }
      surface.track([...summaries.keys()]);
      expect(sm.keys()).not.toContain(agentKey("s1"));
      let unblock!: () => void;
      sm.gate = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      const pending = surface.selectAgent("s101", "s101-w1");
      surface.forget(["s101"]);
      await expect(pending).rejects.toThrow("released");
      unblock();
      sm.gate = undefined;
    } finally {
      surface.dispose();
    }
  });

  test("flush waits past the initial seed, publishes the new state and cancels the throttle", async () => {
    const sm = new FakeSnapshots();
    let release!: () => void;
    sm.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let value = "A";
    const pub = createKeyPublisher(
      sm,
      "rib:chat:t",
      () => value,
      (d) => String(d),
      50,
    );
    let complete = false;
    value = "B";
    const flushed = pub.flush().then(() => {
      complete = true;
    });
    await Bun.sleep(5);
    expect(complete).toBe(false);
    release();
    sm.gate = undefined;
    await flushed;
    expect(sm.frames.get("rib:chat:t")).toEqual(["B", "B"]);
    value = "C";
    pub.schedule();
    await pub.flush();
    expect(sm.frames.get("rib:chat:t")?.at(-1)).toBe("C");
    await Bun.sleep(60);
    expect(sm.frames.get("rib:chat:t")).toHaveLength(3);
    pub.release();
  });

  test("flush shares the dirty loop during overlapping async compositions", async () => {
    const sm = new FakeSnapshots();
    let unblock!: () => void;
    const held = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let value = "A";
    let passes = 0;
    const pub = createKeyPublisher(
      sm,
      "rib:chat:t",
      async () => {
        const captured = value;
        if (++passes === 1) await held;
        return captured;
      },
      (d) => String(d),
      1,
    );
    await Bun.sleep(1);
    value = "B";
    const a = pub.flush();
    value = "C";
    const b = pub.flush();
    unblock();
    await Promise.all([a, b]);
    expect(sm.frames.get("rib:chat:t")).toEqual(["A", "C"]);
    expect(sm.inFlight).toBe(0);
    pub.release();
  });

  test("flush surfaces composition failures and missing frames, then allows retry", async () => {
    const sm = new FakeSnapshots();
    let fail = false;
    const pub = createKeyPublisher(
      sm,
      "rib:chat:t",
      () => {
        if (fail) throw new Error("compose failed");
        return "ok";
      },
      (d) => String(d),
      1,
    );
    await pub.flush();
    fail = true;
    await expect(pub.flush()).rejects.toThrow("compose failed");
    fail = false;
    await pub.flush();
    sm.composers.delete("rib:chat:t");
    await expect(pub.flush()).rejects.toThrow("did not publish a frame");
    pub.release();
  });

  test("release refuses an awaited flush even while the host is still composing", async () => {
    const sm = new FakeSnapshots();
    let unblock!: () => void;
    sm.gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const pub = createKeyPublisher(
      sm,
      "rib:chat:t",
      () => "ok",
      (d) => String(d),
      1,
    );
    const flushed = pub.flush();
    pub.release();
    await expect(flushed).rejects.toThrow("released");
    await expect(pub.flush()).rejects.toThrow("released");
    unblock();
    sm.gate = undefined;
    await Bun.sleep(1);
    expect(sm.keys()).toEqual([]);
  });

  test("a burst of messages is one index and one board frame, with no other churn", async () => {
    const sm = new FakeSnapshots();
    const live = [fixtures.running!, fixtures.waiting!];
    const a = live[0]!;
    const surface = createSwarmsSurface({
      sm,
      state: () => state({ live }),
      find: (id) => ({ live: live.find((s) => s.id === id) }),
      launch: () => ({ projects: [], live: live.length, ended: 0 }),
      launchOf: () => undefined,
      server: () => ({ live: live.length }),
      readLog: async () => "log",
      report: () => undefined,
      views: [],
      windowMs: 50,
    });
    try {
      surface.track(live.map((s) => s.id));
      for (let i = 0; i < 200 && sm.keys().some((key) => !sm.frames.has(key)); i++) {
        await Bun.sleep(5);
      }
      expect(sm.keys().every((key) => sm.frames.has(key))).toBe(true);
      const seeded = new Map([...sm.frames].map(([key, frames]) => [key, frames.length]));
      for (let i = 0; i < 50; i++) surface.changed(a.id, "message");
      await Bun.sleep(100);
      for (const [key, count] of seeded) {
        const delta = key === INDEX_KEY || key === swarmKey(a.id) ? 1 : 0;
        expect(sm.frames.get(key)).toHaveLength(count + delta);
      }
      for (const key of [INDEX_KEY, ...live.map((s) => swarmKey(s.id))]) {
        for (const frame of sm.frames.get(key) ?? []) expectView(key, "board")(frame);
      }
    } finally {
      surface.dispose();
    }
  });

  test("selection republishes the shared index, preserves drawer keys, and clears on forget", async () => {
    const sm = new FakeSnapshots();
    const a = fixtures.running!;
    const b = fixtures.waiting!;
    let live = [a, b];
    const surface = createSwarmsSurface({
      sm,
      state: () => state({ live }),
      find: (id) => ({ live: live.find((s) => s.id === id) }),
      launch: () => ({ projects: [], live: live.length, ended: 0 }),
      launchOf: () => undefined,
      server: () => ({ live: live.length }),
      readLog: async () => "log",
      report: () => undefined,
      views: [],
      windowMs: 1,
    });
    const selectedId = () => {
      const view = expectView(INDEX_KEY, "board")(sm.frames.get(INDEX_KEY)?.at(-1));
      if (view.view !== "board") throw new Error("expected index board");
      const strip = view.sections.find((x) => x.kind === "actions" && x.title === "Live · 2");
      return strip?.kind === "actions" ? strip.items.find((x) => x.selected)?.payload : undefined;
    };
    try {
      surface.track([a.id, b.id]);
      await Bun.sleep(10);
      expect(selectedId()).toEqual({ id: a.id });
      surface.select(b.id);
      await Bun.sleep(10);
      expect(selectedId()).toEqual({ id: b.id });
      await sm.recompose(swarmKey(a.id));
      expect(sm.frames.get(swarmKey(a.id))?.at(-1)).toEqual(buildSwarmBoard(a));
      surface.refresh();
      await Bun.sleep(10);
      expect(selectedId()).toEqual({ id: b.id });
      live = [a];
      surface.forget([b.id]);
      await Bun.sleep(10);
      expect(sm.keys()).not.toContain(swarmKey(b.id));
      live = [a, b];
      surface.refresh();
      await Bun.sleep(10);
      expect(selectedId()).toEqual({ id: a.id });
    } finally {
      surface.dispose();
    }
  });

  test("a change during an in-flight compose lands on the next loop", async () => {
    const sm = new FakeSnapshots();
    let value = 0;
    let release!: () => void;
    sm.gate = new Promise<void>((r) => {
      release = r;
    });
    const pub = createKeyPublisher(
      sm,
      "rib:chat:t",
      () => value,
      (d) => d as number,
      1,
    );
    value = 1;
    pub.schedule();
    await Bun.sleep(5);
    release();
    sm.gate = undefined;
    await Bun.sleep(5);
    expect(sm.frames.get("rib:chat:t")).toEqual([1, 1]);
    value = 2;
    pub.schedule();
    pub.schedule();
    await Bun.sleep(10);
    expect(sm.frames.get("rib:chat:t")?.at(-1)).toBe(2);
    expect(sm.frames.get("rib:chat:t")).toHaveLength(3);
    pub.release();
    expect(sm.keys()).toEqual([]);
  });

  test("the surface registers a board and a markdown pane per swarm, and trims past the cap", async () => {
    const sm = new FakeSnapshots();
    const views: RibViewDescriptor[] = [];
    let refreshes = 0;
    const ended = new Map<string, SwarmSummary>();
    const surface = createSwarmsSurface({
      sm,
      state: () => state({ ended: [...ended.values()] }),
      find: (id): SwarmRecord => (ended.has(id) ? { ended: ended.get(id) as SwarmSummary } : {}),
      launch: () => ({ projects: [], live: 0, ended: 0 }),
      launchOf: () => undefined,
      server: () => ({ live: 0 }),
      readLog: async () => "log",
      report: () => undefined,
      views,
      invalidateManifest: () => refreshes++,
      windowMs: 1,
    });
    for (let i = 0; i < MAX_SWARM_KEYS + 5; i++) {
      const id = `s${String(i).padStart(4, "0")}`;
      ended.set(id, swarm(id, { status: "done", endedAt: T0 }));
    }
    surface.track([...ended.keys()]);
    expect(refreshes).toBe(1);
    expect(views[0]).toEqual({ key: SERVER_LOG_KEY, canvasKind: "log", title: "ClickClack log" });
    expect(views.filter((v) => v.canvasKind === "markdown")).toHaveLength(MAX_SWARM_KEYS);
    expect(views.filter((v) => v.canvasKind === "html")).toHaveLength(MAX_SWARM_KEYS);
    expect(sm.keys()).not.toContain(recordKey("s0000"));
    expect(views[1]).toEqual({
      key: docKey("s0005"),
      canvasKind: "markdown",
      title: "Swarm s0005",
    });
    expect(sm.keys()).toContain(swarmKey("s0104"));
    expect(sm.keys()).not.toContain(swarmKey("s0000"));
    surface.track(["s0104"]);
    expect(refreshes).toBe(1);
    surface.changed("s0104", "end");
    await Bun.sleep(10);
    expect(sm.frames.get(docKey("s0104"))?.length).toBeGreaterThan(1);
    expect(sm.frames.get(HISTORY_KEY)?.length).toBeGreaterThan(1);
    surface.dispose();
    expect(sm.keys()).toEqual([]);
    expect(views).toEqual([]);
  });
});

describe("the record page", () => {
  const activitySection = (html: string) =>
    html.match(/<section><h2>Activity<\/h2>.*?<\/section>/)?.[0] ?? "";

  test.each(["running", "done", "stopped"] as const)(
    "activity retains exactly the latest 200 events, newest first, including empty histories (%s)",
    (status) => {
      for (const count of [0, 1, 200, 201]) {
        const activity = Array.from({ length: count }, (_, i) => ({
          at: new Date(Date.parse(T0) + i * 60_000).toISOString(),
          text: `retained event ${i}`,
        }));
        const original = structuredClone(activity);
        const s = swarm("slog", {
          status,
          endedAt: status === "running" ? undefined : T0,
          activity,
        });
        const html = buildRecord(s, new Date(T0));
        const section = activitySection(html);
        expect(section).toContain("not a complete transcript");
        expect(html.indexOf(section)).toBeLessThan(html.indexOf("<footer>"));
        const rows = section.split(/<tr id=e\d+><td>/).slice(1);
        expect(rows).toHaveLength(Math.min(count, 200));
        expect(rows.map((row) => Number(row.match(/retained event (\d+)/)?.[1]))).toEqual(
          activity
            .slice(-200)
            .reverse()
            .map((event) => Number(event.text.split(" ").at(-1))),
        );
        if (count === 0) expect(section).toContain("No retained events.");
        if (count === 201) expect(section).not.toContain("<td>retained event 0");
        expect(activity).toEqual(original);
      }
    },
  );

  test.each(["running", "done", "stopped"] as const)(
    "activity identifies actors and timestamps, counts repeats and escapes bounded event gists (%s)",
    (status) => {
      const s = swarm("slog", {
        status,
        endedAt: status === "running" ? undefined : T0,
        activity: [
          { at: T0, text: "rib event" },
          { at: T0, text: "operator note", actor: "operator", count: 3 },
          { at: T0, text: "@slog-w1 turn finished", actor: "slog-w1", count: 1 },
          { at: T0, text: "<script> & ' \" <img>", actor: "<unknown>" },
          { at: T0, text: "x".repeat(400), actor: "unknown-agent" },
        ],
      });
      const section = activitySection(buildRecord(s, new Date(T0)));
      expect(section).toContain(`<td>${day(T0)} ${hhmm(T0)} · rib<td>rib event`);
      expect(section).toContain(" · you<td>operator note ×3");
      expect(section).toContain(" · @w1<td>@w1 turn finished");
      expect(section).not.toContain("×1");
      expect(section).toContain(
        " · &lt;unknown&gt;<td>&lt;script&gt; &amp; &#39; &quot; &lt;img&gt;",
      );
      expect(section).not.toContain("<script>");
      expect(section).toContain(` · unknown-agent<td>${"x".repeat(99)}…`);
      expect(section).not.toContain("x".repeat(100));
    },
  );

  test("ended Spend by agent retains fresh and cached usage without inventing missing usage", () => {
    const s = swarm("sspend", {
      status: "done",
      endedAt: T0,
      agents: [
        agent("sspend", 0, { usage: { input: 200, output: 50, cached: 100 } }),
        agent("sspend", 1, { usage: { input: 80, output: 20, cached: 30 } }),
        agent("sspend", 2, { usage: { input: 0, output: 0, cached: 60 } }),
        agent("sspend", 3),
      ],
    });
    const section = buildRecord(s, new Date(T0)).match(
      /<section><h2>Spend by agent<\/h2>.*?<\/section>/,
    )?.[0];
    expect(section).toBeDefined();
    expect(section).toContain("@lead</span>");
    expect(section).toContain("250 fresh · 100 cached");
    expect(section).toContain("@w1</span>");
    expect(section).toContain("100 fresh · 30 cached");
    expect(section).toContain("@w2</span>");
    expect(section).toContain("0 fresh · 60 cached");
    expect(section).not.toContain("@w3");
    expect(buildRecord({ ...s, agents: [agent(s.id, 0)] }, new Date(T0))).not.toContain(
      "Spend by agent",
    );
  });

  test.each(["activity", "health"] as const)(
    "%s changes refresh retained activity in a live record through the publishing window",
    async (kind) => {
      const sm = new FakeSnapshots();
      let live = swarm("slog");
      const surface = createSwarmsSurface({
        sm,
        state: () => state({ live: [live] }),
        find: () => ({ live }),
        launch: () => ({ projects: [], live: 1, ended: 0 }),
        launchOf: () => undefined,
        server: () => ({ live: 1 }),
        readLog: async () => "",
        report: () => undefined,
        views: [],
        windowMs: 5,
      });
      try {
        surface.track([live.id]);
        await Bun.sleep(10);
        const frames = sm.frames.get(recordKey(live.id))!;
        expect(frames).toHaveLength(1);
        live = {
          ...live,
          activity: [{ at: T0, text: "dismissed one question", actor: "operator" }],
        };
        surface.changed(live.id, kind);
        expect(sm.frames.get(recordKey(live.id))).toHaveLength(1);
        await Bun.sleep(15);
        expect(sm.frames.get(recordKey(live.id))).toHaveLength(2);
        expect(sm.frames.get(recordKey(live.id))!.at(-1)).toContain(
          " · you<td>dismissed one question",
        );
      } finally {
        surface.dispose();
      }
    },
  );

  test("semantic edges count distinct sources, fold spawn wakes and keep repeat asks", () => {
    const s = swarm("s1", {
      agents: [agent("s1", 0), agent("s1", 1, { spawnedBy: "s1-lead" })],
      spans: [
        {
          agentId: "s1-w1",
          n: 1,
          startedAt: T0,
          messages: 4,
          wokeBy: ["s1-lead", "s1-lead", "s1-w1", "operator", "rib", "nudge", "missing"],
        },
        { agentId: "missing", n: 1, startedAt: T0, messages: 1, wokeBy: ["s1-lead"] },
      ],
      activity: [
        { at: T0, text: "ask", kind: "ask", actor: "s1-w1", count: 3 },
        { at: T0, text: "ask", kind: "ask", actor: "missing" },
      ],
    });
    expect(buildAgentEdges(s)).toEqual([
      { from: "s1-w1", to: "operator", kind: "asked", n: 3 },
      { from: "s1-lead", to: "s1-w1", kind: "spawned", n: 1, woke: 1 },
      { from: "operator", to: "s1-w1", kind: "woke", n: 1 },
    ]);
    expect(buildAgentEdges(s)).toEqual(buildAgentEdges(s));
  });

  test("semantic aggregation is not limited by the record's forty-edge budget", () => {
    const agents = Array.from({ length: 12 }, (_, i) => agent("s1", i));
    const s = swarm("s1", {
      agents,
      spans: agents.map((a) => ({
        agentId: a.id,
        n: 1,
        startedAt: T0,
        messages: 12,
        wokeBy: agents.map((source) => source.id),
      })),
    });
    expect(buildAgentEdges(s)).toHaveLength(132);
    expect((buildRecord(s, new Date(T0)).match(/marker-end="url\(#arrow\)"/g) ?? []).length).toBe(
      40,
    );
  });

  const at = (m: number) => new Date(Date.parse(T0) + m * 60_000).toISOString();
  const traced = (patch: Partial<SwarmSummary> = {}): SwarmSummary =>
    swarm("s6rec", {
      status: "done",
      endedAt: at(20),
      agents: [
        agent("s6rec", 0, { joinedAt: at(0) }),
        agent("s6rec", 1, { joinedAt: at(4), spawnedBy: "s6rec-lead" }),
        agent("s6rec", 2, { joinedAt: at(2), spawnedBy: "s6rec-lead" }),
      ],
      spans: [
        {
          agentId: "s6rec-lead",
          n: 1,
          startedAt: at(0),
          endedAt: at(1),
          outcome: "ok",
          messages: 1,
          wokeBy: ["rib"],
        },
        {
          agentId: "s6rec-w2",
          n: 1,
          startedAt: at(3),
          endedAt: at(6),
          outcome: "ok",
          messages: 1,
          wokeBy: ["s6rec-lead"],
        },
        {
          agentId: "s6rec-w1",
          n: 1,
          startedAt: at(5),
          endedAt: at(9),
          outcome: "timeout",
          messages: 1,
          wokeBy: ["s6rec-lead"],
        },
        {
          agentId: "s6rec-lead",
          n: 2,
          startedAt: at(10),
          endedAt: at(12),
          outcome: "ok",
          messages: 2,
          wokeBy: ["s6rec-w1", "s6rec-w2", "operator"],
        },
      ],
      activity: [
        { at: at(7), text: "@s6rec-w1 asked the operator", kind: "ask", actor: "s6rec-w1" },
        {
          at: at(8),
          text: "you posted in #swarm-s6rec: 60 s",
          kind: "operator",
          actor: "operator",
        },
        {
          at: at(12),
          text: "@s6rec-lead concluded the swarm",
          kind: "conclusion",
          actor: "s6rec-lead",
        },
      ],
      runs: [
        run("r1", {
          status: "succeeded",
          startedAt: at(2),
          completedAt: at(15),
          verified: true,
          prUrls: ["https://github.com/o/r/pull/41"],
          ci: { verdict: "pass" },
          gates: [{ nodeId: "approve-plan", openedAt: at(4), closedAt: at(8), by: "operator" }],
        }),
      ],
      conclusion: "Done.",
      ...patch,
    });

  test("the timeline draws a lane per agent in turn order, the operator above and runs below", () => {
    const html = buildRecord(traced(), new Date(at(30)));
    const eventMarks = [...html.matchAll(/<text[^>]* aria-describedby="(e\d+)"[^>]*>.*?<\/text>/g)];
    expect(eventMarks).toHaveLength(3);
    for (const mark of eventMarks) {
      expect(mark[0]).toMatch(/<title>[^<]+<\/title>/);
      expect(html).toContain(`<tr id=${mark[1]}>`);
    }
    expect(eventMarks[0]?.[0]).toContain(`<title>${hhmm(at(7))} @w1 asked the operator</title>?`);
    const labels = [...html.matchAll(/<text class="lbl[^"]*"[^>]*>([^<]*)<\/text>/g)].map(
      (m) => m[1],
    );
    expect(labels).toEqual(["you", "@lead", "@w2", "@w1", "fix-issue r10000-1"]);
    for (const x of html.matchAll(/<path[^>]* d="M([\d.]+) [\d.]+h/g)) {
      expect(Number(x[1])).toBeGreaterThanOrEqual(112);
      expect(Number(x[1])).toBeLessThanOrEqual(708);
    }
    expect(html).toContain('class="hatch"');
    for (const glyph of ["○", "?", "▲", "●", "◇", "◆", "✓"])
      expect(html).toContain(`${glyph}</text>`);
    expect(html).toContain("approve-plan answered by you");
    expect(html).toContain("ended ");
    expect(html).toContain(">×1</text>");
    expect(html).toContain(">asked ×1</text>");
    expect(html).not.toMatch(/<script/i);
  });

  test("an ended record is the same whenever it is composed; a live one runs to now", () => {
    const ended = traced();
    expect(buildRecord(ended, new Date(at(30)))).toBe(buildRecord(ended, new Date(at(90))));
    const live = buildRecord(
      traced({ status: "running", endedAt: undefined, conclusion: undefined }),
      new Date(at(14)),
    );
    expect(live).toContain('class="now"');
    expect(live).toContain(`now ${hhmm(at(14))}`);
    expect(live).toContain(`ends ${hhmm(at(30))} →`);
    const legacy = buildRecord(traced({ spans: undefined }), new Date(at(30)));
    expect(legacy).toContain("recorded before turns were kept");
  });

  test("every string from the summary comes out escaped", () => {
    const evil = '<img src=x onerror="alert(1)"> & <script>alert(2)</script>';
    const html = buildRecord(
      traced({
        task: evil,
        channelName: evil,
        runs: [
          run("r2", {
            purpose: evil,
            error: evil,
            checkout: { path: "/p", branch: evil, worktreeEstablished: true },
          }),
        ],
        context: [{ id: "c1", kind: "note", title: evil, sourceUrl: evil, chars: 1 }],
        activity: [{ at: at(3), text: evil, kind: "ask", actor: "s6rec-w1" }],
      }),
      new Date(at(30)),
    );
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
    expect(html).toContain("onerror=&quot;alert(1)&quot;");
  });

  test("a swarm at the start bounds draws inside the doc pane's budget", () => {
    const agents = Array.from({ length: 12 }, (_, i) =>
      agent("s9cap", i, { joinedAt: at(i), ...(i > 0 ? { spawnedBy: "s9cap-lead" } : {}) }),
    );
    const big = swarm("s9cap", {
      status: "done",
      endedAt: at(240),
      task: "t".repeat(8000),
      agents,
      limits: { ...SIZE_PRESETS.large, maxAgents: 12, maxTurns: 200, wallClockMs: 240 * 60_000 },
      spans: Array.from({ length: 200 }, (_, i) => ({
        agentId: agents[i % 12]?.id ?? "",
        n: Math.floor(i / 12) + 1,
        startedAt: at(i),
        endedAt: at(i + 0.5),
        outcome: i % 17 ? ("ok" as const) : ("timeout" as const),
        messages: 3,
        wokeBy: [agents[(i + 1) % 12]?.id ?? "", "operator", "runs"],
      })),
      activity: Array.from({ length: ACTIVITY_KEPT }, (_, i) => ({
        at: at(i),
        text: `@s9cap-w${(i % 11) + 1} asked the operator ${"q".repeat(300)}`,
        kind: "ask" as const,
        actor: agents[(i % 11) + 1]?.id,
      })),
      runs: Array.from({ length: 12 }, (_, i) =>
        run(`r${i}`, {
          status: "succeeded",
          completedAt: at(200),
          prUrls: Array.from({ length: 3 }, (_, k) => `https://github.com/o/r/pull/${i * 3 + k}`),
          ci: { verdict: "pass", detail: "d".repeat(2000) },
          error: "e".repeat(8000),
          gates: [
            { nodeId: "approve-plan", openedAt: at(10), closedAt: at(20), by: "swarm" },
            { nodeId: "approve-release", openedAt: at(30), closedAt: at(40), by: "operator" },
          ],
          approvals: [
            {
              nodeId: "approve-plan",
              decision: "changes",
              reason: "r".repeat(4000),
              feedback: "f".repeat(8000),
              review: "msg_1",
              reviewer: "@s9cap-w1",
              at: at(15),
            },
          ],
        }),
      ),
      context: Array.from({ length: 20 }, (_, i) => ({
        id: `item-${i}`,
        kind: "issue",
        title: "x".repeat(400),
        sourceUrl: `https://github.com/o/r/issues/${i}`,
        chars: 4000,
      })),
      usage: { input: 9_000_000, output: 400_000, cached: 7_000_000 },
    });
    const record = buildRecord(big, new Date(at(300)));
    expect(record.length).toBeLessThan(128_000);
    expect(activitySection(record).match(/<tr id=e\d+>/g)).toHaveLength(200);
    const eventMarks = [
      ...record.matchAll(/aria-describedby="(e\d+)"><title>([^<]+)<\/title>\?<\/text>/g),
    ];
    expect(eventMarks).toHaveLength(200);
    for (const mark of eventMarks) {
      expect(mark[2]).toHaveLength(40);
      expect(mark[2]).toEndWith("…");
      expect(record).toContain(`<tr id=${mark[1]}>`);
    }
    console.info(`Record (200 events, 200 turns, 12 runs): ${record.length} characters`);
  });

  test("each swarm's record registers with its other keys, and Open the record opens it", async () => {
    const sm = new FakeSnapshots();
    const views: RibViewDescriptor[] = [];
    const live = swarm("s6liv");
    const done = traced();
    const surface = createSwarmsSurface({
      sm,
      state: () => state({ live: [live], ended: [done] }),
      find: (id): SwarmRecord =>
        id === live.id ? { live } : id === done.id ? { ended: done } : {},
      launch: () => ({ projects: [], live: 1, ended: 1 }),
      launchOf: () => undefined,
      server: () => ({ live: 0 }),
      readLog: async () => "log",
      report: () => undefined,
      views,
      windowMs: 1,
    });
    surface.track([live.id, done.id]);
    expect(sm.keys()).toContain(recordKey(live.id));
    expect(sm.keys()).toContain(recordKey(done.id));
    expect(views).toContainEqual({
      key: recordKey(live.id),
      canvasKind: "html",
      title: "Record · s6liv",
    });
    const opened = await handleSwarmsAction(
      { type: "open-record", payload: { id: done.id } },
      { ...actionDeps, surface, find: (id) => (id === done.id ? { ended: done } : {}) },
    );
    expect(opened).toEqual({
      ok: true,
      data: { effect: "open-canvas", key: recordKey(done.id), title: "Record · s6rec" },
    });
    await Bun.sleep(10);
    expect(sm.frames.get(recordKey(done.id))?.at(-1)).toContain("Swarm s6rec · record");
    expect(
      (await handleSwarmsAction({ type: "open-record", payload: { id: "s0none" } }, actionDeps)).ok,
    ).toBe(false);
    surface.dispose();
    expect(sm.keys()).toEqual([]);
    expect(views).toEqual([]);
  });
});

const begun: StartSwarmInput[] = [];
const origins: ({ rerunOf?: string } | undefined)[] = [];
const oldLaunch: StartSwarmInput = {
  task: "Fix issue #27",
  workTools: "read",
  project: "p1",
  size: "medium",
  maxTurns: 60,
  provider: "copilot",
  model: "gpt-5.6-sol",
  workerModel: "mai-code-1.1-flash",
  workflows: [{ name: "fix-issue", isolated: true }],
  context: [{ id: "issue-27", kind: "issue", title: "README count", body: "the body" }],
};

const liveSwarm = { summary: () => fixtures.running, steer: async () => {}, stop: async () => {} };
const actionDeps = {
  surface: undefined,
  find: (id: string): SwarmRecord =>
    id === "s9hjx"
      ? { live: fixtures.running as SwarmSummary }
      : id === "s8pln"
        ? { ended: fixtures.done as SwarmSummary }
        : {},
  live: (id: string) => (id === "s9hjx" ? (liveSwarm as unknown as Swarm) : undefined),
  begin: (input: StartSwarmInput, origin?: { rerunOf?: string }) => {
    if (input.task === "refuse") throw new Error("no registered project 'nope'");
    begun.push(input);
    origins.push(origin);
    return "s0new1";
  },
  launchOf: (id: string): StartSwarmInput | undefined => (id === "s8pln" ? oldLaunch : undefined),
};

describe("actions", () => {
  const deps = actionDeps;

  const inspectorSummary = () =>
    swarm("s9hjx", {
      health: {
        asks: [{ ...fixtures.asked!.health!.asks![0]!, threadRootId: "authoritative-root" }],
      },
      runs: [
        run("peer", {
          status: "paused",
          pendingApproval: { ...gate("swarm"), pauseId: "peer-pause" },
        }),
        run("operator", {
          status: "paused",
          pendingApproval: { ...gate("operator"), pauseId: "operator-pause" },
        }),
      ],
    });
  const inspectorActions = (s: SwarmSummary) => [
    {
      type: "select-ask",
      payload: { id: s.id, messageId: s.health!.asks![0]!.messageId },
      key: askKey(s.id),
      title: `Question · ${s.id}`,
    },
    {
      type: "select-gate",
      payload: { id: s.id, runId: s.runs![0]!.runId, gateIdentity: gateIdentity(s.runs![0]!) },
      key: gateKey(s.id),
      title: `Gate · ${s.id}`,
    },
    {
      type: "open-details",
      payload: { id: s.id },
      key: detailsKey(s.id),
      title: `Details · ${s.id}`,
    },
  ];

  test("question, gate and Details opens await publication and return exact native side effects", async () => {
    let current = inspectorSummary();
    const sm = new FakeSnapshots();
    const find = (id: string): SwarmRecord =>
      id !== current.id ? {} : current.status === "done" ? { ended: current } : { live: current };
    const surface = createSwarmsSurface({
      sm,
      views: [],
      state: () => state({ live: [current] }),
      find,
      launch: () => ({ projects: [], live: 1, ended: 0 }),
      launchOf: () => undefined,
      server: () => ({ live: 1 }),
      readLog: async () => "log",
      report: () => undefined,
      windowMs: 1,
    });
    let unblock = () => {};
    try {
      for (const { type, payload, key, title } of inspectorActions(current)) {
        sm.gate = new Promise<void>((resolve) => {
          unblock = resolve;
        });
        let complete = false;
        const pending = handleSwarmsAction({ type, payload }, { ...deps, surface, find }).then(
          (result) => {
            complete = true;
            return result;
          },
        );
        await Bun.sleep(2);
        expect(complete).toBe(false);
        unblock();
        sm.gate = undefined;
        const result = await pending;
        const effect = { effect: "open-canvas", key, title, placement: "side" } as const;
        expect(result).toEqual({ ok: true, data: effect });
        expect(ribClientEffectSchema.parse(result.ok ? result.data : undefined)).toEqual(effect);
        expectView(key, "board")(sm.frames.get(key)?.at(-1));
        sm.failures.set(key, new Error("bad publication"));
        const failed = await handleSwarmsAction({ type, payload }, { ...deps, surface, find });
        expect(failed.ok).toBe(false);
        expect(!failed.ok ? failed.error : "").toContain("bad publication");
        expect(!failed.ok ? failed.error : "").toContain("Could not publish");
        sm.failures.delete(key);
        expect((await handleSwarmsAction({ type, payload }, { ...deps, surface, find })).ok).toBe(
          true,
        );
      }
      const operator = await handleSwarmsAction(
        {
          type: "select-gate",
          payload: {
            id: current.id,
            runId: current.runs![1]!.runId,
            gateIdentity: gateIdentity(current.runs![1]!),
          },
        },
        { ...deps, surface, find },
      );
      expect(ribClientEffectSchema.parse(operator.ok ? operator.data : undefined)).toEqual({
        effect: "open-canvas",
        key: gateKey(current.id),
        title: `Gate · ${current.id}`,
        placement: "side",
      });
      current = { ...current, status: "done", endedAt: T0 };
      const result = await handleSwarmsAction(
        { type: "open-details", payload: { id: current.id } },
        { ...deps, surface, find },
      );
      expect(ribClientEffectSchema.parse(result.ok ? result.data : undefined)).toEqual({
        effect: "open-canvas",
        key: detailsKey(current.id),
        title: `Details · ${current.id}`,
        placement: "side",
      });
      expect(JSON.stringify(sm.frames.get(detailsKey(current.id))?.at(-1))).not.toContain(
        '"kind":"actions"',
      );
    } finally {
      unblock();
      sm.gate = undefined;
      surface.dispose();
    }
  });

  test("inspector actions reject malformed, cross-swarm, HTML-origin and starting inputs before selection", async () => {
    const s = inspectorSummary();
    const calls: unknown[][] = [];
    const surface: SwarmsSurface = {
      track: () => {},
      select: () => {},
      selectAgent: async () => {},
      selectAsk: async (...args) => {
        calls.push(["ask", ...args]);
      },
      selectGate: async (...args) => {
        calls.push(["gate", ...args]);
      },
      openDetails: async (...args) => {
        calls.push(["details", ...args]);
      },
      changed: () => {},
      refresh: () => {},
      forget: () => {},
      logOpened: () => {},
      dispose: () => {},
    };
    const actionDeps: ActionDeps = {
      ...deps,
      surface,
      find: (id) => (id === s.id ? { live: s } : id === "s8pln" ? { ended: fixtures.done! } : {}),
    };
    for (const { type, payload } of inspectorActions(s)) {
      for (const id of ["../bad", 7, "", undefined, "s0000"])
        expect(
          (await handleSwarmsAction({ type, payload: { ...payload, id } }, actionDeps)).ok,
        ).toBe(false);
      expect(
        (await handleSwarmsAction({ type, payload, origin: "canvas-html" }, actionDeps)).ok,
      ).toBe(false);
      expect(
        (await handleSwarmsAction({ type, payload }, { ...actionDeps, find: () => ({ starting }) }))
          .ok,
      ).toBe(false);
      const unavailable = await handleSwarmsAction(
        { type, payload },
        { ...actionDeps, surface: undefined },
      );
      expect(unavailable.ok).toBe(false);
      expect(!unavailable.ok ? unavailable.error : "").toContain("inspector is unavailable");
    }
    for (const messageId of [undefined, "", 7, "foreign-question"])
      expect(
        (
          await handleSwarmsAction(
            { type: "select-ask", payload: { id: s.id, messageId } },
            actionDeps,
          )
        ).ok,
      ).toBe(false);
    for (const payload of [
      { id: "s8pln", messageId: s.health!.asks![0]!.messageId },
      { id: s.id, runId: s.runs![0]!.runId },
      { id: s.id, runId: 7, gateIdentity: gateIdentity(s.runs![0]!) },
      { id: s.id, gateIdentity: gateIdentity(s.runs![0]!) },
      { id: s.id, runId: s.runs![0]!.runId, gateIdentity: 7 },
      { id: s.id, runId: s.runs![0]!.runId, gateIdentity: {} },
      { id: s.id, runId: s.runs![0]!.runId, gateIdentity: "" },
      { id: s.id, runId: s.runs![0]!.runId, gateIdentity: "stale" },
      { id: s.id, runId: "foreign-run", gateIdentity: gateIdentity(s.runs![0]!) },
      { id: "s8pln", runId: s.runs![0]!.runId, gateIdentity: gateIdentity(s.runs![0]!) },
    ]) {
      const type = "messageId" in payload ? "select-ask" : "select-gate";
      expect((await handleSwarmsAction({ type, payload }, actionDeps)).ok).toBe(false);
    }
    expect(calls).toEqual([]);
    for (const { type, payload } of inspectorActions(s))
      expect((await handleSwarmsAction({ type, payload }, actionDeps)).ok).toBe(true);
    expect(calls).toEqual([
      ["ask", s.id, s.health!.asks![0]!.messageId],
      ["gate", s.id, s.runs![0]!.runId, gateIdentity(s.runs![0]!)],
      ["details", s.id],
    ]);
  });

  const replyHarness = () => {
    let current = inspectorSummary();
    const calls: unknown[][] = [];
    let failure = false;
    let blocked: Promise<void> | undefined;
    const fake: NonNullable<ReturnType<ActionDeps["live"]>> = {
      summary: () => current,
      steer: async () => {
        throw new Error("unexpected steer");
      },
      messageAgent: async () => {
        throw new Error("unexpected agent message");
      },
      stop: async () => {
        throw new Error("unexpected stop");
      },
      replyToGate: async (...args) => {
        if (failure) throw new Error("posting failed");
        calls.push(["gate", ...args]);
        if (blocked) await blocked;
      },
      replyInThread: async (...args) => {
        if (failure) throw new Error("posting failed");
        calls.push(["thread", ...args]);
        if (blocked) await blocked;
      },
      dismissAsk: (messageId) => {
        if (failure) throw new Error("dismiss failed");
        calls.push(["dismiss", messageId]);
        return true;
      },
    };
    const actionDeps: ActionDeps = {
      ...deps,
      find: (id) => (id === current.id ? { live: current } : {}),
      live: (id) => (id === current.id ? fake : undefined),
    };
    return {
      calls,
      deps: actionDeps,
      get current() {
        return current;
      },
      set current(s: SwarmSummary) {
        current = s;
      },
      fail() {
        failure = true;
      },
      block(promise: Promise<void>) {
        blocked = promise;
      },
    };
  };

  test("question replies await the authoritative current thread and dismiss invokes only the existing mutation", async () => {
    const h = replyHarness();
    const ask = h.current.health!.asks![0]!;
    let unblock = () => {};
    h.block(
      new Promise<void>((resolve) => {
        unblock = resolve;
      }),
    );
    let complete = false;
    const before = JSON.stringify(h.current.runs);
    const pending = handleSwarmsAction(
      {
        type: "reply-ask",
        payload: {
          id: h.current.id,
          messageId: ask.messageId,
          threadRootId: "forged-route",
          note: "  answer  ",
        },
      },
      h.deps,
    ).then((result) => {
      complete = true;
      return result;
    });
    try {
      await Bun.sleep(2);
      expect(complete).toBe(false);
      expect(h.calls).toEqual([["thread", "authoritative-root", "answer"]]);
      unblock();
      expect(await pending).toEqual({
        ok: true,
        data: {
          message: `Replied to @${ask.handle.replace(`${h.current.id}-`, "")}'s question as you`,
        },
      });
      expect(
        (
          await handleSwarmsAction(
            { type: "dismiss-ask", payload: { id: h.current.id, messageId: ask.messageId } },
            h.deps,
          )
        ).ok,
      ).toBe(true);
      expect(h.calls).toEqual([
        ["thread", "authoritative-root", "answer"],
        ["dismiss", ask.messageId],
      ]);
      expect(JSON.stringify(h.current.runs)).toBe(before);
    } finally {
      unblock();
    }
  });

  test("peer and operator gate replies post as you without approval and legacy run-only Reply still works", async () => {
    const h = replyHarness();
    const before = JSON.stringify(h.current.runs);
    for (const run of h.current.runs!) {
      const result = await handleSwarmsAction(
        {
          type: "reply",
          payload: {
            id: h.current.id,
            runId: run.runId,
            gateIdentity: gateIdentity(run),
            note: "  feedback  ",
          },
        },
        h.deps,
      );
      expect(result).toEqual({
        ok: true,
        data: { message: "Replied in the approve-plan thread as you" },
      });
    }
    expect(
      (
        await handleSwarmsAction(
          {
            type: "reply",
            payload: { id: h.current.id, runId: h.current.runs![0]!.runId, note: "legacy" },
          },
          h.deps,
        )
      ).ok,
    ).toBe(true);
    expect(h.calls).toEqual([
      ["gate", h.current.runs![0]!.runId, "feedback"],
      ["gate", h.current.runs![1]!.runId, "feedback"],
      ["gate", h.current.runs![0]!.runId, "legacy"],
    ]);
    expect(JSON.stringify(h.current.runs)).toBe(before);
  });

  test("operator decision card replies reject a later approval gate", async () => {
    const h = replyHarness();
    h.current = fixtures.onlyYou!;
    const run = h.current.runs![0]!;
    const form = requestOf(h.current, { kind: "decide", run }).more.find(
      (action) => action.type === "reply",
    )!;
    expect(form.binding).toEqual({
      id: h.current.id,
      runId: run.runId,
      gateIdentity: gateIdentity(run),
    });
    const next = {
      ...run,
      pendingApproval: { ...run.pendingApproval!, pauseId: "next-pause", threadId: "next-thread" },
    };
    h.current = { ...h.current, runs: [next] };
    expect(
      (
        await handleSwarmsAction(
          { type: "reply", payload: { ...form.binding, note: "old approval feedback" } },
          h.deps,
        )
      ).ok,
    ).toBe(false);
    expect(h.calls).toEqual([]);
    const currentForm = requestOf(h.current, { kind: "decide", run: next }).more.find(
      (action) => action.type === "reply",
    )!;
    expect(
      (
        await handleSwarmsAction(
          { type: "reply", payload: { ...currentForm.binding, note: "current feedback" } },
          h.deps,
        )
      ).ok,
    ).toBe(true);
    expect(h.calls).toEqual([["gate", run.runId, "current feedback"]]);
  });

  test("stale forms cannot reply or dismiss ended, stopping, concluded or disappeared targets", async () => {
    const h = replyHarness();
    const initial = h.current;
    const question = {
      id: initial.id,
      messageId: initial.health!.asks![0]!.messageId,
      note: "stale",
    };
    const gate = {
      id: initial.id,
      runId: initial.runs![0]!.runId,
      gateIdentity: gateIdentity(initial.runs![0]!),
      note: "stale",
    };
    for (const patch of [
      { status: "done" as const, endedAt: T0 },
      { status: "stopping" as const },
      { conclusion: "finished" },
      { endedAt: T0 },
    ]) {
      h.current = { ...initial, ...patch };
      for (const [type, payload] of [
        ["reply", gate],
        ["reply", { id: initial.id, runId: gate.runId, note: "legacy stale" }],
        ["reply-ask", question],
        ["dismiss-ask", question],
      ] as const)
        expect((await handleSwarmsAction({ type, payload }, h.deps)).ok).toBe(false);
    }
    h.current = { ...initial, health: { asks: [] }, runs: [] };
    for (const [type, payload] of [
      ["reply", gate],
      ["reply-ask", question],
      ["dismiss-ask", question],
    ] as const)
      expect((await handleSwarmsAction({ type, payload }, h.deps)).ok).toBe(false);
    h.current = initial;
    for (const payload of [
      { ...question, id: "s8pln" },
      { ...question, messageId: 7 },
      { ...question, messageId: "foreign" },
    ])
      for (const type of ["reply-ask", "dismiss-ask"])
        expect((await handleSwarmsAction({ type, payload }, h.deps)).ok).toBe(false);
    for (const [type, payload] of [
      ["reply", gate],
      ["reply-ask", question],
      ["dismiss-ask", question],
    ] as const)
      expect((await handleSwarmsAction({ type, payload, origin: "canvas-html" }, h.deps)).ok).toBe(
        false,
      );
    expect(h.calls).toEqual([]);
  });

  test("gate identity guards reject repeated pauses and malformed identities while allowing current replies", async () => {
    const h = replyHarness();
    const initial = h.current;
    const first = initial.runs![0]!;
    const payload = {
      id: initial.id,
      runId: first.runId,
      gateIdentity: gateIdentity(first),
      note: "feedback",
    };
    for (const gate of [
      { ...first.pendingApproval!, pauseId: "next-pause" },
      { ...first.pendingApproval!, pauseId: undefined, nodeId: "approve-deploy" },
    ]) {
      h.current = { ...initial, runs: [{ ...first, pendingApproval: gate }] };
      expect((await handleSwarmsAction({ type: "reply", payload }, h.deps)).ok).toBe(false);
      expect((await handleSwarmsAction({ type: "select-gate", payload }, h.deps)).ok).toBe(false);
      expect((await handleSwarmsAction({ type: "open-run", payload }, h.deps)).ok).toBe(false);
    }
    const legacy = { ...first, pendingApproval: { ...first.pendingApproval!, pauseId: undefined } };
    const legacyPayload = { ...payload, gateIdentity: gateIdentity(legacy) };
    for (const patch of [
      { nodeId: "approve-answer" },
      { openedAt: "later" },
      { threadId: "later-thread" },
    ]) {
      h.current = {
        ...initial,
        runs: [{ ...legacy, pendingApproval: { ...legacy.pendingApproval!, ...patch } }],
      };
      expect((await handleSwarmsAction({ type: "reply", payload: legacyPayload }, h.deps)).ok).toBe(
        false,
      );
    }
    h.current = initial;
    for (const identity of [null, 7, "", {}, "foreign-pause"])
      expect(
        (
          await handleSwarmsAction(
            { type: "reply", payload: { ...payload, gateIdentity: identity } },
            h.deps,
          )
        ).ok,
      ).toBe(false);
    for (const patch of [{ status: "running" as const }, { pendingApproval: undefined }]) {
      h.current = { ...initial, runs: [{ ...first, ...patch }] };
      expect((await handleSwarmsAction({ type: "reply", payload }, h.deps)).ok).toBe(false);
      expect((await handleSwarmsAction({ type: "select-gate", payload }, h.deps)).ok).toBe(false);
    }
    h.current = initial;
    expect(h.calls).toEqual([]);
    expect((await handleSwarmsAction({ type: "reply", payload }, h.deps)).ok).toBe(true);
    expect(h.calls).toEqual([["gate", first.runId, "feedback"]]);
  });

  test("reply actions validate notes and missing threads, await gate posting and surface posting failures", async () => {
    const h = replyHarness();
    const initial = h.current;
    const question = { id: initial.id, messageId: initial.health!.asks![0]!.messageId };
    const gate = {
      id: initial.id,
      runId: initial.runs![0]!.runId,
      gateIdentity: gateIdentity(initial.runs![0]!),
    };
    for (const [type, payload] of [
      ["reply", gate],
      ["reply-ask", question],
    ] as const)
      for (const note of [undefined, 7, " ", "x".repeat(8001)])
        expect((await handleSwarmsAction({ type, payload: { ...payload, note } }, h.deps)).ok).toBe(
          false,
        );
    h.current = {
      ...initial,
      health: { asks: [{ ...initial.health!.asks![0]!, threadRootId: "" }] },
    };
    expect(
      (
        await handleSwarmsAction(
          { type: "reply-ask", payload: { ...question, note: "answer" } },
          h.deps,
        )
      ).ok,
    ).toBe(false);
    h.current = {
      ...initial,
      runs: [
        {
          ...initial.runs![0]!,
          pendingApproval: { ...initial.runs![0]!.pendingApproval!, threadId: undefined },
        },
      ],
    };
    expect(
      (await handleSwarmsAction({ type: "reply", payload: { ...gate, note: "answer" } }, h.deps))
        .ok,
    ).toBe(false);
    expect(h.calls).toEqual([]);
    h.current = initial;
    let unblock = () => {};
    h.block(
      new Promise<void>((resolve) => {
        unblock = resolve;
      }),
    );
    let complete = false;
    const pending = handleSwarmsAction(
      { type: "reply", payload: { ...gate, note: "x".repeat(8000) } },
      h.deps,
    ).then((result) => {
      complete = true;
      return result;
    });
    try {
      await Bun.sleep(2);
      expect(complete).toBe(false);
      unblock();
      expect((await pending).ok).toBe(true);
      h.fail();
      for (const [type, payload] of [
        ["reply", gate],
        ["reply-ask", question],
        ["dismiss-ask", question],
      ] as const) {
        const result = await handleSwarmsAction(
          { type, payload: { ...payload, note: "answer" } },
          h.deps,
        );
        expect(result.ok).toBe(false);
        expect(!result.ok ? result.error : "").toContain("failed");
      }
      expect(h.calls).toHaveLength(1);
    } finally {
      unblock();
    }
  });

  test("select-agent composes before its side-open reply and accepts ended agents", async () => {
    const sm = new FakeSnapshots();
    const surface = createSwarmsSurface({
      sm,
      views: [],
      state: () => state({ live: [fixtures.running!], ended: [fixtures.done!] }),
      find: deps.find,
      launch: () => ({ projects: [], live: 1, ended: 1 }),
      launchOf: () => undefined,
      server: () => ({ live: 1 }),
      readLog: async () => "log",
      report: () => undefined,
      windowMs: 1,
    });
    let unblock!: () => void;
    sm.gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let replied = false;
    const selection = handleSwarmsAction(
      {
        type: "select-agent",
        payload: { id: "s9hjx", agentId: "s9hjx-w1" },
      },
      { ...deps, surface },
    ).then((result) => {
      replied = true;
      return result;
    });
    try {
      await Bun.sleep(5);
      expect(replied).toBe(false);
      expect(sm.frames.has(agentKey("s9hjx"))).toBe(false);
      unblock();
      sm.gate = undefined;
      const result = await selection;
      expect(result).toEqual({
        ok: true,
        data: {
          effect: "open-canvas",
          key: agentKey("s9hjx"),
          title: "Agent @w1 · s9hjx",
          placement: "side",
        },
      });
      expect(ribClientEffectSchema.parse(result.ok ? result.data : undefined)).toMatchObject({
        placement: "side",
      });
      expect(sm.frames.get(agentKey("s9hjx"))?.at(-1)).toMatchObject({
        title: "Agent @w1 · s9hjx",
      });
      const endedBench = buildSwarmBoard(fixtures.done!).sections.find(
        (section) => section.kind === "cards" && section.title?.startsWith("Agents"),
      );
      const cardAction = endedBench?.kind === "cards" ? endedBench.items[0]?.action : undefined;
      if (!cardAction) throw new Error("missing ended card action");
      const ended = await handleSwarmsAction(cardAction, { ...deps, surface });
      expect(ended).toEqual({
        ok: true,
        data: {
          effect: "open-canvas",
          key: agentKey("s8pln"),
          title: "Agent @lead · s8pln",
          placement: "side",
        },
      });
      expect(ribClientEffectSchema.parse(ended.ok ? ended.data : undefined)).toMatchObject({
        placement: "side",
      });
      board(agentKey("s8pln"), sm.frames.get(agentKey("s8pln"))?.at(-1));
      expect(JSON.stringify(sm.frames.get(agentKey("s8pln"))?.at(-1))).not.toContain(
        "message-agent",
      );
      sm.composers.set(agentKey("s9hjx"), {
        compose: () => {
          throw new Error("bad frame");
        },
      });
      const failed = await handleSwarmsAction(
        {
          type: "select-agent",
          payload: { id: "s9hjx", agentId: "s9hjx-lead" },
        },
        { ...deps, surface },
      );
      expect(failed).toEqual({
        ok: false,
        error: "Could not publish the agent inspector: bad frame. Retry the selection.",
      });
    } finally {
      unblock();
      sm.gate = undefined;
      surface.dispose();
    }
  });

  test("select-agent refuses malformed, cross-swarm, starting and HTML-origin selections without effects", async () => {
    for (const payload of [
      { id: "../bad", agentId: "s9hjx-w1" },
      { id: "s9hjx", agentId: "s8pln-lead" },
      { id: "s9hjx", agentId: "you" },
      { id: "s9hjx", agentId: 7 },
      { id: "s9hjx" },
      { id: "s0000", agentId: "s0000-lead" },
    ])
      expect((await handleSwarmsAction({ type: "select-agent", payload }, deps)).ok).toBe(false);
    const valid = { type: "select-agent", payload: { id: "s9hjx", agentId: "s9hjx-w1" } };
    expect(await handleSwarmsAction(valid, deps)).toEqual({
      ok: false,
      error: "The agent inspector is unavailable; reopen the Swarms tab.",
    });
    expect((await handleSwarmsAction({ ...valid, origin: "canvas-html" }, deps)).ok).toBe(false);
    expect(
      (
        await handleSwarmsAction(valid, {
          ...deps,
          find: () => ({ starting }),
        })
      ).ok,
    ).toBe(false);
  });

  test("message-agent validates current eligibility, complete body and server posting failures", async () => {
    let current = fixtures.running!;
    const posted: [string, string][] = [];
    const fake = {
      ...liveSwarm,
      summary: () => current,
      stop: async () => current,
      replyToGate: async () => {},
      replyInThread: async () => {},
      dismissAsk: () => false,
      messageAgent: async (id: string, note: string) => {
        if (note === "posting fails") throw new Error("ClickClack unavailable");
        posted.push([id, note]);
      },
    };
    const messageDeps = { ...deps, live: () => fake };
    const send = (payload: Record<string, unknown>) =>
      handleSwarmsAction(
        {
          type: "message-agent",
          payload: { id: current.id, agentId: current.agents[1]!.id, ...payload },
        },
        messageDeps,
      );
    expect(await send({ note: "  check cache  " })).toMatchObject({
      ok: true,
      data: { message: "Posted to @w1 in #swarm-s9hjx as you" },
    });
    expect(posted).toEqual([["s9hjx-w1", "check cache"]]);
    for (const payload of [
      { note: undefined },
      { note: 7 },
      { note: " " },
      { note: "x".repeat(8000) },
      { agentId: "s8pln-lead", note: "wrong" },
      { agentId: 7, note: "wrong" },
      { note: "posting fails" },
    ])
      expect((await send(payload)).ok).toBe(false);
    expect(posted).toHaveLength(1);
    const prefix = `**Operator:** @${current.agents[1]!.handle} `;
    expect((await send({ note: "x".repeat(8000 - prefix.length) })).ok).toBe(true);
    expect((await send({ note: "x".repeat(8001 - prefix.length) })).ok).toBe(false);
    for (const patch of [
      { status: "stopping" as const },
      { conclusion: "done" },
      { turnsUsed: current.limits.maxTurns },
      { agents: [current.agents[0]!, { ...current.agents[1]!, status: "capped" as const }] },
      { agents: [current.agents[0]!, { ...current.agents[1]!, status: "failed" as const }] },
      {
        agents: [
          current.agents[0]!,
          { ...current.agents[1]!, turns: current.limits.maxTurnsPerAgent },
        ],
      },
    ]) {
      current = { ...fixtures.running!, ...patch };
      expect((await send({ note: "stale" })).ok).toBe(false);
    }
    expect(posted).toHaveLength(2);
    current = fixtures.running!;
    expect(
      (
        await handleSwarmsAction(
          {
            type: "message-agent",
            origin: "canvas-html",
            payload: { id: current.id, agentId: current.agents[1]!.id, note: "no" },
          },
          messageDeps,
        )
      ).ok,
    ).toBe(false);
  });

  test("server-manage opens the side inspector immediately and probes once", async () => {
    let probes = 0;
    let release = () => {};
    const probing = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manageDeps = {
      ...deps,
      probe: () => {
        probes++;
        return probing;
      },
    };
    try {
      const result = await handleSwarmsAction({ type: "server-manage" }, manageDeps);
      const effect = {
        effect: "open-canvas",
        key: SERVER_KEY,
        title: "ClickClack server",
        placement: "side",
      } as const;
      expect(result).toEqual({ ok: true, data: effect });
      expect(ribClientEffectSchema.parse(result.ok ? result.data : undefined)).toEqual(effect);
      expect(probes).toBe(1);
      expect(
        await handleSwarmsAction({ type: "server-manage", origin: "canvas-html" }, manageDeps),
      ).toEqual({ ok: false, error: "the Swarms tab takes actions from its boards only" });
      expect(probes).toBe(1);
      expect(await handleSwarmsAction({ type: "server-manage" }, deps)).toEqual({
        ok: true,
        data: effect,
      });
    } finally {
      release();
    }
  });

  test("select-swarm selects a live swarm without opening a drawer or showing a toast", async () => {
    const selected: string[] = [];
    const surface: SwarmsSurface = {
      selectAgent: async () => {},
      selectAsk: async () => {},
      selectGate: async () => {},
      openDetails: async () => {},
      select: (id) => {
        selected.push(id);
      },
      track: () => {},
      changed: () => {},
      refresh: () => {},
      forget: () => {},
      logOpened: () => {},
      dispose: () => {},
    };
    expect(
      await handleSwarmsAction(
        { type: "select-swarm", payload: { id: "s9hjx" } },
        { ...deps, surface },
      ),
    ).toEqual({ ok: true });
    expect(selected).toEqual(["s9hjx"]);
    for (const id of ["s8pln", "s0000", "../x", 7, undefined]) {
      expect(
        await handleSwarmsAction({ type: "select-swarm", payload: { id } }, { ...deps, surface }),
      ).toEqual({ ok: false, error: `swarm '${String(id)}' is not live` });
    }
    expect(
      await handleSwarmsAction(
        { type: "select-swarm", payload: { id: starting.id } },
        { ...deps, surface, find: () => ({ starting }) },
      ),
    ).toEqual({ ok: false, error: `swarm '${starting.id}' is not live` });
    expect(
      (
        await handleSwarmsAction(
          { type: "select-swarm", payload: { id: "s9hjx" }, origin: "canvas-html" },
          { ...deps, surface },
        )
      ).ok,
    ).toBe(false);
    expect(selected).toEqual(["s9hjx"]);
  });

  test("open and read return an open-canvas effect on the rib's own key", async () => {
    for (const [type, key] of [
      ["swarm-open", swarmKey("s8pln")],
      ["read-doc", docKey("s8pln")],
    ] as const) {
      const result = await handleSwarmsAction({ type, payload: { id: "s8pln" } }, deps);
      expect(result.ok).toBe(true);
      const effect = ribClientEffectSchema.parse(result.ok ? result.data : undefined);
      expect(effect).toMatchObject({ effect: "open-canvas", key });
    }
    const chat = await handleSwarmsAction({ type: "start-in-chat" }, deps);
    expect(ribClientEffectSchema.safeParse(chat.ok ? chat.data : undefined).success).toBe(true);
  });

  test("an unknown or malformed id, an html origin, and an unknown verb are refused", async () => {
    expect(
      (await handleSwarmsAction({ type: "swarm-open", payload: { id: "s0000" } }, deps)).ok,
    ).toBe(false);
    expect(
      (await handleSwarmsAction({ type: "swarm-open", payload: { id: "../x" } }, deps)).ok,
    ).toBe(false);
    expect(
      (
        await handleSwarmsAction(
          { type: "swarm-open", payload: { id: "s8pln" }, origin: "canvas-html" },
          deps,
        )
      ).ok,
    ).toBe(false);
    expect((await handleSwarmsAction({ type: "nope" }, deps)).ok).toBe(false);
  });

  test("a finished action names what it did in the toast", async () => {
    expect(
      await handleSwarmsAction(
        { type: "message-lead", payload: { id: "s9hjx", note: "hi" } },
        deps,
      ),
    ).toEqual({ ok: true, data: { message: "Posted in #swarm-s9hjx as you" } });
    expect(
      await handleSwarmsAction({ type: "stop-swarm", payload: { id: "s9hjx" } }, deps),
    ).toEqual({
      ok: true,
      data: { message: "Stopping swarm s9hjx: cancelling its runs and revoking its bots" },
    });
  });

  test("message-lead and stop need a live swarm, and a message needs a note", async () => {
    expect(
      (
        await handleSwarmsAction(
          { type: "message-lead", payload: { id: "s9hjx", note: "hi" } },
          deps,
        )
      ).ok,
    ).toBe(true);
    expect(
      (await handleSwarmsAction({ type: "steer", payload: { id: "s8pln", note: "hi" } }, deps)).ok,
    ).toBe(false);
    expect(
      (await handleSwarmsAction({ type: "steer", payload: { id: "s9hjx", note: " " } }, deps)).ok,
    ).toBe(false);
    expect(
      (await handleSwarmsAction({ type: "steer", payload: { id: "s9hjx", note: "hi" } }, deps)).ok,
    ).toBe(true);
    expect(
      (await handleSwarmsAction({ type: "stop-swarm", payload: { id: "s8pln" } }, deps)).ok,
    ).toBe(false);
    expect(
      (await handleSwarmsAction({ type: "stop-swarm", payload: { id: "s9hjx" } }, deps)).ok,
    ).toBe(true);
  });
});

describe("launching from the tab", () => {
  const projects = [{ id: "p1", name: "keelson-sample" }];

  test("the Launch header is one form beside Prepare in chat, folded once the tab has a swarm", () => {
    for (const st of [
      { projects, live: 0, ended: 0 },
      { projects: [], live: 0, ended: 0 },
      { projects, live: 2, ended: 3, dispatchBlocked: "no workflows", refused: ["fix-issue"] },
    ]) {
      board(LAUNCH_KEY, buildLaunch(st));
    }
    const items = (st: Parameters<typeof buildLaunch>[0]) => {
      const section = buildLaunch(st).sections[0];
      return section?.kind === "actions" ? section.items : [];
    };
    expect(items({ projects, live: 0, ended: 0 }).map((i) => i.label)).toEqual([
      "Start a swarm",
      "Prepare in chat · attach an issue or PR",
    ]);
    expect(items({ projects, live: 1, ended: 0 })[0]?.expanded).toBe(true);
    expect(buildLaunch({ projects, live: 0, ended: 0 }).header).toEqual({
      defaultCollapsed: false,
    });
    expect(buildLaunch({ projects, live: 0, ended: 1 }).header).toEqual({
      defaultCollapsed: true,
    });
    expect(buildLaunch({ projects, live: 1, ended: 0 }).header).toEqual({
      defaultCollapsed: true,
    });
    expect(items({ projects, live: 0, ended: 0 })[0]?.fields?.map((f) => f.name)).toEqual([
      "task",
      "project",
      "setup",
      "tools",
      "workflows",
      "size",
      "power",
      "model",
    ]);
    expect(items({ projects: [], live: 0, ended: 0 })[0]?.fields?.map((f) => f.name)).toEqual([
      "task",
      "setup",
      "workflows",
      "size",
      "power",
      "model",
    ]);
    const adjusting = { field: "setup", equals: "adjust" };
    const fieldsOf = items({ projects, live: 0, ended: 0 })[0]?.fields ?? [];
    for (const name of ["size", "power", "model"]) {
      expect(fieldsOf.find((f) => f.name === name)?.showWhen).toEqual(adjusting);
    }
    expect(fieldsOf.find((f) => f.name === "setup")).toMatchObject({
      defaultValue: "defaults",
      options: [
        { value: "defaults", label: "defaults · medium · balanced" },
        { value: "adjust", label: "adjust" },
      ],
    });
    expect(launchByline()).toBe(
      "Start runs medium · 5 agents · 40 turns · 30 min · balanced power",
    );
    const field = (st: Parameters<typeof buildLaunch>[0], name: string) =>
      items(st)[0]?.fields?.find((f) => f.name === name);
    expect(field({ projects: [], live: 0, ended: 0 }, "workflows")?.placeholder).toBe(
      "needs a registered project",
    );
    expect(
      field({ projects, live: 0, ended: 0, refused: ["fix-issue"] }, "workflows")?.placeholder,
    ).toBe(
      "none: the swarm investigates · e.g. fix-issue · fix-issue approvals: you answer them in Workflows",
    );
    expect(field({ projects, live: 0, ended: 0 }, "size")?.options?.map((o) => o.label)).toEqual([
      "small · 3 agents · 20 turns",
      "medium · 5 agents · 40 turns",
      "large · 8 agents · 80 turns",
    ]);
    expect(field({ projects, live: 0, ended: 0 }, "project")?.placeholder).toBe("no project");
    expect(field({ projects, live: 0, ended: 0 }, "workflows")?.showWhen).toEqual({
      field: "project",
    });
    expect(field({ projects, live: 0, ended: 0 }, "tools")?.showWhen).toEqual({ field: "project" });
    expect(field({ projects, live: 0, ended: 0 }, "tools")?.options).toEqual([
      { value: "none", label: "chat only" },
      { value: "read", label: "read the project" },
      { value: "write", label: "write the project" },
    ]);
    expect(field({ projects: [], live: 0, ended: 0 }, "workflows")?.showWhen).toBeUndefined();
    expect(
      field({ projects, live: 0, ended: 0, dispatchBlocked: "no workflows" }, "workflows")
        ?.showWhen,
    ).toBeUndefined();
    expect(items({ projects, live: 0, ended: 0 })[0]?.pendingLabel).toBe("Starting…");
  });

  test("each power's hover names the model every provider runs at it", () => {
    const section = buildLaunch({
      projects,
      live: 0,
      ended: 0,
      classes: [
        { provider: "claude", classes: { fast: "haiku-9", balanced: "sonnet-9", deep: "opus-9" } },
        { provider: "copilot", classes: { fast: "mini-6", balanced: "gpt-6", deep: "gpt-6-pro" } },
      ],
    }).sections[0];
    const power = (section?.kind === "actions" ? section.items[0]?.fields : [])?.find(
      (f) => f.name === "power",
    );
    expect(power?.defaultValue).toBe("balanced");
    expect(power?.options?.find((o) => o.value === "deep")?.hint).toBe(
      "claude: opus-9 · copilot: gpt-6-pro",
    );
    const flat = buildLaunch({
      projects,
      live: 0,
      ended: 0,
      classes: [{ provider: "copilot", classes: { fast: "auto", balanced: "auto", deep: "auto" } }],
    }).sections[0];
    const flatPower = (flat?.kind === "actions" ? flat.items[0]?.fields : [])?.find(
      (f) => f.name === "power",
    );
    expect(flatPower?.options?.find((o) => o.value === "fast")?.hint).toBe(
      "copilot: auto (every power)",
    );
    expect(
      buildLaunch({ projects, live: 0, ended: 0 }).sections.flatMap((x) =>
        x.kind === "actions" ? (x.items[0]?.fields ?? []) : [],
      ),
    ).toContainEqual(
      expect.objectContaining({ name: "model", placeholder: "use the power's model" }),
    );
  });

  test("an ended swarm offers Run again, seeded with its size and model, only when its launch is kept", () => {
    const actions = (launch: StartSwarmInput | undefined) =>
      buildSwarmBoard(fixtures.done!, launch ? { launch } : {})
        .sections.filter((x) => x.kind === "actions")
        .flatMap((x) => (x.kind === "actions" ? x.items : []));
    expect(actions(undefined).map((a) => a.type)).toEqual(["open-record", "open-details"]);
    expect(actions(oldLaunch).map((a) => a.type)).toEqual([
      "run-again",
      "open-record",
      "open-details",
    ]);
    const again = actions(oldLaunch)[0];
    expect(again).toMatchObject({ type: "run-again", binding: { id: "s8pln" } });
    expect(again?.hint).toBe(
      "Starts a new swarm with the same task, project, workflows (fix-issue), 1 context item. Context is not refreshed.",
    );
    expect(again?.fields?.find((f) => f.name === "size")?.defaultValue).toBe("medium");
    expect(again?.fields?.find((f) => f.name === "model")).toMatchObject({
      defaultValue: "gpt-6-astra",
      modelPicker: { providerField: "provider", providerDefault: "copilot" },
    });
    board(swarmKey("s8pln"), buildSwarmBoard(fixtures.done!, { launch: oldLaunch }));
  });
});

describe("opening a run and the tab's count", () => {
  test("a gate card and a run row open the run, and the action names its workflow", async () => {
    const drawer = buildSwarmBoard(fixtures.onlyYou!);
    const json = JSON.stringify(drawer);
    expect(json).toContain('"label":"Review plan"');
    expect(json).toContain(
      '"action":{"type":"open-run","payload":{"id":"s7k1p","runId":"r20000-1111-2222"}}',
    );
    board(swarmKey("s7k1p"), drawer);
    const opened = await handleSwarmsAction(
      { type: "open-run", payload: { id: "s8pln", runId: "r40000-1111-2222" } },
      actionDeps,
    );
    expect(ribClientEffectSchema.parse(opened.ok ? opened.data : undefined)).toEqual({
      effect: "open-run",
      runId: "r40000-1111-2222",
      workflow: "fix-issue",
    });
    const missing = await handleSwarmsAction(
      { type: "open-run", payload: { id: "s8pln", runId: "nope" } },
      actionDeps,
    );
    expect(missing.ok).toBe(false);
  });

  test("the tab counts the live swarms that need the operator", () => {
    const badge = buildBadge(
      state({ live: [fixtures.running!, fixtures.onlyYou!, fixtures.review!] }),
    );
    expect(ribSurfaceBadgeSchema.parse(badge)).toEqual({ count: 1, title: "1 swarm needs you" });
    expect(buildBadge(state({ live: [fixtures.running!] }))).toEqual({ count: 0 });
  });
});

describe("power and the served model", () => {
  test("Details names the power, its provider, and the model that served it", () => {
    const done = fixtures.done!;
    const s = {
      ...done,
      model: undefined,
      workerModel: undefined,
      power: "deep" as const,
      agents: done.agents.map((a) => ({ ...a, model: undefined, servedModel: "gpt-6-pro" })),
    };
    const details = JSON.stringify(buildDetailsInspector(s));
    expect(details).toContain("Requested power: deep");
    expect(details).toContain("Requested provider: copilot");
    expect(details).toContain("Served model for @lead (lead): gpt-6-pro");
    board(swarmKey(s.id), buildSwarmBoard(s));
  });
});

describe("start and run again", () => {
  const act = (type: string, payload: Record<string, unknown>) =>
    handleSwarmsAction({ type, payload }, actionDeps);

  test("a form with no workflows starts an investigating swarm and opens the index", async () => {
    begun.length = 0;
    const result = await act("start-swarm", {
      task: "  Why is the build slow?  ",
      workflows: "",
      project: "",
      tools: "none",
      size: "small",
      model: "",
      provider: "",
    });
    expect(result.ok).toBe(true);
    expect(ribClientEffectSchema.parse(result.ok ? result.data : undefined)).toEqual({
      effect: "open-surface",
      surfaceId: "surface:chat:swarms",
      regionKey: INDEX_KEY,
    });
    expect(begun).toEqual([{ task: "Why is the build slow?", workTools: "none", size: "small" }]);
  });

  test("a launch on defaults sends no size, power or model; adjust sends what was picked", async () => {
    begun.length = 0;
    await act("start-swarm", {
      task: "Why is the build slow?",
      setup: "defaults",
      size: "large",
      power: "deep",
      model: "gpt-6-astra",
      provider: "copilot",
    });
    await act("start-swarm", { task: "Why is the build slow?", setup: "adjust", size: "small" });
    expect(begun).toEqual([
      { task: "Why is the build slow?", workTools: "read" },
      { task: "Why is the build slow?", workTools: "read", size: "small" },
    ]);
  });

  test("write the project starts a write swarm, and needs a project", async () => {
    begun.length = 0;
    const ok = await act("start-swarm", {
      task: "Fix the flaky test",
      project: "p1",
      tools: "write",
    });
    expect(ok.ok).toBe(true);
    expect(begun[0]).toEqual({ task: "Fix the flaky test", workTools: "write", project: "p1" });
    const refused = await act("start-swarm", { task: "Fix the flaky test", tools: "write" });
    expect(refused.ok).toBe(false);
    expect(begun).toHaveLength(1);
  });

  test("workflows named grant them to the lead, and refusals come back to the form", async () => {
    begun.length = 0;
    const ok = await act("start-swarm", {
      task: "Fix the README node count",
      project: "p1",
      tools: "read",
      size: "large",
      workflows: "fix-issue, docs-check fix-issue",
      power: "deep",
      model: "gpt-6-astra",
      provider: "copilot",
    });
    expect(ok.ok).toBe(true);
    expect(begun[0]).toEqual({
      task: "Fix the README node count",
      workTools: "read",
      size: "large",
      power: "deep",
      project: "p1",
      model: "gpt-6-astra",
      provider: "copilot",
      workflows: [
        { name: "fix-issue", isolated: true },
        { name: "docs-check", isolated: true },
      ],
    });
    for (const payload of [
      { task: "t", project: "", workflows: "fix-issue" },
      { task: "t", project: "p1", workflows: "../x" },
      { task: " " },
      { task: "refuse" },
    ]) {
      expect((await act("start-swarm", payload)).ok).toBe(false);
    }
    expect(await act("start-swarm", { task: "t", project: "p1", workflows: " " })).toMatchObject({
      ok: true,
    });
  });

  test("a task that names a link with no context is refused before a swarm exists", async () => {
    begun.length = 0;
    for (const task of [
      "Fix https://github.com/o/r/issues/27",
      "Review #41 please",
      "See (#7) for the plan",
    ]) {
      const result = await act("start-swarm", { task });
      expect(result).toEqual({ ok: false, error: LINK_REFUSAL });
    }
    expect((await act("start-swarm", { task: "Issue twenty-seven undercounts nodes" })).ok).toBe(
      true,
    );
    expect(begun).toHaveLength(1);
  });

  test("Run again keeps the launch, and swaps the model only when the picker changed", async () => {
    begun.length = 0;
    const again = await act("run-again", {
      id: "s8pln",
      size: "large",
      model: "gpt-6-astra",
      provider: "copilot",
    });
    expect(ribClientEffectSchema.parse(again.ok ? again.data : undefined)).toMatchObject({
      effect: "open-canvas",
      key: swarmKey("s0new1"),
    });
    expect(begun[0]).toEqual({ ...oldLaunch, size: "large", power: "balanced" });
    expect(origins.at(-1)).toEqual({ rerunOf: "s8pln" });
    begun.length = 0;
    await act("run-again", {
      id: "s8pln",
      size: "medium",
      power: "fast",
      model: "gpt-5.6-sol",
      provider: "copilot",
    });
    const { workerModel: _dropped, ...rest } = oldLaunch;
    expect(begun[0]).toEqual({
      ...rest,
      power: "fast",
      model: "gpt-5.6-sol",
      provider: "copilot",
    });
    expect((await act("run-again", { id: "s9hjx", size: "small" })).ok).toBe(false);
    expect((await act("run-again", { id: "s5tcx", size: "small" })).ok).toBe(false);
  });
});

describe("the server line and inspector", () => {
  const running = serverFixtures.managedRunning;
  const verbsOf = (st: ServerPanelState) =>
    buildServerPanel(st)
      .sections.filter((x) => x.kind === "actions")
      .flatMap((x) => (x.kind === "actions" ? x.items : []));

  test("server refresh republishes matching index and inspector frames on the existing keys", async () => {
    const sm = new FakeSnapshots();
    let server: ServerLine | undefined;
    let op: ServerOp | undefined;
    const surface = createSwarmsSurface({
      sm,
      state: () => state({ server }),
      find: () => ({}),
      launch: () => ({ projects: [], live: 0, ended: 0 }),
      launchOf: () => undefined,
      server: () => ({ server, live: 0, ...(op ? { op } : {}) }),
      readLog: async () => "log",
      report: () => undefined,
      views: [],
      windowMs: 1,
    });
    try {
      expect(sm.keys()).toContain(SERVER_KEY);
      for (const fixture of Object.values(serverFixtures)) {
        server = fixture;
        surface.refresh();
        await Bun.sleep(10);
        const index = sm.frames.get(INDEX_KEY)?.at(-1);
        const inspector = sm.frames.get(SERVER_KEY)?.at(-1);
        board(INDEX_KEY, index);
        board(SERVER_KEY, inspector);
        expect(index).toEqual(buildIndex(state({ server })));
        expect(inspector).toEqual(buildServerPanel({ server, live: 0 }));
      }
      for (const current of [
        { verb: "reset", phase: "running", at: T0 },
        { verb: "reset", phase: "failed", at: T0, error: "boom" },
      ] satisfies ServerOp[]) {
        op = current;
        surface.refresh();
        await Bun.sleep(10);
        expect(sm.frames.get(INDEX_KEY)?.at(-1)).toEqual(buildIndex(state({ server, op })));
      }
    } finally {
      surface.dispose();
    }
    expect(sm.keys()).toEqual([]);
  });

  test("request boards and the index no longer describe channels as being in ClickClack", () => {
    for (const s of [fixtures.onlyYou!, fixtures.asked!, fixtures.gone!, fixtures.quiet!]) {
      const index = buildIndex(state({ live: [s], server: serverFixtures.managedStopped }));
      const swarmBoard = buildSwarmBoard(s, { server: serverFixtures.managedStopped });
      board(INDEX_KEY, index);
      board(swarmKey(s.id), swarmBoard);
      expect(JSON.stringify(index)).not.toContain("in ClickClack");
      expect(JSON.stringify(swarmBoard)).not.toContain("in ClickClack");
    }
  });

  test("a reachable external server links its address, reports the probe and offers only Retry", () => {
    const server = { ...serverFixtures.externalDown, running: true, unreachableSince: undefined };
    const view = buildServerPanel({ server, live: 1 });
    board(SERVER_KEY, view);
    expect(view.header?.status).toEqual({ label: "reachable", tone: "ok" });
    expect(view.sections[0]?.kind === "rows" ? view.sections[0].items[0] : undefined).toEqual({
      text: "Address",
      trailing: "cc.example",
      href: "https://cc.example/app",
    });
    expect(view.sections[0]?.kind === "rows" ? view.sections[0].items[2] : undefined).toEqual({
      text: "Last probe",
      trailing: `answered at ${hhmm(server.checkedAt)}`,
    });
    expect(verbsOf({ server, live: 1 })).toEqual([
      {
        type: "server-probe",
        label: "Retry",
        glyph: "↻",
        hint: "Probes the server again and updates the server line.",
      },
    ]);
    const index = buildIndex(state({ server, live: [fixtures.running!] }));
    board(INDEX_KEY, index);
    expect(JSON.stringify(index.sections.at(-1))).toContain(
      "Server · ClickClack reachable on cc.example · external · 1 swarm",
    );
    expect(
      buildServerPanel({ server: serverFixtures.managedStopped, live: 0 }).header?.status,
    ).toEqual({ label: "stopped", tone: "neutral" });
    expect(buildServerPanel({ live: 0 }).header?.status).toEqual({
      label: "unknown",
      tone: "neutral",
    });
  });

  test("the index always ends with one plain server line and a Manage action", () => {
    const cases = [
      {
        server: serverFixtures.managedRunning,
        live: [fixtures.running!],
        text: "Server · ClickClack running on 127.0.0.1:18080 · managed · 1 swarm",
      },
      {
        server: serverFixtures.managedStopped,
        live: [],
        text: "Server · ClickClack stopped on 127.0.0.1:18080 · managed",
      },
      {
        server: serverFixtures.externalDown,
        live: [],
        text: `Server · ClickClack unreachable since ${hhmm(serverFixtures.externalDown.unreachableSince)} on cc.example · external`,
      },
    ];
    for (const { server, live, text } of cases) {
      const view = buildIndex(state({ server, live, ended: [fixtures.done!] }));
      board(INDEX_KEY, view);
      expect(view.sections.at(-1)).toEqual({
        kind: "rows",
        items: [{ text, trailing: "Manage ›", action: { type: "server-manage" } }],
      });
      expect(JSON.stringify(view)).not.toContain('"collapsed"');
    }
    const startingView = buildIndex(
      state({
        server: serverFixtures.managedRunning,
        live: [fixtures.running!],
        starting: [starting],
      }),
    );
    board(INDEX_KEY, startingView);
    expect(JSON.stringify(startingView.sections.at(-1))).toContain("managed · 2 swarms");
    const unknownView = buildIndex(state({ starting: [starting] }));
    board(INDEX_KEY, unknownView);
    expect(JSON.stringify(unknownView.sections.at(-1))).toContain("ClickClack checking… · 1 swarm");
    for (const [op, chip] of [
      [
        { verb: "reset", phase: "running", at: T0 },
        { label: "resetting…", tone: "info" },
      ],
      [
        { verb: "reset", phase: "failed", at: T0, error: "boom" },
        { label: "reset failed", tone: "error" },
      ],
    ] as const) {
      const view = buildIndex(state({ server: serverFixtures.managedRunning, op }));
      const section = view.sections.at(-1);
      expect(section?.kind === "rows" ? section.items[0]?.chip : undefined).toEqual(chip);
    }
  });

  test("server inspectors box the managed process facts or the external probe", () => {
    const managed = buildServerPanel({ server: running, live: 0 });
    board(SERVER_KEY, managed);
    expect(managed.title).toBe("ClickClack server");
    expect(managed.sections[0]).toEqual({
      kind: "rows",
      boxed: true,
      items: [
        { text: "Address", trailing: "127.0.0.1:18080", href: `${running.url}/app` },
        { text: "Mode", trailing: "managed · the rib starts, stops and resets it" },
        { text: "Process", trailing: "4242" },
        { text: "Started", trailing: `${day(T0)} ${hhmm(T0)}` },
        { text: "Binary", trailing: running.binary },
        { text: "Data directory", trailing: running.dataDir },
      ],
    });
    const stopped = buildServerPanel({ server: serverFixtures.managedStopped, live: 0 });
    board(SERVER_KEY, stopped);
    expect(stopped.sections[0]).toEqual({
      kind: "rows",
      boxed: true,
      items: [
        { text: "Address", trailing: "127.0.0.1:18080" },
        { text: "Mode", trailing: "managed · the rib starts, stops and resets it" },
        { text: "Process", trailing: "not running" },
      ],
    });
    const external = buildServerPanel({ server: serverFixtures.externalDown, live: 0 });
    board(SERVER_KEY, external);
    expect(external.sections[0]).toEqual({
      kind: "rows",
      boxed: true,
      items: [
        { text: "Address", trailing: "cc.example" },
        {
          text: "Mode",
          trailing: "external · run by someone else; the rib doesn't start, stop or reset it",
        },
        {
          text: "Last probe",
          trailing: `no answer at ${hhmm(serverFixtures.externalDown.checkedAt)}; unreachable since ${hhmm(serverFixtures.externalDown.unreachableSince)}`,
        },
      ],
    });
    expect(buildServerPanel({ live: 0 }).sections).toEqual([
      { kind: "rows", items: [{ text: "Checking the server…" }] },
    ]);
    for (const [patch, suffix] of [
      [{ operator: true }, "started by hand"],
      [{ adopted: true }, "adopted"],
    ] as const) {
      const view = buildServerPanel({ server: { ...running, ...patch }, live: 0 });
      expect(view.sections[0]?.kind === "rows" ? view.sections[0].items[2]?.trailing : "").toBe(
        `4242 · ${suffix}`,
      );
    }
  });

  test("server operation results remain separate from the boxed facts", () => {
    for (const phase of ["done", "failed"] as const) {
      const view = buildServerPanel({
        server: running,
        live: 0,
        op: { verb: "start", phase, at: T0, error: "boom" },
      });
      board(SERVER_KEY, view);
      expect(view.sections[1]).toMatchObject({ kind: "rows" });
      expect(
        view.sections[1]?.kind === "rows" ? view.sections[1].boxed : undefined,
      ).toBeUndefined();
      expect(JSON.stringify(view.sections[1])).toContain(
        phase === "done" ? `start finished ${hhmm(T0)}` : "start failed: boom",
      );
    }
  });

  test("composes for every server state, and holds stop and reset while a swarm is live", () => {
    const at = "2026-09-22T14:10:00.000Z";
    const external = {
      mode: "external" as const,
      url: "https://cc.example",
      running: true,
      checkedAt: at,
    };
    for (const st of [
      { live: 0 },
      { server: running, live: 0 },
      { server: { mode: "managed" as const, url: running.url, running: false }, live: 0 },
      { server: external, live: 1 },
      { server: running, live: 0, op: { verb: "reset" as const, phase: "running" as const, at } },
      {
        server: running,
        live: 0,
        op: { verb: "stop" as const, phase: "failed" as const, at, error: "boom" },
      },
    ]) {
      board(SERVER_KEY, buildServerPanel(st));
    }
    expect(verbsOf({ server: running, live: 0 }).map((i) => i.type)).toEqual([
      "server-stop",
      "server-reset",
      "server-log",
    ]);
    expect(verbsOf({ server: serverFixtures.managedStopped, live: 0 }).map((i) => i.type)).toEqual([
      "server-start",
      "server-reset",
      "server-log",
    ]);
    const held = verbsOf({ server: running, live: 2 });
    expect(held.find((i) => i.type === "server-stop")).toMatchObject({ disabled: true });
    expect(held.find((i) => i.type === "server-reset")).toMatchObject({
      disabled: true,
      confirm: { irreversible: true, subject: "reset" },
    });
    expect(verbsOf({ server: external, live: 0 }).map((i) => i.type)).toEqual(["server-probe"]);
  });

  test("the head pill carries the operation, and an external server's reachability", () => {
    const at = "2026-09-22T14:10:00.000Z";
    const status = (st: ServerPanelState) => buildServerPanel(st).header?.status;
    expect(status({ server: running, live: 0 })).toEqual({ label: "running", tone: "ok" });
    expect(
      status({ server: running, live: 0, op: { verb: "reset", phase: "running", at } }),
    ).toEqual({ label: "resetting…", tone: "info" });
    expect(
      status({ server: running, live: 0, op: { verb: "stop", phase: "failed", at, error: "x" } }),
    ).toEqual({ label: "stop failed", tone: "error" });
    expect(status({ server: running, live: 0, op: { verb: "start", phase: "done", at } })).toEqual({
      label: "running",
      tone: "ok",
    });
    expect(
      status({
        server: {
          mode: "external",
          url: "https://cc.example",
          running: false,
          checkedAt: at,
          unreachableSince: "2026-09-22T13:40:00.000Z",
        },
        live: 0,
      }),
    ).toEqual({ label: "unreachable since 13:40", tone: "warn" });
    expect(JSON.stringify(buildServerPanel({ server: running, live: 0 }))).not.toContain(
      "Gates the host keeps",
    );
  });

  test("a verb runs in the background, reports on the inspector, and refuses while it or a swarm is busy", async () => {
    let release: () => void = () => {};
    const calls: string[] = [];
    let live = 0;
    let cleared = 0;
    let changes = 0;
    const server = {
      ensure: async () => ({ url: running.url, pid: 1, adopted: false }),
      stop: () =>
        new Promise<boolean>((resolve) => {
          calls.push("stop");
          release = () => resolve(true);
        }),
      reset: async () => {
        calls.push("reset");
        throw new Error("clickclack was not ready within 30s");
      },
      status: async () => ({ url: running.url, running: true }),
    };
    const ops = createServerOps({
      target: async () => ({ mode: "managed", server }),
      liveCount: () => live,
      clearEnded: () => cleared++,
      changed: () => changes++,
      now: () => T0,
    });
    live = 1;
    expect(await ops.run("stop")).toContain("1 swarm(s) live");
    live = 0;
    expect(await ops.run("stop")).toBeUndefined();
    expect(ops.current()).toMatchObject({ verb: "stop", phase: "running" });
    expect(await ops.run("reset")).toBe("a stop is still running");
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(ops.current()).toMatchObject({ verb: "stop", phase: "done" });
    expect(await ops.run("reset")).toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));
    expect(ops.current()).toMatchObject({
      verb: "reset",
      phase: "failed",
      error: "clickclack was not ready within 30s",
    });
    expect(cleared).toBe(0);
    expect(calls).toEqual(["stop", "reset"]);
    expect(changes).toBe(4);
    const external = createServerOps({
      target: async () => ({ mode: "external", url: "https://cc.example" }),
      liveCount: () => 0,
      clearEnded: () => {},
      changed: () => {},
    });
    expect(await external.run("start")).toContain("external");
  });

  test("the log verb reads the log afresh and opens it", async () => {
    let opened = 0;
    const result = await handleSwarmsAction(
      { type: "server-log" },
      { ...actionDeps, surface: { logOpened: () => opened++ } as unknown as SwarmsSurface },
    );
    expect(opened).toBe(1);
    expect(ribClientEffectSchema.parse(result.ok ? result.data : undefined)).toMatchObject({
      effect: "open-canvas",
      key: SERVER_LOG_KEY,
    });
  });
});

const launchStore = (dir: string) =>
  createSwarmFileStore(
    dir === "" ? () => undefined : () => dir,
    "launches",
    (v): v is StartSwarmInput => typeof v === "object" && v !== null && "task" in v,
  );

describe("the launch store", () => {
  test("keeps each launch on disk until its swarm is forgotten", () => {
    const dir = mkdtempSync(join(tmpdir(), "chat-launches-"));
    try {
      const store = launchStore(dir);
      store.save("s1abc", oldLaunch);
      store.save("s2abc", { task: "other", workTools: "none" });
      expect(launchStore(dir).load("s1abc")).toEqual(oldLaunch);
      store.keepOnly(new Set(["s2abc"]));
      const fresh = launchStore(dir);
      expect(fresh.has("s1abc")).toBe(false);
      expect(fresh.has("s2abc")).toBe(true);
      fresh.clear();
      expect(launchStore(dir).has("s2abc")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the rib's surface", () => {
  test("declares one valid Swarms tab over the live index", () => {
    expect(rib.surfaces).toHaveLength(1);
    const surface = ribSurfaceDescriptorSchema.parse(rib.surfaces?.[0]);
    expect(surface).toMatchObject({ id: "swarms", title: "Swarms", hideRegionActions: true });
    expect(JSON.stringify(surface.layout)).toContain(INDEX_KEY);
    expect(surface.layout.footer).toBeUndefined();
    expect(JSON.stringify(surface.layout)).not.toContain(SERVER_KEY);
  });
});
