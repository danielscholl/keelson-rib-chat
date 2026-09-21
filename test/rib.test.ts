import { describe, expect, test } from "bun:test";
import { ribIdSchema } from "@keelson/shared";
import rib from "../src/index.ts";
import { AGENT_TOOLS } from "../src/swarm.ts";

describe("rib contract", () => {
  test("id matches the package suffix the harness infers", () => {
    expect(rib.id).toBe("chat");
    expect(ribIdSchema.safeParse(rib.id).success).toBe(true);
  });

  test("every tool carries the chat_ family prefix and a unique name", () => {
    const tools = rib.registerTools?.({ getExec: () => ({}) as never }) ?? [];
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((n) => n.startsWith("chat_"))).toBe(true);
  });

  test("every tool a swarm grants its agents is actually registered", () => {
    const names = new Set(
      (rib.registerTools?.({ getExec: () => ({}) as never }) ?? []).map((t) => t.name),
    );
    for (const tool of AGENT_TOOLS) expect(names.has(tool)).toBe(true);
  });

  test("authStatus reports a missing credential instead of throwing", async () => {
    const saved = process.env.CLICKCLACK_TOKEN;
    delete process.env.CLICKCLACK_TOKEN;
    try {
      const status = await rib.authStatus?.({ getExec: () => ({}) as never });
      expect(status?.authenticated).toBe(false);
      expect(status?.statusMessage).toContain("CLICKCLACK_TOKEN");
    } finally {
      if (saved !== undefined) process.env.CLICKCLACK_TOKEN = saved;
    }
  });

  test("authStatus names the url of a server that is not running", async () => {
    const saved = { url: process.env.CLICKCLACK_URL, token: process.env.CLICKCLACK_TOKEN };
    // Port 1 is reserved and refuses at once, so this needs no server and no wait.
    process.env.CLICKCLACK_URL = "http://127.0.0.1:1";
    process.env.CLICKCLACK_TOKEN = "sst_unused";
    try {
      const status = await rib.authStatus?.({ getExec: () => ({}) as never });
      expect(status?.authenticated).toBe(false);
      expect(status?.statusMessage).toBe("ClickClack is not reachable at http://127.0.0.1:1");
    } finally {
      if (saved.url === undefined) delete process.env.CLICKCLACK_URL;
      else process.env.CLICKCLACK_URL = saved.url;
      if (saved.token === undefined) delete process.env.CLICKCLACK_TOKEN;
      else process.env.CLICKCLACK_TOKEN = saved.token;
    }
  });
});
