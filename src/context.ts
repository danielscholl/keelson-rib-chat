// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { z } from "zod";

// Task context: evidence the caller snapshots before delegation (an issue body,
// a diff, review comments, check results) and hands to the swarm whole. The
// swarm never fetches it, so no agent needs a shell, a token, or a forge.

export const CONTEXT_BOUNDS = {
  maxItems: 20,
  maxItemChars: 60_000,
  maxTotalChars: 300_000,
  pageChars: 20_000,
} as const;

// Evidence about a moving target is only meaningful against the commit it was
// taken from.
const SHA_BOUND_KINDS = ["diff", "review", "checks"] as const;

const sha = z
  .string()
  .regex(/^[0-9a-f]{7,40}$/i)
  .describe("A git commit SHA, 7 to 40 hex characters.");

export const contextItemSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
      .describe("Short kebab-case key agents cite, e.g. 'issue-874'."),
    kind: z
      .enum(["issue", "pr", "diff", "review", "checks", "note"])
      .describe("What the item is. diff, review, and checks must carry head_sha."),
    // Single line: it is interpolated into every agent's prompt and read header.
    title: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^\r\n]+$/, "title must be one line"),
    body: z
      .string()
      .min(1)
      .max(CONTEXT_BOUNDS.maxItemChars)
      .describe("The full text, verbatim. Do not summarize."),
    source_url: z
      .url({ protocol: /^https?$/ })
      .max(2_000)
      .optional()
      .describe("Where the text was retrieved from."),
    retrieved_at: z.iso.datetime({ offset: true }).optional().describe("When it was retrieved."),
    head_sha: sha.optional(),
    base_sha: sha.optional(),
  })
  .strict()
  .refine((item) => !isShaBound(item.kind) || item.head_sha !== undefined, {
    message: "diff, review, and checks items must carry head_sha",
    path: ["head_sha"],
  });

export const contextSchema = z
  .array(contextItemSchema)
  .max(CONTEXT_BOUNDS.maxItems)
  .refine((items) => new Set(items.map((i) => i.id)).size === items.length, {
    message: "context item ids must be unique",
  })
  .refine((items) => items.reduce((n, i) => n + i.body.length, 0) <= CONTEXT_BOUNDS.maxTotalChars, {
    message: `context bodies exceed ${CONTEXT_BOUNDS.maxTotalChars} characters in total`,
  });

export type ContextKind = z.infer<typeof contextItemSchema>["kind"];

export interface ContextItem {
  id: string;
  kind: ContextKind;
  title: string;
  body: string;
  sourceUrl?: string;
  retrievedAt?: string;
  headSha?: string;
  baseSha?: string;
}

export type ContextIndexEntry = Omit<ContextItem, "body"> & { chars: number };

function isShaBound(kind: string): boolean {
  return (SHA_BOUND_KINDS as readonly string[]).includes(kind);
}

export function toContextItems(input: z.infer<typeof contextSchema>): ContextItem[] {
  return input.map((i) => ({
    id: i.id,
    kind: i.kind,
    title: i.title,
    body: i.body,
    ...(i.source_url ? { sourceUrl: i.source_url } : {}),
    ...(i.retrieved_at ? { retrievedAt: i.retrieved_at } : {}),
    ...(i.head_sha ? { headSha: i.head_sha } : {}),
    ...(i.base_sha ? { baseSha: i.base_sha } : {}),
  }));
}

export function contextIndex(items: readonly ContextItem[]): ContextIndexEntry[] {
  return items.map(({ body, ...rest }) => ({ ...rest, chars: body.length }));
}

function attribution(entry: ContextIndexEntry): string {
  // A note is the operator's own words, so it has no source to go stale.
  if (entry.kind === "note" && !entry.sourceUrl && !entry.retrievedAt) return "operator note";
  return [
    entry.sourceUrl ? `source ${entry.sourceUrl}` : "source not given",
    entry.retrievedAt ? `retrieved ${entry.retrievedAt}` : "retrieval time unknown",
    ...(entry.headSha ? [`head ${entry.headSha}`] : []),
    ...(entry.baseSha ? [`base ${entry.baseSha}`] : []),
  ].join(", ");
}

export function renderContextIndex(items: readonly ContextItem[]): string {
  if (items.length === 0) return "(no task context was supplied)";
  return contextIndex(items)
    .map((e) => `- ${e.id} [${e.kind}] ${e.title} (${e.chars} chars; ${attribution(e)})`)
    .join("\n");
}

// One page of an item's body, under a header that keeps the text attributable
// wherever an agent quotes it.
export function renderContextItem(item: ContextItem, offset: number): string {
  const { body: _body, ...rest } = item;
  let end = Math.min(item.body.length, offset + CONTEXT_BOUNDS.pageChars);
  // Never end a page inside a surrogate pair; the half would not survive the wire.
  const last = item.body.charCodeAt(end - 1);
  if (end < item.body.length && last >= 0xd800 && last <= 0xdbff) end--;
  const more =
    end < item.body.length
      ? `\n--- truncated at ${end} of ${item.body.length} chars; call chat_context again with offset ${end}`
      : "";
  return `--- ${item.id} [${item.kind}] ${item.title}\n--- ${attribution({ ...rest, chars: item.body.length })}; chars ${offset}-${end} of ${item.body.length}\n${item.body.slice(offset, end)}${more}`;
}
