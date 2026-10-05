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
  test("launcher docs describe only shipped controls and approved lifecycle behavior", () => {
    const swarms = topics(content).find((t) => t.title === "Swarms tab")?.body ?? "";
    const launcher = swarms.slice(
      swarms.indexOf("The Start a swarm header"),
      swarms.indexOf("One muted server line"),
    );
    for (const copy of [
      "themed HTML launcher",
      "No project · chat only",
      "name · path",
      "Working session is selected by default",
      "Customize",
      "Effort and Model",
      "Untouched Working session sends no size, power or model overrides",
      "host toast",
      "about two seconds",
      "compact New swarm line",
      "More options",
      "replacement documents restore",
      "Prepare in chat",
      "ALSO ALLOW",
      "Write, Run workflows and Use the tracker",
      "all off",
      "isolated: true",
      "ribWorkflowGrants",
      "ribApprovalGrants",
      "crossRibGrants",
      "This host does not say which tools a lead may hold.",
      "switches and chips",
      "capability, dispatch",
    ])
      expect(launcher).toContain(copy);
    for (const old of [
      "Setup starts",
      "Agents may field",
      "adjust shows",
      "folded once",
      "fold it by hand",
    ]) {
      expect(launcher).not.toContain(old);
    }
  });

  test("packaged and site launcher docs agree on compact defaults and draft preservation boundaries", () => {
    const swarms = topics(content).find((topic) => topic.title === "Swarms tab")!.body;
    const guide = readFileSync(
      new URL("../docs/src/content/docs/guides/swarms-tab.md", import.meta.url),
      "utf8",
    );
    const normalize = (text: string) => text.replace(/[`*]/g, "").replace(/\s+/g, " ");
    const l = SIZE_PRESETS.medium;
    for (const text of [swarms, guide].map(normalize)) {
      for (const phrase of [
        "With a live or retained ended swarm and no restored expanded draft, it starts as one compact New swarm line",
        "What should the swarm work out?",
        "Working session chip",
        `${l.maxAgents} agents · ${l.wallClockMs / 60_000} min`,
        "Compact Start uses chat mode with no project",
        "nothing on disk is read or changed",
        "no size, power, model, provider, workflow or lead-tool overrides",
        "More options or the Working session chip expands the launcher in place without losing the task",
        "Expansion alone does not change the default plan",
        "With no live or retained ended swarms, the launcher opens expanded",
        "Starting-only entries do not compact it",
        "Ordinary refreshes preserve local expansion, the draft, plan and model choices, switches and chips while swarm presence stays unchanged",
        "Additional swarms and live-to-ended transitions keep the same launcher page",
        "Crossing between no live or retained ended swarms and at least one can replace the page",
        "project-list, provider, capability, dispatch or remembered-refusal configuration change",
        "A restored expanded or multiline draft opens the full controls instead of compact defaults",
      ]) {
        expect(text).toContain(phrase);
      }
      for (const obsolete of [
        "fold it by hand",
        "opens expanded, including with retained swarms",
        "starting a swarm does not fold it automatically",
        "collapse back",
        "replace the page and discard it",
        "Reloading or replacing the page does not restore local edits",
      ]) {
        expect(text).not.toContain(obsolete);
      }
    }
  });

  test("launcher documentation agrees on transient restoration, dispatch clearing and operator workflow intent", () => {
    const swarms = topics(content).find((topic) => topic.title === "Swarms tab")!.body;
    const normalize = (text: string) => text.replace(/[`*]/g, "").replace(/\s+/g, " ");
    const pages = ["swarms-tab", "run-a-swarm"].map((name) =>
      readFileSync(new URL(`../docs/src/content/docs/guides/${name}.md`, import.meta.url), "utf8"),
    );
    for (const text of [swarms, ...pages].map(normalize)) {
      for (const phrase of [
        "On Keelson v0.119.0 or later, replacement documents restore the task verbatim",
        "plan and model choices, project, switches and chips, pending field text, and expanded/Customize presentation",
        "Projects restore by ID",
        "a removed or hidden project becomes chat-only and clears its switches and workflow chips",
        "Current capability restrictions still apply",
        "Named models keep their selected provider",
        "an unavailable provider requires choosing a model or plan again",
        "Workflow chips restore exactly as typed, in order",
        "the host refuses unknown workflows at Start",
        "The launcher does not detect removed workflows",
        "Each Start dispatch clears the saved draft before sending the action, even if the host refuses it",
        "Local validation failures do not clear it",
        "The current document keeps its fields for retry; the next edit saves a fresh draft",
        "state only in browser-tab memory, not durable storage",
        "A browser-page reload loses saved drafts",
        "at most 64 view keys",
        "each JSON snapshot at 65,536 UTF-8 bytes",
        "An oversized save leaves the last accepted snapshot intact without truncating visible text",
        "Older hosts without the state bridge can discard local edits when the launcher page is replaced",
      ])
        expect(text).toContain(phrase);
    }
    const readme = normalize(readFileSync(new URL("../README.md", import.meta.url), "utf8"));
    for (const phrase of [
      "Keelson v0.119.0 or later",
      "replacement documents restore",
      "expanded/Customize presentation",
      "Removed or hidden projects restore as chat-only",
      "Workflow chips restore exactly as typed, in order",
      "the host refuses unknown workflows at Start",
      "Each Start dispatch clears the saved draft",
      "Local validation failures do not clear it",
      "browser-tab memory",
      "browser-page reload loses it",
      "64 view keys",
      "65,536 UTF-8",
      "last accepted snapshot",
      "Older hosts without the state bridge",
    ])
      expect(readme).toContain(phrase);
    expect(readme).not.toContain("changes can discard them");
  });

  test("packaged and both guides agree on host-owned creation and creation draft boundaries", () => {
    const swarms = topics(content).find((topic) => topic.title === "Swarms tab")!.body;
    const pages = ["swarms-tab", "run-a-swarm"].map((name) =>
      readFileSync(new URL(`../docs/src/content/docs/guides/${name}.md`, import.meta.url), "utf8"),
    );
    const normalize = (text: string) => text.replace(/[`*]/g, "").replace(/\s+/g, " ");
    for (const text of [swarms, ...pages].map(normalize)) {
      for (const phrase of [
        "New project… appears last in Project only when the host exposes optional createProject",
        "even with no registered projects",
        "Older hosts omit it and refuse crafted creation requests",
        "required Name and an optional Folder",
        "placeholder ~/keelson/<name> is illustrative",
        "host's workspace root plus the name, not a universal home-directory path",
        "The host expands a leading ~; the rib passes it unchanged",
        "create and register the project before admitting the swarm",
        'initializes a missing or empty folder with git and a first empty "Initialize project" commit',
        "An existing git repository or a nonempty non-git folder is registered untouched",
        "Missing git identity can cause a host initialization error",
        "Host refusal messages appear unchanged in a toast, with no swarm started",
        "swarm admission fails, the registered project remains available for retry",
        "Write is on and locked on",
        "returned registered project ID",
        "Creates <name> · writes on a branch",
        "Use the tracker is shown only when at least one tracker tool is reachable",
        'defaults off with "no tracker yet in a new project"',
        "Reachability is not proof of an initialized tracker",
        "require an initialized .beads/",
        "The rib never runs bd init",
        "rechecked after asynchronous creation before admission",
        "Selecting an existing project reveals Write, Run workflows and Use the tracker, all off",
        "New project… selection, Name and Folder restore verbatim while creation remains available",
        "even after the project list grows",
        "Losing creation capability restores chat-only with elevated access and workflow chips cleared",
        "A changed project root clears elevated consent until you opt in again",
      ])
        expect(text).toContain(phrase);
    }
  });

  test("packaged and site launcher docs agree on switches, chips, grants and fallbacks", () => {
    const swarms = topics(content).find((topic) => topic.title === "Swarms tab")!.body;
    const normalize = (text: string) => text.replace(/[`*\\]/g, "").replace(/\s+/g, " ");
    const pages = ["swarms-tab", "run-a-swarm"].map((name) =>
      readFileSync(new URL(`../docs/src/content/docs/guides/${name}.md`, import.meta.url), "utf8"),
    );
    for (const text of [swarms, ...pages].map(normalize)) {
      for (const phrase of [
        "With no project selected, the ALSO ALLOW group is absent",
        "Write",
        "Run workflows",
        "Use the tracker",
        "all off",
        "only",
        "Enter or comma adds names",
        "workflow chips",
        "10",
        "isolated: true",
        "invalid or over-limit text stays in the input and blocks Start",
        "ribWorkflowGrants",
        "ribApprovalGrants",
        "remembered approval",
        "beads_ready",
        "beads_show",
        "beads_create",
        "beads_update",
        "beads_close",
        "beads_dep",
        "needs your grant: crossRibGrants",
        "does not create host grants",
        "This host does not say which tools a lead may hold.",
        "rechecks lead-tool reachability on Start and Run again",
        "Changing or clearing the project resets all switches and chips, not the task",
        "writes on a branch",
        "no workflows",
        "beads suffix",
        "dispatch or remembered-refusal",
      ])
        expect(text).toContain(phrase);
    }
    expect(topics(content).find((topic) => topic.title === "Write mode")!.body).toContain(
      "turn on Write",
    );
    expect(topics(content).find((topic) => topic.title === "Workflow dispatch")!.body).toContain(
      "Run workflows",
    );
    expect(content).toContain("Use the tracker to request");
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(normalize(readme)).not.toContain("no size, model, write or workflow controls");
    for (const name of ["Write", "Run workflows", "Use the tracker"])
      expect(normalize(readme)).toContain(name);
  });

  test("packaged and both guides agree on plans, Customize, sparse defaults and Run again", () => {
    const swarms = topics(content).find((t) => t.title === "Swarms tab")?.body ?? "";
    const guides = ["swarms-tab", "run-a-swarm"].map((name) =>
      readFileSync(new URL(`../docs/src/content/docs/guides/${name}.md`, import.meta.url), "utf8"),
    );
    const normalize = (text: string) => text.replace(/[`*"]/g, "").replace(/\s+/g, " ");
    for (const text of [swarms, ...guides].map(normalize)) {
      for (const phrase of [
        "Working session is selected by default",
        "Effort changes size budgets, not reasoning effort",
        "the plan's models",
        "default model, class models and pinned models, without duplicates within a group",
        "Other… accepts a model name and uses the effective default provider",
        "Changing Effort keeps the plan's pair",
        "Naming a model runs every agent on it",
        "Picking a card clears the named model and restores that plan",
        "The live footer follows the choice",
        "Untouched Working session sends no size, power or model overrides",
        "Quick look records small/fast; Deep dig records large/deep",
        "A named model records size, model and provider, with no power",
        "Effort and Model only",
        "Run again reuses saved plan power unless a model is named",
        "there is no Power field",
        "context is not refreshed",
        "Accepting an unchanged plan-derived lead keeps the pair",
      ])
        expect(text).toContain(phrase);
      for (const [name, size, blurb] of [
        ["Quick look", "small", "A narrow question, or a first pass before a bigger run."],
        ["Working session", "medium", "Most tasks: investigate, debate, and decide."],
        ["Deep dig", "large", "Wide or hard problems that are worth the spend."],
      ] as const) {
        const l = SIZE_PRESETS[size];
        expect(text).toContain(
          `| ${name} | ${blurb} | ${l.maxAgents} | ${l.maxTurns} | ${l.wallClockMs / 60_000} |`,
        );
      }
      for (const obsolete of [
        "fixed medium limits",
        "no size, model, write",
        "size, power and model; its hover",
      ]) {
        expect(text).not.toContain(obsolete);
      }
    }
  });

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
    expect(swarms).toContain("of N · pace over the last 5 min");
    expect(swarms).toContain("turn start timestamps over the last five minutes");
    expect(swarms).toContain("Older records without spans");
    expect(swarms).toContain("accounting for the partial");
    expect(swarms).toContain("Fewer than one turn is reported as no pace");
    expect(swarms).toContain("turn budget (rounded up) would be unused");
    expect(swarms).toContain("computed when the board composes");
    expect(swarms).toContain("It changes nothing the engine does: no limits, nudges or stopping.");
    expect(swarms).toContain('An ended Turns tile has no forecast and its sub stays "of N".');
  });

  test("packaged and site docs agree on full-width Map, compact Turns and readable Details", () => {
    const swarms = topics(content).find((t) => t.title === "Swarms tab")?.body ?? "";
    const page = readFileSync(
      new URL("../docs/src/content/docs/guides/swarms-tab.md", import.meta.url),
      "utf8",
    );
    const normalized = (text: string) => text.replace(/[`*]/g, "").replace(/\s+/g, " ");
    for (const text of [normalized(swarms), normalized(page)]) {
      for (const phrase of [
        "Map owns a full-width row on both live surfaces; Conversation and the eligible composer follow",
        "The live Turns tile has a numeric value",
        "At 3 of 20 turns, its value is 3",
        '"of 20 · pace over the last 5 min"',
        "Delta text stays within 44 characters through the 200-turn bound",
        "The rate is not displayed",
        'An ended Turns tile has no forecast and its sub stays "of N"',
        "It retains the numeric used count and existing sparkline",
        "A single-part task is labeled Task; longer tasks use numbered parts",
        "Details durations use exact whole minutes or seconds, including fractional seconds",
        "1800000 ms becomes 30 min",
        "300000 ms becomes 5 min",
        "45000 ms becomes 45 s",
        "90000 ms remains 90 s",
        "Setup has one Lead model row and one Worker model row, requested settings first",
        '"balanced power, host default"',
        "Each role's disclosure labels served model and served provider per agent by short handle",
        "explicit per-agent request overrides",
        "Missing served evidence says not reported",
        "missing role agents are explicitly not recorded",
        "Recorded reasoning effort and aggregate token usage remain visible",
        "Ended agent heads use the swarm lifecycle pill: done, stopped, stalled, out of budget or failed",
        "not the agent's last live status",
        "Live, unended heads retain the agent's actual status",
        "A retained end time with a still-live status suppresses the activity pill",
      ])
        expect(text).toContain(phrase);
      for (const line of [
        "| runs-out-first | N left · out about hh:mm, before the clock | down | warn |",
        "| clock-first | N left · about M unused at hh:mm | flat | caution |",
        "| fits | N left · pace fits the clock | flat | none |",
        "| no-pace | N left · no turn in 5 min | flat | none |",
        "| out-of-turns | none left · agents finish their turns | down | warn |",
      ])
        expect(text).toContain(line);
      for (const obsolete of [
        "Map beside Conversation",
        "Map and Conversation stack on narrow screens",
        "at R a minute",
        "at this pace about",
        "rate shows one decimal",
        "Task · part 1 of 1",
      ])
        expect(text).not.toContain(obsolete);
    }
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
