import { describe, expect, test } from "bun:test";
import { branchCommits, branchDiff, createWorktree, resolveWriteTarget } from "../src/worktree.ts";
import { fakeGit } from "./fakes.ts";

const ROOT = "/repo";
const HEAD = "a".repeat(40);

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
