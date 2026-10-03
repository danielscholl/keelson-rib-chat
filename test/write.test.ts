import { describe, expect, test } from "bun:test";
import { ClickClackClient } from "../src/clickclack.ts";
import rib from "../src/index.ts";
import { Swarm, type SwarmOptions, WRITER_TOOLS } from "../src/swarm.ts";
import { makeChatTools } from "../src/tools.ts";
import type { RunAgentTurn } from "../src/turn-runner.ts";
import { ownsPr, type SwarmSummary, type WriterPr } from "../src/types.ts";
import { attributionIn, createWorktree, readWriterCi, releaseWorktree } from "../src/worktree.ts";
import {
  FakeClickClack,
  fakeDispatcher,
  fakeGit,
  OWNER_TOKEN,
  type Script,
  scriptedProvider,
  WORKSPACE,
} from "./fakes.ts";

const ROOT = "/repo";
const WT = `${ROOT}/.worktrees/swarm-s1-coder`;
const PR = "https://github.com/o/r/pull/101";
const HEAD = "a".repeat(40);
const check = (conclusion: string | null, status = "COMPLETED") => ({
  __typename: "CheckRun",
  status,
  conclusion,
});
const legacy = (state: string) => ({ __typename: "StatusContext", state });
const rollup = (checks: unknown[], headRefOid = HEAD) =>
  JSON.stringify({ headRefOid, statusCheckRollup: checks });

function harness(script: Script, extra: Partial<SwarmOptions> = {}, git = fakeGit()) {
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
  const start = () =>
    Swarm.start({
      id: "s1",
      task: "Fix the flaky test",
      owner,
      workspaceId: WORKSPACE,
      runAgentTurn: provider.run,
      quiesceMs: 20,
      reconnectMs: 5,
      cwd: ROOT,
      workTools: ["Read", "Grep", "Glob"],
      write: { root: ROOT, git: git.deps },
      onCreated: (s) => swarms.set(s.id, s),
      ...extra,
    });
  return { server, provider, start, git };
}

const turnsOf = (h: ReturnType<typeof harness>, agentId: string) =>
  h.provider.requests.filter((r) => r.turnContext?.agentId === agentId);
const toolNames = (r: { tools?: readonly { name: string }[] }) =>
  (r.tools ?? []).map((t) => t.name);

async function writerHarness(git = fakeGit(), extra: Partial<SwarmOptions> = {}) {
  const h = harness(async () => {}, { quiesceMs: 60_000, ...extra }, git);
  const swarm = await h.start();
  const writer = await swarm.spawn(swarm.summary().agents[0]!.id, {
    handle: "coder",
    role: "r",
    brief: "b",
    writes: true,
  });
  git.commits.set(WT, [{ sha: HEAD, subject: "fix: x", message: "fix: x\n" }]);
  return { ...h, swarm, writer };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}

describe("writer CI lifecycle", () => {
  test("writer-only swarms poll terminal observations without waking agents or duplicating reads", async () => {
    const git = fakeGit();
    git.prChecks.set(PR, rollup([check("SUCCESS")]));
    const dispatcher = fakeDispatcher();
    const kinds: string[] = [];
    const h = await writerHarness(git, {
      dispatch: { grants: [], dispatcher: dispatcher.dispatcher, pollMs: 5 },
      onChange: (kind) => kinds.push(kind),
    });
    await h.swarm.openPr(h.writer.id, { title: "fix: x", body: "b" });
    expect(h.swarm.summary().prs?.[0]?.ci?.verdict).toBe("pass");
    await until(() => h.swarm.summary().agents.every((a) => a.status !== "busy"));
    const turns = h.swarm.summary().turnsUsed;
    const publications = kinds.filter((k) => k === "agent").length;
    await until(() => git.ran("gh pr view").length >= 3);
    expect(kinds.filter((k) => k === "agent")).toHaveLength(publications);
    let release!: (response: string) => void;
    git.prChecks.set(
      PR,
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const before = git.ran("gh pr view").length;
    await until(() => git.ran("gh pr view").length === before + 1);
    await Bun.sleep(25);
    expect(git.ran("gh pr view")).toHaveLength(before + 1);
    git.prChecks.set(PR, rollup([check("FAILURE")]));
    release(rollup([check("FAILURE")]));
    await until(() => h.swarm.summary().prs?.[0]?.ci?.verdict === "fail");
    expect(h.swarm.summary().runs).toBeUndefined();
    expect(h.swarm.summary().turnsUsed).toBe(turns);
    const ended = await h.swarm.stop();
    expect(ended.prs?.[0]?.ci?.verdict).toBe("fail");
  });

  test("new pushes invalidate pass and an old-head in-flight response cannot restore it", async () => {
    const git = fakeGit();
    git.prChecks.set(PR, rollup([check("SUCCESS")]));
    const h = await writerHarness(git, {
      dispatch: { grants: [], dispatcher: fakeDispatcher().dispatcher, pollMs: 5 },
    });
    await h.swarm.openPr(h.writer.id, { title: "fix: x", body: "b" });
    let release!: (response: string) => void;
    git.prChecks.set(
      PR,
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const reads = git.ran("gh pr view").length;
    await until(() => git.ran("gh pr view").length > reads);
    const nextHead = "b".repeat(40);
    git.heads.set(WT, nextHead);
    const pushed = h.swarm.openPr(h.writer.id, { title: "fix: x", body: "b" });
    await until(() => h.swarm.summary().prs?.[0]?.ci === undefined);
    git.prChecks.set(PR, rollup([check("SUCCESS")]));
    release(rollup([check("SUCCESS")]));
    await pushed;
    expect(h.swarm.summary().prs?.[0]?.ci).toBeUndefined();
    // The forge may still report the old head on the next poll.
    git.prChecks.set(PR, rollup([check("SUCCESS")]));
    await h.swarm.openPr(h.writer.id, { title: "fix: x", body: "b" });
    expect(h.swarm.summary().prs?.[0]?.ci).toBeUndefined();
    git.prChecks.set(PR, rollup([check(null, "IN_PROGRESS")], nextHead));
    await h.swarm.openPr(h.writer.id, { title: "fix: x", body: "b" });
    expect(h.swarm.summary().prs?.[0]?.ci?.verdict).toBe("running");
    expect(git.ran("gh pr create")).toHaveLength(1);
    await h.swarm.stop();
  });

  test("independent writers collect evidence and a failed read is visible and recoverable", async () => {
    const git = fakeGit();
    git.prChecks.set(PR, new Error("forge unavailable"));
    const h = await writerHarness(git);
    const opened = await h.swarm.openPr(h.writer.id, { title: "fix: x", body: "b" });
    expect(opened.url).toBe(PR);
    expect(h.swarm.summary().prs?.[0]?.ci).toEqual({
      verdict: "unknown",
      detail: "gh pr view failed: forge unavailable",
    });
    expect(h.swarm.summary().activity).toContainEqual(
      expect.objectContaining({
        kind: "fault",
        subject: PR,
      }),
    );
    const other = await h.swarm.spawn(h.swarm.summary().agents[0]!.id, {
      handle: "other",
      role: "r",
      brief: "b",
      writes: true,
    });
    git.commits.set(other.worktree!.path, [{ sha: HEAD, subject: "fix: y", message: "fix: y" }]);
    const otherPr = "https://github.com/o/r/pull/102";
    git.prChecks.set(otherPr, rollup([legacy("FAILURE")]));
    await h.swarm.openPr(other.id, { title: "fix: y", body: "b" });
    git.prChecks.set(PR, rollup([legacy("SUCCESS")]));
    await h.swarm.openPr(h.writer.id, { title: "fix: x", body: "b" });
    expect(h.swarm.summary().prs?.map((p) => p.ci?.verdict)).toEqual(["pass", "fail"]);
    expect((await h.swarm.stop()).prs?.map((p) => p.ci?.verdict)).toEqual(["pass", "fail"]);
  });

  test("shutdown discards older reads, saves one final observation and never publishes late results", async () => {
    const git = fakeGit();
    git.prChecks.set(PR, rollup([check(null, "QUEUED")]));
    const kinds: string[] = [];
    const h = await writerHarness(git, {
      dispatch: { grants: [], dispatcher: fakeDispatcher().dispatcher, pollMs: 5 },
      onChange: (kind) => kinds.push(kind),
    });
    await h.swarm.openPr(h.writer.id, { title: "fix: x", body: "b" });
    let release!: (response: string) => void;
    git.prChecks.set(
      PR,
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const before = git.ran("gh pr view").length;
    await until(() => git.ran("gh pr view").length > before);
    const reads = git.ran("gh pr view").length;
    const stopped = h.swarm.stop();
    git.prChecks.set(PR, rollup([check("FAILURE")]));
    release(rollup([check("SUCCESS")]));
    const ended = await stopped;
    expect(git.ran("gh pr view")).toHaveLength(reads + 1);
    expect(ended.prs?.[0]?.ci?.verdict).toBe("fail");
    const snapshot = JSON.stringify(h.swarm.summary());
    const publications = kinds.length;
    await Bun.sleep(25);
    expect(JSON.stringify(h.swarm.summary())).toBe(snapshot);
    expect(kinds).toHaveLength(publications);
  });

  test("a final read timeout keeps the last observation and drops a late success", async () => {
    const git = fakeGit();
    git.prChecks.set(PR, rollup([check(null, "QUEUED")]));
    const h = await writerHarness(git);
    await h.swarm.openPr(h.writer.id, { title: "fix: x", body: "b" });
    let release!: (response: string) => void;
    git.prChecks.set(
      PR,
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const reads = git.ran("gh pr view").length;
    const ended = await h.swarm.stop();
    expect(ended.prs?.[0]?.ci?.verdict).toBe("running");
    expect(git.ran("gh pr view")).toHaveLength(reads + 1);
    expect(git.ran("gh pr view").every((call) => call.timeoutMs === 3_000)).toBe(true);
    release(rollup([check("SUCCESS")]));
    await Bun.sleep(10);
    expect(h.swarm.summary().prs?.[0]?.ci).toEqual(ended.prs?.[0]?.ci);
  });
});

describe("writer PR CI reader", () => {
  test("maps current-head checks conservatively, including legacy statuses", async () => {
    const git = fakeGit();
    const cases: [unknown[], NonNullable<WriterPr["ci"]>["verdict"] | undefined][] = [
      [[], undefined],
      [[check("SUCCESS")], "pass"],
      [[check("SUCCESS"), check("NEUTRAL"), check("SKIPPED")], "pass"],
      [[check("NEUTRAL"), check("SKIPPED")], "unknown"],
      [[check("FAILURE")], "fail"],
      [[check("CANCELLED")], "fail"],
      [[check(null, "QUEUED")], "running"],
      [[check(null, "IN_PROGRESS")], "running"],
      [[check("FAILURE"), check(null, "QUEUED")], "fail"],
      [[check("SUCCESS"), check("NEW_CONCLUSION")], "unknown"],
      [[check("SUCCESS", "NEW_STATUS")], "unknown"],
      [[legacy("SUCCESS")], "pass"],
      [[legacy("PENDING")], "running"],
      [[legacy("ERROR"), legacy("PENDING")], "fail"],
      [[legacy("NEW_STATE")], "unknown"],
      [[{ __typename: "NewCheck", state: "SUCCESS" }], "unknown"],
    ];
    for (const [checks, verdict] of cases) {
      git.prChecks.set(PR, rollup(checks));
      const observed = await readWriterCi(git.deps, ROOT, PR);
      expect(observed.headRefOid).toBe(HEAD);
      expect(observed.ci?.verdict).toBe(verdict);
    }
    expect(git.ran("gh pr create")).toHaveLength(0);
    expect(git.calls[0]).toEqual({
      cmd: "gh",
      args: ["pr", "view", PR, "--json", "headRefOid,statusCheckRollup"],
      cwd: ROOT,
      timeoutMs: 3_000,
    });
    git.prChecks.set(PR, JSON.stringify({ headRefOid: HEAD, statusCheckRollup: null }));
    expect((await readWriterCi(git.deps, ROOT, PR)).ci).toBeUndefined();
  });

  test("malformed JSON, malformed fields and CLI errors propagate", async () => {
    const git = fakeGit();
    for (const response of ["not json", "{}", rollup([null]), new Error("not authenticated")]) {
      git.prChecks.set(PR, response);
      await expect(readWriterCi(git.deps, ROOT, PR)).rejects.toThrow();
    }
  });

  test("a deferred CLI response is bounded even when the execution seam hangs", async () => {
    const git = fakeGit();
    git.prChecks.set(PR, () => new Promise(() => {}));
    await expect(readWriterCi(git.deps, ROOT, PR, 5)).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(git.calls[0]?.timeoutMs).toBe(5);
  });
});

describe("write mode", () => {
  test("launch capability is explicit before a writer exists and absent on read/chat launches", async () => {
    for (const extra of [{}, { write: undefined }, { write: undefined, workTools: undefined }]) {
      const h = harness(async () => {}, { quiesceMs: 60_000, ...extra });
      const swarm = await h.start();
      const summary = swarm.summary();
      expect(summary.writeEnabled).toBe(
        extra.write === undefined && "write" in extra ? undefined : true,
      );
      expect(summary.prs).toBeUndefined();
      expect(summary.agents.some((a) => a.worktree)).toBe(false);
      await swarm.stop();
    }
  });

  test("writer CI is optional and summary observations are defensive copies", async () => {
    const h = await writerHarness();
    await h.swarm.openPr(h.writer.id, { title: "fix: x", body: "b" });
    expect(h.swarm.summary().prs?.[0]?.ci).toBeUndefined();
    h.git.prChecks.set(PR, rollup([check(null, "QUEUED")]));
    await h.swarm.openPr(h.writer.id, { title: "fix: x", body: "b" });
    const snapshot = h.swarm.summary();
    snapshot.prs![0]!.ci!.detail = "changed by caller";
    expect(h.swarm.summary().prs?.[0]?.ci).toEqual({
      verdict: "running",
      detail: "1 check(s): running",
    });
    await h.swarm.stop();
  });

  test("a spawn with writes is refused in a swarm that only reads", async () => {
    let refusal = "";
    const h = harness(
      async ({ agentId, turn, call }) => {
        if (agentId !== "s1-lead") return;
        if (turn === 1) {
          refusal = (
            await call("chat_spawn", { handle: "coder", role: "r", brief: "b", writes: true })
          ).content;
        } else await call("chat_done", { summary: "ok" });
      },
      { write: undefined },
    );
    const summary = await (await h.start()).finished;
    expect(refusal).toContain("writes: true needs a swarm started with work_tools 'write'");
    expect(summary.agents.map((a) => a.handle)).toEqual(["s1-lead"]);
    expect(h.git.calls).toHaveLength(0);
  });

  test("only the lead spawns a writer", async () => {
    let refusal = "";
    const h = harness(async ({ agentId, turn, call }) => {
      if (agentId === "s1-lead" && turn === 1) {
        await call("chat_spawn", { handle: "helper", role: "r", brief: "b" });
      } else if (agentId === "s1-helper") {
        refusal = (
          await call("chat_spawn", { handle: "coder", role: "r", brief: "b", writes: true })
        ).content;
      } else if (agentId === "s1-lead") await call("chat_done", { summary: "ok" });
    });
    await (await h.start()).finished;
    expect(refusal).toContain("only the lead may spawn a writer");
  });

  test("a writer's turns get the write tools in its own worktree; everyone else only reads", async () => {
    const h = harness(async ({ agentId, turn, call }) => {
      if (agentId === "s1-lead" && turn === 1) {
        const spawned = await call("chat_spawn", {
          handle: "coder",
          role: "writes the fix",
          brief: "Fix it.",
          writes: true,
        });
        expect(spawned.content).toContain(`It writes in ${WT} on branch keelson/swarm/s1/coder.`);
        await call("chat_spawn", { handle: "reviewer", role: "reviews", brief: "Review it." });
      } else if (agentId === "s1-lead") {
        await call("chat_done", { summary: "ok" });
      }
    });
    const summary = await (await h.start()).finished;

    const [writer] = turnsOf(h, "s1-coder");
    expect(writer?.cwd).toBe(WT);
    expect(writer?.allowedDirectories).toEqual([WT]);
    for (const tool of WRITER_TOOLS) expect(toolNames(writer ?? {})).toContain(tool);
    expect(writer?.system).toContain(`You are a WRITER. Your own git worktree is ${WT}`);

    for (const id of ["s1-lead", "s1-reviewer"]) {
      const [turn] = turnsOf(h, id);
      expect(turn?.cwd).toBe(ROOT);
      expect(turn?.allowedDirectories).toEqual([ROOT]);
      expect(toolNames(turn ?? {})).toContain("Read");
      for (const tool of ["Edit", "Write", "Bash"])
        expect(toolNames(turn ?? {})).not.toContain(tool);
      expect(turn?.system).not.toContain("You are a WRITER");
    }
    expect(turnsOf(h, "s1-lead")[0]?.system).toContain("chat_spawn a worker with writes: true");

    const coder = summary.agents.find((a) => a.handle === "s1-coder");
    expect(coder?.worktree).toEqual({ path: WT, branch: "keelson/swarm/s1/coder", base: "main" });
    expect(summary.agents.find((a) => a.handle === "s1-reviewer")?.worktree).toBeUndefined();
  });

  test("a worktree is cut from the fetched remote default branch, never a local one", async () => {
    const git = fakeGit({ defaultBranch: "trunk" });
    const wt = await createWorktree(git.deps, ROOT, "s1", "coder");
    const lines = git.calls.map((c) => `${c.cmd} ${c.args.join(" ")}`);
    const fetch = lines.indexOf("git fetch origin");
    const add = lines.findIndex((l) => l.startsWith("git worktree add"));
    expect(fetch).toBeGreaterThanOrEqual(0);
    expect(add).toBeGreaterThan(fetch);
    expect(lines[add]).toBe(
      `git worktree add --no-track -b keelson/swarm/s1/coder ${WT} origin/trunk`,
    );
    expect(wt).toEqual({ path: WT, branch: "keelson/swarm/s1/coder", base: "trunk" });
    expect(git.calls.every((c) => c.cwd === ROOT)).toBe(true);
    // Not ignored by the project: excluded locally instead.
    expect(git.appended).toEqual([{ file: `${ROOT}/.git/info/exclude`, line: "/.worktrees/" }]);
  });

  test("a project that already ignores .worktrees is left alone", async () => {
    const git = fakeGit({ ignored: true });
    await createWorktree(git.deps, ROOT, "s1", "coder");
    expect(git.appended).toEqual([]);
  });

  test("a project with no origin default branch refuses the writer", async () => {
    let refusal = "";
    const h = harness(
      async ({ agentId, turn, call }) => {
        if (agentId !== "s1-lead") return;
        if (turn === 1) {
          refusal = (
            await call("chat_spawn", { handle: "coder", role: "r", brief: "b", writes: true })
          ).content;
        } else await call("chat_done", { summary: "ok" });
      },
      {},
      fakeGit({ defaultBranch: null }),
    );
    const summary = await (await h.start()).finished;
    expect(refusal).toContain("could not make a worktree for @s1-coder");
    expect(refusal).toContain("no origin default branch");
    expect(summary.agents.map((a) => a.handle)).toEqual(["s1-lead"]);
  });

  test("at the end a clean worktree is removed and one with unsaved work is kept and listed", async () => {
    const git = fakeGit();
    const dirtyWt = `${ROOT}/.worktrees/swarm-s1-messy`;
    git.dirty.set(dirtyWt, " M src/a.ts\n?? src/b.ts\n");
    git.ahead.set(dirtyWt, 2);
    const h = harness(
      async ({ agentId, turn, call }) => {
        if (agentId === "s1-lead" && turn === 1) {
          await call("chat_spawn", { handle: "coder", role: "r", brief: "b", writes: true });
          await call("chat_spawn", { handle: "messy", role: "r", brief: "b", writes: true });
        } else if (agentId === "s1-lead") await call("chat_done", { summary: "ok" });
      },
      {},
      git,
    );
    const summary = await (await h.start()).finished;

    expect(git.ran(`git worktree remove ${WT}`)).toHaveLength(1);
    expect(git.ran("git branch -D keelson/swarm/s1/coder")).toHaveLength(1);
    expect(git.ran(`git worktree remove ${dirtyWt}`)).toHaveLength(0);
    expect(summary.worktrees).toEqual([
      {
        agent: "s1-messy",
        path: dirtyWt,
        branch: "keelson/swarm/s1/messy",
        reason: "2 uncommitted change(s), 2 commit(s) not pushed",
      },
    ]);
  });

  test("a worktree whose branch could not be deleted is listed with why", async () => {
    const git = fakeGit({ failBranchDelete: true });
    const h = harness(
      async ({ agentId, turn, call }) => {
        if (agentId === "s1-lead" && turn === 1) {
          await call("chat_spawn", { handle: "coder", role: "r", brief: "b", writes: true });
        } else if (agentId === "s1-lead") await call("chat_done", { summary: "ok" });
      },
      {},
      git,
    );
    const summary = await (await h.start()).finished;
    expect(summary.worktrees).toEqual([
      {
        agent: "s1-coder",
        path: WT,
        branch: "keelson/swarm/s1/coder",
        reason: "the worktree was removed, but its local branch was not: cannot lock ref",
      },
    ]);
  });

  test("a branch delete that throws is a kept reason, not a stuck swarm", async () => {
    const git = fakeGit();
    const run = git.deps.run;
    const deps = {
      ...git.deps,
      run: async (cmd: string, args: string[], o?: { cwd?: string }) => {
        if (args[0] === "branch") throw new Error("spawn failed");
        return run(cmd, args, o);
      },
    };
    const reason = await releaseWorktree(deps, ROOT, {
      path: WT,
      branch: "keelson/swarm/s1/coder",
      base: "main",
    });
    expect(reason).toBe("the worktree was removed, but its local branch was not: spawn failed");
  });

  test("a writer whose turn has not settled keeps its worktree", async () => {
    const git = fakeGit();
    let writing: () => void = () => {};
    const writerStarted = new Promise<void>((resolve) => {
      writing = resolve;
    });
    let run: RunAgentTurn = () => {
      throw new Error("not wired");
    };
    const h = harness(
      async ({ agentId, turn, call }) => {
        if (agentId === "s1-lead" && turn === 1) {
          await call("chat_spawn", { handle: "coder", role: "r", brief: "b", writes: true });
        }
      },
      {
        settleMs: 20,
        runAgentTurn: (req) => {
          if (req.turnContext?.agentId !== "s1-coder") return run(req);
          // A provider still writing: its result outlives the swarm's abort.
          writing();
          return { stream: (async function* () {})(), result: new Promise(() => {}) };
        },
      },
      git,
    );
    run = h.provider.run;
    const swarm = await h.start();
    await writerStarted;
    const summary = await swarm.stop();
    expect(git.ran(`git worktree remove ${WT}`)).toHaveLength(0);
    expect(git.ran("git status")).toHaveLength(0);
    expect(summary.worktrees).toEqual([
      {
        agent: "s1-coder",
        path: WT,
        branch: "keelson/swarm/s1/coder",
        reason: "its last turn had not finished when the swarm ended",
      },
    ]);
  });

  test("a writer still being spawned when the swarm stops is revoked and cleaned up", async () => {
    let release: () => void = () => {};
    const git = fakeGit({
      holdAdd: new Promise<void>((resolve) => {
        release = resolve;
      }),
    });
    let spawning: () => void = () => {};
    const spawnStarted = new Promise<void>((resolve) => {
      spawning = resolve;
    });
    let spawned: Promise<{ content: string; isError: boolean }> | undefined;
    const h = harness(
      async ({ agentId, turn, call }) => {
        if (agentId === "s1-lead" && turn === 1) {
          spawned = call("chat_spawn", { handle: "coder", role: "r", brief: "b", writes: true });
          spawning();
          await spawned;
        }
      },
      {},
      git,
    );
    const swarm = await h.start();
    await spawnStarted;
    const stopped = swarm.stop();
    release();
    const summary = await stopped;
    const result = await spawned;
    expect(result?.isError).toBe(true);
    expect(summary.agents.map((a) => a.handle)).toContain("s1-coder");
    expect(h.server.tokens.get("ccb_s1-coder")?.revoked).toBe(true);
    expect(git.ran(`git worktree remove ${WT}`)).toHaveLength(1);
  });

  test("chat_pr_open refuses commits that credit an AI, and pushes nothing", async () => {
    const git = fakeGit();
    git.commits.set(WT, [
      { sha: "a".repeat(40), subject: "fix: clean", message: "fix: clean\n" },
      {
        sha: "b".repeat(40),
        subject: "fix: the flake",
        message: "fix: the flake\n\nBody.\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>\n",
      },
      {
        sha: "c".repeat(40),
        subject: "test: cover it",
        message:
          "test: cover it\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n",
      },
    ]);
    let refusal = { content: "", isError: false };
    const h = harness(
      async ({ agentId, turn, call }) => {
        if (agentId === "s1-lead" && turn === 1) {
          await call("chat_spawn", { handle: "coder", role: "r", brief: "b", writes: true });
        } else if (agentId === "s1-coder") {
          refusal = await call("chat_pr_open", { title: "fix: the flake", body: "Fixes it." });
        } else if (agentId === "s1-lead") await call("chat_done", { summary: "ok" });
      },
      {},
      git,
    );
    const summary = await (await h.start()).finished;
    expect(refusal.isError).toBe(true);
    expect(refusal.content).toContain("2 commit(s) carry AI attribution");
    expect(refusal.content).toContain(
      'bbbbbbb fix: the flake: "Co-Authored-By: Claude Opus <noreply@anthropic.com>"',
    );
    expect(refusal.content).toContain("ccccccc test: cover it");
    expect(refusal.content).not.toContain("aaaaaaa");
    expect(git.ran("git push")).toHaveLength(0);
    expect(git.ran("gh")).toHaveLength(0);
    expect(summary.prs).toBeUndefined();
  });

  test("attribution is any generated-with footer, or a trailer or line naming an assistant", () => {
    for (const text of [
      "fix: x\n\n🤖 Generated with [Aider](https://aider.chat)",
      "fix: x\n\nGenerated with a tool",
      "fix: x\n\nThis change was generated by Claude.",
      "fix: x\n\nCo-authored-by: GitHub Copilot <copilot@github.com>",
      "fix: x\n\nCo-Authored-By: Aider <noreply@aider.chat>",
      "fix: x\n\nThis was generated by Aider.",
      "fix: x\n\nClaude-Session: https://claude.ai/code/abc",
    ]) {
      expect(attributionIn(text)).toBeDefined();
    }
    for (const text of [
      "fix: regenerate the lockfile",
      "fix: x\n\nThe parser is generated with protoc from api.proto.",
      "fix: x\n\nCo-authored-by: Ada Lovelace <ada@example.com>",
    ]) {
      expect(attributionIn(text)).toBeUndefined();
    }
  });

  test("an overlong pull request title is refused with how much to cut", async () => {
    const tool = makeChatTools({
      swarms: new Map(),
      ended: new Map(),
      startSwarm: async () => {
        throw new Error("not used");
      },
    }).find((t) => t.name === "chat_pr_open");
    const parsed = tool?.inputSchema.safeParse({ title: "x".repeat(210), body: "b" });
    expect(parsed?.success).toBe(false);
    expect(JSON.stringify(parsed?.error?.issues)).toContain("Cut at least 10 characters");
  });

  test("chat_pr_open refuses attribution in the body, and a reader cannot call it", async () => {
    const git = fakeGit();
    git.commits.set(WT, [{ sha: "a".repeat(40), subject: "fix: x", message: "fix: x\n" }]);
    let body = "";
    let reader = "";
    const h = harness(
      async ({ agentId, turn, call }) => {
        if (agentId === "s1-lead" && turn === 1) {
          await call("chat_spawn", { handle: "coder", role: "r", brief: "b", writes: true });
          reader = (await call("chat_pr_open", { title: "t", body: "b" })).content;
        } else if (agentId === "s1-coder") {
          body = (
            await call("chat_pr_open", {
              title: "fix: x",
              body: "Fixes it.\n\nGenerated with Claude Code",
            })
          ).content;
        } else if (agentId === "s1-lead") await call("chat_done", { summary: "ok" });
      },
      {},
      git,
    );
    await (await h.start()).finished;
    expect(body).toContain("the title or body carries AI attribution");
    expect(reader).toBe("tool chat_pr_open not granted");
    expect(git.ran("gh")).toHaveLength(0);
  });

  test("chat_pr_open opens one draft, records it, and a second call only pushes", async () => {
    const git = fakeGit();
    git.commits.set(WT, [{ sha: "a".repeat(40), subject: "fix: x", message: "fix: x\n" }]);
    const opened: string[] = [];
    let leadPrompt = "";
    let diff = "";
    const h = harness(
      async ({ agentId, turn, call, prompt }) => {
        if (agentId === "s1-lead" && turn === 1) {
          await call("chat_spawn", { handle: "coder", role: "r", brief: "b", writes: true });
          await call("chat_spawn", { handle: "reviewer", role: "r", brief: "b" });
        } else if (agentId === "s1-coder" && turn === 1) {
          opened.push((await call("chat_pr_open", { title: "fix: x", body: "Fixes it." })).content);
          opened.push((await call("chat_pr_open", { title: "fix: x", body: "Again." })).content);
          await call("chat_post", { body: "@s1-lead opened it" });
        } else if (agentId === "s1-reviewer") {
          diff = (await call("chat_diff", { writer: "coder" })).content;
        } else if (agentId === "s1-lead") {
          leadPrompt = prompt;
          await call("chat_done", { summary: "ok" });
        }
      },
      {},
      git,
    );
    const summary = await (await h.start()).finished;
    const url = "https://github.com/o/r/pull/101";

    expect(opened[0]).toBe(
      `opened draft pull request ${url}. Report it to the lead; the operator merges.`,
    );
    expect(opened[1]).toBe(`pushed your branch; your pull request is already open: ${url}`);
    expect(git.ran("git push -u origin keelson/swarm/s1/coder")).toHaveLength(2);
    const created = git.ran("gh pr create");
    expect(created).toHaveLength(1);
    expect(created[0]?.args).toEqual([
      "pr",
      "create",
      "--draft",
      "--base",
      "main",
      "--head",
      "keelson/swarm/s1/coder",
      "--title",
      "fix: x",
      "--body",
      "Fixes it.",
    ]);
    expect(created[0]?.cwd).toBe(WT);
    expect(git.ran("gh pr merge")).toHaveLength(0);

    expect(summary.prs).toEqual([
      expect.objectContaining({ agent: "s1-coder", url, branch: "keelson/swarm/s1/coder" }),
    ]);
    expect(summary.agents.find((a) => a.handle === "s1-coder")?.prUrl).toBe(url);
    expect(summary.activity?.some((e) => e.kind === "pr" && e.subject === url)).toBe(true);
    expect(leadPrompt).toContain(`@s1-coder draft ${url}`);
    expect(ownsPr(summary, url)).toBe(true);
    expect(ownsPr(summary, "https://github.com/o/r/pull/7")).toBe(false);
    expect(diff).toContain("Branch keelson/swarm/s1/coder against origin/main");
    expect(git.ran("git diff origin/main...HEAD")[0]?.cwd).toBe(WT);
  });

  test("a start with write and no project is refused before a swarm exists", async () => {
    const tools =
      rib.registerTools?.({
        getExec: () => ({}) as never,
        runAgentTurn: (() => {
          throw new Error("no turn should run");
        }) as never,
      }) ?? [];
    let out = "";
    try {
      await tools
        .find((t) => t.name === "chat_swarm_start")
        ?.execute(
          { task: "write with no project", work_tools: "write" },
          {
            cwd: "/tmp",
            abortSignal: new AbortController().signal,
            emit: (c) => {
              if (c.type === "tool_result") out = String(c.content);
            },
          },
        );
      expect(out).toContain("work_tools 'write' needs a project");
      const status = tools.find((t) => t.name === "chat_swarm_status");
      let listed = "";
      await status?.execute(
        {},
        {
          cwd: "/tmp",
          abortSignal: new AbortController().signal,
          emit: (c) => {
            if (c.type === "tool_result") listed = String(c.content);
          },
        },
      );
      const rows = JSON.parse(listed) as { task: string }[];
      expect(rows.some((r) => r.task === "write with no project")).toBe(false);
    } finally {
      await rib.dispose?.();
    }
  });
});
