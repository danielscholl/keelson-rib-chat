import { describe, expect, test } from "bun:test";
import { expectView } from "@keelson/shared";
import { ClickClackClient } from "../src/clickclack.ts";
import { needsYou } from "../src/needs.ts";
import { buildDoc } from "../src/surface/doc.ts";
import { buildIndex } from "../src/surface/index-board.ts";
import { INDEX_KEY, swarmKey } from "../src/surface/keys.ts";
import { buildSwarmBoard } from "../src/surface/swarm-board.ts";
import { Swarm } from "../src/swarm.ts";
import { makeChatTools } from "../src/tools.ts";
import type { SwarmLimits, SwarmSummary } from "../src/types.ts";
import { FakeClickClack, OWNER_TOKEN, type Script, scriptedProvider, WORKSPACE } from "./fakes.ts";

const QUESTION = "@operator is the 30 s backoff cap a product decision or a guess?";

function harness(script: Script, limits: Partial<SwarmLimits> = {}) {
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
      task: "Tune the retry backoff",
      owner,
      workspaceId: WORKSPACE,
      runAgentTurn: provider.run,
      limits: { maxNudges: 2, ...limits },
      quiesceMs: 10,
      reconnectMs: 5,
    });
    swarms.set(swarm.id, swarm);
    return swarm;
  };
  return { server, start };
}

const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

describe("an agent asking the operator", () => {
  test("holds the swarm open past its nudges, and the operator's post clears it", async () => {
    const { server, start } = harness(async ({ agentId, turn, prompt, call }) => {
      if (agentId !== "s1-lead") return;
      if (turn === 1) await call("chat_post", { body: QUESTION });
      else {
        expect(prompt).toContain("A guess");
        await call("chat_done", { summary: "Kept the cap as a guess." });
      }
    });
    const swarm = await start();
    await settle();
    const held = swarm.summary();
    expect(held.status).toBe("running");
    expect(held.turnsUsed).toBe(1);
    expect(held.health?.nudges).toBeUndefined();
    expect(needsYou(held).map((n) => n.kind)).toEqual(["question"]);
    expect(held.health?.asks?.[0]).toMatchObject({ handle: "s1-lead", text: QUESTION });

    server.postAsOwner(server.channels[0]?.id ?? "", "A guess.");
    const summary = await swarm.finished;
    expect(summary.status).toBe("done");
    expect(summary.health?.asks).toBeUndefined();
  });

  test("steer answers it too, and a reply in a thread counts as an ask", async () => {
    const { start } = harness(async ({ agentId, turn, call }) => {
      if (agentId !== "s1-lead") return;
      if (turn === 1) {
        const posted = await call("chat_post", { body: "Plan: cap at 30 s." });
        const root = posted.content.replace("posted ", "");
        await call("chat_reply", { message_id: root, body: QUESTION });
      } else {
        await call("chat_done", { summary: "ok" });
      }
    });
    const swarm = await start();
    await settle();
    expect(needsYou(swarm.summary()).map((n) => n.kind)).toEqual(["question"]);
    await swarm.steer("Product decision; keep it.");
    expect(
      swarm
        .summary()
        .activity?.some((e) => e.text === "you posted in #swarm-s1: Product decision; keep it."),
    ).toBe(true);
    await settle(40);
    expect(swarm.summary().health?.asks).toBeUndefined();
    expect((await swarm.finished).status).toBe("done");
  });

  test("two questions clear one at a time: a reply in one thread leaves the other open", async () => {
    const { server, start } = harness(async ({ agentId, turn, call }) => {
      if (agentId !== "s1-lead") return;
      if (turn === 1) {
        await call("chat_spawn", { handle: "w", role: "worker", brief: "ask the operator" });
        await call("chat_post", { body: "@operator lead question: keep the cap?" });
      }
      if (turn >= 3) await call("chat_done", { summary: "ok" });
    });
    // The worker asks its own question, in a thread of its own.
    const swarm = await start();
    await settle();
    const channel = server.channels[0]?.id ?? "";
    const lead = swarm.summary().health?.asks ?? [];
    expect(lead.map((a) => a.handle)).toEqual(["s1-lead"]);
    // A note that mentions the worker answers nothing of the lead's.
    server.postAsOwner(channel, "@s1-w carry on");
    await settle(40);
    expect(swarm.summary().health?.asks?.map((a) => a.handle)).toEqual(["s1-lead"]);
    // A reply in the lead's thread clears the lead's question.
    server.postAsOwner(channel, "Keep it.", lead[0]?.threadRootId);
    await settle(40);
    expect(swarm.summary().health?.asks).toBeUndefined();
    await swarm.stop();
  });

  test("Dismiss clears one question and logs it", async () => {
    const { start } = harness(async ({ agentId, turn, call }) => {
      if (agentId === "s1-lead" && turn === 1) {
        await call("chat_post", { body: "@operator first?" });
        await call("chat_post", { body: "@operator second?" });
      }
    });
    const swarm = await start();
    await settle();
    const asks = swarm.summary().health?.asks ?? [];
    expect(asks).toHaveLength(2);
    expect(swarm.dismissAsk("nope")).toBe(false);
    expect(swarm.dismissAsk(asks[0]?.messageId ?? "")).toBe(true);
    expect(swarm.summary().health?.asks?.map((a) => a.text)).toEqual(["@operator second?"]);
    expect(swarm.summary().activity?.at(-1)?.text).toBe("dismissed @s1-lead's question");
    await swarm.stop();
  });

  test("an unanswered ask ends only at the wall clock", async () => {
    const { start } = harness(
      async ({ agentId, turn, call }) => {
        if (agentId === "s1-lead" && turn === 1) await call("chat_post", { body: QUESTION });
      },
      { wallClockMs: 150 },
    );
    const summary = await (await start()).finished;
    expect(summary.status).toBe("exhausted");
    expect(summary.turnsUsed).toBe(1);
  });

  test("a plain post raises nothing, and the owner's own handle counts once it has one", async () => {
    const { server, start } = harness(async ({ agentId, turn, call }) => {
      if (agentId !== "s1-lead") return;
      if (turn === 1) {
        await call("chat_post", { body: "The operator set the cap last year." });
        await call("chat_post", { body: "@dana should the cap stay?" });
      }
    });
    server.owner.handle = "dana";
    const swarm = await start();
    await settle();
    expect(swarm.summary().health?.asks?.map((a) => a.text)).toEqual([
      "@dana should the cap stay?",
    ]);
    await swarm.stop();
  });

  test("a long ask keeps its question: the card shows the line that asks, the pane all of it", async () => {
    const long = [
      "@operator The evidence does not decide this, so I need your preference.",
      "",
      `**What we measured.** ${"Showing all 12 adds 484 bytes. ".repeat(20)}`,
      "",
      "**Which do you prefer, 8 of 12 or all 12?**",
      "",
      "1. Keep 8 of 12.",
      "2. Show all 12.",
    ].join("\n");
    const { start } = harness(async ({ agentId, turn, call }) => {
      if (agentId === "s1-lead" && turn === 1) await call("chat_post", { body: long });
    });
    const swarm = await start();
    await settle();
    const s = swarm.summary();
    const index = JSON.stringify(buildIndex({ live: [s], starting: [], ended: [] }));
    expect(index).toContain('{"label":"asked","clock":{"at":"');
    expect(index).toContain("@lead asked: Which do you prefer, 8 of 12 or all 12?");
    const drawer = JSON.stringify(buildSwarmBoard(s));
    expect(drawer).toContain('"title":"@lead asked: Which do you prefer, 8 of 12 or all 12?"');
    expect(drawer).toContain("Read question");
    const doc = buildDoc(s, "s1");
    expect(doc).toContain("## @lead asked you");
    expect(doc).toContain("2. Show all 12.");
    expect(doc).not.toContain("@operator");
    await swarm.stop();
  });

  test("the card and the drawer say who asked what", async () => {
    const { start } = harness(async ({ agentId, turn, call }) => {
      if (agentId === "s1-lead" && turn === 1) await call("chat_post", { body: QUESTION });
    });
    const swarm = await start();
    await settle();
    const s = swarm.summary();
    const index = buildIndex({ live: [s], starting: [], ended: [] });
    expect(() => expectView(INDEX_KEY, "board")(index)).not.toThrow();
    expect(JSON.stringify(index)).toContain(
      "@lead asked: is the 30 s backoff cap a product decision or a guess?",
    );
    const drawer = buildSwarmBoard(s);
    expect(() => expectView(swarmKey("s1"), "board")(drawer)).not.toThrow();
    const waiting = drawer.sections.find((x) => x.kind === "cards" && x.title === "1 request");
    expect(JSON.stringify(waiting)).toContain("@lead asked:");
    expect(JSON.stringify(waiting)).toContain("a reply in its thread answers it");
    expect(JSON.stringify(waiting)).toContain('"type":"dismiss-ask"');
    await swarm.stop();
  });
});
