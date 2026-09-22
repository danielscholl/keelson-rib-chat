import { describe, expect, test } from "bun:test";
import { expectView } from "@keelson/shared";
import { ClickClackClient } from "../src/clickclack.ts";
import { checkReport, unwrapReport } from "../src/report.ts";
import { handleSwarmsAction } from "../src/surface/actions.ts";
import { buildIndex } from "../src/surface/index-board.ts";
import { INDEX_KEY, reportKey, swarmKey } from "../src/surface/keys.ts";
import { buildSwarmBoard } from "../src/surface/swarm-board.ts";
import { Swarm, type SwarmChange } from "../src/swarm.ts";
import { makeChatTools } from "../src/tools.ts";
import type { SwarmSummary } from "../src/types.ts";
import { FakeClickClack, OWNER_TOKEN, type Script, scriptedProvider, WORKSPACE } from "./fakes.ts";

const PAGE = `<style>:root{--ink:#e6e6f0}:root[data-theme="light"]{--ink:#1b1b2a}</style><main><h1>Build time</h1><p>Linking takes 70%.</p></main>`;

function harness(script: Script) {
  const server = new FakeClickClack();
  const swarms = new Map<string, Swarm>();
  const owner = new ClickClackClient("http://fake", OWNER_TOKEN, server.transport);
  const tools = makeChatTools({
    swarms,
    ended: new Map<string, SwarmSummary>(),
    startSwarm: async () => {
      throw new Error("not used");
    },
  });
  const provider = scriptedProvider(tools, script);
  const changes: SwarmChange[] = [];
  const start = async () => {
    const swarm = await Swarm.start({
      id: "s1",
      task: "Find why the build is slow",
      owner,
      workspaceId: WORKSPACE,
      runAgentTurn: provider.run,
      quiesceMs: 20,
      reconnectMs: 5,
      onChange: (kind) => changes.push(kind),
    });
    swarms.set(swarm.id, swarm);
    return swarm;
  };
  return { provider, start, changes };
}

describe("the report page", () => {
  test("follows canvas_publish: inline assets only, and a declared palette must pass", () => {
    expect(checkReport(PAGE)).toBeUndefined();
    expect(checkReport(`<script src="https://x/y.js"></script>`)).toContain("inline all script");
    expect(checkReport(`<link rel="stylesheet" href="a.css">`)).toContain("inline all CSS");
    expect(
      checkReport(`<body data-palette-dark="#ff0000,#fe0000,#fd0000"><p>x</p></body>`),
    ).toContain("palette fails validation");
    expect(checkReport("x".repeat(512 * 1024 + 1))).toContain("512 KB");
  });

  test("a CDATA or code-fence wrapper comes off, so the stylesheet survives", () => {
    expect(unwrapReport(`<![CDATA[\n${PAGE}\n]]>`)).toBe(PAGE);
    expect(unwrapReport(`\`\`\`html\n${PAGE}\n\`\`\``)).toBe(PAGE);
    expect(unwrapReport(`  ${PAGE}  `)).toBe(PAGE);
  });

  test("only the lead holds chat_report and the design guide, and publishing lands on the summary", async () => {
    const results: { agent: string; isError: boolean; content: string }[] = [];
    const h = harness(async ({ agentId, turn, call }) => {
      if (agentId === "s1-lead" && turn === 1) {
        await call("chat_spawn", { handle: "w", role: "worker", brief: "report back" });
        return;
      }
      if (agentId === "s1-w") {
        results.push({
          agent: agentId,
          ...(await call("chat_report", { title: "t", html: PAGE })),
        });
        await call("chat_post", { body: "@s1-lead done" });
        return;
      }
      results.push({
        agent: agentId,
        ...(await call("chat_report", { title: "t", html: `<script src="x.js"></script>` })),
      });
      results.push({
        agent: agentId,
        ...(await call("chat_report", {
          title: "Why the build is slow",
          html: `<![CDATA[${PAGE}]]>`,
        })),
      });
      await call("chat_done", { summary: "Linking; see the report." });
    });
    const swarm = await h.start();
    const summary = await swarm.finished;

    expect(results.map((r) => [r.agent, r.isError])).toEqual([
      ["s1-w", true],
      ["s1-lead", true],
      ["s1-lead", false],
    ]);
    expect(summary.report).toMatchObject({ title: "Why the build is slow", bytes: PAGE.length });
    expect(swarm.reportPage()?.html).toBe(PAGE);
    expect(h.changes).toContain("report");

    const byAgent = (id: string) =>
      new Set(
        h.provider.requests
          .filter((r) => r.turnContext?.agentId === id)
          .flatMap((r) => (r.tools ?? []).map((t) => t.name)),
      );
    expect(byAgent("s1-lead").has("chat_report")).toBe(true);
    expect(byAgent("s1-lead").has("canvas_design_guide")).toBe(true);
    expect(byAgent("s1-w").has("chat_report")).toBe(false);
    expect(byAgent("s1-w").has("canvas_design_guide")).toBe(false);
    expect(h.provider.requests[0]?.system).toContain("chat_report");
  });

  test("the card and the drawer open the report on the rib's own key", async () => {
    const summary: SwarmSummary = {
      id: "s2rep",
      task: "Find why the build is slow",
      status: "done",
      channelId: "ch",
      channelName: "swarm-s2rep",
      startedAt: "2026-09-22T14:00:00.000Z",
      endedAt: "2026-09-22T14:10:00.000Z",
      turnsUsed: 4,
      limits: {
        maxAgents: 5,
        maxTurns: 40,
        maxTurnsPerAgent: 12,
        maxConcurrent: 3,
        wallClockMs: 1_800_000,
        turnTimeoutMs: 300_000,
        maxNudges: 2,
      },
      size: "medium",
      sizeBase: "medium",
      agents: [],
      conclusion: "Linking; see the report.",
      report: { title: "Why the build is slow", at: "2026-09-22T14:09:00.000Z", bytes: 9_000 },
    };
    const drawer = buildSwarmBoard(summary);
    expect(() => expectView(swarmKey("s2rep"), "board")(drawer)).not.toThrow();
    expect(JSON.stringify(drawer)).toContain('"type":"open-report"');
    const index = buildIndex({
      live: [{ ...summary, status: "running" }],
      starting: [],
      ended: [],
    });
    expect(() => expectView(INDEX_KEY, "board")(index)).not.toThrow();
    expect(JSON.stringify(index)).toContain('"type":"open-report"');

    const deps = {
      surface: undefined,
      find: (id: string) => (id === "s2rep" ? { ended: summary } : {}),
      live: () => undefined,
      begin: () => "s0",
      launchOf: () => undefined,
      hasReport: (id: string) => id === "s2rep",
    };
    const open = await handleSwarmsAction({ type: "open-report", payload: { id: "s2rep" } }, deps);
    expect(open).toEqual({
      ok: true,
      data: { effect: "open-canvas", key: reportKey("s2rep"), title: "Why the build is slow" },
    });
    expect(
      (await handleSwarmsAction({ type: "open-report", payload: { id: "s3non" } }, deps)).ok,
    ).toBe(false);
  });
});
