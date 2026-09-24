// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { type ToolContext, type ToolDefinition, z } from "@keelson/shared";
import { type ContextItem, contextSchema, toContextItems } from "./context.ts";
import { describeRun } from "./dispatch.ts";
import { modelLabel, sizeText, tokensText } from "./labels.ts";
import { REPORT_HTML_MAX, REPORT_TITLE_MAX } from "./report.ts";
import type { Swarm } from "./swarm.ts";
import {
  BODY_MAX,
  type ChatMessage,
  CONCLUSION_MAX,
  type DispatchGrant,
  isLive,
  publicSummary,
  readTurnContext,
  SIZE_PRESETS,
  type StartingSwarm,
  SWARM_POWERS,
  SWARM_SIZES,
  type SwarmPower,
  type SwarmSize,
  type SwarmSummary,
  sizeOf,
} from "./types.ts";

// The tool layer's seams, injected so the module stays testable: index.ts
// passes the live registry and launcher, tests pass fakes.
export interface StartSwarmInput {
  task: string;
  project?: string;
  size?: SwarmSize;
  maxAgents?: number;
  maxTurns?: number;
  maxTurnsPerAgent?: number;
  turnTimeoutMs?: number;
  wallClockMs?: number;
  workTools: WorkTools;
  context?: ContextItem[];
  provider?: string;
  model?: string;
  workerModel?: string;
  power?: SwarmPower;
  workflows?: DispatchGrant[];
  // Other ribs' tools the lead holds, each cleared by the operator's crossRibGrants.
  leadTools?: string[];
}

export const WORK_TOOLS = ["none", "read", "write"] as const;
export type WorkTools = (typeof WORK_TOOLS)[number];

export interface ToolDeps {
  swarms: Map<string, Swarm>;
  // Swarms between the start call and a booted channel.
  starting?: ReadonlyMap<string, StartingSwarm>;
  // Swarms still booting whose agents may already be taking turns.
  booting?: ReadonlyMap<string, Swarm>;
  // Summaries of swarms that have ended, kept so status still answers.
  ended: Map<string, SwarmSummary>;
  // `url` is the ClickClack server the swarm runs on, for pointing a human at its UI.
  startSwarm: (input: StartSwarmInput) => Promise<{ swarm: Swarm; opId?: string; url?: string }>;
  // Reads a swarm's channel as the owner, ended swarms included. Absent in tests
  // that never read a transcript.
  readChannel?: (channelId: string, threadId?: string) => Promise<ChatMessage[]>;
  // Drops ended swarms from history, with their launches and reports. Absent in
  // tests that never forget one.
  forget?: (ids: readonly string[]) => void;
}

export const START_BOUNDS = {
  maxLeadTools: 20,
  maxAgents: 12,
  maxTurns: 200,
  maxTurnsPerAgent: 100,
  turnTimeoutS: { min: 30, max: 1_800 },
  maxMinutes: 240,
  maxWorkflows: 10,
} as const;
export const WAIT_BOUNDS = { defaultS: 120, maxS: 600 } as const;
export const READ_BOUNDS = { defaultLimit: 20, maxLimit: 50 } as const;
export const TRANSCRIPT_PAGE = 40_000;
export const DIFF_PAGE = 40_000;
export const PR_BOUNDS = { title: 200, body: 20_000 } as const;
// Refuses runaway input outright; the engine enforces CONCLUSION_MAX with a
// message the lead can act on, and keeps the refused draft.
const CONCLUSION_HARD_MAX = 200_000;
// Ended swarms whose summary chat_swarm_status still answers for.
export const ENDED_KEPT = 50;
function tooLong(max: number) {
  return {
    error: (issue: { input?: unknown }) => {
      const length = typeof issue.input === "string" ? issue.input.length : 0;
      return `Too long: ${length} characters, and the limit is ${max}. Cut at least ${length - max} characters and call again.`;
    },
  };
}

const body = z.string().min(1).max(BODY_MAX, tooLong(BODY_MAX)).describe("Markdown message body.");

export function emitText(ctx: ToolContext, content: string, isError = false): void {
  ctx.emit({ type: "tool_result", toolUseId: "", content, ...(isError ? { isError: true } : {}) });
}

// A tool failure is a result the agent can read and react to, never an
// exception that escapes into the harness's turn loop.
export function guarded(
  fn: (input: unknown, ctx: ToolContext) => Promise<void>,
): (input: unknown, ctx: ToolContext) => Promise<void> {
  return async (input, ctx) => {
    try {
      await fn(input, ctx);
    } catch (err) {
      emitText(ctx, `chat tool failed: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  };
}

function renderMessages(messages: readonly ChatMessage[]): string {
  if (messages.length === 0) return "(no messages)";
  return messages
    .map((m) => {
      const who = m.authorHandle ? `@${m.authorHandle}` : m.authorName;
      const where = m.threadRootId === m.id ? m.id : `${m.id} in thread ${m.threadRootId}`;
      return `--- ${who}${m.authorKind === "human" ? " [human]" : ""} (${where})\n${m.body}`;
    })
    .join("\n");
}

export function makeChatTools(deps: ToolDeps): ToolDefinition[] {
  // The calling agent comes from the turn context the swarm engine set, never
  // from tool input, so an agent cannot speak as another.
  const caller = (ctx: ToolContext): { swarm: Swarm; agentId: string } => {
    const turn = readTurnContext(ctx.turnContext);
    if (!turn) throw new Error("this tool only works inside a swarm agent's turn");
    const swarm = deps.swarms.get(turn.swarmId) ?? deps.booting?.get(turn.swarmId);
    if (!swarm) throw new Error(`swarm ${turn.swarmId} is no longer running`);
    return { swarm, agentId: turn.agentId };
  };

  const postSchema = z.object({ body }).strict();
  const replySchema = z
    .object({
      message_id: z.string().min(1).describe("Any message id in the thread to answer."),
      body,
    })
    .strict();
  const readSchema = z
    .object({
      thread_id: z
        .string()
        .optional()
        .describe("A thread's root message id. Omit to read the channel's latest messages."),
      limit: z.number().int().min(1).max(READ_BOUNDS.maxLimit).optional(),
    })
    .strict();
  const contextReadSchema = z
    .object({
      id: z.string().optional().describe("A context item id. Omit to list the items."),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Character offset to continue a long item from."),
    })
    .strict();
  const spawnSchema = z
    .object({
      handle: z.string().min(1).max(20).describe("Short kebab-case name, e.g. 'log-reader'."),
      role: z.string().min(1).max(200).describe("One line: what this agent is for."),
      brief: z
        .string()
        .min(1)
        .max(BODY_MAX, tooLong(BODY_MAX))
        .describe("The narrow task, with what to report."),
      writes: z
        .boolean()
        .optional()
        .describe(
          "Lead only, in a swarm started with work_tools 'write'. The agent gets its own git worktree and branch of the project, and may edit, run commands, and commit there.",
        ),
    })
    .strict();
  const prOpenSchema = z
    .object({
      title: z
        .string()
        .min(1)
        .max(PR_BOUNDS.title)
        .describe("The pull request title: a conventional commit subject."),
      body: z
        .string()
        .min(1)
        .max(PR_BOUNDS.body, tooLong(PR_BOUNDS.body))
        .describe("Markdown: what changed and why, and the checks you ran."),
    })
    .strict();
  const diffSchema = z
    .object({
      writer: z.string().min(1).describe("The writer's handle, with or without the swarm prefix."),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Character offset to continue a long diff from."),
    })
    .strict();
  const doneSchema = z
    .object({
      summary: z
        .string()
        .min(1)
        .max(CONCLUSION_HARD_MAX)
        .describe(`The swarm's final answer, at most ${CONCLUSION_MAX} characters.`),
    })
    .strict();
  const startSchema = z
    .object({
      task: z
        .string()
        .min(1)
        .max(BODY_MAX, tooLong(BODY_MAX))
        .describe("What the swarm should work out."),
      project: z
        .string()
        .optional()
        .describe("A registered keelson project; agents read its checkout."),
      size: z
        .enum(SWARM_SIZES)
        .optional()
        .describe(
          `How much the swarm may do. ${SWARM_SIZES.map((k) => `${k}: ${sizeText(SIZE_PRESETS[k])}`).join("; ")}. Default medium. The max_* inputs override single limits.`,
        ),
      max_agents: z.number().int().min(1).max(START_BOUNDS.maxAgents).optional(),
      max_turns: z.number().int().min(1).max(START_BOUNDS.maxTurns).optional(),
      max_turns_per_agent: z
        .number()
        .int()
        .min(1)
        .max(START_BOUNDS.maxTurnsPerAgent)
        .optional()
        .describe("Turns each worker may take. The lead is bounded by max_turns only."),
      turn_timeout_s: z
        .number()
        .int()
        .min(START_BOUNDS.turnTimeoutS.min)
        .max(START_BOUNDS.turnTimeoutS.max)
        .optional()
        .describe("Seconds one agent turn may run before it is abandoned."),
      max_minutes: z
        .number()
        .int()
        .min(1)
        .max(START_BOUNDS.maxMinutes)
        .optional()
        .describe("Wall clock for the whole swarm."),
      work_tools: z
        .enum(WORK_TOOLS)
        .optional()
        .describe(
          "'read' (default) grants Read/Grep/Glob; 'none' is chat only; 'write' also lets the lead spawn writers, each with its own worktree and Bash. 'write' needs project.",
        ),
      provider: z.string().optional(),
      model: z
        .string()
        .optional()
        .describe("Model for every agent, or for the lead alone when worker_model is set."),
      worker_model: z.string().optional().describe("Model for workers. Defaults to model."),
      power: z
        .enum(SWARM_POWERS)
        .optional()
        .describe(
          "How much model the agents get: fast, balanced (default) or deep. Each provider maps the class to one of its models; a named model wins.",
        ),
      workflows: z
        .array(
          z
            .object({
              name: z.string().min(1).max(100).describe("A catalog workflow name."),
              isolated: z
                .boolean()
                .optional()
                .describe(
                  "Default true: a run must establish its own worktree, or the swarm cancels it. Set false for a read-only workflow.",
                ),
            })
            .strict(),
        )
        .max(START_BOUNDS.maxWorkflows)
        .optional()
        .describe(
          "Workflows the lead may start on the project, which must be set. Each also needs the operator's ribWorkflowGrants entry for the chat rib.",
        ),
      lead_tools: z
        .array(
          z
            .string()
            .regex(/^[a-z][a-z0-9_]{1,63}$/, "a tool name such as beads_ready")
            .refine((n) => !n.startsWith("chat_"), "chat_* tools are the swarm's own"),
        )
        .max(START_BOUNDS.maxLeadTools)
        .optional()
        .describe(
          "Other ribs' tools the lead holds, e.g. beads_ready, beads_show, beads_close. The host projects a tool onto the lead's turns only when the operator's crossRibGrants lets the chat rib call it.",
        ),
      context: contextSchema
        .optional()
        .describe(
          "Evidence agents cannot fetch themselves: full issue bodies, PR diffs, reviews, check results. Snapshot it before starting; agents read it verbatim with chat_context.",
        ),
    })
    .strict();
  const reportSchema = z
    .object({
      title: z.string().min(1).max(REPORT_TITLE_MAX).describe("The report's title, one line."),
      html: z
        .string()
        .min(1)
        .max(REPORT_HTML_MAX)
        .describe("The page body markup, self-contained. The host supplies the document shell."),
    })
    .strict();
  const workflowStartSchema = z
    .object({
      workflow: z.string().min(1).describe("A workflow this swarm was granted, by exact name."),
      purpose: z
        .string()
        .min(1)
        .max(500)
        .describe("One line: what this run is for, such as the issue it fixes."),
      inputs: z
        .record(z.string(), z.string())
        .optional()
        .describe("The workflow's inputs by name, as strings."),
    })
    .strict();
  const workflowStatusSchema = z
    .object({ run_id: z.string().optional().describe("One run. Omit for every run.") })
    .strict();
  const workflowCancelSchema = z.object({ run_id: z.string().min(1) }).strict();
  const workflowRespondSchema = z
    .object({
      run_id: z.string().min(1),
      decision: z
        .enum(["approve", "changes"])
        .describe("approve lets the run go on; changes sends it feedback to apply first."),
      review: z
        .string()
        .min(1)
        .describe(
          "The id of the review message the decision rests on: written after the gate opened, by another agent or the operator.",
        ),
      reason: z
        .string()
        .min(1)
        .max(2_000)
        .describe("Why, in a sentence or two: the criteria the plan covers, or what it misses."),
      feedback: z
        .string()
        .max(BODY_MAX, tooLong(BODY_MAX))
        .optional()
        .describe(
          "Required for changes: what the run must change, completely. The run applies it without asking again.",
        ),
    })
    .strict();
  const swarmRef = z.object({ swarm: z.string().min(1).describe("The swarm id.") }).strict();
  const forgetSchema = z
    .object({
      swarm: z.string().min(1).optional().describe("One ended swarm's id."),
      older_than_days: z
        .number()
        .min(0)
        .max(3650)
        .optional()
        .describe(
          "Every ended swarm that ended more than this many days ago. 0 means every ended swarm.",
        ),
      confirm: z
        .boolean()
        .optional()
        .describe("Must be true to forget. Omitted, the tool reports what it would forget."),
    })
    .strict()
    .refine((a) => (a.swarm === undefined) !== (a.older_than_days === undefined), {
      message: "pass exactly one of swarm or older_than_days",
    });
  const transcriptSchema = z
    .object({
      swarm: z.string().min(1).describe("The swarm id."),
      thread: z.string().optional().describe("A thread's root message id, to read one thread."),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Character offset to continue a long transcript from."),
      tail: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe(
          "Only the last this many messages, still in order: the newest activity without paging.",
        ),
    })
    .strict();
  const statusSchema = z.object({ swarm: z.string().optional() }).strict();
  const waitSchema = z
    .object({
      swarm: z.string().min(1),
      timeout_s: z.number().int().min(1).max(WAIT_BOUNDS.maxS).optional(),
    })
    .strict();

  const summaryOf = (id: string): SwarmSummary | undefined =>
    deps.swarms.get(id)?.summary() ?? deps.ended.get(id);

  return [
    {
      name: "chat_post",
      description:
        "Swarm agents only. Write a top-level message on the swarm's shared channel. Wakes no one unless the body @mentions an agent's handle. NOT for answering an existing message (chat_reply).",
      inputSchema: postSchema,
      state_changing: true,
      execute: guarded(async (input, ctx) => {
        const args = postSchema.parse(input);
        const { swarm, agentId } = caller(ctx);
        const message = await swarm.post(agentId, args.body);
        emitText(ctx, `posted ${message.id}`);
      }),
    },
    {
      name: "chat_reply",
      description:
        "Swarm agents only. Answer inside a message's thread. Wakes the agent that started the thread, plus anyone @mentioned; when you started the thread, it wakes everyone in it. NOT for starting a new topic (chat_post).",
      inputSchema: replySchema,
      state_changing: true,
      execute: guarded(async (input, ctx) => {
        const args = replySchema.parse(input);
        const { swarm, agentId } = caller(ctx);
        const message = await swarm.reply(agentId, args.message_id, args.body);
        emitText(ctx, `replied ${message.id} in thread ${message.threadRootId}`);
      }),
    },
    {
      name: "chat_read",
      description:
        "Swarm agents only. Re-read the swarm channel's latest messages, or one thread when thread_id is given. Use it to regain context; new messages addressed to you arrive on their own.",
      inputSchema: readSchema,
      execute: guarded(async (input, ctx) => {
        const args = readSchema.parse(input);
        const { swarm, agentId } = caller(ctx);
        const messages = await swarm.read(agentId, {
          ...(args.thread_id ? { threadId: args.thread_id } : {}),
          limit: args.limit ?? READ_BOUNDS.defaultLimit,
        });
        emitText(ctx, renderMessages(messages));
      }),
    },
    {
      name: "chat_roster",
      description:
        "Swarm agents only. List the swarm's agents with their handles, roles, and turn counts.",
      inputSchema: z.object({}).strict(),
      execute: guarded(async (_input, ctx) => {
        const { swarm } = caller(ctx);
        emitText(ctx, JSON.stringify(swarm.roster(), null, 1));
      }),
    },
    {
      name: "chat_context",
      description:
        "Swarm agents only. Read the task context the operator supplied: with no id, list the items; with an id, read that item verbatim with its source, retrieval time, and SHAs. Long items page by offset. NOT for the chat transcript (chat_read).",
      inputSchema: contextReadSchema,
      execute: guarded(async (input, ctx) => {
        const args = contextReadSchema.parse(input);
        const { swarm, agentId } = caller(ctx);
        emitText(
          ctx,
          swarm.context(agentId, { ...(args.id ? { id: args.id } : {}), offset: args.offset ?? 0 }),
        );
      }),
    },
    {
      name: "chat_spawn",
      description:
        "Swarm agents only. Add a worker agent with its own context for a line of inquiry worth separating out. Posts the brief as an @mention so the new agent starts at once. Fails once the swarm's agent cap is reached. In a write swarm the lead passes writes: true for an agent that changes code in its own worktree. NOT for reaching an agent that already exists (@mention it).",
      inputSchema: spawnSchema,
      state_changing: true,
      execute: guarded(async (input, ctx) => {
        const args = spawnSchema.parse(input);
        const { swarm, agentId } = caller(ctx);
        const agent = await swarm.spawn(agentId, args);
        emitText(
          ctx,
          `spawned @${agent.handle}; it has been briefed and is starting.${agent.worktree ? ` It writes in ${agent.worktree.path} on branch ${agent.worktree.branch}.` : ""}`,
        );
      }),
    },
    {
      name: "chat_pr_open",
      description:
        "Writers only. Push your branch and open a DRAFT pull request against the project's default branch. Refuses uncommitted changes, and commits or text that carry AI attribution such as a Co-Authored-By: Claude trailer. A second call pushes your new commits and returns the pull request already open. It never merges.",
      inputSchema: prOpenSchema,
      state_changing: true,
      execute: guarded(async (input, ctx) => {
        const args = prOpenSchema.parse(input);
        const { swarm, agentId } = caller(ctx);
        const pr = await swarm.openPr(agentId, args);
        emitText(
          ctx,
          pr.again
            ? `pushed your branch; your pull request is already open: ${pr.url}`
            : `opened draft pull request ${pr.url}. Report it to the lead; the operator merges.`,
        );
      }),
    },
    {
      name: "chat_diff",
      description: `Swarm agents only, in a write swarm. Read a writer's change: its commits, what it has not committed, and git diff against the remote default branch. Pages by ${DIFF_PAGE} characters. For reviewing a writer's work.`,
      inputSchema: diffSchema,
      execute: guarded(async (input, ctx) => {
        const args = diffSchema.parse(input);
        const { swarm, agentId } = caller(ctx);
        const text = await swarm.diff(agentId, args.writer);
        const offset = args.offset ?? 0;
        if (offset > 0 && offset >= text.length) {
          return emitText(
            ctx,
            `offset ${offset} is past the end (${text.length} characters)`,
            true,
          );
        }
        const end = Math.min(text.length, offset + DIFF_PAGE);
        const more = end < text.length ? `\n\nMore: call again with offset ${end}.` : "";
        emitText(ctx, `${text.slice(offset, end)}${more}`);
      }),
    },
    {
      name: "chat_done",
      description: `Lead agent only. Conclude the swarm with its final answer, at most ${CONCLUSION_MAX} characters. Posts the conclusion to the channel and ends the run; no further turns start.`,
      inputSchema: doneSchema,
      state_changing: true,
      execute: guarded(async (input, ctx) => {
        const args = doneSchema.parse(input);
        const { swarm, agentId } = caller(ctx);
        const postError = await swarm.conclude(agentId, args.summary);
        emitText(
          ctx,
          postError
            ? `conclusion recorded; the swarm is ending, but posting it to the channel failed (${postError}). The operator has it in the swarm summary. End your turn now.`
            : "conclusion recorded; the swarm is ending. End your turn now.",
        );
      }),
    },
    {
      name: "chat_report",
      description: `Lead agent only. Publish the swarm's report: a designed, self-contained HTML page the operator opens from the Swarms tab. Calling it again replaces the page. Pass the markup itself, not wrapped in CDATA or a code fence. Read canvas_design_guide (sections "page" and "anti-patterns", plus "form" and "color" for charts) before writing it. The page renders in a sandboxed iframe with no network access: inline all CSS and JS, no external scripts or stylesheets, system font stack only (font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif). Style through CSS custom properties: dark values in :root, overridden in :root[data-theme="light"]. Declare any categorical chart palette on <body> as data-palette-dark="#hex,…" and data-palette-light="…"; a palette that fails color-vision or contrast checks is refused, so fix the colors and call again.`,
      inputSchema: reportSchema,
      state_changing: true,
      execute: guarded(async (input, ctx) => {
        const args = reportSchema.parse(input);
        const { swarm, agentId } = caller(ctx);
        const report = swarm.publishReport(agentId, args.title, args.html);
        emitText(
          ctx,
          `report "${report.title}" published (${Math.round(Buffer.byteLength(report.html, "utf8") / 1024)} KB). The operator opens it from the swarm's card. Keep the chat_done conclusion a short summary that points to it.`,
        );
      }),
    },
    {
      name: "chat_workflow_start",
      description:
        "Lead agent only, in a swarm granted workflows. Start one of the granted Keelson workflows on the project and track its run. Returns the run id; the run's progress wakes you. NOT for work you can do with chat tools.",
      inputSchema: workflowStartSchema,
      state_changing: true,
      execute: guarded(async (input, ctx) => {
        const args = workflowStartSchema.parse(input);
        const { swarm, agentId } = caller(ctx);
        const run = await swarm.startRun(agentId, {
          workflow: args.workflow,
          purpose: args.purpose,
          inputs: args.inputs ?? {},
        });
        emitText(ctx, `started ${run.workflow} run ${run.runId}. Its progress will wake you.`);
      }),
    },
    {
      name: "chat_workflow_status",
      description:
        "Lead agent only. Report this swarm's workflow runs: status, approval gates waiting and answered, branch, pull requests, isolation, CI verdict, and whether each is verified.",
      inputSchema: workflowStatusSchema,
      execute: guarded(async (input, ctx) => {
        const args = workflowStatusSchema.parse(input);
        const { swarm } = caller(ctx);
        const runs = swarm.runLedger().filter((r) => !args.run_id || r.runId === args.run_id);
        if (args.run_id && runs.length === 0) {
          return emitText(ctx, `no run '${args.run_id}' was started by this swarm`, true);
        }
        emitText(ctx, runs.length > 0 ? runs.map(describeRun).join("\n") : "(no runs started)");
      }),
    },
    {
      name: "chat_workflow_cancel",
      description: "Lead agent only. Cancel a live workflow run this swarm started.",
      inputSchema: workflowCancelSchema,
      state_changing: true,
      execute: guarded(async (input, ctx) => {
        const args = workflowCancelSchema.parse(input);
        const { swarm, agentId } = caller(ctx);
        const run = await swarm.cancelChildRun(agentId, args.run_id);
        emitText(ctx, describeRun(run));
      }),
    },
    {
      name: "chat_workflow_respond",
      description:
        "Lead agent only. Answer a paused run's approval gate for the operator once another agent has reviewed it: approve, or send the changes the run must make. Cite the review message.",
      inputSchema: workflowRespondSchema,
      state_changing: true,
      execute: guarded(async (input, ctx) => {
        const args = workflowRespondSchema.parse(input);
        const { swarm, agentId } = caller(ctx);
        const run = await swarm.answerGate(agentId, {
          runId: args.run_id,
          decision: args.decision,
          review: args.review,
          reason: args.reason,
          ...(args.feedback ? { feedback: args.feedback } : {}),
        });
        emitText(ctx, describeRun(run));
      }),
    },
    {
      name: "chat_swarm_start",
      description:
        "Start an agent swarm on a task. Agents are ClickClack bots that coordinate in a dedicated channel a human can watch and post in. Returns at once with the swarm id and a run id: poll chat_swarm_status or run_status, stop with chat_swarm_stop or run_cancel, redirect with run_steer. NOT for a single-agent question, or a fixed-roster discussion (a Chamber room).",
      inputSchema: startSchema,
      state_changing: true,
      execute: guarded(async (input, ctx) => {
        const args = startSchema.parse(input);
        const { swarm, opId, url } = await deps.startSwarm({
          task: args.task,
          workTools: args.work_tools ?? "read",
          ...(args.project ? { project: args.project } : {}),
          ...(args.size ? { size: args.size } : {}),
          ...(args.max_agents ? { maxAgents: args.max_agents } : {}),
          ...(args.max_turns ? { maxTurns: args.max_turns } : {}),
          ...(args.max_turns_per_agent ? { maxTurnsPerAgent: args.max_turns_per_agent } : {}),
          ...(args.turn_timeout_s ? { turnTimeoutMs: args.turn_timeout_s * 1_000 } : {}),
          ...(args.max_minutes ? { wallClockMs: args.max_minutes * 60_000 } : {}),
          ...(args.provider ? { provider: args.provider } : {}),
          ...(args.model ? { model: args.model } : {}),
          ...(args.worker_model ? { workerModel: args.worker_model } : {}),
          ...(args.power ? { power: args.power } : {}),
          ...(args.workflows?.length
            ? {
                workflows: args.workflows.map((w) => ({
                  name: w.name,
                  isolated: w.isolated ?? true,
                })),
              }
            : {}),
          ...(args.context?.length ? { context: toContextItems(args.context) } : {}),
          ...(args.lead_tools?.length ? { leadTools: [...new Set(args.lead_tools)] } : {}),
        });
        const s = swarm.summary();
        emitText(
          ctx,
          `swarm ${s.id} started in #${s.channelName}${opId ? ` (run ${opId})` : ""}. Poll chat_swarm_status("${s.id}")${opId ? ` or run_status("${opId}")` : ""}.${url ? ` Watch at ${url}/app.` : ""}`,
        );
      }),
    },
    {
      name: "chat_swarm_status",
      description:
        "Report one swarm (agents, turns used, status, conclusion), or every known swarm when `swarm` is omitted.",
      inputSchema: statusSchema,
      execute: guarded(async (input, ctx) => {
        const args = statusSchema.parse(input);
        if (args.swarm) {
          const summary = summaryOf(args.swarm);
          if (!summary) return emitText(ctx, `no swarm '${args.swarm}'`, true);
          return emitText(ctx, JSON.stringify(publicSummary(summary), null, 1));
        }
        const pending = [...(deps.starting?.values() ?? [])].map((s) => ({
          id: s.id,
          status: "starting",
          size: sizeOf(s.limits, s.sizeBase),
          model: modelLabel({ ...s, agents: [] }),
          task: s.task.slice(0, 120),
        }));
        const all = [...[...deps.swarms.values()].map((s) => s.summary()), ...deps.ended.values()];
        emitText(
          ctx,
          JSON.stringify(
            [
              ...pending,
              ...all.map((s) => ({
                id: s.id,
                status: s.status,
                channelName: s.channelName,
                turnsUsed: s.turnsUsed,
                size: s.size,
                model: modelLabel(s),
                ...(s.usage ? { tokens: tokensText(s.usage) } : {}),
                task: s.task.slice(0, 120),
              })),
            ],
            null,
            1,
          ),
        );
      }),
    },
    {
      name: "chat_swarm_wait",
      description: `Block until a swarm ends or timeout_s (default ${WAIT_BOUNDS.defaultS}) passes, then report its status. For a workflow that must hold until the swarm concludes; from chat, prefer chat_swarm_status.`,
      inputSchema: waitSchema,
      execute: guarded(async (input, ctx) => {
        const args = waitSchema.parse(input);
        const live = deps.swarms.get(args.swarm);
        if (live) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timeout = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, (args.timeout_s ?? WAIT_BOUNDS.defaultS) * 1_000);
          });
          const aborted = new Promise<void>((resolve) =>
            ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true }),
          );
          await Promise.race([live.finished, timeout, aborted]);
          if (timer) clearTimeout(timer);
        }
        const summary = summaryOf(args.swarm);
        if (!summary) return emitText(ctx, `no swarm '${args.swarm}'`, true);
        const state = isLive(summary.status) ? "RUNNING" : "ENDED";
        emitText(ctx, `${state}\n${JSON.stringify(publicSummary(summary), null, 1)}`);
      }),
    },
    {
      name: "chat_swarm_transcript",
      description: `Read a swarm's channel as the operator, running or ended: every message in order, thread replies included, or one thread. Pages by ${TRANSCRIPT_PAGE} characters; \`tail\` reads only the newest messages. NOT for swarm agents (chat_read).`,
      inputSchema: transcriptSchema,
      execute: guarded(async (input, ctx) => {
        const args = transcriptSchema.parse(input);
        const summary = summaryOf(args.swarm);
        if (!summary) return emitText(ctx, `no swarm '${args.swarm}'`, true);
        if (!deps.readChannel) return emitText(ctx, "transcripts are not available here", true);
        const all = await deps.readChannel(summary.channelId, args.thread);
        const messages = args.tail ? all.slice(-args.tail) : all;
        const text = renderMessages(messages);
        const offset = args.offset ?? 0;
        if (offset > 0 && offset >= text.length) {
          return emitText(
            ctx,
            `offset ${offset} is past the end (${text.length} characters)`,
            true,
          );
        }
        const end = Math.min(text.length, offset + TRANSCRIPT_PAGE);
        const count =
          messages.length < all.length
            ? `last ${messages.length} of ${all.length} messages`
            : `${all.length} messages`;
        const head = `#${summary.channelName}${args.thread ? ` thread ${args.thread}` : ""}: ${count}, ${text.length} characters. Showing ${offset}-${end}.`;
        const more = end < text.length ? `\n\nMore: call again with offset ${end}.` : "";
        emitText(ctx, `${head}\n\n${text.slice(offset, end)}${more}`);
      }),
    },
    {
      name: "chat_swarm_forget",
      description:
        "Forget ended swarms: drop them from the Swarms tab, chat_swarm_status, and the rib's history, with their launches and reports. Takes one `swarm` id or `older_than_days`. Never touches a live swarm, and leaves each channel's transcript in ClickClack. Without confirm: true it only reports what it would forget. To wipe transcripts too, use chat_server_reset.",
      inputSchema: forgetSchema,
      state_changing: true,
      execute: guarded(async (input, ctx) => {
        const args = forgetSchema.parse(input);
        if (!deps.forget) return emitText(ctx, "this host cannot forget swarms", true);
        if (args.swarm && (deps.swarms.has(args.swarm) || deps.starting?.has(args.swarm))) {
          return emitText(ctx, `swarm '${args.swarm}' is live; stop it first`, true);
        }
        const cutoff =
          args.older_than_days === undefined
            ? undefined
            : Date.now() - args.older_than_days * 86_400_000;
        const ids = [...deps.ended.values()]
          .filter((s) =>
            args.swarm !== undefined
              ? s.id === args.swarm
              : cutoff !== undefined &&
                (args.older_than_days === 0 || Date.parse(s.endedAt ?? s.startedAt) < cutoff),
          )
          .map((s) => s.id);
        if (ids.length === 0) {
          return emitText(
            ctx,
            args.swarm
              ? `no ended swarm '${args.swarm}'`
              : "no ended swarm matches; nothing to forget",
            Boolean(args.swarm),
          );
        }
        const list = ids.join(", ");
        if (!args.confirm) {
          return emitText(
            ctx,
            `would forget ${ids.length} ended swarm(s): ${list}. Re-issue with confirm: true.`,
          );
        }
        deps.forget(ids);
        emitText(
          ctx,
          `forgot ${ids.length} ended swarm(s): ${list}. Their transcripts stay in ClickClack.`,
        );
      }),
    },
    {
      name: "chat_swarm_stop",
      description:
        "Stop a running swarm: aborts turns in flight, revokes the agents' credentials, and leaves the channel transcript in place.",
      inputSchema: swarmRef,
      state_changing: true,
      execute: guarded(async (input, ctx) => {
        const args = swarmRef.parse(input);
        const swarm = deps.swarms.get(args.swarm);
        if (!swarm) return emitText(ctx, `no running swarm '${args.swarm}'`, true);
        const summary = await swarm.stop();
        emitText(ctx, `swarm ${summary.id} stopped after ${summary.turnsUsed} turns.`);
      }),
    },
  ];
}
