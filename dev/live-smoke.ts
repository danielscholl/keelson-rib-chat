#!/usr/bin/env bun
/**
 * Live smoke: run a real swarm against a real ClickClack server with scripted
 * agents standing in for the model, so it proves the HTTP shapes, the WebSocket
 * auth, the event echo, bot minting, and token revocation without spending a
 * single model token.
 *
 *   CLICKCLACK_TOKEN=<owner session> bun dev/live-smoke.ts
 *
 * With no URL and no token it takes the managed path instead: it spawns the
 * binary, mints its own session, and afterwards proves adoption, reset, and stop.
 *
 *   CLICKCLACK_BIN=<clickclack binary> bun dev/live-smoke.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClickClackClient } from "../src/clickclack.ts";
import { ManagedServer, realServerDeps } from "../src/server.ts";
import { Swarm } from "../src/swarm.ts";
import { makeChatTools } from "../src/tools.ts";
import { type Script, scriptedProvider } from "../test/fakes.ts";

let url = process.env.CLICKCLACK_URL ?? "http://localhost:8080";
let token = process.env.CLICKCLACK_TOKEN;
let managed: { server: ManagedServer; home: string } | undefined;
if (!token && !process.env.CLICKCLACK_URL) {
  const home = mkdtempSync(join(tmpdir(), "rib-chat-smoke-"));
  const server = new ManagedServer(realServerDeps(() => home));
  const why = server.unavailable();
  if (why) {
    console.error(why);
    process.exit(1);
  }
  const running = await server.ensure();
  console.log(`managed: pid ${running.pid} at ${running.url}, data under ${home}`);
  url = running.url;
  token = await server.ownerSession();
  managed = { server, home };
}
if (!token) {
  console.error("set CLICKCLACK_TOKEN to an owner session (clickclack login --magic-token ...)");
  process.exit(1);
}

const owner = new ClickClackClient(url, token);
await owner.ready();
const me = await owner.me();
const workspace = (await owner.listWorkspaces())[0];
if (!workspace) throw new Error("no workspace visible to this session");
console.log(`owner: ${me.displayName} (${me.kind})  workspace: ${workspace.name}`);

const swarms = new Map<string, Swarm>();
const tools = makeChatTools({
  swarms,
  ended: new Map(),
  startSwarm: async () => {
    throw new Error("unused");
  },
});

const script: Script = async ({ agentId, turn, prompt, call }) => {
  const say = async (tool: string, input: unknown) => {
    const out = await call(tool, input);
    console.log(`   ${agentId} -> ${tool}: ${out.isError ? "ERROR " : ""}${out.content}`);
    if (out.isError) throw new Error(out.content);
  };
  if (agentId.endsWith("-lead") && turn === 1) {
    await say("chat_post", { body: "Plan: split this into a log review and a config review." });
    await say("chat_spawn", {
      handle: "logs",
      role: "reads the build logs",
      brief: "Find the slowest build step and report it in this thread.",
    });
    await say("chat_spawn", {
      handle: "config",
      role: "reviews the build config",
      brief: "Check whether caching is enabled and report in this thread.",
    });
  } else if (agentId.endsWith("-logs") || agentId.endsWith("-config")) {
    const briefId = prompt.match(/top-level (msg_\w+)/)?.[1];
    const finding = agentId.endsWith("-logs")
      ? "The link step takes 9 of the 11 minutes."
      : "Incremental caching is disabled in the release profile.";
    await say("chat_reply", { message_id: briefId, body: finding });
  } else if (agentId.endsWith("-lead")) {
    const roster = JSON.parse((await call("chat_roster", {})).content) as { turns: number }[];
    const reported = roster.filter((a) => a.turns > 0).length;
    console.log(`   lead turn ${turn}: ${reported}/3 agents have worked`);
    if (reported === 3) {
      await say("chat_done", {
        summary:
          "Linking dominates the build, and disabled caching makes every run pay it in full.",
      });
    }
  }
};

const provider = scriptedProvider(tools, script);
const swarm = await Swarm.start({
  task: "Smoke test: work out why the build is slow.",
  owner,
  workspaceId: workspace.id,
  runAgentTurn: provider.run,
  quiesceMs: 1_000,
  log: (m, d) => console.log(`[swarm] ${m}${d ? ` ${JSON.stringify(d)}` : ""}`),
});
swarms.set(swarm.id, swarm);

const summary = await swarm.finished;
console.log(
  `\nstatus=${summary.status} turns=${summary.turnsUsed} agents=${summary.agents.length}`,
);
console.log(`conclusion: ${summary.conclusion ?? "(none)"}`);

// Revocation must be real: ask the server, not the swarm, about each credential.
const res = await fetch(`${url}/api/workspaces/${workspace.id}/bots`, {
  headers: { Authorization: `Bearer ${token}` },
});
const listed = (await res.json()) as {
  bots: { bot: { handle: string }; tokens: { revoked_at?: string }[] }[];
};
const mine = listed.bots.filter((b) => b.bot.handle.startsWith(`${summary.id}-`));
const live = mine.filter((b) => b.tokens.some((t) => !t.revoked_at));
console.log(`revocation: ${mine.length} swarm bots, ${live.length} with a live token`);

let ok = summary.status === "done" && mine.length === summary.agents.length && live.length === 0;

if (managed) {
  const { server, home } = managed;
  const check = (label: string, pass: boolean): void => {
    console.log(`managed: ${pass ? "ok  " : "FAIL"} ${label}`);
    ok &&= pass;
  };
  const { pid } = await server.ensure();
  const alive = (p: number): boolean => {
    try {
      process.kill(p, 0);
      return true;
    } catch {
      return false;
    }
  };

  // A second instance stands in for a harness that restarted and found the server up.
  const successor = new ManagedServer(realServerDeps(() => home));
  const adopted = await successor.ensure();
  check("a new process adopts the running server", adopted.adopted && adopted.pid === pid);

  const fresh = await successor.reset();
  check("reset replaces the process", fresh.pid !== pid && !alive(pid));
  const after = new ClickClackClient(fresh.url, await successor.ownerSession());
  const workspaces = await after.listWorkspaces();
  const channels = workspaces[0] ? await after.listChannels(workspaces[0].id) : [];
  check(
    "reset leaves one workspace and no swarm channel",
    workspaces.length === 1 && !channels.some((c) => c.name === summary.channelName),
  );
  let stale = false;
  try {
    await owner.me();
  } catch {
    stale = true;
  }
  check("the session minted before the reset no longer works", stale);

  check("stop reports a running server", await successor.stop());
  check("the process is gone", !alive(fresh.pid));
  check("status sees nothing running", !(await successor.status()).running);
  rmSync(home, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
