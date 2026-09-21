import { describe, expect, test } from "bun:test";
import type { ToolContext } from "@keelson/shared";
import { makeServerTools, type ServerControl, type ServerTarget } from "../src/server-tools.ts";

function harness(opts: { external?: boolean; live?: number; ended?: number } = {}) {
  const calls: string[] = [];
  let ended = opts.ended ?? 0;
  const server: ServerControl = {
    ensure: async () => {
      calls.push("ensure");
      return { url: "http://127.0.0.1:18080", pid: 4000, adopted: false };
    },
    stop: async () => {
      calls.push("stop");
      return true;
    },
    reset: async () => {
      calls.push("reset");
      return { url: "http://127.0.0.1:18080", pid: 4001, adopted: false };
    },
    status: async () => ({
      url: "http://127.0.0.1:18080",
      running: true,
      pid: 4000,
      dataDir: "/home/rib-chat/clickclack/data",
    }),
  };
  const target: ServerTarget = opts.external
    ? { mode: "external", url: "http://chat.example" }
    : { mode: "managed", server };
  const tools = makeServerTools({
    target: async () => target,
    liveCount: () => opts.live ?? 0,
    endedCount: () => ended,
    clearEnded: () => {
      ended = 0;
    },
  });
  const run = async (name: string, input: unknown = {}) => {
    const results: { content: string; isError?: boolean }[] = [];
    const ctx: ToolContext = {
      cwd: "/",
      abortSignal: new AbortController().signal,
      emit: (chunk) => {
        if (chunk.type === "tool_result") results.push(chunk);
      },
    };
    await tools.find((t) => t.name === name)?.execute(input, ctx);
    expect(results).toHaveLength(1);
    return results[0] as { content: string; isError?: boolean };
  };
  return { tools, run, calls, endedCount: () => ended };
}

describe("server tools", () => {
  test("only status is read-only, and reset asks for confirmation", () => {
    const { tools } = harness();
    expect(tools.map((t) => [t.name, t.state_changing === true])).toEqual([
      ["chat_server_status", false],
      ["chat_server_start", true],
      ["chat_server_stop", true],
      ["chat_server_reset", true],
    ]);
    expect(tools.find((t) => t.name === "chat_server_reset")?.requires_confirmation).toBe(true);
  });

  test("status answers in both modes and never starts anything", async () => {
    const managed = harness({ live: 2 });
    expect(JSON.parse((await managed.run("chat_server_status")).content)).toMatchObject({
      mode: "managed",
      running: true,
      pid: 4000,
      liveSwarms: 2,
    });
    expect(managed.calls).toEqual([]);
    const external = harness({ external: true });
    expect(JSON.parse((await external.run("chat_server_status")).content)).toEqual({
      mode: "external",
      url: "http://chat.example",
      liveSwarms: 0,
    });
  });

  test("start reports where to watch", async () => {
    const result = await harness().run("chat_server_start");
    expect(result.content).toBe(
      "ClickClack running at http://127.0.0.1:18080 (pid 4000, started). Watch at http://127.0.0.1:18080/app.",
    );
  });

  test.each(["chat_server_start", "chat_server_stop", "chat_server_reset"])(
    "%s leaves an external server alone",
    async (name) => {
      const h = harness({ external: true });
      const result = await h.run(name, name === "chat_server_reset" ? { confirm: true } : {});
      expect(result.isError).toBe(true);
      expect(result.content).toContain("external (http://chat.example)");
      expect(h.calls).toEqual([]);
    },
  );

  test.each(["chat_server_stop", "chat_server_reset"])(
    "%s refuses while a swarm is live or starting",
    async (name) => {
      const h = harness({ live: 1 });
      const result = await h.run(name, name === "chat_server_reset" ? { confirm: true } : {});
      expect(result.isError).toBe(true);
      expect(result.content).toContain("1 swarm(s) live");
      expect(h.calls).toEqual([]);
    },
  );

  test("reset without confirm names what it would delete and deletes nothing", async () => {
    const h = harness({ ended: 3 });
    const result = await h.run("chat_server_reset");
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("/home/rib-chat/clickclack/data");
    expect(result.content).toContain("forget 3 ended swarm(s)");
    expect(result.content).toContain("confirm: true");
    expect(h.calls).toEqual([]);
    expect(h.endedCount()).toBe(3);
  });

  test("a confirmed reset wipes the server and forgets the swarms that ran on it", async () => {
    const h = harness({ ended: 3 });
    const result = await h.run("chat_server_reset", { confirm: true });
    expect(result.content).toContain("reset");
    expect(h.calls).toEqual(["reset"]);
    expect(h.endedCount()).toBe(0);
  });

  test("an unknown input is a readable failure, not an exception", async () => {
    const result = await harness().run("chat_server_stop", { force: true });
    expect(result.isError).toBe(true);
  });
});
