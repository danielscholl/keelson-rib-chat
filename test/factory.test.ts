import { describe, expect, test } from "bun:test";
import { ClickClackClient } from "../src/clickclack.ts";
import { Swarm } from "../src/swarm.ts";
import { makeChatTools } from "../src/tools.ts";
import type { FactoryBudget, SwarmSummary } from "../src/types.ts";
import { FakeClickClack, OWNER_TOKEN, type Script, scriptedProvider, WORKSPACE } from "./fakes.ts";

function harness(script: Script, factory: FactoryBudget, leadTools: string[] = []) {
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
  const start = async () => {
    const swarm = await Swarm.start({
      id: "s1",
      task: "Drain the backlog",
      owner,
      workspaceId: WORKSPACE,
      runAgentTurn: provider.run,
      limits: { maxTurns: 1_000, maxTurnsPerAgent: 200, maxNudges: 2 },
      factory,
      ...(leadTools.length ? { leadTools } : {}),
      quiesceMs: 10,
      reconnectMs: 5,
    });
    swarms.set(swarm.id, swarm);
    return swarm;
  };
  return { server, start, provider };
}

// A lead that keeps a worker busy forever without landing anything.
const busywork =
  (onLead: Script = async () => {}): Script =>
  async (t) => {
    if (t.agentId === "s1-lead") {
      if (t.turn === 1) {
        await t.call("chat_spawn", { handle: "w", role: "worker", brief: "Keep going." });
      } else {
        await onLead(t);
        await t.call("chat_post", { body: "@s1-w keep going" });
      }
    } else {
      await t.call("chat_post", { body: "@s1-lead still going" });
    }
  };

describe("factory mode", () => {
  test("warns the lead when work stops landing, and ends stalled if it never wraps up", async () => {
    const prompts: string[] = [];
    const { start } = harness(
      busywork(async ({ prompt }) => {
        prompts.push(prompt);
      }),
      { progressTurns: 6, maxTokens: 10_000_000 },
    );
    const summary = await (await start()).finished;
    expect(summary.status).toBe("stalled");
    expect(summary.error).toBe("no progress in 9 turns");
    expect(summary.turnsUsed).toBe(9);
    expect(prompts.some((p) => p.includes("Factory mode: no work has landed in 6 turns"))).toBe(
      true,
    );
    expect(prompts.at(-1)).toContain("Budget: factory mode,");
    expect(summary.factory).toMatchObject({ progressTurns: 6, sinceProgress: 9 });
  });

  test("the lead can conclude on the wrap-up note", async () => {
    const { start } = harness(
      busywork(async ({ prompt, call }) => {
        if (prompt.includes("Factory mode: no work has landed")) {
          await call("chat_done", { summary: "Landed nothing more; stopping." });
        }
      }),
      { progressTurns: 4, maxTokens: 10_000_000 },
    );
    const summary = await (await start()).finished;
    expect(summary.status).toBe("done");
    expect(summary.conclusion).toBe("Landed nothing more; stopping.");
  });

  test("a closed bead resets the window", async () => {
    let closes = 0;
    const { start } = harness(
      busywork(async ({ turn, call }) => {
        if (turn % 3 === 0 && closes < 4) {
          closes++;
          await call("beads_close", { id: `b${closes}` });
        }
      }),
      { progressTurns: 6, maxTokens: 10_000_000 },
      ["beads_close"],
    );
    const summary = await (await start()).finished;
    expect(summary.status).toBe("stalled");
    expect(summary.turnsUsed).toBeGreaterThan(12);
    expect(summary.factory?.lastProgress?.what).toBe("the lead closed a bead");
  });

  test("planning the tracker counts until work lands", async () => {
    const { start } = harness(
      busywork(async ({ turn, call }) => {
        if (turn <= 12 && turn % 3 === 0) await call("beads_create", { title: `bead ${turn}` });
      }),
      { progressTurns: 6, maxTokens: 10_000_000 },
      ["beads_create"],
    );
    const summary = await (await start()).finished;
    expect(summary.status).toBe("stalled");
    expect(summary.turnsUsed).toBeGreaterThan(12);
    expect(summary.factory?.lastProgress?.what).toBe("the lead planned the backlog");
  });

  test("once work has landed, planning alone no longer resets the window", async () => {
    let closed = false;
    const { start } = harness(
      busywork(async ({ turn, call }) => {
        if (!closed) {
          closed = true;
          await call("beads_close", { id: "b1" });
        } else if (turn % 2 === 0) {
          await call("beads_update", { id: "b2", status: "in_progress" });
        }
      }),
      { progressTurns: 6, maxTokens: 10_000_000 },
      ["beads_close", "beads_update"],
    );
    const summary = await (await start()).finished;
    expect(summary.status).toBe("stalled");
    expect(summary.factory?.lastProgress?.what).toBe("the lead closed a bead");
  });

  test("the token ceiling ends it as exhausted", async () => {
    const { start } = harness(busywork(), { progressTurns: 100, maxTokens: 6_000 });
    const summary = await (await start()).finished;
    expect(summary.status).toBe("exhausted");
    expect(summary.error).toBe("token ceiling of 6000 fresh tokens reached");
    // Each scripted turn spends 1,500 fresh tokens; a turn already in flight may finish.
    expect(summary.turnsUsed).toBeGreaterThanOrEqual(4);
    expect(summary.turnsUsed).toBeLessThanOrEqual(5);
  });

  test("the charter explains the progress budget instead of a turn budget", async () => {
    const { start, provider } = harness(
      async ({ agentId, call }) => {
        if (agentId === "s1-lead") await call("chat_done", { summary: "ok" });
      },
      { progressTurns: 15, maxTokens: 2_000_000 },
    );
    await (await start()).finished;
    const system = provider.requests[0]?.system ?? "";
    expect(system).toContain("factory mode: no turn budget, only progress");
    expect(system).not.toContain("shared budget of");
  });
});
