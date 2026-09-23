import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expectView,
  type RibViewDescriptor,
  ribClientEffectSchema,
  ribSurfaceBadgeSchema,
  ribSurfaceDescriptorSchema,
  type SnapshotManager,
} from "@keelson/shared";
import rib from "../src/index.ts";
import { createSwarmFileStore } from "../src/store.ts";
import { handleSwarmsAction, LINK_REFUSAL } from "../src/surface/actions.ts";
import { buildDoc } from "../src/surface/doc.ts";
import { hhmm } from "../src/surface/format.ts";
import {
  buildBadge,
  buildHistory,
  buildIndex,
  endedRow,
  type SurfaceState,
} from "../src/surface/index-board.ts";
import {
  docKey,
  HISTORY_KEY,
  INDEX_KEY,
  LAUNCH_KEY,
  SERVER_KEY,
  SERVER_LOG_KEY,
  swarmKey,
} from "../src/surface/keys.ts";
import { buildLaunch } from "../src/surface/launch-board.ts";
import { createKeyPublisher } from "../src/surface/publisher.ts";
import { createServerOps } from "../src/surface/server-ops.ts";
import { buildServerPanel, type ServerPanelState } from "../src/surface/server-panel.ts";
import {
  createSwarmsSurface,
  MAX_SWARM_KEYS,
  type SwarmRecord,
  type SwarmsSurface,
} from "../src/surface/surface.ts";
import { buildGoneBoard, buildStartingBoard, buildSwarmBoard } from "../src/surface/swarm-board.ts";
import { ACTIVITY_KEPT, type Swarm } from "../src/swarm.ts";
import type { StartSwarmInput } from "../src/tools.ts";
import {
  type ChildRun,
  SIZE_PRESETS,
  type StartingSwarm,
  type SwarmAgent,
  type SwarmSummary,
  WORKER_TONES,
} from "../src/types.ts";

const T0 = "2026-09-22T14:00:00.000Z";

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

const starting: StartingSwarm = {
  id: "s0new",
  task: "Summarize open deploy issues",
  startedAt: T0,
  limits: SIZE_PRESETS.small,
  sizeBase: "small",
};

const fixtures: Record<string, SwarmSummary> = {
  running: swarm("s9hjx"),
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
  gone: swarm("s4n4x", { health: { socketDrops: 2, channelFault: "fetch failed" } }),
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

const state = (patch: Partial<SurfaceState> = {}): SurfaceState => ({
  live: [],
  starting: [],
  ended: [],
  ...patch,
});

const board = (key: string, view: unknown) =>
  expect(() => expectView(key, "board")(view)).not.toThrow();

describe("Swarms boards", () => {
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
    board(swarmKey(starting.id), buildStartingBoard(starting));
    board(swarmKey("s0old"), buildGoneBoard("s0old"));
  });

  const cardsOf = (view: ReturnType<typeof buildIndex>) => {
    const cards = view.sections.find((s) => s.kind === "cards");
    return cards?.kind === "cards" ? cards.items : [];
  };

  test("the index sorts requests first, oldest first, then starting, then running", () => {
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
      "No agent has worked since 14:40",
      "Summarize open deploy issues · s0new",
      "Fix issue #27: README undercounts frontend-mix nodes · s9hjx",
    ]);
  });

  test("a connection request starts a stopped managed server and links the channel", () => {
    const down = { mode: "managed" as const, running: false };
    const card = cardsOf(buildIndex(state({ live: [fixtures.gone!], server: down })))[0];
    expect(card?.pill).toEqual({ label: "connection", tone: "error" });
    expect(card?.fields?.[0]?.value).toContain("the managed server is not running");
    expect(card?.fields?.[1]).toEqual({
      value: "#swarm-s4n4x in ClickClack",
      href: "http://127.0.0.1:18080/app/ws_1/ch_s4n4x",
    });
    expect(card?.actions?.map((a) => a.type).slice(0, 2)).toEqual(["server-start", "swarm-open"]);
    const up = { mode: "managed" as const, running: true, url: "http://127.0.0.1:18080" };
    const retrying = cardsOf(buildIndex(state({ live: [fixtures.gone!], server: up })))[0];
    expect(retrying?.fields?.[0]?.value).toContain("the swarm retries every 2 seconds");
    expect(retrying?.actions?.[0]?.type).toBe("swarm-open");
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
    expect(card?.bar).toBeUndefined();
    expect(card?.fields?.[0]?.value).toBe(
      "fix-issue r20000-1 paused at approve-plan since 14:31 · only you can approve fix-issue on this host",
    );
    expect(card?.fields?.[1]).toEqual({
      value: "the approval thread in ClickClack",
      href: "http://127.0.0.1:18080/app/ws_1/msg_0042",
    });
    expect(card?.fields?.[2]?.value).toMatch(
      /^11 of 80 turns used · 69 remaining · \d+ of 60 min$/,
    );
    expect(card?.footnote).toBe(
      "Fix issue #27: README undercounts frontend-mix nodes · keelson-sample · large · gpt-6-astra · 2 agents · started 14:00",
    );
    expect(card?.reason).toBeUndefined();
    expect(card?.actions?.map((a) => a.label)).toEqual([
      "Review plan",
      "Open swarm",
      "Stop swarm…",
    ]);
    expect(card?.actions?.[0]).toMatchObject({ type: "open-run", tone: "brand" });
    expect(card?.actions?.[1]?.hint).toBe(
      "large: up to 8 agents · 80 turns, 16 per worker · 4 at once · 5 min a turn. Model: gpt-6-astra.",
    );
  });

  test("a second request is counted, never shown in the reason", () => {
    const card = cardsOf(buildIndex(state({ live: [fixtures.asked!] })))[0];
    expect(card?.title).toBe(
      "Review the plan for Fix issue #27: README undercounts frontend-mix nodes",
    );
    expect(card?.reason).toEqual({ text: "+1 more request" });
    const question = cardsOf(buildIndex(state({ live: [{ ...fixtures.asked!, runs: [] }] })))[0];
    expect(question?.title).toBe("@w1 asked: which retry cap, 30 s or 60 s?");
    expect(question?.pill).toEqual({ label: "question", tone: "caution" });
    expect(question?.actions?.[0]).toMatchObject({ type: "read-doc", label: "Read question" });
  });

  test("a running card names the activity, then the budget as a named meter", () => {
    const card = cardsOf(buildIndex(state({ live: [fixtures.waiting!] })))[0];
    expect(card?.pill).toEqual({ label: "running", tone: "info" });
    expect(card?.bar).toEqual({ value: 11, total: 40 });
    expect(card?.fields?.[0]?.value).toBe("@lead working · @lead turn 3 ok");
    expect(card?.fields?.[1]?.value).toBe("Turn budget used · 11 of 40 · 29 remaining");
    expect(card?.footnote).toBe("keelson-sample · medium · gpt-5.6-sol · 2 agents · started 14:00");
    expect(card?.actions?.[0]).toMatchObject({ type: "swarm-open", label: "Open swarm" });
    const stopping = cardsOf(buildIndex(state({ live: [fixtures.stopping!] })))[0];
    expect(stopping?.pill).toEqual({ label: "stopping", tone: "neutral" });
  });

  test("an empty tab shows the journey, not a placeholder row", () => {
    const view = buildIndex(state());
    expect(view.sections.map((x) => x.kind)).toEqual(["journey"]);
    expect(view.header).toBeUndefined();
  });

  test("ended rows show eight, newest first, then a row that opens the rest", () => {
    const ended = Array.from({ length: 11 }, (_, i) =>
      swarm(`s${String(i).padStart(4, "0")}`, { status: "done", endedAt: T0 }),
    );
    const view = buildIndex(state({ ended }));
    const rows = view.sections.find((s) => s.kind === "rows" && s.title === "Ended");
    const items = rows?.kind === "rows" ? rows.items : [];
    expect(items).toHaveLength(9);
    expect(items[0]).toMatchObject({
      chip: { label: "done", tone: "ok" },
      text: "Fix issue #27: README undercounts frontend-mix nodes · s0010",
    });
    expect(items[0]?.trailing?.startsWith("gpt-5.6-sol · 11 turns · ")).toBe(true);
    const done = fixtures.done!;
    expect(endedRow(done, new Date("2026-09-30T12:00:00Z")).trailing).toBe(
      "gpt-6-astra · workers gpt-5.6-sol · 11 turns · 29 min · Sep 22 · 1 of 1 run verified",
    );
    expect(endedRow(done, new Date(done.endedAt!)).trailing).toBe(
      `gpt-6-astra · workers gpt-5.6-sol · 11 turns · 29 min · ${hhmm(done.endedAt)} · 1 of 1 run verified`,
    );
    expect(items.at(-1)).toMatchObject({
      text: "3 earlier ended swarms",
      action: { type: "history-open" },
    });
  });

  test("the drawer spells out the size and names the models per role", () => {
    const view = buildSwarmBoard(fixtures.done!);
    expect(view.header?.status).toEqual({ label: "done", tone: "ok" });
    expect(view.header?.chip).toBe(
      "medium · 11 turns · 29 min · gpt-6-astra · workers gpt-5.6-sol",
    );
    const text = JSON.stringify(view);
    expect(text).toContain(
      "medium: up to 5 agents · 40 turns, 12 per worker · 3 at once · 5 min a turn",
    );
    expect(text).toContain("copilot · lead gpt-6-astra · workers gpt-5.6-sol");
    expect(text).not.toContain('"type":"steer"');
    expect(text).toContain('"label":"Runs verified","value":"1 of 1","tone":"ok"');
    expect(JSON.stringify(buildIndex(state({ ended: [fixtures.done!] })))).toContain(
      "· Sep 22 · 1 of 1 run verified",
    );
  });

  test("a custom size says which preset it was adjusted from", () => {
    const view = buildSwarmBoard(
      swarm("s2cus", { size: "custom", limits: { ...SIZE_PRESETS.medium, maxTurns: 60 } }),
    );
    expect(view.header?.chip).toBe("medium, adjusted · 11 of 60 turns · gpt-5.6-sol");
    expect(JSON.stringify(view)).toContain("medium, adjusted: up to 5 agents · 60 turns");
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
    expect(view.sections.map((x) => x.kind)).toEqual(["cards", "stats", "cards", "rows", "rows"]);
    const row = JSON.stringify(buildIndex({ live: [], starting: [], ended: [stopped] }));
    expect(row).toContain('"chip":{"label":"stopped","tone":"neutral"}');
    expect(row).toContain("· 11 turns · 23 s · ");
    const out = buildSwarmBoard(
      swarm("s4out", { status: "exhausted", endedAt: T0, error: "turn budget of 40 spent" }),
    );
    expect(JSON.stringify(out)).toContain('"title":"Out of turns at 40"');
  });

  test("a live board runs requests, budget, the lead's line and stop, then the record", () => {
    const view = buildSwarmBoard(fixtures.review!);
    expect(view.sections.map((x) => x.kind)).toEqual([
      "cards",
      "stats",
      "actions",
      "cards",
      "rows",
      "rows",
      "rows",
    ]);
    const actions = view.sections.filter((s) => s.kind === "actions");
    expect(actions).toHaveLength(1);
    const items = actions[0]?.kind === "actions" ? actions[0].items : [];
    expect(items.map((i) => i.type)).toEqual(["message-lead", "stop-swarm"]);
    expect(items[0]).toMatchObject({ label: "Message the lead", expanded: true });
    expect(items[1]).toMatchObject({ inline: true, align: "end" });
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

  test("the bench shows each agent, waiting seats, and ghosts up to the cap", () => {
    const view = buildSwarmBoard(fixtures.waiting!);
    const bench = view.sections.find((x) => x.kind === "cards" && x.title?.startsWith("Agents"));
    const items = bench?.kind === "cards" ? bench.items : [];
    expect(bench).toMatchObject({ grid: true, title: "Agents · 2 of 5" });
    expect(bench).not.toHaveProperty("columns");
    expect(items).toHaveLength(5);
    expect(items[0]).toMatchObject({
      title: "lead",
      titleTone: "brand",
      mono: true,
      pill: { label: "busy", tone: "info" },
    });
    expect(items[0]?.bar).toBeUndefined();
    expect(items[1]).toMatchObject({
      pill: { label: "waiting", tone: "caution" },
      bar: { value: 3, total: 12 },
      footnote: "2 messages waiting",
    });
    expect(items.slice(2).every((c) => c.ghost === true)).toBe(true);
    const stats = view.sections.find((x) => x.kind === "stats");
    const tiles = stats?.kind === "stats" ? stats.items : [];
    expect(tiles[0]).toMatchObject({
      label: "Turns",
      value: "11 of 40",
      sub: "29 remaining",
      spark: [1, 3, 2, 0, 1],
    });
    expect(tiles[2]).toMatchObject({ label: "Agents", value: "2 of 5", sub: "1 busy · 1 waiting" });
    expect(JSON.stringify(view)).toContain('"text":"@lead turn 3 ok ×2"');
    const ended = buildSwarmBoard(fixtures.done!);
    const endedBench = ended.sections.find(
      (x) => x.kind === "cards" && x.title?.startsWith("Agents"),
    );
    expect(endedBench?.kind === "cards" ? endedBench.items : []).toHaveLength(2);
  });

  test("Runs appear only when the launch named workflows, and say so while none ran", () => {
    const titles = (s: SwarmSummary) =>
      buildSwarmBoard(s).sections.flatMap((x) => (x.kind === "rows" && x.title ? [x.title] : []));
    expect(titles(fixtures.running!)).toEqual(["Task and context", "About"]);
    expect(titles(fixtures.dispatchIdle!)).toEqual(["Runs", "Task and context", "About"]);
    expect(JSON.stringify(buildSwarmBoard(fixtures.dispatchIdle!))).toContain(
      "The lead may start fix-issue, docs-check; none started yet.",
    );
    expect(JSON.stringify(buildSwarmBoard(fixtures.done!))).toContain(
      '"trailing":"PR #28 · verified"',
    );
    expect(JSON.stringify(buildSwarmBoard(fixtures.review!))).toContain("4 steps done");
  });

  test("the task and each context item disclose their text under the row", () => {
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
    const section = buildSwarmBoard(s).sections.find(
      (x) => x.kind === "rows" && x.title === "Task and context",
    );
    const rows = section?.kind === "rows" ? section.items : [];
    expect(rows[0]?.text).toBe("Task: Fix issue #27");
    expect(rows[0]?.detail?.length).toBe(4000);
    expect(rows[0]?.trailing).toBe("first 4,000 of 7,014 characters");
    expect(rows[1]).toMatchObject({
      text: "issue: README count",
      trailing: "retrieved Sep 22 13:00 · first 4,000 of 5,000 chars",
    });
    expect(rows[1]?.detail?.length).toBe(4000);
    expect(rows[1]?.href).toBeUndefined();
    expect(rows[2]).toMatchObject({ trailing: "12 chars", detail: "twelve chars" });
    board(swarmKey("s8ctx"), buildSwarmBoard(s));
    expect(buildDoc(s, "s8ctx")).toContain("## issue: README count");
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
    expect(index).toContain('"value":"14:21 @lead turn 12 ok"');
  });

  test("frames stay inside their budgets at the limits", () => {
    const agents = Array.from({ length: 12 }, (_, i) => agent("s9big", i));
    const runs = Array.from({ length: 12 }, (_, i) =>
      run(`r${i}`, { status: "paused", pendingApproval: gate(i % 2 ? "swarm" : "operator") }),
    );
    const big = swarm("s9big", {
      agents,
      runs,
      task: "t".repeat(8000),
      conclusion: "c".repeat(20_000),
      activity: Array.from({ length: ACTIVITY_KEPT }, () => ({ at: T0, text: "a".repeat(400) })),
      usage: { input: 9_000_000, output: 400_000, cached: 7_000_000 },
    });
    const many = Array.from({ length: 50 }, (_, i) =>
      swarm(`s${String(i).padStart(4, "0")}`, {
        status: "done",
        endedAt: T0,
        task: "t".repeat(8000),
      }),
    );
    const live = Array.from({ length: 6 }, (_, i) => ({ ...big, id: `s9bi${i}` }));
    expect(JSON.stringify(buildIndex(state({ live, ended: many }))).length).toBeLessThan(48_000);
    expect(JSON.stringify(buildIndex(state({ live: [big], ended: many }))).length).toBeLessThan(
      16_000,
    );
    expect(JSON.stringify(buildSwarmBoard(big)).length).toBeLessThan(48_000);
    expect(buildDoc(big, big.id).length).toBeLessThan(128_000);
  });
});

describe("the record", () => {
  const rowsTitled = (view: ReturnType<typeof buildSwarmBoard>, title: string) => {
    const section = view.sections.find((x) => x.kind === "rows" && x.title === title);
    return section?.kind === "rows" ? section.items : [];
  };

  test("activity shows the newest twelve and points at the full log", () => {
    const s = swarm("s7log", {
      activity: Array.from({ length: 15 }, (_, i) => ({ at: T0, text: `event ${i}` })),
    });
    const view = buildSwarmBoard(s);
    board(swarmKey(s.id), view);
    const rows = rowsTitled(view, "Activity");
    expect(rows).toHaveLength(13);
    expect(rows[0]?.text).toBe("event 14");
    expect(rows.at(-1)).toMatchObject({
      text: "Read the full log · 3 earlier events",
      action: { type: "read-doc", payload: { id: "s7log" } },
    });
    const doc = buildDoc(s, s.id);
    expect(doc).toContain("## Activity");
    expect(doc).toContain("- 14:00 event 0\n");
    const short = buildSwarmBoard(swarm("s7few", { activity: [{ at: T0, text: "one" }] }));
    expect(rowsTitled(short, "Activity").map((r) => r.text)).toEqual(["one"]);
  });

  test("an answered approval names its reviewer and discloses the reason", () => {
    const rows = rowsTitled(buildSwarmBoard(fixtures.done!), "Runs");
    expect(rows[1]).toMatchObject({
      text: "approve-plan approved on @w1's review",
      detail: "r",
      href: "http://127.0.0.1:18080/app/ws_1/msg_1",
    });
  });
});

describe("the reading pane", () => {
  test("an open gate shows its files: markdown as is, other text fenced, failures named", () => {
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
    const doc = buildDoc(withFiles, "s9fil");
    expect(doc).toContain("### plan.md\n\n## Steps\n\n1. Count the nodes.");
    expect(doc).toContain("### diff.patch (cut short)\n\n````\n+12 nodes\n````");
    expect(doc).toContain("### notes.txt\n\n*Could not be read: not found.*");
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

  test("the conclusion's copy button reveals the whole conclusion", async () => {
    const done = fixtures.done!;
    const drawer = JSON.stringify(buildSwarmBoard(done));
    expect(drawer).toContain('"copyAction":{"type":"copy-conclusion","payload":{"id":"s8pln"}}');
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
  });

  test("shows the whole conclusion, the refused draft, or the open gate's prompt", () => {
    expect(buildDoc(fixtures.done, "s8pln")).toContain("x".repeat(3000));
    expect(buildDoc(fixtures.stalled, "s5tcx")).toContain("a draft");
    const gated = buildDoc(fixtures.review, "s9hjy");
    expect(gated).toContain("> Plan: set the README node count to 12.");
    expect(gated).toContain("http://127.0.0.1:18080/app/ws_1/msg_0042");
    expect(buildDoc(undefined, "s0old")).toContain("no longer in the rib's history");
  });
});

class FakeSnapshots implements SnapshotManager {
  composers = new Map<string, { compose: () => unknown; validate?: (d: unknown) => unknown }>();
  frames = new Map<string, unknown[]>();
  inFlight = 0;
  gate: Promise<void> | undefined;

  register<T>(key: string, compose: () => T | Promise<T>, opts?: { validate?: (d: unknown) => T }) {
    if (this.composers.has(key)) throw new Error(`duplicate key ${key}`);
    this.composers.set(key, { compose, ...(opts?.validate ? { validate: opts.validate } : {}) });
    return () => void this.composers.delete(key);
  }
  async recompose(key: string) {
    const c = this.composers.get(key);
    if (!c) return undefined;
    this.inFlight++;
    try {
      if (this.gate) await this.gate;
      const data = await c.compose();
      c.validate?.(data);
      this.frames.set(key, [...(this.frames.get(key) ?? []), data]);
    } finally {
      this.inFlight--;
    }
    return undefined;
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
      launch: () => ({ projects: [], live: 0 }),
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

const begun: StartSwarmInput[] = [];
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
  begin: (input: StartSwarmInput) => {
    if (input.task === "refuse") throw new Error("no registered project 'nope'");
    begun.push(input);
    return "s0new1";
  },
  launchOf: (id: string): StartSwarmInput | undefined => (id === "s8pln" ? oldLaunch : undefined),
};

describe("actions", () => {
  const deps = actionDeps;

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

  test("the Launch header is one form, open until a swarm is live, beside Prepare in chat", () => {
    for (const st of [
      { projects, live: 0 },
      { projects: [], live: 0 },
      { projects, live: 2, dispatchBlocked: "no workflows", refused: ["fix-issue"] },
    ]) {
      board(LAUNCH_KEY, buildLaunch(st));
    }
    const items = (st: Parameters<typeof buildLaunch>[0]) => {
      const section = buildLaunch(st).sections[0];
      return section?.kind === "actions" ? section.items : [];
    };
    expect(items({ projects, live: 0 }).map((i) => i.type)).toEqual([
      "start-swarm",
      "start-in-chat",
    ]);
    expect(items({ projects, live: 0 })[0]?.expanded).toBe(true);
    expect(items({ projects, live: 1 })[0]?.expanded).toBeUndefined();
    expect(items({ projects: [], live: 0 })[0]?.fields?.map((f) => f.name)).toEqual([
      "task",
      "workflows",
      "size",
      "power",
      "model",
    ]);
    const field = (st: Parameters<typeof buildLaunch>[0], name: string) =>
      items(st)[0]?.fields?.find((f) => f.name === name);
    expect(field({ projects: [], live: 0 }, "workflows")?.placeholder).toBe(
      "needs a registered project",
    );
    expect(field({ projects, live: 0, refused: ["fix-issue"] }, "workflows")?.placeholder).toBe(
      "none: the swarm investigates · e.g. fix-issue · fix-issue approvals: you answer them in Workflows",
    );
    expect(field({ projects, live: 0 }, "size")?.options?.map((o) => o.label)).toEqual([
      "small · 3 agents · 20 turns",
      "medium · 5 agents · 40 turns",
      "large · 8 agents · 80 turns",
    ]);
    expect(field({ projects, live: 0 }, "project")?.placeholder).toBe("no project");
  });

  test("each power's hover names the model every provider runs at it", () => {
    const section = buildLaunch({
      projects,
      live: 0,
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
    expect(
      buildLaunch({ projects, live: 0 }).sections.flatMap((x) =>
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
    expect(actions(undefined)).toEqual([]);
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
  test("the drawer names the power, its provider, and the model that served it", () => {
    const done = fixtures.done!;
    const s = {
      ...done,
      model: undefined,
      workerModel: undefined,
      power: "deep" as const,
      agents: done.agents.map((a) => ({ ...a, model: undefined, servedModel: "gpt-6-pro" })),
    };
    const drawer = JSON.stringify(buildSwarmBoard(s));
    expect(drawer).toContain("deep power on copilot · every agent on gpt-6-pro");
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
    expect(begun).toEqual([
      { task: "Why is the build slow?", workTools: "none", size: "small", power: "balanced" },
    ]);
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

describe("the ClickClack footer", () => {
  const running = {
    mode: "managed" as const,
    url: "http://127.0.0.1:18080",
    running: true,
    pid: 4242,
    binary: "/usr/local/bin/clickclack",
    dataDir: "/data/clickclack",
    startedAt: T0,
  };
  const verbsOf = (st: ServerPanelState) =>
    buildServerPanel(st)
      .sections.filter((x) => x.kind === "actions")
      .flatMap((x) => (x.kind === "actions" ? x.items : []));

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

  test("a verb runs in the background, reports on the footer, and refuses while it or a swarm is busy", async () => {
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
  });
});
