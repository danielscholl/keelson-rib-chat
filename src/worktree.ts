// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { RibExec } from "@keelson/shared";
import { z } from "zod";
import type { AgentWorktree, WriterPr } from "./types.ts";

export type RunText = RibExec["runText"];

export type WriteTarget = { mode: "origin" } | { mode: "local"; base: string };

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

export async function resolveWriteTarget(deps: WorktreeDeps, root: string): Promise<WriteTarget> {
  const remotes = (await git(deps, root, ["remote"])).trim().split(/\s+/);
  if (remotes.includes("origin")) return { mode: "origin" };
  const ref = (await git(deps, root, ["symbolic-ref", "--quiet", "HEAD"])).trim();
  if (!ref.startsWith("refs/heads/")) throw new Error("local write mode needs a branch HEAD");
  await git(deps, root, ["rev-parse", "--verify", `${ref}^{commit}`]);
  return { mode: "local", base: ref.slice("refs/heads/".length) };
}

function comparisonRef(wt: AgentWorktree): string {
  return wt.local ? `refs/heads/${wt.base}` : `origin/${wt.base}`;
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
  target?: WriteTarget,
): Promise<AgentWorktree> {
  return serially(root, async () => {
    const selected = target ?? (await resolveWriteTarget(deps, root));
    if (selected.mode === "origin") await git(deps, root, ["fetch", "origin"]);
    const base = selected.mode === "local" ? selected.base : await remoteDefaultBranch(deps, root);
    await ensureIgnored(deps, root);
    const wt = worktreeFor(root, swarmId, name, base);
    if (selected.mode === "local") wt.local = true;
    await git(deps, root, [
      "worktree",
      "add",
      "--no-track",
      "-b",
      wt.branch,
      wt.path,
      comparisonRef(wt),
    ]);
    return wt;
  });
}

// What would be lost by removing a worktree. Undefined when there is nothing.
export async function unsavedWork(
  deps: WorktreeDeps,
  wt: AgentWorktree,
): Promise<string | undefined> {
  const status = (
    await git(deps, wt.path, [
      "status",
      "--porcelain",
      ...(wt.local ? ["--untracked-files=all"] : []),
    ])
  ).trim();
  const ahead = Number(
    (
      await git(deps, wt.path, [
        "rev-list",
        "--count",
        "HEAD",
        "--not",
        wt.local ? comparisonRef(wt) : "--remotes=origin",
      ])
    ).trim(),
  );
  if (!Number.isSafeInteger(ahead) || ahead < 0)
    throw new Error("git returned an invalid commit count");
  const why = [
    ...(status ? [`${status.split("\n").length} uncommitted change(s)`] : []),
    ...(ahead > 0
      ? [wt.local ? `not merged into ${wt.base}` : `${ahead} commit(s) not pushed`]
      : []),
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

// The commits on a writer's branch that its base lacks, newest first.
export async function branchCommits(
  deps: WorktreeDeps,
  wt: AgentWorktree,
  head = "HEAD",
): Promise<BranchCommit[]> {
  const out = await git(deps, wt.path, [
    "log",
    "--format=%H%x1f%s%x1f%B%x1e",
    `${comparisonRef(wt)}..${head}`,
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

async function mergeReady(deps: WorktreeDeps, cwd: string, branch: string): Promise<void> {
  const ref = (await git(deps, cwd, ["symbolic-ref", "--quiet", "HEAD"])).trim();
  if (ref !== `refs/heads/${branch}`) throw new Error(`expected branch ${branch} in ${cwd}`);
  if ((await git(deps, cwd, ["status", "--porcelain=v1", "--untracked-files=all"])).trim())
    throw new Error(`worktree is dirty: ${cwd}`);
  for (const marker of ["MERGE_HEAD", "rebase-merge", "rebase-apply"]) {
    const path = (await git(deps, cwd, ["rev-parse", "--git-path", marker])).trim();
    if (existsSync(isAbsolute(path) ? path : join(cwd, path)))
      throw new Error(`a merge or rebase is already in progress in ${cwd}`);
  }
}

export function mergeWorktree(
  deps: WorktreeDeps,
  root: string,
  wt: AgentWorktree,
  handle: string,
  head: string,
): Promise<{ message: string; commit?: string; conflicts?: string[] }> {
  return serially(root, async () => {
    if (!wt.local) throw new Error("chat_merge is only available for local writers");
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(head))
      throw new Error("head_sha must be a full commit SHA");
    head = head.toLowerCase();
    await mergeReady(deps, root, wt.base);
    await mergeReady(deps, wt.path, wt.branch);
    const writerHead = (
      await git(deps, wt.path, ["rev-parse", "--verify", "HEAD^{commit}"])
    ).trim();
    if (writerHead !== head)
      throw new Error("writer HEAD changed; review its new head before merging");
    const before = (await git(deps, root, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    const commits = await branchCommits(deps, wt, head);
    const attributed = commits.filter((commit) => attributionIn(commit.message));
    if (attributed.length)
      throw new Error(
        `commits carry AI attribution:\n${attributed.map((commit) => `${commit.sha} ${commit.subject}`).join("\n")}`,
      );
    const message = `Merge writer @${handle.replace(/^@/, "")} branch ${wt.branch} into ${wt.base}`;
    if (attributionIn(message)) throw new Error("merge message carries AI attribution");
    const result = await deps.run(
      "git",
      ["merge", "--no-ff", "--no-edit", "--no-autostash", "-m", message, head],
      { cwd: root, timeoutMs: GIT_TIMEOUT_MS },
    );
    if (!result.ok) {
      let conflicts: string[] = [];
      await git(deps, root, ["diff", "--name-only", "--diff-filter=U", "-z"])
        .then((out) => {
          conflicts = out.split("\0").filter(Boolean);
        })
        .finally(async () => {
          if (
            conflicts.length ||
            (await gitOk(deps, root, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]))
          ) {
            await git(deps, root, ["merge", "--abort"]).catch((error: unknown) => {
              throw new Error(
                `git merge --abort failed: ${error instanceof Error ? error.message : String(error)}`,
                { cause: error },
              );
            });
            const restored = (
              await git(deps, root, ["rev-parse", "--verify", "HEAD^{commit}"])
            ).trim();
            if (restored !== before)
              throw new Error(`merge abort did not restore HEAD: ${result.error}`);
            await mergeReady(deps, root, wt.base);
          }
        });
      if (conflicts.length) return { message: result.error, conflicts };
      throw new Error(`git merge failed: ${result.error}`);
    }
    const commit = (await git(deps, root, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    return { message: result.data.trim(), ...(commit !== before ? { commit } : {}) };
  });
}

export async function pushBranch(deps: WorktreeDeps, wt: AgentWorktree): Promise<string> {
  if (wt.local) throw new Error("local writers cannot push; ask the lead to use chat_merge");
  const head = (await git(deps, wt.path, ["rev-parse", "HEAD"])).trim();
  if (!/^[a-f0-9]{40,64}$/i.test(head)) throw new Error("git rev-parse HEAD printed no commit SHA");
  await git(deps, wt.path, ["push", "-u", "origin", wt.branch]);
  return head;
}

// Opens a draft pull request for the branch against its base; returns its URL.
export async function openDraftPr(
  deps: WorktreeDeps,
  wt: AgentWorktree,
  title: string,
  body: string,
): Promise<string> {
  if (wt.local) throw new Error("local writers cannot open a PR; ask the lead to use chat_merge");
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

const CI_TIMEOUT_MS = 3_000;
const prChecks = z.object({
  headRefOid: z.string().min(1),
  statusCheckRollup: z
    .array(
      z.object({
        __typename: z.string(),
        status: z.string().nullable().optional(),
        conclusion: z.string().nullable().optional(),
        state: z.string().nullable().optional(),
      }),
    )
    .nullable(),
});

export async function readWriterCi(
  deps: WorktreeDeps,
  root: string,
  url: string,
  timeoutMs = CI_TIMEOUT_MS,
): Promise<{ headRefOid: string; ci?: WriterPr["ci"] }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new DOMException("PR CI read timed out", "TimeoutError")),
        timeoutMs,
      );
    });
    const out = await Promise.race([
      timeout,
      deps.run("gh", ["pr", "view", url, "--json", "headRefOid,statusCheckRollup"], {
        cwd: root,
        timeoutMs,
      }),
    ]);
    if (!out.ok) throw new Error(`gh pr view failed: ${out.error}`);
    const { headRefOid, statusCheckRollup } = prChecks.parse(JSON.parse(out.data));
    if (!statusCheckRollup?.length) return { headRefOid };
    const states = statusCheckRollup.map((check) => {
      if (check.__typename === "StatusContext") {
        switch (check.state) {
          case "SUCCESS":
            return "success";
          case "FAILURE":
          case "ERROR":
            return "fail";
          case "PENDING":
          case "EXPECTED":
            return "running";
          default:
            return "unknown";
        }
      }
      if (check.__typename !== "CheckRun") return "unknown";
      if (
        ["QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED"].includes(check.status ?? "")
      ) {
        return "running";
      }
      if (check.status !== "COMPLETED") return "unknown";
      switch (check.conclusion) {
        case "SUCCESS":
          return "success";
        case "NEUTRAL":
        case "SKIPPED":
          return "neutral";
        case "FAILURE":
        case "CANCELLED":
        case "TIMED_OUT":
        case "ACTION_REQUIRED":
        case "STARTUP_FAILURE":
        case "STALE":
          return "fail";
        default:
          return "unknown";
      }
    });
    const verdict = states.includes("fail")
      ? "fail"
      : states.includes("unknown")
        ? "unknown"
        : states.includes("running")
          ? "running"
          : states.includes("success")
            ? "pass"
            : "unknown";
    return {
      headRefOid,
      ci: { verdict, detail: `${states.length} check(s): ${verdict}` },
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// A writer's change as a reviewer reads it: its commits, what is not committed,
// and the diff against its base branch.
export async function branchDiff(deps: WorktreeDeps, wt: AgentWorktree): Promise<string> {
  const base = comparisonRef(wt);
  const head = wt.local
    ? (await git(deps, wt.path, ["rev-parse", "--verify", "HEAD^{commit}"])).trim()
    : "HEAD";
  const [log, status, diff] = await Promise.all([
    git(deps, wt.path, ["log", "--oneline", `${base}..${head}`]),
    git(deps, wt.path, ["status", "--short", ...(wt.local ? ["--untracked-files=all"] : [])]),
    git(deps, wt.path, ["diff", `${base}...${head}`]),
  ]);
  return [
    `Branch ${wt.branch} against ${base}, in ${wt.path}.`,
    ...(wt.local ? [`Head: ${head}`] : []),
    `Commits:\n${log.trim() || "(none)"}`,
    `Not committed:\n${status.trim() || "(nothing)"}`,
    `Diff (git diff ${base}...${head}):\n${diff.trim() || "(empty)"}`,
  ].join("\n\n");
}
