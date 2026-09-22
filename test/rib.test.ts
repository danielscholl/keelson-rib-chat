import { describe, expect, test } from "bun:test";
import { ribIdSchema } from "@keelson/shared";
import rib from "../src/index.ts";
import { AGENT_TOOLS, DISPATCH_TOOLS } from "../src/swarm.ts";

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
    for (const tool of [...AGENT_TOOLS, ...DISPATCH_TOOLS]) expect(names.has(tool)).toBe(true);
  });

  test("a start on a provider that cannot run agent turns fails before any channel", async () => {
    const tools =
      rib.registerTools?.({
        getExec: () => ({}) as never,
        runAgentTurn: (() => {
          throw new Error("no turn should run");
        }) as never,
        getProviders: () => [
          { id: "copilot", displayName: "Copilot" },
          { id: "workflow", displayName: "Workflow" },
        ],
      }) ?? [];
    const start = tools.find((t) => t.name === "chat_swarm_start");
    const run = async (provider: string) => {
      let out = "";
      await start?.execute(
        { task: "t", provider },
        {
          cwd: "/tmp",
          abortSignal: new AbortController().signal,
          emit: (c) => {
            if (c.type === "tool_result") out = String(c.content);
          },
        },
      );
      return out;
    };
    try {
      expect(await run("claude")).toContain("no registered provider 'claude'; registered: copilot");
      expect(await run("workflow")).toContain("provider 'workflow' cannot run agent turns");
      expect(await run("stub")).toContain("provider 'stub' cannot run agent turns");
    } finally {
      await rib.dispose?.();
    }
  });

  test("authStatus reports a missing credential for a server the operator pointed it at", async () => {
    const saved = {
      CLICKCLACK_URL: process.env.CLICKCLACK_URL,
      CLICKCLACK_TOKEN: process.env.CLICKCLACK_TOKEN,
    };
    process.env.CLICKCLACK_URL = "http://127.0.0.1:1";
    delete process.env.CLICKCLACK_TOKEN;
    try {
      const status = await rib.authStatus?.({ getExec: () => ({}) as never });
      expect(status?.authenticated).toBe(false);
      expect(status?.statusMessage).toContain("no ClickClack owner session");
    } finally {
      restore(saved);
    }
  });

  test("with no url and no token the rib manages its own server, and says what it lacks", async () => {
    const saved = {
      CLICKCLACK_URL: process.env.CLICKCLACK_URL,
      CLICKCLACK_TOKEN: process.env.CLICKCLACK_TOKEN,
      CLICKCLACK_BIN: process.env.CLICKCLACK_BIN,
    };
    delete process.env.CLICKCLACK_URL;
    delete process.env.CLICKCLACK_TOKEN;
    process.env.CLICKCLACK_BIN = "/opt/clickclack";
    try {
      // This host offers no data directory, so nothing can be spawned from here.
      const status = await rib.authStatus?.({ getExec: () => ({}) as never });
      expect(status?.authenticated).toBe(false);
      expect(status?.statusMessage).toContain("rib data directory");
      expect(status?.statusMessage).toContain("CLICKCLACK_URL and CLICKCLACK_TOKEN");
    } finally {
      restore(saved);
      await rib.dispose?.();
    }
  });

  test("a token alone keeps today's default url, so an existing setup is not replaced", async () => {
    const saved = {
      CLICKCLACK_URL: process.env.CLICKCLACK_URL,
      CLICKCLACK_TOKEN: process.env.CLICKCLACK_TOKEN,
    };
    delete process.env.CLICKCLACK_URL;
    process.env.CLICKCLACK_TOKEN = "sst_unused";
    try {
      const tools = rib.registerTools?.({ getExec: () => ({}) as never }) ?? [];
      const results: { content: string }[] = [];
      await tools
        .find((t) => t.name === "chat_server_status")
        ?.execute(
          {},
          {
            cwd: "/",
            abortSignal: new AbortController().signal,
            emit: (chunk) => {
              if (chunk.type === "tool_result") results.push(chunk);
            },
          },
        );
      expect(JSON.parse(results[0]?.content ?? "{}")).toEqual({
        mode: "external",
        url: "http://localhost:8080",
        liveSwarms: 0,
      });
    } finally {
      restore(saved);
      await rib.dispose?.();
    }
  });

  test("authStatus names the url of a server that is not running", async () => {
    const saved = {
      CLICKCLACK_URL: process.env.CLICKCLACK_URL,
      CLICKCLACK_TOKEN: process.env.CLICKCLACK_TOKEN,
    };
    // Port 1 is reserved and refuses at once, so this needs no server and no wait.
    process.env.CLICKCLACK_URL = "http://127.0.0.1:1";
    process.env.CLICKCLACK_TOKEN = "sst_unused";
    try {
      const status = await rib.authStatus?.({ getExec: () => ({}) as never });
      expect(status?.authenticated).toBe(false);
      expect(status?.statusMessage).toContain("ClickClack is not reachable at http://127.0.0.1:1");
    } finally {
      restore(saved);
    }
  });

  test("an unreachable server fails the start before any run is registered", async () => {
    const saved = {
      CLICKCLACK_URL: process.env.CLICKCLACK_URL,
      CLICKCLACK_TOKEN: process.env.CLICKCLACK_TOKEN,
      CLICKCLACK_WORKSPACE: process.env.CLICKCLACK_WORKSPACE,
    };
    process.env.CLICKCLACK_URL = "http://127.0.0.1:1";
    process.env.CLICKCLACK_TOKEN = "sst_unused";
    // Pinned, so the workspace lookup cannot be what fails first.
    process.env.CLICKCLACK_WORKSPACE = "wsp_pinned";
    let registered = 0;
    try {
      const tools =
        rib.registerTools?.({
          getExec: () => ({}) as never,
          runAgentTurn: (() => {
            throw new Error("no turn should run");
          }) as never,
          registerOp: (() => {
            registered++;
            throw new Error("no op should be registered");
          }) as never,
        }) ?? [];
      const start = tools.find((t) => t.name === "chat_swarm_start");
      const results: { content: string; isError?: boolean }[] = [];
      await start?.execute(
        { task: "anything" },
        {
          cwd: "/",
          abortSignal: new AbortController().signal,
          emit: (chunk) => {
            if (chunk.type === "tool_result") results.push(chunk);
          },
        },
      );
      expect(results).toHaveLength(1);
      expect(results[0]?.isError).toBe(true);
      expect(results[0]?.content).toContain("not reachable at http://127.0.0.1:1");
      expect(registered).toBe(0);
    } finally {
      restore(saved);
      await rib.dispose?.();
    }
  });
});

function restore(saved: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
