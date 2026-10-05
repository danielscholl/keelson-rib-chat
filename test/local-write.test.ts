import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  type WorktreeDeps,
} from "../src/worktree.ts";
import {
  FakeClickClack,
  fakeGit,
  OWNER_TOKEN,
  type Script,
  scriptedProvider,
  WORKSPACE,
} from "./fakes.ts";

const ROOT = "/repo";
const HEAD = "a".repeat(40);

async function localHarness(
  git: {
    deps: WorktreeDeps;
    calls: ReturnType<typeof fakeGit>["calls"];
    ran: ReturnType<typeof fakeGit>["ran"];
  } = fakeGit({ origin: false }),
  root = ROOT,
  script: Script = async () => {},
) {
  const server = new FakeClickClack();
  const swarms = new Map<string, Swarm>();
  const tools = makeChatTools({
    swarms,
    ended: new Map<string, SwarmSummary>(),
    startSwarm: async () => {
      throw new Error("not used");
    },
  });
  const provider = scriptedProvider(tools, script);
  const swarm = await Swarm.start({
    id: "s1",
    task: "Change code locally",
    owner: new ClickClackClient("http://fake", OWNER_TOKEN, server.transport),
    workspaceId: WORKSPACE,
    runAgentTurn: provider.run,
    cwd: root,
    workTools: ["Read", "Grep", "Glob"],
    write: { root, git: git.deps },
    quiesceMs: 60_000,
    onCreated: (s) => swarms.set(s.id, s),
  });
  const call = async (name: string, input: unknown, agentId?: string) => {
    const tool = tools.find((tool) => tool.name === name)!;
    let result = { content: "", isError: false };
    await tool.execute(input, {
      cwd: root,
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

  test.each(["failure", "timeout", "no merge state"] as const)(
    "checks for rollback when conflict inspection fails: %s",
    async (failure) => {
      const git = fakeGit({ origin: false });
      const wt = await createWorktree(git.deps, ROOT, "s1", "coder");
      const run = git.deps.run;
      git.deps.run = async (cmd, args, opts) => {
        if (
          (args[0] === "merge" && args[1] === "--no-ff") ||
          args[0] === "diff" ||
          (args[1] === "--verify" && args.at(-1) === "MERGE_HEAD")
        ) {
          git.calls.push({ cmd, args, cwd: opts?.cwd ?? "", timeoutMs: opts?.timeoutMs });
          if (args.at(-1) === "MERGE_HEAD")
            return failure === "no merge state"
              ? { ok: false, error: "no merge in progress", code: 1 }
              : { ok: true, data: HEAD, exitCode: 0 };
          if (args[0] === "diff") {
            if (failure === "timeout") throw new Error("conflict inspection timed out");
            return { ok: false, error: "conflict inspection failed", code: 1 };
          }
          return { ok: false, error: "merge conflict", code: 1 };
        }
        return run(cmd, args, opts);
      };

      await expect(mergeWorktree(git.deps, ROOT, wt, "coder", HEAD)).rejects.toThrow(
        failure === "timeout" ? "conflict inspection timed out" : "conflict inspection failed",
      );
      expect(git.ran("git rev-parse --verify --quiet MERGE_HEAD")).toHaveLength(1);
      expect(git.ran("git merge --abort")).toHaveLength(failure === "no merge state" ? 0 : 1);
      expect(git.heads.get(ROOT)).toBeUndefined();
    },
  );

  test.each(["failure", "timeout"] as const)(
    "surfaces rollback errors when conflict inspection also fails: %s",
    async (failure) => {
      const git = fakeGit({ origin: false });
      const wt = await createWorktree(git.deps, ROOT, "s1", "coder");
      const run = git.deps.run;
      git.deps.run = async (cmd, args, opts) => {
        if (
          args[0] === "merge" ||
          args[0] === "diff" ||
          (args[1] === "--verify" && args.at(-1) === "MERGE_HEAD")
        ) {
          git.calls.push({ cmd, args, cwd: opts?.cwd ?? "", timeoutMs: opts?.timeoutMs });
          if (args.at(-1) === "MERGE_HEAD") return { ok: true, data: HEAD, exitCode: 0 };
          if (args[0] === "merge" && args[1] === "--abort") {
            if (failure === "timeout") throw new Error("abort timed out");
            return { ok: false, error: "cannot restore index", code: 1 };
          }
          return { ok: false, error: "merge or conflict inspection failed", code: 1 };
        }
        return run(cmd, args, opts);
      };

      await expect(mergeWorktree(git.deps, ROOT, wt, "coder", HEAD)).rejects.toThrow(
        failure === "timeout"
          ? "git merge --abort failed: abort timed out"
          : "git merge --abort failed: git merge failed: cannot restore index",
      );
      expect(git.ran("git merge --abort")).toHaveLength(1);
    },
  );
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
      const leadPrompt = h.provider.requests.find(
        (req) => req.turnContext?.agentId === lead.id,
      )!.system;
      const writerPrompt = h.provider.requests.find(
        (req) => req.turnContext?.agentId === writer.id,
      )!.system;
      expect(leadPrompt).toContain("peer-reviewed head_sha");
      expect(leadPrompt).toContain("Later writers inherit completed local merges");
      expect(leadPrompt).toContain("merge commits in your report and conclusion");
      expect(writerPrompt).toContain("full HEAD commit SHA");
      expect(writerPrompt).toContain("Never fetch, push, add a remote");
      expect(writerPrompt).not.toContain("call chat_pr_open with a title");
      const reviewer = await h.swarm.spawn(lead.id, {
        handle: "reviewer",
        role: "review",
        brief: "review coder",
      });
      await idle(h.swarm, reviewer.id);
      const reviewRequest = h.provider.requests.find(
        (req) => req.turnContext?.agentId === reviewer.id,
      )!;
      expect(reviewRequest.system).toContain("full reviewed head SHA");
      expect(reviewRequest.tools!.map((t) => t.name)).not.toContain("chat_merge");
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
      expect(h.provider.requests[0]!.system).toContain("Nobody in the swarm merges one");
      expect(h.provider.requests[0]!.system).not.toContain("peer-reviewed head_sha");
    } finally {
      await h.swarm.stop();
    }
  });
});

test("real local swarm merges, inherits the base, and aborts a conflict cleanly", async () => {
  const root = mkdtempSync(join(tmpdir(), "chat-local-write-"));
  const calls: ReturnType<typeof fakeGit>["calls"] = [];
  const run: WorktreeDeps["run"] = async (cmd, args, options) => {
    calls.push({ cmd, args, cwd: options?.cwd ?? "", timeoutMs: options?.timeoutMs });
    const result = Bun.spawnSync([cmd, ...args], {
      cwd: options?.cwd,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    return result.exitCode === 0
      ? { ok: true, data: result.stdout.toString() }
      : { ok: false, error: `${result.stdout}${result.stderr}`, code: result.exitCode };
  };
  const git = async (cwd: string, ...args: string[]) => {
    const result = await run("git", args, { cwd });
    if (!result.ok) throw new Error(result.error);
    return result.data.trim();
  };
  let swarm: Swarm | undefined;
  try {
    await git(root, "init", "--initial-branch=main");
    for (const [key, value] of [
      ["user.name", "Test"],
      ["user.email", "test@example.com"],
      ["commit.gpgsign", "false"],
      ["core.hooksPath", "/dev/null"],
    ])
      await git(root, "config", "--local", key!, value!);
    await git(root, "commit", "--allow-empty", "-m", "Initialize project");
    expect(await git(root, "remote")).toBe("");
    let reviewed = { content: "", isError: false };
    let inherited = "";
    const h = await localHarness(
      {
        deps: { run },
        calls,
        ran: (prefix) => calls.filter((c) => `${c.cmd} ${c.args.join(" ")}`.startsWith(prefix)),
      },
      root,
      async ({ agentId, turn, call }) => {
        if (turn !== 1 || agentId === "s1-lead") return;
        if (agentId === "s1-reviewer") {
          reviewed = await call("chat_diff", { writer: "coder" });
          return;
        }
        const name = agentId.slice("s1-".length);
        const path = join(root, ".worktrees", `swarm-s1-${name}`);
        if (name === "second") inherited = await Bun.file(join(path, "notes.txt")).text();
        await Bun.write(join(path, "notes.txt"), `${name}\n`);
        await git(path, "add", "notes.txt");
        await git(path, "commit", "-m", `feat: write ${name} notes`);
      },
    );
    swarm = h.swarm;
    const lead = swarm.summary().agents[0]!;
    const spawn = async (handle: string, writes = true) => {
      const result = await h.call(
        "chat_spawn",
        {
          handle,
          role: writes ? "writer" : "reviewer",
          brief: "Complete your piece",
          writes,
        },
        lead.id,
      );
      expect(result.isError).toBe(false);
      const agent = swarm!.summary().agents.find((a) => a.handle === `s1-${handle}`)!;
      await idle(swarm!, agent.id);
      return agent;
    };
    const first = await spawn("coder");
    const firstHead = await git(first.worktree!.path, "rev-parse", "HEAD");
    const reviewer = await spawn("reviewer", false);
    expect(reviewed.isError).toBe(false);
    expect(reviewed.content).toContain(`Head: ${firstHead}`);
    expect(reviewed.content).toContain("refs/heads/main");
    expect(reviewed.content).toContain("+coder");
    const landed = await h.call("chat_merge", { writer: "coder", head_sha: firstHead }, lead.id);
    expect(landed.isError).toBe(false);
    const firstMerge = await git(root, "rev-parse", "HEAD");
    expect((await git(root, "rev-list", "--parents", "-n", "1", "HEAD")).split(" ")).toHaveLength(
      3,
    );
    expect(await git(root, "show", "-s", "--format=%B", "HEAD")).toBe(
      `Merge writer @s1-coder branch ${first.worktree!.branch} into main`,
    );
    expect(await git(root, "rev-parse", first.worktree!.branch)).toBe(firstHead);
    expect(landed.content).toContain(firstMerge);
    const second = await spawn("second");
    expect(inherited).toBe("coder\n");
    const conflicting = await spawn("conflicting");
    const secondHead = await git(second.worktree!.path, "rev-parse", "HEAD");
    const secondDiff = await h.call("chat_diff", { writer: "second" }, reviewer.id);
    expect(secondDiff.content).toContain(secondHead);
    expect(
      (await h.call("chat_merge", { writer: "second", head_sha: secondHead }, lead.id)).isError,
    ).toBe(false);
    const beforeHead = await git(root, "rev-parse", "HEAD");
    const beforeIndex = await git(root, "ls-files", "--stage");
    const beforeFile = readFileSync(join(root, "notes.txt"), "utf8");
    const conflictHead = await git(conflicting.worktree!.path, "rev-parse", "HEAD");
    const conflict = await h.call(
      "chat_merge",
      { writer: "conflicting", head_sha: conflictHead },
      lead.id,
    );
    expect(conflict.content).toContain("Merge conflicted and was aborted");
    expect(conflict.content).toContain("Conflicting files:\nnotes.txt\n");
    expect(await git(root, "rev-parse", "HEAD")).toBe(beforeHead);
    expect(await git(root, "ls-files", "--stage")).toBe(beforeIndex);
    expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe(beforeFile);
    expect(await git(root, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
    expect(existsSync(join(root, await git(root, "rev-parse", "--git-path", "MERGE_HEAD")))).toBe(
      false,
    );
    const summary = await swarm.stop();
    expect(summary.prs ?? []).toHaveLength(0);
    expect(summary.activity).toContainEqual(
      expect.objectContaining({
        text: expect.stringContaining(firstMerge),
      }),
    );
    expect(summary.worktrees).toEqual([
      {
        agent: conflicting.handle,
        path: conflicting.worktree!.path,
        branch: conflicting.worktree!.branch,
        reason: "not merged into main",
      },
    ]);
    expect(existsSync(first.worktree!.path)).toBe(false);
    expect(existsSync(second.worktree!.path)).toBe(false);
    expect(existsSync(conflicting.worktree!.path)).toBe(true);
    expect(calls.some((c) => c.cmd !== "git" || ["fetch", "push"].includes(c.args[0]!))).toBe(
      false,
    );
    expect(calls.filter((c) => c.args[0] === "remote").every((c) => c.args.length === 1)).toBe(
      true,
    );
  } finally {
    await swarm?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
