import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ribDocsSourceSchema } from "@keelson/shared";
import pkg from "../package.json" with { type: "json" };
import rib from "../src/index.ts";
import { DEFAULT_LIMITS, SIZE_PRESETS, SWARM_SIZES } from "../src/types.ts";

const ctx = { getExec: () => ({}) as never };
const source = rib.contributeDocs?.(ctx)[0];
const content = source?.content ?? "";
const tools = rib.registerTools?.(ctx) ?? [];

// keelson_docs slices a corpus on H1, and reads a leading blockquote as the
// topic's summary.
function topics(corpus: string): { title: string; body: string }[] {
  return corpus
    .split(/^# /m)
    .slice(1)
    .map((block) => {
      const [title = "", ...rest] = block.split("\n");
      return { title: title.trim(), body: rest.join("\n").trim() };
    });
}

// One row of a markdown table, keyed by the backticked name in its first cell.
function row(name: string): string {
  const line = content.split("\n").find((l) => l.startsWith(`| \`${name}\` |`));
  if (!line) throw new Error(`no table row for ${name}`);
  return line;
}

describe("contributed docs", () => {
  test("the rib contributes one valid, inline docs source", () => {
    expect(rib.contributeDocs?.(ctx)).toHaveLength(1);
    expect(ribDocsSourceSchema.safeParse(source).success).toBe(true);
    // Inline content ships in the package; a URL would need a published site.
    expect(source?.llmsFullUrl).toBeUndefined();
    expect(content.length).toBeGreaterThan(0);
  });

  test("the corpus lives under a path the published package includes", () => {
    expect(pkg.files).toContain("src");
    expect(pkg.main.startsWith("./src/")).toBe(true);
  });

  test("every topic is individually readable: a title, a summary, and a body", () => {
    const parsed = topics(content);
    expect(parsed.length).toBeGreaterThanOrEqual(6);
    expect(new Set(parsed.map((t) => t.title)).size).toBe(parsed.length);
    for (const topic of parsed) {
      const [summary, ...body] = topic.body.split("\n\n");
      expect(summary?.startsWith("> ")).toBe(true);
      expect(body.join("").length).toBeGreaterThan(0);
    }
  });

  test("the corpus names every registered tool and no tool that does not exist", () => {
    const registered = new Set(tools.map((t) => t.name));
    const mentioned = new Set(content.match(/\bchat_[a-z_]+\b/g) ?? []);
    for (const name of registered) expect(mentioned.has(name)).toBe(true);
    for (const name of mentioned) expect(registered.has(name)).toBe(true);
  });

  test("the advertised start bounds are the ones the schema enforces", () => {
    const start = tools.find((t) => t.name === "chat_swarm_start");
    const accepts = (input: Record<string, unknown>) =>
      start?.inputSchema.safeParse({ task: "t", ...input }).success;

    const maxAgents = Number(row("max_agents").match(/1 to (\d+)/)?.[1]);
    expect(accepts({ max_agents: maxAgents })).toBe(true);
    expect(accepts({ max_agents: maxAgents + 1 })).toBe(false);

    const maxTurns = Number(row("max_turns").match(/1 to (\d+)/)?.[1]);
    expect(accepts({ max_turns: maxTurns })).toBe(true);
    expect(accepts({ max_turns: maxTurns + 1 })).toBe(false);

    const taskMax = Number(row("task").match(/At most (\d+) characters/)?.[1]);
    expect(accepts({ task: "x".repeat(taskMax) })).toBe(true);
    expect(accepts({ task: "x".repeat(taskMax + 1) })).toBe(false);

    expect(accepts({ work_tools: "read" })).toBe(true);
    expect(accepts({ work_tools: "write" })).toBe(true);
    expect(accepts({ work_tools: "all" })).toBe(false);

    const meaning = row("size").split("|")[3] ?? "";
    const sizes = [...meaning.matchAll(/`(\w+)`/g)].map((m) => m[1]);
    expect(sizes).toEqual([...SWARM_SIZES]);
    for (const size of sizes) expect(accepts({ size })).toBe(true);
    expect(accepts({ size: "huge" })).toBe(false);
  });

  test("the advertised sizes are the presets", () => {
    for (const size of SWARM_SIZES) {
      const p = SIZE_PRESETS[size];
      expect(row(size)).toBe(
        `| \`${size}\` | ${p.maxAgents} | ${p.maxTurns} | ${p.maxTurnsPerAgent} | ${p.maxConcurrent} | ${p.wallClockMs / 60_000} minutes |`,
      );
    }
  });

  test("the advertised wait bound is the one the schema enforces", () => {
    const wait = tools.find((t) => t.name === "chat_swarm_wait");
    const max = Number(row("chat_swarm_wait").match(/at most (\d+)/)?.[1]);
    expect(wait?.inputSchema.safeParse({ swarm: "s1", timeout_s: max }).success).toBe(true);
    expect(wait?.inputSchema.safeParse({ swarm: "s1", timeout_s: max + 1 }).success).toBe(false);
  });

  test("the advertised read bound is the one the schema enforces", () => {
    const read = tools.find((t) => t.name === "chat_read");
    const max = Number(row("chat_read").match(/at most (\d+)/)?.[1]);
    expect(read?.inputSchema.safeParse({ limit: max }).success).toBe(true);
    expect(read?.inputSchema.safeParse({ limit: max + 1 }).success).toBe(false);
  });

  test("the advertised defaults are the engine's defaults", () => {
    expect(row("max_agents")).toContain(`| ${DEFAULT_LIMITS.maxAgents} |`);
    expect(row("max_turns")).toContain(`| ${DEFAULT_LIMITS.maxTurns} |`);
    expect(content).toContain(`| Turns per worker | ${DEFAULT_LIMITS.maxTurnsPerAgent} |`);
    expect(content).toContain(`| Turns running at once | ${DEFAULT_LIMITS.maxConcurrent} |`);
    expect(content).toContain(`| Wall clock | ${DEFAULT_LIMITS.wallClockMs / 60_000} minutes |`);
  });

  test("the site's tool reference names exactly the registered tools", () => {
    const page = readFileSync(
      new URL("../docs/src/content/docs/reference/tools-and-commands.md", import.meta.url),
      "utf8",
    );
    const registered = new Set(tools.map((t) => t.name));
    const mentioned = new Set(page.match(/\bchat_[a-z_]+\b/g) ?? []);
    for (const name of registered) expect(mentioned.has(name)).toBe(true);
    for (const name of mentioned) expect(registered.has(name)).toBe(true);
  });
});
