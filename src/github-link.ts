// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { CONTEXT_BOUNDS, type ContextItem } from "./context.ts";

// A GitHub issue or PR link in a launcher task. The rib reads it with the gh
// CLI at Start, the same snapshot a caller would hand over as context.
export interface GithubLink {
  repo: string;
  kind: "issue" | "pr";
  number: number;
}

export const MAX_LINKS = 5;

const GITHUB_LINK = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(issues|pull)\/(\d+)\S*/g;

export function githubLinks(task: string): GithubLink[] {
  const seen = new Map<string, GithubLink>();
  for (const m of task.matchAll(GITHUB_LINK)) {
    const link: GithubLink = {
      repo: m[1]!,
      kind: m[2] === "pull" ? "pr" : "issue",
      number: Number(m[3]),
    };
    seen.set(`${link.repo}#${link.number}`, link);
  }
  return [...seen.values()];
}

export function withoutGithubLinks(task: string): string {
  return task.replace(GITHUB_LINK, "");
}

interface Viewed {
  title: string;
  body: string;
  url: string;
  comments?: { author?: { login?: string }; body?: string }[];
}

export function contextFromView(link: GithubLink, view: Viewed, at: Date): ContextItem {
  const comments = (view.comments ?? [])
    .filter((c) => c.body?.trim())
    .map((c) => `--- comment by @${c.author?.login ?? "unknown"}\n${c.body!.trim()}`);
  const body = [view.body.trim() || "(no description)", ...comments].join("\n\n");
  const label = link.kind === "pr" ? "PR" : "issue";
  return {
    id: `${link.kind}-${link.number}`,
    kind: link.kind,
    title: `${label} ${link.repo}#${link.number}: ${view.title}`
      .replace(/[\r\n]+/g, " ")
      .slice(0, 200),
    body: body.slice(0, CONTEXT_BOUNDS.maxItemChars),
    sourceUrl: view.url,
    retrievedAt: at.toISOString(),
  };
}

export async function readGithubLink(link: GithubLink): Promise<ContextItem> {
  const name = `${link.kind === "pr" ? "PR" : "issue"} ${link.repo}#${link.number}`;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(
      [
        "gh",
        link.kind,
        "view",
        String(link.number),
        "--repo",
        link.repo,
        "--json",
        "title,body,url,comments",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
  } catch {
    throw new Error(`Couldn't read ${name}: the gh CLI isn't installed. Paste its text instead.`);
  }
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    const why = err.trim().split("\n")[0] || `gh exited ${code}`;
    throw new Error(`Couldn't read ${name}: ${why}. Paste its text instead.`);
  }
  return contextFromView(link, JSON.parse(out) as Viewed, new Date());
}
