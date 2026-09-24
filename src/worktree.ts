// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { RibExec } from "@keelson/shared";
import type { AgentWorktree } from "./types.ts";

// A writer's own checkout: a git worktree under the project's `.worktrees/`,
// on a branch cut from the remote default branch after a fetch.

export type RunText = RibExec["runText"];

export interface WorktreeDeps {
  run: RunText;
  // Appends a line to a file, creating it; tests pass a recorder.
  append?: (file: string, line: string) => void;
}

export const WORKTREE_DIR = ".worktrees";
const GIT_TIMEOUT_MS = 120_000;

async function git(deps: WorktreeDeps, cwd: string, args: string[]): Promise<string> {
  const out = await deps.run("git", args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
  if (!out.ok) throw new Error(`git ${args[0]} failed: ${out.error}`);
  return out.data;
}

async function gitOk(deps: WorktreeDeps, cwd: string, args: string[]): Promise<boolean> {
  return (await deps.run("git", args, { cwd, timeoutMs: GIT_TIMEOUT_MS })).ok;
}

// Every writer on one repository queues here: concurrent `git worktree add`
// calls race on the repository's config lock.
const queues = new Map<string, Promise<unknown>>();

function serially<T>(root: string, work: () => Promise<T>): Promise<T> {
  const prior = queues.get(root) ?? Promise.resolve();
  const next = prior.then(work, work);
  const settled = next.catch(() => undefined);
  queues.set(root, settled);
  void settled.then(() => {
    if (queues.get(root) === settled) queues.delete(root);
  });
  return next;
}

// The remote's default branch, never a local one: a stale local main is how a
// branch ends up conflicting with origin.
export async function remoteDefaultBranch(deps: WorktreeDeps, root: string): Promise<string> {
  const head = await deps.run("git", ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], {
    cwd: root,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  const ref = head.ok ? head.data.trim().replace(/^refs\/remotes\/origin\//, "") : "";
  if (ref) return ref;
  for (const name of ["main", "master"]) {
    if (
      await gitOk(deps, root, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}`])
    )
      return name;
  }
  throw new Error("the project has no origin default branch to cut a writer's branch from");
}

function appendLine(file: string, line: string): void {
  mkdirSync(dirname(file), { recursive: true });
  let current = "";
  try {
    current = readFileSync(file, "utf8");
  } catch {
    // a missing exclude file is created by the append
  }
  const lead = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  appendFileSync(file, `${lead}${line}\n`);
}

// A project that does not ignore `.worktrees/` gets it in `.git/info/exclude`,
// which stays local and is never committed.
export async function ensureIgnored(deps: WorktreeDeps, root: string): Promise<void> {
  if (await gitOk(deps, root, ["check-ignore", "-q", `${WORKTREE_DIR}/probe`])) return;
  const common = (await git(deps, root, ["rev-parse", "--git-common-dir"])).trim();
  const dir = isAbsolute(common) ? common : join(root, common);
  (deps.append ?? appendLine)(join(dir, "info", "exclude"), `/${WORKTREE_DIR}/`);
}

export function worktreeFor(
  root: string,
  swarmId: string,
  name: string,
  base: string,
): AgentWorktree {
  return {
    path: join(root, WORKTREE_DIR, `swarm-${swarmId}-${name}`),
    branch: `keelson/swarm/${swarmId}/${name}`,
    base,
  };
}

export function createWorktree(
  deps: WorktreeDeps,
  root: string,
  swarmId: string,
  name: string,
): Promise<AgentWorktree> {
  return serially(root, async () => {
    await git(deps, root, ["fetch", "origin"]);
    const base = await remoteDefaultBranch(deps, root);
    await ensureIgnored(deps, root);
    const wt = worktreeFor(root, swarmId, name, base);
    await git(deps, root, [
      "worktree",
      "add",
      "--no-track",
      "-b",
      wt.branch,
      wt.path,
      `origin/${base}`,
    ]);
    return wt;
  });
}

// What would be lost by removing a worktree: uncommitted changes, and commits
// no remote branch holds. Undefined when there is nothing.
export async function unsavedWork(
  deps: WorktreeDeps,
  wt: AgentWorktree,
): Promise<string | undefined> {
  const status = (await git(deps, wt.path, ["status", "--porcelain"])).trim();
  const ahead = Number(
    (await git(deps, wt.path, ["rev-list", "--count", "HEAD", "--not", "--remotes=origin"])).trim(),
  );
  const why = [
    ...(status ? [`${status.split("\n").length} uncommitted change(s)`] : []),
    ...(ahead > 0 ? [`${ahead} commit(s) not pushed`] : []),
  ];
  return why.length > 0 ? why.join(", ") : undefined;
}

// Removes a clean worktree and its local branch; returns why one is kept.
export function releaseWorktree(
  deps: WorktreeDeps,
  root: string,
  wt: AgentWorktree,
): Promise<string | undefined> {
  return serially(root, async () => {
    try {
      const unsaved = await unsavedWork(deps, wt);
      if (unsaved) return unsaved;
      await git(deps, root, ["worktree", "remove", wt.path]);
    } catch (e) {
      return `could not check or remove it: ${e instanceof Error ? e.message : String(e)}`;
    }
    const deleted = await deps
      .run("git", ["branch", "-D", wt.branch], { cwd: root, timeoutMs: GIT_TIMEOUT_MS })
      .catch((e): { ok: false; error: string } => ({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      }));
    return deleted.ok
      ? undefined
      : `the worktree was removed, but its local branch was not: ${deleted.error}`;
  });
}

// Trailers and footers that credit an AI with a change. A pull request carrying
// one is refused before anything is pushed.
const ASSISTANTS =
  "claude|anthropic|openai|chatgpt|gpt|codex|copilot|gemini|cursor|devin|aider|windsurf";
const ATTRIBUTION = [
  new RegExp(`^\\s*co-authored-by:[^\\n]*\\b(${ASSISTANTS})\\b`, "im"),
  /^\W*generated with\b/im,
  new RegExp(`\\bgenerated (with|by)\\b[^\\n]*\\b(${ASSISTANTS}|ai)\\b`, "i"),
  /^\s*claude-session:/im,
  /noreply@anthropic\.com/i,
];

export function attributionIn(text: string): string | undefined {
  for (const pattern of ATTRIBUTION) {
    const hit = pattern.exec(text);
    if (!hit) continue;
    const start = text.lastIndexOf("\n", hit.index) + 1;
    const end = text.indexOf("\n", hit.index + hit[0].length);
    return text.slice(start, end < 0 ? undefined : end).trim();
  }
  return undefined;
}

export interface BranchCommit {
  sha: string;
  subject: string;
  message: string;
}

// The commits on a writer's branch that the remote default branch lacks, newest first.
export async function branchCommits(
  deps: WorktreeDeps,
  wt: AgentWorktree,
): Promise<BranchCommit[]> {
  const out = await git(deps, wt.path, [
    "log",
    "--format=%H%x1f%s%x1f%B%x1e",
    `origin/${wt.base}..HEAD`,
  ]);
  return out
    .split("\x1e")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [sha = "", subject = "", message = ""] = r.split("\x1f");
      return { sha, subject, message };
    });
}

export async function uncommitted(deps: WorktreeDeps, wt: AgentWorktree): Promise<string> {
  return (await git(deps, wt.path, ["status", "--porcelain"])).trim();
}

export async function pushBranch(deps: WorktreeDeps, wt: AgentWorktree): Promise<void> {
  await git(deps, wt.path, ["push", "-u", "origin", wt.branch]);
}

// Opens a draft pull request for the branch against its base; returns its URL.
export async function openDraftPr(
  deps: WorktreeDeps,
  wt: AgentWorktree,
  title: string,
  body: string,
): Promise<string> {
  const out = await deps.run(
    "gh",
    [
      "pr",
      "create",
      "--draft",
      "--base",
      wt.base,
      "--head",
      wt.branch,
      "--title",
      title,
      "--body",
      body,
    ],
    { cwd: wt.path, timeoutMs: GIT_TIMEOUT_MS },
  );
  if (!out.ok) throw new Error(`gh pr create failed: ${out.error}`);
  const url = out.data.match(/https?:\/\/\S+\/pull\/\d+/)?.[0];
  if (!url) throw new Error(`gh pr create printed no pull request URL: ${out.data.trim()}`);
  return url;
}

// A writer's change as a reviewer reads it: its commits, what is not committed,
// and the diff against the remote default branch.
export async function branchDiff(deps: WorktreeDeps, wt: AgentWorktree): Promise<string> {
  const base = `origin/${wt.base}`;
  const [log, status, diff] = await Promise.all([
    git(deps, wt.path, ["log", "--oneline", `${base}..HEAD`]),
    git(deps, wt.path, ["status", "--short"]),
    git(deps, wt.path, ["diff", `${base}...HEAD`]),
  ]);
  return [
    `Branch ${wt.branch} against ${base}, in ${wt.path}.`,
    `Commits:\n${log.trim() || "(none)"}`,
    `Not committed:\n${status.trim() || "(nothing)"}`,
    `Diff (git diff ${base}...HEAD):\n${diff.trim() || "(empty)"}`,
  ].join("\n\n");
}
