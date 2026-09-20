import { describe, expect, test } from "bun:test";
import { ClickClackClient } from "../src/clickclack.ts";
import { Swarm } from "../src/swarm.ts";
import { makeChatTools } from "../src/tools.ts";
import type { SwarmSummary } from "../src/types.ts";
import { FakeClickClack, OWNER_TOKEN, type Script, scriptedProvider, WORKSPACE } from "./fakes.ts";

function harness(script: Script, limits = {}) {
  const server = new FakeClickClack();
  const swarms = new Map<string, Swarm>();
  const tools = makeChatTools({
    swarms,
    ended: new Map<string, SwarmSummary>(),
    startSwarm: async () => {
      throw new Error("not used");
    },
  });
  const provider = scriptedProvider(tools, script);
  const logs: string[] = [];
  const start = async () => {
    const swarm = await Swarm.start({
      id: "s1",
      task: "Find why the build is slow",
      owner: new ClickClackClient("http://fake", OWNER_TOKEN, server.transport),
      workspaceId: WORKSPACE,
      runAgentTurn: provider.run,
      limits,
      quiesceMs: 20,
      reconnectMs: 5,
      log: (m) => logs.push(m),
    });
    swarms.set(swarm.id, swarm);
    return swarm;
  };
  return { server, provider, logs, start };
}

describe("Swarm", () => {
  test("lead spawns a worker, the worker reports in-thread, the lead concludes", async () => {
    const { server, provider, start } = harness(async ({ agentId, turn, prompt, call }) => {
      if (agentId === "s1-lead" && turn === 1) {
        expect(prompt).toContain("Find why the build is slow");
        const spawned = await call("chat_spawn", {
          handle: "Scout",
          role: "reads the build logs",
          brief: "Find the slowest step and report it.",
        });
        expect(spawned.isError).toBe(false);
      } else if (agentId === "s1-scout") {
        const briefId = prompt.match(/top-level (msg_\d+)/)?.[1];
        await call("chat_reply", { message_id: briefId, body: "The link step takes 9 minutes." });
      } else if (agentId === "s1-lead" && turn === 2) {
        expect(prompt).toContain("The link step takes 9 minutes.");
        await call("chat_done", { summary: "Linking is the bottleneck." });
      }
    });
    const swarm = await start();
    const summary = await swarm.finished;

    expect(summary.status).toBe("done");
    expect(summary.conclusion).toBe("Linking is the bottleneck.");
    expect(summary.turnsUsed).toBe(3);
    expect(summary.agents.map((a) => a.handle)).toEqual(["s1-lead", "s1-scout"]);
    // Authorship comes from each bot's own token, not from anything it claimed.
    expect(server.bodiesBy("s1-scout")).toEqual(["The link step takes 9 minutes."]);
    expect(server.bodiesBy("s1-lead").at(-1)).toContain("Linking is the bottleneck.");
    // Every agent credential is revoked once the swarm ends.
    const botTokens = [...server.tokens.entries()].filter(([t]) => t.startsWith("ccb_"));
    expect(botTokens.length).toBe(2);
    expect(botTokens.every(([, t]) => t.revoked)).toBe(true);
    // Agents resume one continuous session across turns.
    const leadTurns = provider.requests.filter((r) => r.turnContext?.agentId === "s1-lead");
    expect(leadTurns[0]?.resumeSessionId).toBeUndefined();
    expect(leadTurns[1]?.resumeSessionId).toBe("sess_s1-lead");
  });

  test("works with no socket echo at all: local ingestion is enough", async () => {
    const h = harness(async ({ agentId, turn, call }) => {
      if (agentId === "s1-lead" && turn === 1) {
        await call("chat_spawn", { handle: "w", role: "worker", brief: "report back" });
      } else if (agentId === "s1-w") {
        await call("chat_post", { body: "@s1-lead done" });
      } else {
        await call("chat_done", { summary: "ok" });
      }
    });
    h.server.echo = false;
    const summary = await (await h.start()).finished;
    expect(summary.status).toBe("done");
    expect(summary.turnsUsed).toBe(3);
  });

  test("the socket echo of a locally ingested message never double-wakes", async () => {
    let scoutTurns = 0;
    const { start } = harness(async ({ agentId, turn, call }) => {
      if (agentId === "s1-lead" && turn === 1) {
        await call("chat_spawn", { handle: "scout", role: "r", brief: "b" });
      } else if (agentId === "s1-scout") {
        scoutTurns++;
      } else {
        await call("chat_done", { summary: "ok" });
      }
    });
    const summary = await (await start()).finished;
    expect(scoutTurns).toBe(1);
    expect(summary.status).toBe("done");
  });

  test("the spawn cap is enforced and reported to the agent", async () => {
    const results: boolean[] = [];
    const { start } = harness(
      async ({ agentId, turn, call }) => {
        if (agentId !== "s1-lead") return;
        if (turn === 1) {
          for (const handle of ["a", "b", "c"]) {
            results.push((await call("chat_spawn", { handle, role: "r", brief: "b" })).isError);
          }
        } else {
          await call("chat_done", { summary: "ok" });
        }
      },
      { maxAgents: 3 },
    );
    const summary = await (await start()).finished;
    expect(results).toEqual([false, false, true]);
    expect(summary.agents.length).toBe(3);
  });

  test("an idle swarm nudges its lead, then ends as stalled", async () => {
    const { start, logs } = harness(async () => {}, { maxNudges: 2 });
    const summary = await (await start()).finished;
    expect(summary.status).toBe("stalled");
    expect(summary.turnsUsed).toBe(3);
    expect(logs.filter((l) => l.includes("nudging")).length).toBe(2);
  });

  test("the turn budget ends a swarm that would otherwise ping-pong", async () => {
    const { start } = harness(
      async ({ agentId, turn, call }) => {
        if (agentId === "s1-lead" && turn === 1) {
          await call("chat_spawn", { handle: "echo", role: "r", brief: "b" });
        } else {
          const other = agentId === "s1-lead" ? "s1-echo" : "s1-lead";
          await call("chat_post", { body: `@${other} your turn` });
        }
      },
      { maxTurns: 6, maxTurnsPerAgent: 50 },
    );
    const summary = await (await start()).finished;
    expect(summary.status).toBe("exhausted");
    expect(summary.turnsUsed).toBe(6);
  });

  test("a per-agent cap silences one agent without ending the swarm", async () => {
    const { start, server } = harness(
      async ({ agentId, turn, call }) => {
        if (agentId === "s1-lead" && turn === 1) {
          await call("chat_spawn", { handle: "echo", role: "r", brief: "b" });
        } else if (agentId === "s1-echo") {
          await call("chat_post", { body: "@s1-echo-2 hello" });
          await call("chat_post", { body: "@s1-lead ping" });
        } else if (turn >= 4) {
          await call("chat_done", { summary: "enough" });
        } else {
          await call("chat_post", { body: "@s1-echo again" });
        }
      },
      { maxTurnsPerAgent: 2, maxTurns: 30 },
    );
    const summary = await (await start()).finished;
    expect(summary.agents.find((a) => a.handle === "s1-echo")?.status).toBe("capped");
    expect(server.messages.some((m) => m.body.includes("used all 2 of its turns"))).toBe(true);
  });

  test("a human post mid-run reaches the lead, and steer does the same", async () => {
    const seen: string[] = [];
    let swarmRef: Swarm | undefined;
    const { start, server } = harness(async ({ agentId, turn, prompt, call }) => {
      if (agentId !== "s1-lead") return;
      seen.push(prompt);
      if (turn === 1) {
        server.postAsOwner(server.channels[0]?.id ?? "", "Also check the cache.");
      } else if (turn === 2) {
        await swarmRef?.steer("Wrap it up.");
      } else {
        await call("chat_done", { summary: "done" });
      }
    });
    swarmRef = await start();
    const summary = await swarmRef.finished;
    expect(summary.status).toBe("done");
    expect(seen[1]).toContain("Also check the cache.");
    expect(seen[1]).toContain("[human]");
    expect(seen[2]).toContain("**Operator:** Wrap it up.");
  });

  test("a dropped socket reconnects from the durable cursor", async () => {
    const { start, server } = harness(async ({ agentId, turn, call }) => {
      if (agentId !== "s1-lead") return;
      if (turn === 1) {
        for (const socket of [...server.sockets]) socket.drop(1006);
        await new Promise((r) => setTimeout(r, 15));
        expect(server.sockets.size).toBe(1);
        expect([...server.sockets][0]?.url).toContain("after_cursor=");
        server.postAsOwner(server.channels[0]?.id ?? "", "after reconnect");
      } else {
        await call("chat_done", { summary: "ok" });
      }
    });
    const summary = await (await start()).finished;
    expect(summary.status).toBe("done");
  });

  test("stop aborts the swarm and later tool calls are refused", async () => {
    let late: { content: string; isError: boolean } | undefined;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { start } = harness(async ({ call }) => {
      await gate;
      late = await call("chat_post", { body: "too late" });
    });
    const swarm = await start();
    await new Promise((r) => setTimeout(r, 10));
    const summary = await swarm.stop();
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(summary.status).toBe("stopped");
    expect(late?.isError).toBe(true);
  });

  test("only the lead may conclude", async () => {
    let refused: boolean | undefined;
    const { start } = harness(async ({ agentId, turn, call }) => {
      if (agentId === "s1-lead" && turn === 1) {
        await call("chat_spawn", { handle: "w", role: "r", brief: "b" });
      } else if (agentId === "s1-w") {
        refused = (await call("chat_done", { summary: "mine" })).isError;
        await call("chat_post", { body: "@s1-lead over to you" });
      } else {
        await call("chat_done", { summary: "lead's" });
      }
    });
    const summary = await (await start()).finished;
    expect(refused).toBe(true);
    expect(summary.conclusion).toBe("lead's");
  });
});

describe("chat tools outside a swarm", () => {
  test("agent tools refuse a caller with no swarm turn context", async () => {
    const tools = makeChatTools({
      swarms: new Map(),
      ended: new Map(),
      startSwarm: async () => {
        throw new Error("unused");
      },
    });
    let out = { content: "", isError: false };
    await tools
      .find((t) => t.name === "chat_post")
      ?.execute(
        { body: "hi" },
        {
          cwd: "/tmp",
          abortSignal: new AbortController().signal,
          emit: (c) => {
            if (c.type === "tool_result")
              out = { content: String(c.content), isError: !!c.isError };
          },
        },
      );
    expect(out.isError).toBe(true);
    expect(out.content).toContain("only works inside a swarm");
  });
});
