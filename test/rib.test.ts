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
});
