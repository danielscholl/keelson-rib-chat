#!/usr/bin/env bun
/**
 * Live smoke: run a real swarm against a real ClickClack server with scripted
 * agents standing in for the model, so it proves the HTTP shapes, the WebSocket
 * auth, the event echo, bot minting, and token revocation without spending a
 * single model token.
 *
 *   CLICKCLACK_TOKEN=<owner session> bun dev/live-smoke.ts
 */
import { ClickClackClient } from "../src/clickclack.ts";
import { Swarm } from "../src/swarm.ts";
import { makeChatTools } from "../src/tools.ts";
import { type Script, scriptedProvider } from "../test/fakes.ts";

const url = process.env.CLICKCLACK_URL ?? "http://localhost:8080";
const token = process.env.CLICKCLACK_TOKEN;
if (!token) {
  console.error("set CLICKCLACK_TOKEN to an owner session (clickclack login --magic-token ...)");
  process.exit(1);
}

const owner = new ClickClackClient(url, token);
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

const ok = summary.status === "done" && mine.length === summary.agents.length && live.length === 0;
process.exit(ok ? 0 : 1);
