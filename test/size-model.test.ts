import { describe, expect, test } from "bun:test";
import { modelLabel } from "../src/labels.ts";
import type { Swarm } from "../src/swarm.ts";
import { makeChatTools, type StartSwarmInput } from "../src/tools.ts";
import {
  DEFAULT_LIMITS,
  SIZE_PRESETS,
  SWARM_SIZES,
  type SwarmSummary,
  sizeOf,
} from "../src/types.ts";

describe("size presets", () => {
  test("medium is the engine's defaults", () => {
    expect(SIZE_PRESETS.medium).toEqual(DEFAULT_LIMITS);
  });

  test("each preset reads back as its own word", () => {
    for (const size of SWARM_SIZES) expect(sizeOf(SIZE_PRESETS[size], size)).toBe(size);
  });

  test("one limit moved off the preset reads as custom", () => {
    expect(sizeOf({ ...SIZE_PRESETS.large, maxTurns: 81 }, "large")).toBe("custom");
    expect(sizeOf(SIZE_PRESETS.small, "medium")).toBe("custom");
  });

  test("only large changes concurrency, and every size gives a turn five minutes", () => {
    expect(SWARM_SIZES.map((s) => SIZE_PRESETS[s].maxConcurrent)).toEqual([3, 3, 4]);
    for (const s of SWARM_SIZES) expect(SIZE_PRESETS[s].turnTimeoutMs).toBe(5 * 60_000);
  });
});

describe("model label", () => {
  const agents: SwarmSummary["agents"] = [];
  test("names the model asked for", () => {
    expect(modelLabel({ model: "gpt-5.6-sol", agents })).toBe("gpt-5.6-sol");
  });
  test("splits lead and workers when they differ", () => {
    expect(modelLabel({ model: "gpt-6-astra", workerModel: "gpt-5.6-sol", agents })).toBe(
      "gpt-6-astra · workers gpt-5.6-sol",
    );
    expect(modelLabel({ model: "gpt-6-astra", workerModel: "gpt-6-astra", agents })).toBe(
      "gpt-6-astra",
    );
    expect(modelLabel({ workerModel: "mai-code-1.1-flash", agents })).toBe(
      "provider default · workers mai-code-1.1-flash",
    );
  });
  test("names the provider's default once a turn reported the provider", () => {
    expect(modelLabel({ agents })).toBe("provider default");
    const served = [{ providerId: "copilot" }] as unknown as SwarmSummary["agents"];
    expect(modelLabel({ agents: served })).toBe("copilot default");
  });
  test("names the power when no model was asked for", () => {
    const served = [{ providerId: "copilot" }] as unknown as SwarmSummary["agents"];
    expect(modelLabel({ power: "deep", agents })).toBe("deep power");
    expect(modelLabel({ power: "deep", agents: served })).toBe("deep power on copilot");
    expect(modelLabel({ power: "fast", workerModel: "mai-code-1.1-flash", agents })).toBe(
      "fast power · workers mai-code-1.1-flash",
    );
    expect(modelLabel({ power: "fast", model: "gpt-6-astra", agents })).toBe("gpt-6-astra");
  });
});

describe("chat_swarm_start inputs", () => {
  async function start(input: Record<string, unknown>): Promise<StartSwarmInput | undefined> {
    let seen: StartSwarmInput | undefined;
    const tools = makeChatTools({
      swarms: new Map(),
      ended: new Map(),
      startSwarm: async (i) => {
        seen = i;
        const swarm = { summary: () => ({ id: "s1", channelName: "swarm-s1" }) };
        return { swarm: swarm as unknown as Swarm };
      },
    });
    await tools
      .find((t) => t.name === "chat_swarm_start")
      ?.execute(input, {
        cwd: "/tmp",
        abortSignal: new AbortController().signal,
        emit: () => {},
      });
    return seen;
  }

  test("size, model and worker_model reach the launcher", async () => {
    const seen = await start({
      task: "t",
      size: "large",
      max_turns: 90,
      provider: "copilot",
      model: "gpt-6-astra",
      worker_model: "gpt-5.6-sol",
    });
    expect(seen).toMatchObject({
      size: "large",
      maxTurns: 90,
      provider: "copilot",
      model: "gpt-6-astra",
      workerModel: "gpt-5.6-sol",
    });
  });

  test("no size leaves the launcher on its default", async () => {
    const seen = await start({ task: "t" });
    expect(seen?.size).toBeUndefined();
  });

  test("an unknown size is refused", async () => {
    expect(await start({ task: "t", size: "huge" })).toBeUndefined();
  });

  test("power reaches the launcher, and an unknown one is refused", async () => {
    expect((await start({ task: "t", power: "deep" }))?.power).toBe("deep");
    expect((await start({ task: "t" }))?.power).toBeUndefined();
    expect(await start({ task: "t", power: "max" })).toBeUndefined();
  });
});
