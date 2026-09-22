import { describe, expect, test } from "bun:test";
import type { RibRunStatus } from "@keelson/shared";
import { ClickClackClient } from "../src/clickclack.ts";
import { MAX_TURN_FAILURES, Swarm, type SwarmOptions, splitBody } from "../src/swarm.ts";
import { makeChatTools } from "../src/tools.ts";
import { BODY_MAX, CONCLUSION_MAX, type SwarmSummary } from "../src/types.ts";
import { FakeClickClack, OWNER_TOKEN, type Script, scriptedProvider, WORKSPACE } from "./fakes.ts";

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

function fakeDispatcher(opts: { live?: boolean } = {}) {
  const states = new Map<string, RibRunStatus>();
  const started: { name: string; inputs: Record<string, string> }[] = [];
  const cancelled: string[] = [];
  let n = 0;
  const set = (runId: string, patch: Partial<RibRunStatus>) => {
    const current = states.get(runId);
    if (current) states.set(runId, { ...current, ...patch });
  };
  return {
    started,
    cancelled,
    set,
    dispatcher: {
      start: async (name: string, inputs: Record<string, string>) => {
        n++;
        const runId = `run_${n}`;
        started.push({ name, inputs });
        states.set(runId, {
          runId,
          workflowName: name,
          status: "running",
          startedAt: new Date().toISOString(),
          checkout: opts.live
            ? { path: "/project", branch: "main", worktreeEstablished: false }
            : { path: `/wt/${runId}`, branch: `keelson/${runId}`, worktreeEstablished: true },
          nodes: [],
        });
        return { runId };
      },
      status: async (runId: string) => states.get(runId),
      cancel: async (runId: string) => {
        cancelled.push(runId);
        set(runId, { status: "cancelled" });
        return { ok: true as const };
      },
    },
  };
}

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
          later(20, () => {
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
    expect(prompts[1]).toContain("paused for human approval at node approve-plan");
    expect(refused).toContain("still live");
    expect(prompts[2]).toContain("is succeeded");
    expect(prompts[2]).toContain("verified");
    expect(summary.status).toBe("done");
    expect(summary.runs?.[0]).toMatchObject({
      runId: "run_1",
      status: "succeeded",
      verified: true,
      prUrls: ["https://github.com/o/r/pull/7"],
    });
    // Waiting on a live run is not idleness: the lead was never nudged.
    expect(logs.some((l) => l.includes("nudging"))).toBe(false);
    const leadTools = provider.requests[0]?.tools?.map((t) => t.name) ?? [];
    expect(leadTools).toContain("chat_workflow_start");
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
