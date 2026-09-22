import { describe, expect, test } from "bun:test";
import {
  expectView,
  type RibViewDescriptor,
  ribClientEffectSchema,
  ribSurfaceDescriptorSchema,
  type SnapshotManager,
} from "@keelson/shared";
import rib from "../src/index.ts";
import { handleSwarmsAction } from "../src/surface/actions.ts";
import { buildDoc } from "../src/surface/doc.ts";
import { buildHistory, buildIndex, type SurfaceState } from "../src/surface/index-board.ts";
import { docKey, HISTORY_KEY, INDEX_KEY, swarmKey } from "../src/surface/keys.ts";
import { createKeyPublisher } from "../src/surface/publisher.ts";
import { createSwarmsSurface, MAX_SWARM_KEYS, type SwarmRecord } from "../src/surface/surface.ts";
import { buildGoneBoard, buildStartingBoard, buildSwarmBoard } from "../src/surface/swarm-board.ts";
import type { Swarm } from "../src/swarm.ts";
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

function gate(answerer: "swarm" | "operator"): ChildRun["pendingApproval"] {
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
    runs: [run("r2", { status: "paused", pendingApproval: gate("operator") })],
  }),
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

  test("the index sorts needs first, oldest need first, then starting, then running", () => {
    const view = buildIndex(
      state({
        live: [fixtures.running!, fixtures.quiet!, fixtures.onlyYou!],
        starting: [starting],
      }),
    );
    expect(view.header?.status).toEqual({ label: "2 need you", tone: "caution" });
    const cards = view.sections.find((s) => s.kind === "cards");
    const titles =
      cards?.kind === "cards" ? cards.items.map((c) => c.title.split(" · ").at(-1)) : [];
    expect(titles).toEqual(["s7k1p", "s5c07", "s0new", "s9hjx"]);
  });

  test("a card names its size and model, and its Open hover spells both out", () => {
    const view = buildIndex(state({ live: [fixtures.onlyYou!] }));
    const cards = view.sections.find((s) => s.kind === "cards");
    const card = cards?.kind === "cards" ? cards.items[0] : undefined;
    expect(card?.fields).toContainEqual({ label: "size", value: "large" });
    expect(card?.fields).toContainEqual({ label: "model", value: "gpt-6-astra" });
    expect(card?.reason?.text).toContain("answer it in the Workflows tab");
    expect(card?.actions?.[0]?.hint).toBe(
      "large: up to 8 agents · 80 turns, 16 per worker · 4 at once · 5 min a turn. Model: gpt-6-astra.",
    );
  });

  test("ended rows show eight, newest first, then a row that opens the rest", () => {
    const ended = Array.from({ length: 11 }, (_, i) =>
      swarm(`s${String(i).padStart(4, "0")}`, { status: "done", endedAt: T0 }),
    );
    const view = buildIndex(state({ ended }));
    const rows = view.sections.find((s) => s.kind === "rows" && s.title === "Ended");
    const items = rows?.kind === "rows" ? rows.items : [];
    expect(items).toHaveLength(9);
    expect(items[0]?.text.startsWith("s0010 ")).toBe(true);
    expect(items.at(-1)).toMatchObject({
      text: "3 earlier ended swarms",
      action: { type: "history-open" },
    });
  });

  test("the drawer spells out the size and names the models per role", () => {
    const view = buildSwarmBoard(fixtures.done!);
    expect(view.header?.chip).toBe("medium · 11/40 turns · gpt-6-astra · workers gpt-5.6-sol");
    const text = JSON.stringify(view);
    expect(text).toContain(
      "medium: up to 5 agents · 40 turns, 12 per worker · 3 at once · 5 min a turn",
    );
    expect(text).toContain("copilot · lead gpt-6-astra · workers gpt-5.6-sol");
    expect(text).not.toContain('"type":"steer"');
  });

  test("a custom size names its base", () => {
    const view = buildSwarmBoard(
      swarm("s2cus", { size: "custom", limits: { ...SIZE_PRESETS.medium, maxTurns: 60 } }),
    );
    expect(JSON.stringify(view)).toContain("custom, from medium: up to 5 agents · 60 turns");
  });

  test("a live swarm has one actions section, with steer and stop", () => {
    const view = buildSwarmBoard(fixtures.review!);
    const actions = view.sections.filter((s) => s.kind === "actions");
    expect(actions).toHaveLength(1);
    const types = actions[0]?.kind === "actions" ? actions[0].items.map((i) => i.type) : [];
    expect(types).toEqual(["read-doc", "steer", "stop-swarm"]);
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
    expect(buildDoc(big, big.id).length).toBeLessThan(96_000);
  });
});

describe("the reading pane", () => {
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
    expect(views).toHaveLength(MAX_SWARM_KEYS);
    expect(views[0]).toEqual({
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

describe("actions", () => {
  const live = { summary: () => fixtures.running, steer: async () => {}, stop: async () => {} };
  const deps = {
    surface: undefined,
    find: (id: string): SwarmRecord =>
      id === "s9hjx"
        ? { live: fixtures.running as SwarmSummary }
        : id === "s8pln"
          ? { ended: fixtures.done as SwarmSummary }
          : {},
    live: (id: string) => (id === "s9hjx" ? (live as unknown as Swarm) : undefined),
  };

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

  test("steer and stop need a live swarm, and steer needs a note", async () => {
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

describe("the rib's surface", () => {
  test("declares one valid Swarms tab over the live index", () => {
    expect(rib.surfaces).toHaveLength(1);
    const surface = ribSurfaceDescriptorSchema.parse(rib.surfaces?.[0]);
    expect(surface).toMatchObject({ id: "swarms", title: "Swarms", hideRegionActions: true });
    expect(JSON.stringify(surface.layout)).toContain(INDEX_KEY);
  });
});
