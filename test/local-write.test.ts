import { describe, expect, test } from "bun:test";
import { ClickClackClient } from "../src/clickclack.ts";
import { Swarm } from "../src/swarm.ts";
import { makeChatTools } from "../src/tools.ts";
import type { SwarmSummary } from "../src/types.ts";
import {
  branchCommits,
  branchDiff,
  createWorktree,
  mergeWorktree,
  openDraftPr,
  pushBranch,
  releaseWorktree,
  resolveWriteTarget,
  unsavedWork,
} from "../src/worktree.ts";
import { FakeClickClack, fakeGit, OWNER_TOKEN, scriptedProvider, WORKSPACE } from "./fakes.ts";

const ROOT = "/repo";
const HEAD = "a".repeat(40);

async function localHarness(git = fakeGit({ origin: false })) {
  const server = new FakeClickClack();
  const swarms = new Map<string, Swarm>();
  const tools = makeChatTools({
    swarms,
    ended: new Map<string, SwarmSummary>(),
    startSwarm: async () => {
      throw new Error("not used");
    },
  });
  const provider = scriptedProvider(tools, async () => {});
  const swarm = await Swarm.start({
    id: "s1",
    task: "Change code locally",
    owner: new ClickClackClient("http://fake", OWNER_TOKEN, server.transport),
    workspaceId: WORKSPACE,
    runAgentTurn: provider.run,
    cwd: ROOT,
    workTools: ["Read", "Grep", "Glob"],
    write: { root: ROOT, git: git.deps },
    quiesceMs: 60_000,
    onCreated: (s) => swarms.set(s.id, s),
  });
  const call = async (name: string, input: unknown, agentId?: string) => {
    const tool = tools.find((tool) => tool.name === name)!;
    let result = { content: "", isError: false };
    await tool.execute(input, {
      cwd: ROOT,
      abortSignal: new AbortController().signal,
      ...(agentId ? { turnContext: { swarmId: swarm.id, agentId } } : {}),
      emit: (chunk) => {
        if (chunk.type === "tool_result")
          result = { content: String(chunk.content), isError: chunk.isError === true };
      },
    });
    return result;
  };
  return { swarm, git, tools, provider, call };
}

async function idle(swarm: Swarm, agentId: string) {
  for (let i = 0; i < 200; i++) {
    const agent = swarm.summary().agents.find((a) => a.id === agentId);
    if (agent?.turns && agent.status === "idle") return;
    await Bun.sleep(5);
  }
  throw new Error(`agent ${agentId} did not settle`);
}

describe("local write target", () => {
  test("captures symbolic HEAD and branches from its current ref without fetching", async () => {
    const git = fakeGit({ origin: false, localBase: "trunk" });
    const target = await resolveWriteTarget(git.deps, ROOT);
    expect(target).toEqual({ mode: "local", base: "trunk" });
    const wt = await createWorktree(git.deps, ROOT, "s1", "coder", target);
    expect(wt).toEqual({
      path: "/repo/.worktrees/swarm-s1-coder",
      branch: "keelson/swarm/s1/coder",
      base: "trunk",
      local: true,
    });

    expect(git.ran("git worktree add")[0]?.args.at(-1)).toBe("refs/heads/trunk");
    expect(git.ran("git fetch")).toHaveLength(0);
    const diff = await branchDiff(git.deps, wt);
    expect(diff).toContain(`Head: ${HEAD}`);
    expect(diff).toContain(`refs/heads/trunk...${HEAD}`);
    await branchCommits(git.deps, wt, HEAD);
    expect(git.ran("git log --format")[0]?.args.at(-1)).toBe(`refs/heads/trunk..${HEAD}`);
  });

  test("origin preserves fetched remote worktree shape", async () => {
    const git = fakeGit();
    expect(await resolveWriteTarget(git.deps, ROOT)).toEqual({ mode: "origin" });
    const wt = await createWorktree(git.deps, ROOT, "s1", "coder");
    expect(wt).toEqual({
      path: "/repo/.worktrees/swarm-s1-coder",
      branch: "keelson/swarm/s1/coder",
      base: "main",
    });
    expect(git.ran("git fetch origin")).toHaveLength(1);
  });

  test("refuses detached HEAD or a failed remote listing", async () => {
    const git = fakeGit({ origin: false, localBase: null });
    await expect(resolveWriteTarget(git.deps, ROOT)).rejects.toThrow("symbolic-ref");
    git.deps.run = async () => ({ ok: false, error: "not a repository", code: 1 });
    await expect(resolveWriteTarget(git.deps, ROOT)).rejects.toThrow("not a repository");
  });
});

describe("local cleanup", () => {
  test("retains unmerged and dirty work, releasing only preserved commits", async () => {
    const git = fakeGit({ origin: false });
    const wt = await createWorktree(git.deps, ROOT, "s1", "coder");
    git.ahead.set(wt.path, 1);
    expect(await releaseWorktree(git.deps, ROOT, wt)).toBe("not merged into main");
    expect(git.ran("git worktree remove")).toHaveLength(0);
    git.dirty.set(wt.path, " M file\n?? dir/new\n?? dir/other");
    expect(await unsavedWork(git.deps, wt)).toBe("3 uncommitted change(s), not merged into main");
    git.ahead.set(wt.path, 0);
    expect(await releaseWorktree(git.deps, ROOT, wt)).toBe("3 uncommitted change(s)");
    git.dirty.delete(wt.path);
    expect(await releaseWorktree(git.deps, ROOT, wt)).toBeUndefined();
    expect(git.ran("git worktree remove")).toHaveLength(1);
    expect(git.ran("git rev-list --count")[0]?.args).toContain("refs/heads/main");
    expect(git.ran("git status --porcelain")[0]?.args).toContain("--untracked-files=all");
  });

  test("an unreadable base retains the worktree", async () => {
    const git = fakeGit({ origin: false });
    const wt = await createWorktree(git.deps, ROOT, "s1", "coder");
    const run = git.deps.run;
    git.deps.run = (cmd, args, opts) =>
      args[0] === "rev-list"
        ? Promise.resolve({ ok: false, error: "unknown revision refs/heads/main", code: 1 })
        : run(cmd, args, opts);
    expect(await releaseWorktree(git.deps, ROOT, wt)).toContain("unknown revision");
    expect(git.ran("git worktree remove")).toHaveLength(0);
  });
});

describe("local merge helper", () => {
  test("merges the reviewed head with an engine-owned message and no network", async () => {
    const git = fakeGit({ origin: false });
    const wt = await createWorktree(git.deps, ROOT, "s1", "coder");
    expect(await mergeWorktree(git.deps, ROOT, wt, "coder", HEAD)).toEqual({
      commit: "c".repeat(40),
      message: "Merge made by the 'ort' strategy.",
    });
    expect(git.ran("git merge")[0]?.args).toEqual([
      "merge",
      "--no-ff",
      "--no-edit",
      "--no-autostash",
      "-m",
      `Merge writer @coder branch ${wt.branch} into main`,
      HEAD,
    ]);
    await expect(pushBranch(git.deps, wt)).rejects.toThrow("chat_merge");
    await expect(openDraftPr(git.deps, wt, "title", "body")).rejects.toThrow("chat_merge");
    expect(git.calls.some((c) => c.cmd === "gh" || ["fetch", "push"].includes(c.args[0]!))).toBe(
      false,
    );
  });

  test("refuses dirty checkouts, stale heads, and attributed incoming commits", async () => {
    const git = fakeGit({ origin: false });
    const wt = await createWorktree(git.deps, ROOT, "s1", "coder");
    for (const path of [ROOT, wt.path]) {
      git.dirty.set(path, "?? new");
      await expect(mergeWorktree(git.deps, ROOT, wt, "coder", HEAD)).rejects.toThrow("dirty");
      git.dirty.delete(path);
    }
    await expect(mergeWorktree(git.deps, ROOT, wt, "coder", "b".repeat(40))).rejects.toThrow(
      "HEAD changed",
    );
    git.commits.set(wt.path, [
      { sha: HEAD, subject: "fix", message: "fix\n\nCo-Authored-By: Copilot" },
    ]);
    await expect(mergeWorktree(git.deps, ROOT, wt, "coder", HEAD)).rejects.toThrow(
      "AI attribution",
    );
    expect(git.ran("git merge")).toHaveLength(0);
  });
});

describe("local merge tool", () => {
  test("strict reviewed SHA schema and trusted lead identity", async () => {
    const h = await localHarness();
    try {
      const lead = h.swarm.summary().agents[0]!;
      const writer = await h.swarm.spawn(lead.id, {
        handle: "coder",
        role: "writer",
        brief: "commit",
        writes: true,
      });
      await idle(h.swarm, writer.id);
      const tool = h.tools.find((t) => t.name === "chat_merge")!;
      expect(tool.state_changing).toBe(true);
      expect(tool.inputSchema.safeParse({ writer: "coder", head_sha: HEAD }).success).toBe(true);
      expect(
        tool.inputSchema.safeParse({ writer: "coder", head_sha: "f".repeat(64) }).success,
      ).toBe(true);
      for (const head of ["HEAD", "a".repeat(7), "a".repeat(41)])
        expect(tool.inputSchema.safeParse({ writer: "coder", head_sha: head }).success).toBe(false);
      expect(
        tool.inputSchema.safeParse({ writer: "coder", head_sha: HEAD, base: "other" }).success,
      ).toBe(false);
      const args = { writer: "coder", head_sha: HEAD };
      expect((await h.call("chat_merge", args)).content).toContain("inside a swarm");
      expect((await h.call("chat_merge", args, writer.id)).content).toContain("only the lead");
      expect(
        (await h.call("chat_merge", { ...args, writer: "foreign" }, lead.id)).content,
      ).toContain("not a writer");
      const pr = await h.call("chat_pr_open", { title: "fix: x", body: "b" }, writer.id);
      expect(pr.isError).toBe(true);
      expect(pr.content).toContain("chat_merge");
      const result = await h.call("chat_merge", args, lead.id);
      expect(result.isError).toBe(false);
      expect(result.content).toContain("c".repeat(40));
      expect(h.swarm.summary().activity).toContainEqual(
        expect.objectContaining({
          text: expect.stringContaining(
            `@${writer.handle} merged branch ${writer.worktree!.branch}`,
          ),
        }),
      );
      const leadTools = h.provider.requests.find((req) => req.turnContext?.agentId === lead.id)!
        .tools!;
      const writerTools = h.provider.requests.find((req) => req.turnContext?.agentId === writer.id)!
        .tools!;
      expect(leadTools.map((t) => t.name)).toContain("chat_merge");
      expect(writerTools.map((t) => t.name)).not.toContain("chat_merge");
      expect(h.git.ran("git remote")).toHaveLength(1);
      expect(
        h.git.calls.some((c) => c.cmd === "gh" || ["fetch", "push"].includes(c.args[0]!)),
      ).toBe(false);
    } finally {
      await h.swarm.stop();
    }
  });

  test("origin swarms do not grant or accept local merging", async () => {
    const h = await localHarness(fakeGit());
    try {
      const lead = h.swarm.summary().agents[0]!;
      await idle(h.swarm, lead.id);
      expect(
        (await h.call("chat_merge", { writer: "coder", head_sha: HEAD }, lead.id)).content,
      ).toContain("only available");
      expect(h.provider.requests[0]!.tools!.map((t) => t.name)).not.toContain("chat_merge");
    } finally {
      await h.swarm.stop();
    }
  });
});
