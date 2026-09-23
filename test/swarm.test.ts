import { describe, expect, test } from "bun:test";
import { ClickClackClient } from "../src/clickclack.ts";
import { needsYou } from "../src/needs.ts";
import { handleSwarmsAction } from "../src/surface/actions.ts";
import { buildSwarmBoard } from "../src/surface/swarm-board.ts";
import {
  keepActivity,
  MAX_TURN_FAILURES,
  paceOf,
  Swarm,
  type SwarmChange,
  type SwarmOptions,
  SwarmStartError,
  splitBody,
} from "../src/swarm.ts";
import { makeChatTools } from "../src/tools.ts";
import { BODY_MAX, CONCLUSION_MAX, SIZE_PRESETS, type SwarmSummary } from "../src/types.ts";
import {
  FakeClickClack,
  fakeDispatcher,
  OWNER_TOKEN,
  type Script,
  scriptedProvider,
  WORKSPACE,
} from "./fakes.ts";

const never = new Promise<void>(() => {});

function harness(script: Script, limits = {}, extra: Partial<SwarmOptions> = {}) {
  const server = new FakeClickClack();
  const swarms = new Map<string, Swarm>();
  const owner = new ClickClackClient("http://fake", OWNER_TOKEN, server.transport);
  const tools = makeChatTools({
    swarms,
    ended: new Map<string, SwarmSummary>(),
    startSwarm: async () => {
      throw new Error("not used");
    },
    readChannel: (channelId, threadId) =>
      threadId ? owner.getThread(threadId) : owner.channelTranscript(channelId),
  });
  const provider = scriptedProvider(tools, script);
  const logs: string[] = [];
  const start = async () => {
    const swarm = await Swarm.start({
      id: "s1",
      task: "Find why the build is slow",
      owner,
      workspaceId: WORKSPACE,
      runAgentTurn: provider.run,
      limits,
      quiesceMs: 20,
      reconnectMs: 5,
      log: (m) => logs.push(m),
      ...extra,
    });
    swarms.set(swarm.id, swarm);
    return swarm;
  };
  return { server, provider, logs, start, tools };
}

async function callTool(
  tools: ReturnType<typeof makeChatTools>,
  name: string,
  input: unknown,
): Promise<{ content: string; isError: boolean }> {
  let out = { content: "", isError: false };
  await tools
    .find((t) => t.name === name)
    ?.execute(input, {
      cwd: "/tmp",
      abortSignal: new AbortController().signal,
      emit: (c) => {
        if (c.type === "tool_result") out = { content: String(c.content), isError: !!c.isError };
      },
    });
  return out;
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

  test("token usage sums per agent and per swarm, failed turns included", async () => {
    const { start } = harness(async ({ agentId, turn, call }) => {
      if (agentId !== "s1-lead") return;
      if (turn === 1) throw new Error("provider hiccup");
      await call("chat_done", { summary: "ok" });
    });
    const summary = await (await start()).finished;
    const two = { input: 2_400, output: 600, cached: 1_600 };
    expect(summary.agents[0]?.usage).toEqual(two);
    expect(summary.usage).toEqual(two);
    const board = JSON.stringify(buildSwarmBoard(summary));
    expect(board).toContain("2k in · 600 out · 2k cached tokens");
    expect(board).toContain("2 turns · 3k tokens");
    expect(board).toContain('"value":"3k","sub":"fresh · 2k cached"');
  });

  test("a rerun names the swarm it repeats", async () => {
    const { start } = harness(
      async ({ call }) => {
        await call("chat_done", { summary: "ok" });
      },
      {},
      { rerunOf: "s0old" },
    );
    expect((await (await start()).finished).rerunOf).toBe("s0old");
  });

  test("an idle swarm nudges its lead, then ends as stalled", async () => {
    const { start, logs } = harness(async () => {}, { maxNudges: 2 });
    const summary = await (await start()).finished;
    expect(summary.status).toBe("stalled");
    expect(summary.turnsUsed).toBe(3);
    expect(logs.filter((l) => l.includes("nudging")).length).toBe(2);
    expect(summary.spans?.map((t) => t.wokeBy)).toEqual([["rib"], ["nudge"], ["nudge"]]);
    const turns = summary.activity?.filter((e) => e.kind === "turn") ?? [];
    expect(turns.at(-1)?.text).toMatch(/^@s1-lead turn 3 ok · \d+ s · nudged$/);
    // Over a run shorter than a minute the spark has one bucket, so none is kept.
    expect(summary.pace).toBeUndefined();
  });

  test("each turn leaves a span naming who woke it, and one activity entry", async () => {
    const { start, logs, tools } = harness(async ({ agentId, turn, prompt, call }) => {
      if (agentId === "s1-lead" && turn === 1) {
        await call("chat_spawn", { handle: "scout", role: "reads logs", brief: "Report back." });
      } else if (agentId === "s1-scout") {
        const briefId = prompt.match(/top-level (msg_\d+)/)?.[1];
        await call("chat_reply", { message_id: briefId, body: "Linking is slow." });
      } else {
        await call("chat_done", { summary: "Linking." });
      }
    });
    const summary = await (await start()).finished;
    expect(summary.spans?.map((t) => [t.agentId, t.n, t.outcome, t.messages, t.wokeBy])).toEqual([
      ["s1-lead", 1, "ok", 1, ["rib"]],
      ["s1-scout", 1, "ok", 1, ["s1-lead"]],
      ["s1-lead", 2, "ok", 1, ["s1-scout"]],
    ]);
    for (const t of summary.spans ?? []) {
      expect(Date.parse(t.endedAt ?? "")).toBeGreaterThanOrEqual(Date.parse(t.startedAt));
    }
    const turns = summary.activity?.filter((e) => e.kind === "turn") ?? [];
    expect(turns.map((e) => e.text.split(" · ")[0])).toEqual([
      "@s1-lead turn 1 ok",
      "@s1-scout turn 1 ok",
      "@s1-lead turn 2 ok",
    ]);
    expect(turns[1]).toMatchObject({ actor: "s1-scout", subject: "turn:1" });
    expect(turns[1]?.text.endsWith(" · 1 new")).toBe(true);
    expect(summary.activity?.find((e) => e.kind === "spawn")).toMatchObject({
      actor: "s1-lead",
      subject: "s1-scout",
    });
    expect(summary.activity?.find((e) => e.kind === "conclusion")?.actor).toBe("s1-lead");
    expect(summary.activity?.[0]?.kind).toBe("start");
    expect(summary.activity?.at(-1)?.kind).toBe("end");
    // The op's progress keeps both ends of every turn; the tab keeps one line.
    expect(logs).toContain("@s1-lead turn 1 (1 new)");
    expect(logs).toContain("@s1-lead turn 1 ok");
    expect(summary.activity?.some((e) => e.text.endsWith("(1 new)"))).toBe(false);
    expect(summary.agents.every((a) => Number.isFinite(Date.parse(a.joinedAt ?? "")))).toBe(true);
    // The spans are for drawing; the status tools leave them out.
    for (const tool of ["chat_swarm_status", "chat_swarm_wait"]) {
      const out = await callTool(tools, tool, { swarm: "s1" });
      expect(out.content).toContain('"activity"');
      expect(out.content).not.toContain('"spans"');
    }
  });

  test("a failed turn's span says so, and an operator post wakes the lead", async () => {
    let swarmRef: Swarm | undefined;
    const { start } = harness(async ({ agentId, turn, call }) => {
      if (agentId !== "s1-lead") return;
      if (turn === 1) throw new Error("provider hiccup");
      if (turn === 2) await swarmRef?.steer("Wrap it up.");
      else await call("chat_done", { summary: "ok" });
    });
    swarmRef = await start();
    const summary = await swarmRef.finished;
    expect(summary.spans?.map((t) => [t.outcome, t.wokeBy])).toEqual([
      ["error", ["rib"]],
      ["ok", ["rib"]],
      ["ok", ["operator"]],
    ]);
    expect(summary.activity?.find((e) => e.kind === "operator")).toMatchObject({
      actor: "operator",
      text: "you posted in #swarm-s1: Wrap it up.",
    });
  });

  test("a turn in flight when the swarm stops closes as aborted", async () => {
    const { start } = harness(async () => {
      await never;
    });
    const swarm = await start();
    await new Promise((r) => setTimeout(r, 10));
    const summary = await swarm.stop();
    expect(summary.spans).toHaveLength(1);
    expect(summary.spans?.[0]).toMatchObject({ outcome: "aborted", endedAt: expect.any(String) });
  });

  test("the activity trim drops turn entries before the events that mark the course", () => {
    const entries = [
      { at: "t", text: "start", kind: "start" as const },
      { at: "t", text: "t1", kind: "turn" as const },
      { at: "t", text: "spawn", kind: "spawn" as const },
      { at: "t", text: "t2", kind: "turn" as const },
      { at: "t", text: "ask", kind: "ask" as const },
    ];
    keepActivity(entries, 3);
    expect(entries.map((e) => e.text)).toEqual(["start", "spawn", "ask"]);
    const legacy = [
      { at: "t", text: "a" },
      { at: "t", text: "b" },
    ];
    keepActivity(legacy, 1);
    expect(legacy.map((e) => e.text)).toEqual(["b"]);
  });

  test("an ended swarm's pace spreads its whole run over at most thirty buckets", () => {
    const t0 = Date.parse("2026-09-22T14:00:00.000Z");
    const min = 60_000;
    const starts = [0, 1, 2, 59, 60, 90, 119].map((m) => t0 + m * min);
    const ended = paceOf(starts, t0, t0 + 120 * min, true);
    expect(ended).toHaveLength(30);
    expect(ended?.reduce((a, b) => a + b, 0)).toBe(7);
    expect(ended?.[0]).toBe(3);
    const live = paceOf(starts, t0, t0 + 120 * min, false);
    expect(live).toHaveLength(30);
    expect(live?.reduce((a, b) => a + b, 0)).toBe(2);
    expect(paceOf([t0], t0, t0 + 30_000, true)).toBeUndefined();
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

describe("Swarm resilience", () => {
  test("an oversized conclusion is refused with its length, then lands in parts", async () => {
    let refusal = "";
    const long = `${"a".repeat(BODY_MAX - 100)}\n\n${"b".repeat(BODY_MAX - 100)}`;
    const { start, server } = harness(async ({ agentId, call }) => {
      if (agentId !== "s1-lead") return;
      refusal = (await call("chat_done", { summary: "x".repeat(CONCLUSION_MAX + 5) })).content;
      await call("chat_done", { summary: long });
    });
    const summary = await (await start()).finished;
    expect(refusal).toContain(`${CONCLUSION_MAX + 5} characters`);
    expect(refusal).toContain("Cut at least 5 characters");
    expect(summary.status).toBe("done");
    expect(summary.conclusion).toBe(long);
    expect(summary.draftConclusion).toBeUndefined();
    const parts = server.bodiesBy("s1-lead").filter((b) => b.startsWith("**Conclusion"));
    expect(parts.map((b) => b.split("\n")[0])).toEqual([
      "**Conclusion (1/2)**",
      "**Conclusion (2/2)**",
    ]);
    expect(parts.every((b) => b.length <= BODY_MAX)).toBe(true);
  });

  test("a swarm that stalls on a refused conclusion says so and keeps the draft", async () => {
    const draft = "y".repeat(CONCLUSION_MAX + 1);
    const { start } = harness(async ({ agentId, call }) => {
      if (agentId === "s1-lead") await call("chat_done", { summary: draft });
    });
    const summary = await (await start()).finished;
    expect(summary.status).toBe("stalled");
    expect(summary.error).toContain("refused 3 time(s)");
    expect(summary.draftConclusion).toBe(draft);
  });

  test("a timed-out turn's messages are delivered again on the next turn", async () => {
    const leadPrompts: string[] = [];
    const { start } = harness(
      async ({ agentId, turn, prompt, call }) => {
        if (agentId === "s1-lead") {
          leadPrompts.push(prompt);
          if (turn === 1) {
            await call("chat_spawn", { handle: "w", role: "worker", brief: "report back" });
          } else if (turn === 2) {
            await never;
          } else {
            await call("chat_done", { summary: "got it" });
          }
        } else {
          const briefId = prompt.match(/top-level (msg_\d+)/)?.[1];
          await call("chat_reply", { message_id: briefId, body: "the finding" });
        }
      },
      { turnTimeoutMs: 40 },
    );
    const summary = await (await start()).finished;
    expect(summary.status).toBe("done");
    expect(leadPrompts[1]).toContain("the finding");
    expect(leadPrompts[2]).toContain("ended before it finished (timeout");
    expect(leadPrompts[2]).toContain("the finding");
  });

  test("a lead whose turns keep failing ends the swarm as error", async () => {
    const { start } = harness(async () => {
      throw new Error("provider down");
    });
    const summary = await (await start()).finished;
    expect(summary.status).toBe("error");
    expect(summary.turnsUsed).toBe(MAX_TURN_FAILURES);
    expect(summary.error).toContain("provider down");
  });

  test("a worker whose turns keep failing is retired and the swarm goes on", async () => {
    const { start, server } = harness(async ({ agentId, turn, call }) => {
      if (agentId === "s1-lead") {
        if (turn === 1) await call("chat_spawn", { handle: "w", role: "r", brief: "b" });
        else await call("chat_done", { summary: "without w" });
        return;
      }
      throw new Error("worker broke");
    });
    const summary = await (await start()).finished;
    expect(summary.status).toBe("done");
    expect(summary.agents.find((a) => a.handle === "s1-w")?.status).toBe("failed");
    expect(summary.agents.find((a) => a.handle === "s1-w")?.turns).toBe(MAX_TURN_FAILURES);
    expect(server.messages.some((m) => m.body.includes("will not respond further"))).toBe(true);
  });

  test("a conclusion survives a channel that cannot take the post", async () => {
    let reply = "";
    const { start, server } = harness(async ({ agentId, call }) => {
      if (agentId !== "s1-lead") return;
      server.down = true;
      reply = (await call("chat_done", { summary: "the answer" })).content;
    });
    const swarm = await start();
    const summary = await swarm.finished;
    expect(reply).toContain("posting it to the channel failed");
    expect(summary.status).toBe("done");
    expect(summary.conclusion).toBe("the answer");
    // The lead's token could not be revoked while the server was down.
    expect(swarm.unrevokedTokens()).toHaveLength(1);
  });

  test("a stall while ClickClack is unreachable says so", async () => {
    const { start, server } = harness(async ({ agentId, call }) => {
      if (agentId !== "s1-lead") return;
      server.down = true;
      await call("chat_post", { body: "trying" });
    });
    const summary = await (await start()).finished;
    expect(summary.status).toBe("stalled");
    expect(summary.error).toContain("agents could not reach ClickClack: fetch failed");
  });

  test("a stall names the lead's failed last turn", async () => {
    const { start } = harness(
      async ({ agentId, turn }) => {
        if (agentId === "s1-lead" && turn > 1) await never;
      },
      { turnTimeoutMs: 30 },
    );
    const summary = await (await start()).finished;
    expect(summary.status).toBe("stalled");
    expect(summary.error).toContain("the lead's last turn failed: timeout");
  });

  test("a report in a shared thread wakes the lead, and peers see it as background", async () => {
    const prompts = new Map<string, string[]>();
    const { start, provider } = harness(
      async ({ agentId, turn, prompt, call }) => {
        prompts.set(agentId, [...(prompts.get(agentId) ?? []), prompt]);
        if (agentId === "s1-lead") {
          if (turn === 1) {
            await call("chat_spawn", { handle: "a", role: "r", brief: "wait for the plan" });
            await call("chat_spawn", { handle: "b", role: "r", brief: "wait for the plan" });
            await call("chat_post", { body: "@s1-a @s1-b report in this thread" });
          } else if (prompt.includes("b found")) {
            await call("chat_done", { summary: "both reported" });
          }
          return;
        }
        const root = [...prompt.matchAll(/top-level (msg_\d+)/g)].at(-1)?.[1];
        await call("chat_reply", { message_id: root, body: `${agentId.slice(3)} found it` });
      },
      { maxConcurrent: 1 },
      { model: "big", workerModel: "small" },
    );
    const summary = await (await start()).finished;
    expect(summary.status).toBe("done");
    // Neither worker's report cost the other a turn.
    expect(prompts.get("s1-a")?.length).toBe(1);
    expect(prompts.get("s1-b")?.length).toBe(1);
    expect(prompts.get("s1-b")?.[0]).toContain("Background");
    expect(prompts.get("s1-b")?.[0]).toContain("a found it");
    expect(prompts.get("s1-lead")?.[1]).toMatch(/Workers: @s1-a (idle|working) \(1 turns\)/);
    // The lead runs the swarm's model; workers run the worker model.
    const models = new Map(provider.requests.map((r) => [r.turnContext?.agentId, r.model]));
    expect(models.get("s1-lead")).toBe("big");
    expect(models.get("s1-a")).toBe("small");
  });

  test("the operator reads the whole transcript in order, thread replies included", async () => {
    const { start, tools } = harness(async ({ agentId, turn, prompt, call }) => {
      if (agentId === "s1-lead" && turn === 1) {
        await call("chat_spawn", { handle: "w", role: "r", brief: "report" });
      } else if (agentId === "s1-w") {
        const briefId = prompt.match(/top-level (msg_\d+)/)?.[1];
        await call("chat_reply", { message_id: briefId, body: "threaded finding" });
      } else {
        await call("chat_done", { summary: "ok" });
      }
    });
    const summary = await (await start()).finished;
    const out = await callTool(tools, "chat_swarm_transcript", { swarm: summary.id });
    expect(out.isError).toBe(false);
    expect(out.content).toContain("#swarm-s1");
    const order = [
      "Find why the build is slow",
      "joining as",
      "threaded finding",
      "**Conclusion**",
    ];
    const at = order.map((text) => out.content.indexOf(text));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
    const missing = await callTool(tools, "chat_swarm_transcript", { swarm: "nope" });
    expect(missing.isError).toBe(true);
  });
});

const later = (ms: number, fn: () => void) => setTimeout(fn, ms);

describe("Workflow dispatch", () => {
  test("the lead starts a run, waits it out through an approval, and concludes verified", async () => {
    const fake = fakeDispatcher();
    let swarmRef: Swarm | undefined;
    const prompts: string[] = [];
    let refused = "";
    const { start, logs, provider } = harness(
      async ({ agentId, turn, prompt, call }) => {
        if (agentId !== "s1-lead") return;
        prompts.push(prompt);
        if (turn === 1) {
          const out = await call("chat_workflow_start", {
            workflow: "fix-issue",
            purpose: "fix issue 1",
            inputs: { issue: "1" },
          });
          expect(out.content).toContain("started fix-issue run run_1");
          later(40, () => {
            fake.set("run_1", {
              status: "paused",
              pendingApproval: { nodeId: "approve-plan", prompt: "Approve the plan?" },
            });
            swarmRef?.onRunEvent("run_1");
          });
        } else if (turn === 2) {
          refused = (await call("chat_done", { summary: "too early" })).content;
          // Resuming after the approval is posted but does not wake the lead.
          later(20, () => {
            fake.set("run_1", { status: "running", pendingApproval: undefined });
            swarmRef?.onRunEvent("run_1");
          });
          later(60, () => {
            fake.set("run_1", {
              status: "succeeded",
              completedAt: new Date().toISOString(),
              pendingApproval: undefined,
              nodes: [
                {
                  nodeId: "open-pr",
                  status: "succeeded",
                  output: "opened https://github.com/o/r/pull/7",
                },
                { nodeId: "ci-green-gate", status: "succeeded", output: "CI_GATE: PASS" },
              ],
            });
            swarmRef?.onRunEvent("run_1");
          });
        } else {
          await call("chat_done", { summary: "issue 1 fixed in PR 7" });
        }
      },
      {},
      {
        dispatch: { grants: [{ name: "fix-issue", isolated: true }], dispatcher: fake.dispatcher },
      },
    );
    swarmRef = await start();
    const summary = await swarmRef.finished;
    expect(fake.started).toEqual([{ name: "fix-issue", inputs: { issue: "1" } }]);
    expect(prompts[1]).toContain("paused for approval at node approve-plan");
    expect(prompts[1]).toContain("Only the operator can answer it");
    expect(refused).toContain("still live");
    expect(prompts).toHaveLength(3);
    expect(prompts[2]).toContain("is succeeded");
    expect(prompts[2]).toContain("verified");
    expect(summary.status).toBe("done");
    expect(summary.runs?.[0]).toMatchObject({
      runId: "run_1",
      status: "succeeded",
      verified: true,
      prUrls: ["https://github.com/o/r/pull/7"],
      ci: { verdict: "pass" },
    });
    // The host moved the run past its gate, so the operator answered it.
    expect(summary.runs?.[0]?.gates).toEqual([
      {
        nodeId: "approve-plan",
        openedAt: expect.any(String),
        closedAt: expect.any(String),
        by: "operator",
      },
    ]);
    expect(summary.spans?.map((t) => t.wokeBy)).toEqual([["rib"], ["runs"], ["runs"]]);
    expect(summary.activity?.filter((e) => e.kind === "gate")).toHaveLength(1);
    // Waiting on a live run is not idleness: the lead was never nudged.
    expect(logs.some((l) => l.includes("nudging"))).toBe(false);
    const leadTools = provider.requests[0]?.tools?.map((t) => t.name) ?? [];
    expect(leadTools).toContain("chat_workflow_start");
    // This host cannot answer a gate, so the lead is not offered the tool.
    expect(leadTools).not.toContain("chat_workflow_respond");
    const charter = provider.requests[0]?.system ?? "";
    expect(charter).toContain("start the dependent run only after they say it is merged");
    expect(charter).toContain("reported passing CI");
    expect(charter).toContain("You cannot answer it");
  });

  test("only the lead holds the other ribs' tools it was given, and its charter names them", async () => {
    const { start, provider } = harness(
      async ({ agentId, turn, call }) => {
        if (agentId !== "s1-lead") return;
        if (turn === 1) {
          await call("chat_spawn", { handle: "helper", role: "Helps", brief: "Say hi." });
          return;
        }
        await call("chat_done", { summary: "ok" });
      },
      {},
      { leadTools: ["beads_ready", "beads_close"] },
    );
    const summary = await (await start()).finished;
    const toolsOf = (id: string) =>
      provider.requests.find((r) => r.turnContext?.agentId === id)?.tools?.map((t) => t.name) ?? [];
    expect(toolsOf("s1-lead")).toEqual(expect.arrayContaining(["beads_ready", "beads_close"]));
    expect(toolsOf("s1-helper")).toContain("chat_reply");
    expect(toolsOf("s1-helper")).not.toContain("beads_ready");
    const charter =
      provider.requests.find((r) => r.turnContext?.agentId === "s1-lead")?.system ?? "";
    expect(charter).toContain("beads_ready, beads_close come from other Keelson ribs");
    expect(summary.leadTools).toEqual(["beads_ready", "beads_close"]);
  });

  test("a worker reviews the gate's plan and the lead answers it for the operator", async () => {
    const fake = fakeDispatcher({ answers: true });
    let swarmRef: Swarm | undefined;
    let gateThread = "";
    let selfReview = "";
    let keptFiles: unknown;
    let planSeen = "";
    const { start, provider, tools } = harness(
      async ({ agentId, turn, prompt, call }) => {
        if (agentId === "s1-reviewer") {
          planSeen = (await call("chat_read", { thread_id: gateThread })).content;
          const brief = prompt.match(/top-level (msg_\d+)/)?.[1];
          await call("chat_reply", { message_id: brief, body: "approve: it covers the criterion" });
          return;
        }
        if (agentId !== "s1-lead") return;
        if (turn === 1) {
          await call("chat_workflow_start", { workflow: "fix-issue", purpose: "fix issue 1" });
          later(40, () => {
            fake.set("run_1", {
              status: "paused",
              pendingApproval: {
                nodeId: "approve-plan",
                prompt: "Approve this plan?\n\n$ARTIFACTS_DIR/plan.md",
                pauseId: "pause-1",
                artifacts: [{ path: "plan.md", text: "# Plan\n1. Fix the README count." }],
              },
            });
            swarmRef?.onRunEvent("run_1");
          });
        } else if (turn === 2) {
          gateThread = prompt.match(/in thread (msg_\d+)/)?.[1] ?? "";
          keptFiles = swarmRef?.summary().runs?.[0]?.pendingApproval?.files;
          selfReview = (
            await call("chat_workflow_respond", {
              run_id: "run_1",
              decision: "approve",
              review: gateThread,
              reason: "looks right",
            })
          ).content;
          await call("chat_spawn", {
            handle: "reviewer",
            role: "plan reviewer",
            brief: `Review the plan in thread ${gateThread} against issue 1.`,
          });
        } else if (turn === 3) {
          const review = [...prompt.matchAll(/@s1-reviewer \((msg_\d+)/g)].at(-1)?.[1];
          await call("chat_workflow_respond", {
            run_id: "run_1",
            decision: "approve",
            review,
            reason: "Every criterion maps to a plan step.",
          });
          later(20, () => {
            fake.set("run_1", {
              status: "succeeded",
              completedAt: new Date().toISOString(),
              nodes: [
                { nodeId: "open-pr", status: "succeeded", output: "https://github.com/o/r/pull/8" },
                { nodeId: "ci-green-gate", status: "succeeded", output: "CI_GATE: PASS" },
              ],
            });
            swarmRef?.onRunEvent("run_1");
          });
        } else {
          await call("chat_done", { summary: "issue 1 fixed in PR 8" });
        }
      },
      {},
      {
        dispatch: { grants: [{ name: "fix-issue", isolated: true }], dispatcher: fake.dispatcher },
      },
    );
    swarmRef = await start();
    const summary = await swarmRef.finished;
    expect(summary.status).toBe("done");
    expect(selfReview).toContain("the lead cannot review its own run's gate");
    expect(keptFiles).toEqual([{ path: "plan.md", text: "# Plan\n1. Fix the README count." }]);
    expect(planSeen).toContain("Approve this plan?");
    expect(planSeen).toContain("# Plan");
    expect(planSeen).not.toContain("$ARTIFACTS_DIR");
    expect(fake.answered).toEqual([
      { runId: "run_1", nodeId: "approve-plan", text: "approve", pauseId: "pause-1" },
    ]);
    expect(summary.runs?.[0]).toMatchObject({ status: "succeeded", verified: true });
    expect(summary.runs?.[0]?.approvals).toEqual([
      expect.objectContaining({
        nodeId: "approve-plan",
        decision: "approve",
        reviewer: "@s1-reviewer",
        reason: "Every criterion maps to a plan step.",
      }),
    ]);
    const lead = provider.requests.find((r) => r.turnContext?.agentId === "s1-lead");
    expect(lead?.tools?.map((t) => t.name)).toContain("chat_workflow_respond");
    expect(lead?.system).toContain("your own review checks nothing");
    expect(summary.runs?.[0]?.gates?.map((g) => g.by)).toEqual(["swarm"]);
    expect(summary.activity?.find((e) => e.kind === "gate-answer")).toMatchObject({
      actor: "s1-lead",
      subject: "run_1",
    });
    const transcript = await callTool(tools, "chat_swarm_transcript", { swarm: summary.id });
    expect(transcript.content).toContain("**Approved** `approve-plan` on run `run_1`");
  });

  test("changes need feedback, and an ungranted workflow goes back to the operator", async () => {
    const fake = fakeDispatcher({
      refuseAnswers:
        "rib 'chat' is not granted approvals for workflow 'fix-issue' (config.json ribApprovalGrants)",
    });
    let swarmRef: Swarm | undefined;
    const outs: string[] = [];
    const { start } = harness(
      async ({ agentId, turn, prompt, call }) => {
        if (agentId !== "s1-lead") return;
        if (turn === 1) {
          await call("chat_workflow_start", { workflow: "fix-issue", purpose: "fix issue 1" });
          later(40, () => {
            fake.set("run_1", {
              status: "paused",
              pendingApproval: { nodeId: "approve-plan", prompt: "Approve the plan?" },
            });
            swarmRef?.onRunEvent("run_1");
          });
        } else if (turn === 2) {
          later(10, () => void swarmRef?.steer("approve the plan"));
        } else {
          const review = [...prompt.matchAll(/\[human\] \(top-level (msg_\d+)\)/g)].at(-1)?.[1];
          outs.push(
            (
              await call("chat_workflow_respond", {
                run_id: "run_1",
                decision: "changes",
                review,
                reason: "r",
              })
            ).content,
          );
          outs.push(
            (
              await call("chat_workflow_respond", {
                run_id: "run_1",
                decision: "approve",
                review,
                reason: "the operator approved",
              })
            ).content,
          );
          await call("chat_workflow_cancel", { run_id: "run_1" });
          await call("chat_done", { summary: "handed back to the operator" });
        }
      },
      {},
      {
        dispatch: { grants: [{ name: "fix-issue", isolated: true }], dispatcher: fake.dispatcher },
      },
    );
    swarmRef = await start();
    const summary = await swarmRef.finished;
    expect(outs[0]).toContain("needs feedback");
    expect(outs[1]).toContain("has not let this swarm answer this workflow's gates");
    expect(summary.runs?.[0]?.approvals).toBeUndefined();
  });

  test("a gate on a workflow the host refused tells the lead the operator answers it", async () => {
    const fake = fakeDispatcher({ answers: true });
    const refused = new Set(["fix-issue"]);
    let swarmRef: Swarm | undefined;
    let notice = "";
    const { start } = harness(
      async ({ agentId, turn, prompt, call }) => {
        if (agentId !== "s1-lead") return;
        if (turn === 1) {
          await call("chat_workflow_start", { workflow: "fix-issue", purpose: "fix issue 1" });
          later(40, () => {
            fake.set("run_1", {
              status: "paused",
              pendingApproval: { nodeId: "approve-plan", prompt: "Approve the plan?" },
            });
            swarmRef?.onRunEvent("run_1");
          });
        } else {
          notice = prompt;
          await call("chat_workflow_cancel", { run_id: "run_1" });
          await call("chat_done", { summary: "handed to the operator" });
        }
      },
      {},
      {
        approvalRefusals: {
          has: (w) => refused.has(w),
          set: (w, r) => void (r ? refused.add(w) : refused.delete(w)),
        },
        dispatch: { grants: [{ name: "fix-issue", isolated: true }], dispatcher: fake.dispatcher },
      },
    );
    swarmRef = await start();
    await swarmRef.finished;
    expect(notice).toContain("Only the operator can answer it");
    expect(notice).not.toContain("Have another agent review it");
  });

  test("an isolated run found in the live checkout is cancelled and reported", async () => {
    const fake = fakeDispatcher({ live: true });
    const prompts: string[] = [];
    let swarmRef: Swarm | undefined;
    const { start } = harness(
      async ({ agentId, turn, prompt, call }) => {
        if (agentId !== "s1-lead") return;
        prompts.push(prompt);
        if (turn === 1) {
          await call("chat_workflow_start", { workflow: "fix-issue", purpose: "fix issue 2" });
          // Still creating its worktree: the harness reports the live checkout.
          later(40, () => {
            expect(fake.cancelled).toEqual([]);
            fake.set("run_1", { nodes: [{ nodeId: "extract-issue", status: "succeeded" }] });
            swarmRef?.onRunEvent("run_1");
          });
        } else {
          await call("chat_done", { summary: "the run could not be isolated" });
        }
      },
      {},
      {
        dispatch: { grants: [{ name: "fix-issue", isolated: true }], dispatcher: fake.dispatcher },
      },
    );
    swarmRef = await start();
    const summary = await swarmRef.finished;
    expect(fake.cancelled).toEqual(["run_1"]);
    expect(prompts[1]).toContain("not an isolated worktree");
    expect(summary.runs?.[0]).toMatchObject({ status: "cancelled", verified: false });
  });

  test("a workflow outside the grant is refused, and workers never hold dispatch tools", async () => {
    const fake = fakeDispatcher();
    let refusal = "";
    const { start, provider } = harness(
      async ({ agentId, turn, call }) => {
        if (agentId === "s1-lead" && turn === 1) {
          refusal = (await call("chat_workflow_start", { workflow: "deploy", purpose: "x" }))
            .content;
          await call("chat_spawn", { handle: "w", role: "r", brief: "b" });
        } else if (agentId === "s1-lead") {
          await call("chat_done", { summary: "ok" });
        } else {
          await call("chat_post", { body: "@s1-lead done" });
        }
      },
      {},
      {
        dispatch: { grants: [{ name: "fix-issue", isolated: true }], dispatcher: fake.dispatcher },
      },
    );
    await (await start()).finished;
    expect(refusal).toContain("not one this swarm may start. It may start: fix-issue");
    expect(fake.started).toEqual([]);
    const worker = provider.requests.find((r) => r.turnContext?.agentId === "s1-w");
    expect(worker?.tools?.map((t) => t.name)).not.toContain("chat_workflow_start");
  });

  test("stopping the swarm cancels its live runs", async () => {
    const fake = fakeDispatcher();
    let swarmRef: Swarm | undefined;
    const { start } = harness(
      async ({ agentId, turn, call }) => {
        if (agentId === "s1-lead" && turn === 1) {
          await call("chat_workflow_start", { workflow: "fix-issue", purpose: "fix issue 3" });
          later(20, () => void swarmRef?.stop());
        }
      },
      {},
      {
        dispatch: { grants: [{ name: "fix-issue", isolated: true }], dispatcher: fake.dispatcher },
      },
    );
    swarmRef = await start();
    const summary = await swarmRef.finished;
    expect(summary.status).toBe("stopped");
    expect(fake.cancelled).toEqual(["run_1"]);
    expect(summary.runs?.[0]?.status).toBe("cancelled");
  });

  test("a swarm without workflows gives its lead no dispatch tools", async () => {
    const { start, provider } = harness(async ({ call }) => {
      await call("chat_done", { summary: "ok" });
    });
    await (await start()).finished;
    expect(provider.requests[0]?.tools?.map((t) => t.name)).not.toContain("chat_workflow_start");
  });
});

describe("splitBody", () => {
  test("keeps short text whole and cuts long text at paragraph breaks", () => {
    expect(splitBody("short", 100)).toEqual(["short"]);
    const text = `${"a".repeat(60)}\n\n${"b".repeat(60)}`;
    expect(splitBody(text, 100)).toEqual(["a".repeat(60), "b".repeat(60)]);
    expect(splitBody("c".repeat(250), 100).map((p) => p.length)).toEqual([100, 100, 50]);
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

describe("size and model", () => {
  const script: Script = async ({ agentId, turn, call }) => {
    if (agentId === "s1-lead" && turn === 1) {
      await call("chat_spawn", { handle: "w", role: "worker", brief: "report back" });
    } else if (agentId === "s1-w") {
      await call("chat_post", { body: "@s1-lead done" });
    } else {
      await call("chat_done", { summary: "ok" });
    }
  };

  test("a size sets the limits, and an override reads as custom", async () => {
    const small = await (await harness(script, {}, { size: "small" }).start()).finished;
    expect(small.limits).toEqual(SIZE_PRESETS.small);
    expect(small.size).toBe("small");
    expect(small.sizeBase).toBe("small");

    const custom = await (await harness(script, { maxTurns: 25 }, { size: "small" }).start())
      .finished;
    expect(custom.limits.maxTurns).toBe(25);
    expect(custom.limits.maxAgents).toBe(SIZE_PRESETS.small.maxAgents);
    expect(custom.size).toBe("custom");
    expect(custom.sizeBase).toBe("small");
  });

  test("no size is medium", async () => {
    const summary = await (await harness(script).start()).finished;
    expect(summary.size).toBe("medium");
    expect(summary.limits).toEqual(SIZE_PRESETS.medium);
  });

  test("the lead runs model, workers run worker_model, and each agent records both", async () => {
    const h = harness(
      script,
      {},
      { provider: "copilot", model: "gpt-6-astra", workerModel: "gpt-5.6-sol" },
    );
    const summary = await (await h.start()).finished;
    const modelOf = (id: string) =>
      h.provider.requests.filter((r) => r.turnContext?.agentId === id).map((r) => r.model);
    expect(new Set(modelOf("s1-lead"))).toEqual(new Set(["gpt-6-astra"]));
    expect(modelOf("s1-w")).toEqual(["gpt-5.6-sol"]);
    expect(summary).toMatchObject({
      provider: "copilot",
      model: "gpt-6-astra",
      workerModel: "gpt-5.6-sol",
    });
    expect(summary.agents.map((a) => [a.handle, a.model, a.providerId])).toEqual([
      ["s1-lead", "gpt-6-astra", "copilot"],
      ["s1-w", "gpt-5.6-sol", "copilot"],
    ]);
  });

  test("power rides every turn as a model class, and a named model wins over it", async () => {
    const h = harness(script, {}, { power: "deep", workerModel: "gpt-5.6-sol" });
    const summary = await (await h.start()).finished;
    const turnsOf = (id: string) =>
      h.provider.requests.filter((r) => r.turnContext?.agentId === id);
    expect(turnsOf("s1-lead").every((r) => r.modelClass === "deep" && !r.model)).toBe(true);
    expect(turnsOf("s1-w").map((r) => [r.model, r.modelClass])).toEqual([
      ["gpt-5.6-sol", undefined],
    ]);
    expect(summary.power).toBe("deep");
    expect(summary.agents.map((a) => [a.handle, a.servedModel])).toEqual([
      ["s1-lead", "deep-1"],
      ["s1-w", "gpt-5.6-sol"],
    ]);
  });

  test("with no model, agents record no model and the provider that served them", async () => {
    const summary = await (await harness(script).start()).finished;
    expect(summary.model).toBeUndefined();
    expect(summary.agents.every((a) => a.model === undefined && a.providerId === "fake")).toBe(
      true,
    );
  });
});

describe("changes and records", () => {
  const script: Script = async ({ agentId, turn, call }) => {
    if (agentId === "s1-lead" && turn === 1) {
      await call("chat_spawn", { handle: "w", role: "worker", brief: "report back" });
    } else if (agentId === "s1-w") {
      await call("chat_post", { body: "@s1-lead done" });
    } else {
      await call("chat_done", { summary: "ok" });
    }
  };

  test("a swarm reports each change, ending with its end", async () => {
    const kinds: SwarmChange[] = [];
    const h = harness(script, {}, { onChange: (k) => kinds.push(k) });
    await (await h.start()).finished;
    expect(kinds.slice(0, 2)).toEqual(["agent", "start"]);
    expect(kinds.filter((k) => k === "agent")).toHaveLength(2);
    expect(kinds.filter((k) => k === "turn")).toHaveLength(6);
    expect(kinds).toContain("conclusion");
    expect(kinds.at(-1)).toBe("end");
  });

  test("a throwing listener never breaks the swarm", async () => {
    const h = harness(
      script,
      {},
      {
        onChange: () => {
          throw new Error("listener");
        },
      },
    );
    expect((await (await h.start()).finished).status).toBe("done");
  });

  test("agents take identity tones in spawn order", async () => {
    const h = harness(
      async ({ agentId, turn, call }) => {
        if (agentId === "s1-lead" && turn === 1) {
          for (const handle of ["a", "b", "c", "d", "e", "f"]) {
            await call("chat_spawn", { handle, role: "r", brief: "b" });
          }
          await call("chat_done", { summary: "ok" });
        }
      },
      { maxAgents: 7 },
    );
    const summary = await (await h.start()).finished;
    expect(summary.agents.map((a) => a.tone)).toEqual([
      "brand",
      "id-blue",
      "id-amber",
      "id-teal",
      "id-rose",
      "id-olive",
      "neutral",
    ]);
  });

  test("a boot failure throws the ended summary with it", async () => {
    const h = harness(script, {}, { project: { id: "p1", name: "sample" }, opId: "op1" });
    h.server.down = true;
    const error = await h.start().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SwarmStartError);
    const summary = (error as SwarmStartError).summary;
    expect(summary).toMatchObject({
      id: "s1",
      status: "error",
      project: { id: "p1", name: "sample" },
      opId: "op1",
    });
    expect(summary.error).toContain("fetch failed");
  });
});

describe("health and needs", () => {
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
    expect(check()).toBe(true);
  };

  test("two socket closes with no open between count as ClickClack gone; an open clears it", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const h = harness(async ({ agentId, turn, call }) => {
      if (agentId === "s1-lead" && turn === 1) {
        await held;
        await call("chat_done", { summary: "ok" });
      }
    });
    const swarm = await h.start();
    const dropAll = () => {
      for (const socket of [...h.server.sockets]) socket.drop(1006);
    };
    dropAll();
    await until(() => h.server.sockets.size === 1);
    expect(needsYou(swarm.summary())).toEqual([]);
    dropAll();
    await until(() => h.server.sockets.size === 1);
    expect(swarm.summary().health?.socketDrops).toBe(2);
    expect(needsYou(swarm.summary()).map((n) => n.kind)).toEqual(["connection"]);
    for (const socket of h.server.sockets) socket.open();
    expect(swarm.summary().health).toBeUndefined();
    release();
    expect((await swarm.finished).status).toBe("done");
  });

  test("a refused answer is remembered, and the next gate on that workflow is the operator's", async () => {
    const fake = fakeDispatcher({
      refuseAnswers:
        "rib 'chat' is not granted approvals for workflow 'fix-issue' (config.json ribApprovalGrants)",
    });
    const refused = new Set<string>();
    const memory = {
      has: (w: string) => refused.has(w),
      set: (w: string, r: boolean) => void (r ? refused.add(w) : refused.delete(w)),
    };
    let swarmRef: Swarm | undefined;
    const answerers: (string | undefined)[] = [];
    const { start } = harness(
      async ({ agentId, turn, prompt, call }) => {
        if (agentId !== "s1-lead") return;
        if (turn === 1) {
          await call("chat_workflow_start", { workflow: "fix-issue", purpose: "fix issue 1" });
          later(40, () => {
            fake.set("run_1", {
              status: "paused",
              pendingApproval: { nodeId: "approve-plan", prompt: "Approve the plan?" },
            });
            swarmRef?.onRunEvent("run_1");
          });
        } else if (turn === 2) {
          answerers.push(swarmRef?.summary().runs?.[0]?.pendingApproval?.answerer);
          later(10, () => void swarmRef?.steer("approve the plan"));
        } else if (turn === 3) {
          const review = [...prompt.matchAll(/\[human\] \(top-level (msg_\d+)\)/g)].at(-1)?.[1];
          await call("chat_workflow_respond", {
            run_id: "run_1",
            decision: "approve",
            review,
            reason: "r",
          });
          answerers.push(swarmRef?.summary().runs?.[0]?.pendingApproval?.answerer);
          await call("chat_workflow_cancel", { run_id: "run_1" });
          await call("chat_done", { summary: "handed back" });
        }
      },
      {},
      {
        approvalRefusals: memory,
        dispatch: { grants: [{ name: "fix-issue", isolated: true }], dispatcher: fake.dispatcher },
      },
    );
    swarmRef = await start();
    await swarmRef.finished;
    expect(answerers[0]).toBe("swarm");
    expect(refused.has("fix-issue")).toBe(true);
    expect(answerers[1]).toBe("operator");
  });

  test("the operator's reply lands in the gate thread and wakes the lead there", async () => {
    const fake = fakeDispatcher();
    let swarmRef: Swarm | undefined;
    const prompts: string[] = [];
    const { start, server } = harness(
      async ({ agentId, turn, prompt, call }) => {
        if (agentId !== "sgate-lead") return;
        prompts.push(prompt);
        if (turn === 1) {
          await call("chat_workflow_start", { workflow: "fix-issue", purpose: "p" });
          later(40, () => {
            fake.set("run_1", {
              status: "paused",
              pendingApproval: { nodeId: "approve-plan", prompt: "Approve?" },
            });
            swarmRef?.onRunEvent("run_1");
          });
        } else if (prompt.includes("Keep the retry cap")) {
          await call("chat_workflow_cancel", { run_id: "run_1" });
          await call("chat_done", { summary: "ok" });
        }
      },
      {},
      {
        id: "sgate",
        dispatch: { grants: [{ name: "fix-issue", isolated: true }], dispatcher: fake.dispatcher },
      },
    );
    swarmRef = await start();
    const swarm = swarmRef;
    const deps = {
      surface: undefined,
      find: () => ({ live: swarm.summary() }),
      live: (id: string) => (id === "sgate" ? swarm : undefined),
      begin: () => "s0",
      launchOf: () => undefined,
    };
    const reply = (runId: string, note: string) =>
      handleSwarmsAction({ type: "reply", payload: { id: "sgate", runId, note } }, deps);
    while (!swarm.summary().runs?.[0]?.pendingApproval?.threadId) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const threadId = swarm.summary().runs?.[0]?.pendingApproval?.threadId;
    expect((await reply("run_9", "x")).ok).toBe(false);
    expect((await reply("run_1", "  ")).ok).toBe(false);
    expect(await reply("run_1", "Keep the retry cap at 30 s.")).toEqual({
      ok: true,
      data: { message: "Replied in the approve-plan thread as you" },
    });
    await swarm.finished;
    const posted = server.messages.find(
      (m) => m.body === "**Operator:** Keep the retry cap at 30 s.",
    );
    expect(posted?.thread_root_id).toBe(threadId ?? "");
    expect(prompts.some((p) => p.includes("Keep the retry cap"))).toBe(true);
    expect((await reply("run_1", "late")).ok).toBe(false);
  });

  test("a gate with no respond seam is the operator's", async () => {
    const fake = fakeDispatcher();
    let swarmRef: Swarm | undefined;
    let answerer: string | undefined;
    const { start } = harness(
      async ({ agentId, turn, call }) => {
        if (agentId !== "s1-lead") return;
        if (turn === 1) {
          await call("chat_workflow_start", { workflow: "fix-issue", purpose: "p" });
          later(40, () => {
            fake.set("run_1", {
              status: "paused",
              pendingApproval: { nodeId: "approve-plan", prompt: "Approve?" },
            });
            swarmRef?.onRunEvent("run_1");
          });
        } else if (turn === 2) {
          answerer = swarmRef?.summary().runs?.[0]?.pendingApproval?.answerer;
          await call("chat_workflow_cancel", { run_id: "run_1" });
          await call("chat_done", { summary: "ok" });
        }
      },
      {},
      {
        dispatch: { grants: [{ name: "fix-issue", isolated: true }], dispatcher: fake.dispatcher },
      },
    );
    swarmRef = await start();
    await swarmRef.finished;
    expect(answerer).toBe("operator");
  });

  test("a swarm idle at an open gate is quiet until its next turn", async () => {
    const fake = fakeDispatcher({ answers: true });
    let swarmRef: Swarm | undefined;
    const { start } = harness(
      async ({ agentId, turn, call }) => {
        if (agentId !== "s1-lead") return;
        if (turn === 1) {
          await call("chat_workflow_start", { workflow: "fix-issue", purpose: "p" });
          later(40, () => {
            fake.set("run_1", {
              status: "paused",
              pendingApproval: { nodeId: "approve-plan", prompt: "Approve?" },
              nodes: [{ nodeId: "approve-plan", status: "paused" }],
            });
            swarmRef?.onRunEvent("run_1");
          });
        } else if (turn === 3) {
          await call("chat_workflow_cancel", { run_id: "run_1" });
          await call("chat_done", { summary: "ok" });
        }
      },
      {},
      {
        dispatch: { grants: [{ name: "fix-issue", isolated: true }], dispatcher: fake.dispatcher },
      },
    );
    const swarm = await start();
    swarmRef = swarm;
    await until(() => swarm.summary().health?.quietSince !== undefined);
    const needs = needsYou(swarm.summary());
    expect(needs.map((n) => n.kind)).toEqual(["quiet"]);
    expect(needs[0]?.run?.lastNode).toBe("approve-plan");
    await swarm.steer("cancel it and conclude");
    await until(() => swarm.summary().health?.quietSince === undefined);
    expect((await swarm.finished).status).toBe("done");
  });

  test("a live summary names its ClickClack", async () => {
    const h = harness(async ({ call }) => {
      await call("chat_done", { summary: "ok" });
    });
    const summary = await (await h.start()).finished;
    expect(summary.clickclack).toEqual({ url: "http://fake", workspaceId: WORKSPACE });
  });
});
