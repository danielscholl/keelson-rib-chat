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

  test("the Swarms topic describes the cockpit and shared selection without claiming form tabs", () => {
    const swarms = topics(content).find((t) => t.title === "Swarms tab")?.body ?? "";
    expect(swarms).toContain("one card per request, oldest first");
    expect(swarms).toContain("oldest 12 shown");
    expect(swarms).toContain("cockpit on the page, not in the drawer");
    expect(swarms).toContain("hatched open");
    expect(swarms).toContain("choice is shared by every viewer");
    expect(swarms).toContain("wrapping action strip");
    expect(swarms).toContain("per-swarm board also still");
    expect(swarms).not.toContain("Live swarms are cards");
    expect(swarms).toContain("server line");
    expect(swarms).toContain("Manage");
    expect(swarms).toContain("at the side");
    expect(swarms).toContain("Only ended boards keep About: times, health and one transcript link");
    expect(swarms).toContain("Conversation");
    expect(swarms).toContain("eight newest channel messages, newest first");
    expect(swarms).toContain("newest 20");
    expect(swarms).toContain("200 characters");
    expect(swarms).toContain('"ask" | "run" | "conclusion"');
    expect(swarms).toContain("run for the rib's quiet run and gate bookkeeping posts");
    expect(swarms).toContain("`chat_report` never posts to the channel");
    expect(swarms).toContain("durable op record leave this recent-message");
    expect(swarms).not.toContain("ClickClack footer");
    expect(swarms).not.toContain("and the channel in ClickClack");
  });

  test("the Swarms topic describes the advisory forecast and its five readings", () => {
    const swarms = topics(content).find((t) => t.title === "Swarms tab")?.body ?? "";
    for (const reading of ["runs-out-first", "clock-first", "fits", "no-pace", "out-of-turns"]) {
      expect(swarms).toContain(`| ${reading} |`);
    }
    expect(swarms).toContain("pace over the last 5 min");
    expect(swarms).toContain("turn start timestamps over the last five minutes");
    expect(swarms).toContain("Older records without spans");
    expect(swarms).toContain("accounting for the partial");
    expect(swarms).toContain("Fewer than one turn is reported as no pace");
    expect(swarms).toContain("turn budget (rounded up) would be unused");
    expect(swarms).toContain("computed when the board composes");
    expect(swarms).toContain("It changes nothing the engine does: no limits, nudges or stopping.");
    expect(swarms).toContain('An ended Turns tile has no forecast and its sub stays "of N".');
  });

  test("packaged and site docs agree on produced rows, honest CI and PR totals", () => {
    const swarms = topics(content).find((t) => t.title === "Swarms tab")?.body ?? "";
    const page = readFileSync(
      new URL("../docs/src/content/docs/guides/swarms-tab.md", import.meta.url),
      "utf8",
    );
    const normalized = (text: string) => text.replace(/[`*]/g, "").replace(/\s+/g, " ");
    for (const text of [normalized(swarms), normalized(page)]) {
      for (const phrase of [
        "Produced so far",
        "landing order, oldest first",
        "report publication time",
        "run start time",
        "PR opening time",
        "immediately under their parent run",
        "retention reason",
        "eligible writers",
        "lead may spawn writers",
        "chat-only swarm without workflows",
        "Missing evidence never implies pass",
        "Pull requests",
        "distinct URLs across runs and writers",
        "M with CI passing",
        "every recorded owner explicitly reports pass",
        "The Pull requests tile appears when workflows were named, writeEnabled is true, a legacy writer has a worktree, or any run or writer PR exists.",
        'Eligible write or dispatch swarms with no PRs show 0 with "0 with CI passing".',
        "A chat-only swarm with no runs and no PRs omits the tile.",
        "Run CI must also identify the same PR URL",
        "Live boards omit the Pull requests tile",
        "Only the operator merges",
        "board never removes worktrees",
      ])
        expect(text).toContain(phrase);
      expect(text).not.toContain("only when the launch named workflows");
      expect(text).not.toContain("Live and zero-PR boards omit it");
      expect(text).not.toContain("zero-PR boards omit this tile");
      expect(text).not.toContain("adds Pull requests when any exist");
    }
    const write = normalized(topics(content).find((t) => t.title === "Write mode")?.body ?? "");
    for (const text of [write, normalized(page)]) {
      for (const phrase of [
        "current-head checks",
        "gh pr view",
        "every 20 seconds",
        "3-second timeout",
        "different head are discarded",
        "not reported, never pass",
        "unknown",
        "running",
        "one final read",
        "timeout keeps the last observation",
        "saved observation, not a continuously monitored guarantee",
      ])
        expect(text.toLowerCase()).toContain(phrase);
    }
    expect(write).toContain("writeEnabled");
  });

  test("packaged and site docs agree on the map, inspector and targeted messaging", () => {
    const swarms = topics(content).find((t) => t.title === "Swarms tab")?.body ?? "";
    const page = readFileSync(
      new URL("../docs/src/content/docs/guides/swarms-tab.md", import.meta.url),
      "utf8",
    );
    const normalized = (text: string) => text.replace(/[`*]/g, "").replace(/\s+/g, " ");
    for (const text of [normalized(swarms), normalized(page)]) {
      for (const phrase of [
        "You, Lead, Workers, Runs",
        "0, 1, 2, 3",
        "Grandchildren remain in Workers",
        "Agent tones show identity",
        "run tones show status",
        "operatorMessageCount",
        "posts not recorded",
        "Lead turns have no worker cap",
        "Solid spawn edges",
        "one wake per source per turn",
        "dashed",
        "updates",
        "per-run wake count",
        "You is informational; run nodes open the run; agent nodes select the agent",
        "48 nodes and 200 edges",
        "shown/total counts",
        "520 px inspector",
        "shared by every viewer",
        "replaces the side drawer",
        "One inspector key per swarm",
        "recent messages only",
        "actually served",
        "not reported",
        "Open PR",
        "Message @agent",
        "roster's full handle",
        "unchanged router",
        "spends a turn",
        "body limit includes the operator prefix",
        "read-only with no composer",
        "no live clock",
        "monospace/stacked cards or ghost seats",
      ])
        expect(text).toContain(phrase);
      expect(text).not.toContain("details are the same in both");
    }
  });

  test("packaged and site docs agree on side inspectors and content destinations", () => {
    const swarms = topics(content).find((t) => t.title === "Swarms tab")?.body ?? "";
    const page = readFileSync(
      new URL("../docs/src/content/docs/guides/swarms-tab.md", import.meta.url),
      "utf8",
    );
    const normalized = (text: string) => text.replace(/[`*]/g, "").replace(/\s+/g, " ");
    for (const text of [normalized(swarms), normalized(page)]) {
      for (const phrase of [
        "rib:chat:ask:<swarm>",
        "rib:chat:gate:<swarm>",
        "rib:chat:details:<swarm>",
        "complete admitted question",
        "bounded question previews",
        "only the question inspector shows the full body",
        "Reply and Dismiss",
        "full retained prompt",
        "empty files, read errors and truncation notices",
        "operator-only gates also offer Open run",
        "Peer gates have no approval control",
        "Reply posts as you in the thread and never approves",
        "Review plan and Answer still open the run drawer",
        "ordered disclosures of at most 4,000 characters",
        "every retained context excerpt",
        "head/base SHA",
        "all effective limits",
        "requested models per role/provider",
        "recorded overrides and effort",
        "Actually served models stay separate from requested settings",
        "read-only with no composer",
        "Each inspector publishes before opening",
        "one key per swarm and kind",
        "resolved question or advanced gate",
        "retention trimming and disposal release inspector keys",
        "times, health and one transcript link",
        "separate row outside About",
        "Ended section order: Outcome, Result, actions, Agents, Produced so far when applicable, Activity when events exist, About, then the separate Ended swarms back-link.",
        "The ended Result orders Turns, Time, Tokens, Pull requests when eligible, then Runs verified only when runs exist.",
        "There is no Agents tile",
        "unavailable, not an invented zero",
        "The actions strip is Run again, Open the record, Details",
        "Run again is omitted when retained launch inputs are unavailable",
        "Outcome has no channel field",
        "For ended swarms, Spend by agent is on the record only, with fresh and cached tokens apart",
        "Ended Activity shows at most the newest 12 events, with actor, time and repeats, and no Read the full log row",
        "Only live Activity adds Read the full log when earlier events exist",
        "Open the record reaches Activity as well as the timeline and spend",
        "The transcript link is omitted when its address is unavailable",
        "latest 200 retained entries, newest first",
        "not a complete transcript",
        "applicable conclusion or refused draft and the full task, not questions, gates, context, runs or activity",
        "The conclusion's copy button copies all of it, not the board preview.",
        "Legacy summaries cannot recover question text already truncated",
      ]) {
        expect(text).toContain(phrase);
      }
      for (const obsolete of [
        "Read question opens the reading pane",
        "cockpit task disclosure shows at most",
        "1,000 task characters",
        "last 200 events are in the reading pane",
        "Both retain Spend",
        "agent bench, Spend, Produced so far",
        "The remaining details follow in both",
      ]) {
        expect(text).not.toContain(obsolete);
      }
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
