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
import { expectView } from "@keelson/shared";
import { ClickClackClient } from "../src/clickclack.ts";
import { needsYou } from "../src/needs.ts";
import { ManagedServer, realServerDeps } from "../src/server.ts";
import { buildBadge, buildIndex } from "../src/surface/index-board.ts";
import { INDEX_KEY, swarmKey } from "../src/surface/keys.ts";
import { buildSwarmBoard } from "../src/surface/swarm-board.ts";
import { Swarm } from "../src/swarm.ts";
import { makeChatTools } from "../src/tools.ts";
import type { SwarmSummary } from "../src/types.ts";
import { fakeDispatcher, type Script, scriptedProvider } from "../test/fakes.ts";

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
// Every change the tab would publish must compose a frame the host accepts.
let frames = 0;
let badFrame: string | undefined;
// What the index said along the way: its head, the card's pill, and whether the
// running card carried its named turn meter.
const heads = new Set<string>();
const pills = new Set<string>();
let meters = 0;
let started: Swarm | undefined;
const checkFrames = (s: SwarmSummary, live: boolean) => {
  const index = buildIndex({ live: live ? [s] : [], starting: [], ended: live ? [] : [s] });
  const views: [string, unknown][] = [
    [INDEX_KEY, index],
    [swarmKey(s.id), buildSwarmBoard(s)],
  ];
  if (index.header?.status) heads.add(index.header.status.label);
  for (const section of index.sections) {
    if (section.kind !== "cards") continue;
    for (const card of section.items) {
      if (card.pill) pills.add(card.pill.label);
      if (card.bar && "label" in card.bar && card.bar.label === "Turn budget used") meters++;
    }
  }
  for (const [key, view] of views) {
    try {
      expectView(key, "board")(view);
      frames++;
    } catch (e) {
      badFrame ??= `${key}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
};

const swarm = await Swarm.start({
  task: "Smoke test: work out why the build is slow.",
  owner,
  workspaceId: workspace.id,
  runAgentTurn: provider.run,
  quiesceMs: 1_000,
  log: (m, d) => console.log(`[swarm] ${m}${d ? ` ${JSON.stringify(d)}` : ""}`),
  onChange: () => {
    if (started) checkFrames(started.summary(), true);
  },
});
started = swarm;
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

// The operator transcript must hold every thread reply, oldest first.
const transcript = await owner.channelTranscript(summary.channelId);
const replies = transcript.filter((m) => m.threadRootId !== m.id).length;
const ordered = transcript.every(
  (m, i) => i === 0 || (transcript[i - 1]?.createdAt ?? "") <= m.createdAt,
);
console.log(
  `transcript: ${transcript.length} messages, ${replies} thread replies, ordered=${ordered}`,
);

checkFrames(summary, false);
console.log(`boards: ${frames} frames valid${badFrame ? `; first invalid: ${badFrame}` : ""}`);
const endedIndex = JSON.stringify(buildIndex({ live: [], starting: [], ended: [summary] }));
const indexOk =
  heads.has("1 live") &&
  pills.has("running") &&
  meters > 0 &&
  endedIndex.includes(` · ${summary.id}","trailing":"`) &&
  endedIndex.includes('"label":"done"');
console.log(
  `index: heads=${[...heads].join("|")} pills=${[...pills].join("|")} meters=${meters} ended row=${endedIndex.includes('"label":"done"')}`,
);

// ---- Scene two: a peer reviews one approval, and only the operator can answer the next. ----

const later = (ms: number, fn: () => void) => setTimeout(fn, ms);
const fake = fakeDispatcher({ answers: true });
const REFUSAL =
  "rib 'chat' is not granted approvals for workflow 'release' (config.json ribApprovalGrants)";
const dispatcher = {
  ...fake.dispatcher,
  respond: async (runId: string, nodeId: string, text: string, pauseId?: string) =>
    runId === "run_2"
      ? { ok: false as const, error: REFUSAL }
      : fake.dispatcher.respond!(runId, nodeId, text, pauseId),
};
// An earlier swarm learned that the host keeps release approvals for the operator.
const refused = new Set(["release"]);
const approvalRefusals = {
  has: (w: string) => refused.has(w),
  set: (w: string, r: boolean) => void (r ? refused.add(w) : refused.delete(w)),
};
const shipped = (runId: string, pr: number) => {
  fake.set(runId, {
    status: "succeeded",
    completedAt: new Date().toISOString(),
    nodes: [
      { nodeId: "open-pr", status: "succeeded", output: `https://github.com/o/r/pull/${pr}` },
      { nodeId: "ci-green-gate", status: "succeeded", output: "CI_GATE: PASS" },
    ],
  });
  gated?.onRunEvent(runId);
};
const pause = (runId: string, nodeId: string, prompt: string) => {
  fake.set(runId, { status: "paused", pendingApproval: { nodeId, prompt } });
  gated?.onRunEvent(runId);
};

let gated: Swarm | undefined;
let gateThread: string | undefined;
let reviewed = false;
const gateScript: Script = async ({ agentId, turn, prompt, call }) => {
  const say = async (tool: string, input: unknown) => {
    const out = await call(tool, input);
    console.log(`   ${agentId} -> ${tool}: ${out.isError ? "ERROR " : ""}${out.content}`);
    if (out.isError) throw new Error(out.content);
  };
  if (agentId.endsWith("-reviewer")) {
    const brief = prompt.match(/top-level (msg_\w+)/)?.[1];
    if (!brief) return;
    await say("chat_reply", {
      message_id: brief,
      body: "approve: each plan step maps to the issue",
    });
    return;
  }
  if (!agentId.endsWith("-lead")) return;
  if (turn === 1) {
    await say("chat_workflow_start", { workflow: "fix-issue", purpose: "fix the slow build" });
    later(300, () => pause("run_1", "approve-plan", "Approve this plan?\n\n1. Enable caching."));
    return;
  }
  if (!gateThread) {
    gateThread = prompt.match(/in thread (msg_\w+)/)?.[1];
    if (!gateThread) return;
    await say("chat_spawn", {
      handle: "reviewer",
      role: "plan reviewer",
      brief: `Review the plan in thread ${gateThread} and reply to this brief with your verdict.`,
    });
    await say("chat_reply", {
      message_id: gateThread,
      body: `@${gated?.id}-reviewer please review this plan.`,
    });
    return;
  }
  if (!reviewed) {
    const review = [...prompt.matchAll(/-reviewer \((msg_\w+)/g)].at(-1)?.[1];
    if (!review) return;
    reviewed = true;
    await say("chat_workflow_respond", {
      run_id: "run_1",
      decision: "approve",
      review,
      reason: "Every plan step maps to the issue.",
    });
    later(200, () => shipped("run_1", 8));
    await say("chat_workflow_start", { workflow: "release", purpose: "release the fix" });
    later(500, () => pause("run_2", "approve-release", "Release 1.2.3?"));
    return;
  }
  const runs = gated?.summary().runs ?? [];
  if (runs.length === 2 && runs.every((r) => r.status === "succeeded")) {
    await say("chat_done", { summary: "The fix shipped in PR 8 and the release in PR 9." });
  }
};

// What the tab showed along the way.
const gateHeads = new Set<string>();
const gatePills = new Set<string>();
const verbs = new Set<string>();
const seen = { reviewing: false, badge: false };
let operatorAnswered = false;
const gateProvider = scriptedProvider(tools, gateScript);
const second = await Swarm.start({
  task: "Smoke test: fix the slow build and release it.",
  owner,
  workspaceId: workspace.id,
  runAgentTurn: gateProvider.run,
  quiesceMs: 1_000,
  approvalRefusals,
  dispatch: {
    grants: [
      { name: "fix-issue", isolated: true },
      { name: "release", isolated: true },
    ],
    dispatcher,
  },
  log: (m, d) => console.log(`[gates] ${m}${d ? ` ${JSON.stringify(d)}` : ""}`),
  onChange: () => {
    if (!gated) return;
    const s = gated.summary();
    const index = buildIndex({ live: [s], starting: [], ended: [] });
    const board = buildSwarmBoard(s);
    for (const [key, view] of [
      [INDEX_KEY, index],
      [swarmKey(s.id), board],
    ] as const) {
      try {
        expectView(key, "board")(view);
        frames++;
      } catch (e) {
        badFrame ??= `${key}: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    if (index.header?.status) gateHeads.add(index.header.status.label);
    if (buildBadge({ live: [s], starting: [], ended: [] }).count === 1) seen.badge = true;
    for (const section of index.sections) {
      if (section.kind !== "cards") continue;
      for (const card of section.items) {
        if (card.pill) gatePills.add(card.pill.label);
        if (card.actions?.[0]) verbs.add(card.actions[0].label);
      }
    }
    for (const section of board.sections) {
      if (section.kind !== "cards") continue;
      for (const card of section.items) {
        if (
          card.pill?.label === "reviewing" &&
          card.fields?.some((f) => String(f.value).startsWith("@reviewer reviews the plan"))
        ) {
          seen.reviewing = true;
        }
      }
    }
    if (!operatorAnswered && needsYou(s).some((n) => n.kind === "decide")) {
      operatorAnswered = true;
      // The operator answers in Workflows, outside the swarm.
      later(500, async () => {
        await fake.dispatcher.respond!("run_2", "approve-release", "approve");
        shipped("run_2", 9);
      });
    }
  },
});
gated = second;
swarms.set(second.id, second);
const gatedSummary = await second.finished;
const [fixRun, releaseRun] = gatedSummary.runs ?? [];
const gatesOk =
  gatedSummary.status === "done" &&
  fixRun?.verified === true &&
  releaseRun?.verified === true &&
  fixRun.approvals?.[0]?.reviewer === `@${second.id}-reviewer` &&
  releaseRun.approvals === undefined &&
  seen.reviewing &&
  gateHeads.has("1 needs you") &&
  gatePills.has("decide") &&
  verbs.has("Review and approve") &&
  seen.badge &&
  fake.answered.map((a) => a.runId).join(",") === "run_1,run_2";
console.log(
  `gates: status=${gatedSummary.status} runs=${(gatedSummary.runs ?? []).map((r) => `${r.workflow}:${r.status}${r.verified ? "+verified" : ""}`).join(",")} reviewing=${seen.reviewing} heads=${[...gateHeads].join("|")} pills=${[...gatePills].join("|")} verbs=${[...verbs].join("|")} badge=${seen.badge} answered=${fake.answered.map((a) => a.runId).join(",")}`,
);
console.log(
  `boards: ${frames} frames valid in both scenes${badFrame ? `; first invalid: ${badFrame}` : ""}`,
);

let ok =
  gatesOk &&
  !badFrame &&
  frames > 0 &&
  indexOk &&
  summary.status === "done" &&
  mine.length === summary.agents.length &&
  live.length === 0 &&
  replies > 0 &&
  ordered;

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
