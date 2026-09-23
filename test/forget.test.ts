import { describe, expect, test } from "bun:test";
import type { Swarm } from "../src/swarm.ts";
import { makeChatTools } from "../src/tools.ts";
import type { SwarmSummary } from "../src/types.ts";

const DAY = 86_400_000;

function endedSwarm(id: string, daysAgo: number): SwarmSummary {
  const at = new Date(Date.now() - daysAgo * DAY).toISOString();
  return { id, status: "done", startedAt: at, endedAt: at } as SwarmSummary;
}

function setup() {
  const ended = new Map<string, SwarmSummary>([
    ["sold1", endedSwarm("sold1", 10)],
    ["sold2", endedSwarm("sold2", 8)],
    ["snew1", endedSwarm("snew1", 0)],
  ]);
  const swarms = new Map<string, Swarm>([["slive", {} as Swarm]]);
  const forgotten: string[][] = [];
  const tools = makeChatTools({
    swarms,
    ended,
    startSwarm: async () => {
      throw new Error("not used");
    },
    forget: (ids) => {
      forgotten.push([...ids]);
      for (const id of ids) ended.delete(id);
    },
  });
  const call = async (input: unknown) => {
    let out = { content: "", isError: false };
    await tools
      .find((t) => t.name === "chat_swarm_forget")
      ?.execute(input, {
        cwd: "/tmp",
        abortSignal: new AbortController().signal,
        emit: (c) => {
          if (c.type === "tool_result") out = { content: String(c.content), isError: !!c.isError };
        },
      });
    return out;
  };
  return { ended, forgotten, call };
}

describe("chat_swarm_forget", () => {
  test("reports what it would forget until confirmed", async () => {
    const { forgotten, call } = setup();
    const out = await call({ older_than_days: 7 });
    expect(out.content).toContain("would forget 2 ended swarm(s): sold1, sold2");
    expect(forgotten).toEqual([]);
  });

  test("forgets ended swarms older than the cutoff and keeps the rest", async () => {
    const { ended, forgotten, call } = setup();
    const out = await call({ older_than_days: 7, confirm: true });
    expect(out.isError).toBe(false);
    expect(forgotten).toEqual([["sold1", "sold2"]]);
    expect([...ended.keys()]).toEqual(["snew1"]);
  });

  test("0 days forgets every ended swarm", async () => {
    const { ended, call } = setup();
    await call({ older_than_days: 0, confirm: true });
    expect(ended.size).toBe(0);
  });

  test("forgets one swarm by id", async () => {
    const { ended, call } = setup();
    await call({ swarm: "snew1", confirm: true });
    expect(ended.has("snew1")).toBe(false);
    expect(ended.size).toBe(2);
  });

  test("refuses a live swarm and an unknown id", async () => {
    const { forgotten, call } = setup();
    expect((await call({ swarm: "slive", confirm: true })).content).toContain("is live");
    expect((await call({ swarm: "snope", confirm: true })).isError).toBe(true);
    expect(forgotten).toEqual([]);
  });

  test("needs exactly one of swarm or older_than_days", async () => {
    const { call } = setup();
    expect((await call({ confirm: true })).isError).toBe(true);
    expect((await call({ swarm: "sold1", older_than_days: 1 })).isError).toBe(true);
  });
});
