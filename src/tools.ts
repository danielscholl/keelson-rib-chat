// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { ToolContext, ToolDefinition } from "@keelson/shared";
import { z } from "zod";
import { type ContextItem, contextSchema, toContextItems } from "./context.ts";
import type { Swarm } from "./swarm.ts";
import { type ChatMessage, readTurnContext, type SwarmSummary } from "./types.ts";

// The tool layer's seams, injected so the module stays testable: index.ts
// passes the live registry and launcher, tests pass fakes.
export interface StartSwarmInput {
  task: string;
  project?: string;
  maxAgents?: number;
  maxTurns?: number;
  workTools: "none" | "read";
  context?: ContextItem[];
  provider?: string;
  model?: string;
}

export interface ToolDeps {
  swarms: Map<string, Swarm>;
  // Summaries of swarms that have ended, kept so status still answers.
  ended: Map<string, SwarmSummary>;
  startSwarm: (input: StartSwarmInput) => Promise<{ swarm: Swarm; opId?: string }>;
}

export const BODY_MAX = 8_000;
export const START_BOUNDS = { maxAgents: 12, maxTurns: 200 } as const;
export const WAIT_BOUNDS = { defaultS: 120, maxS: 600 } as const;
export const READ_BOUNDS = { defaultLimit: 20, maxLimit: 50 } as const;
// Ended swarms whose summary chat_swarm_status still answers for.
export const ENDED_KEPT = 20;
const body = z.string().min(1).max(BODY_MAX).describe("Markdown message body.");

function emitText(ctx: ToolContext, content: string, isError = false): void {
  ctx.emit({ type: "tool_result", toolUseId: "", content, ...(isError ? { isError: true } : {}) });
}

// A tool failure is a result the agent can read and react to, never an
// exception that escapes into the harness's turn loop.
function guarded(
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
    const swarm = deps.swarms.get(turn.swarmId);
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
      brief: z.string().min(1).max(BODY_MAX).describe("The narrow task, with what to report."),
    })
    .strict();
  const doneSchema = z
    .object({ summary: z.string().min(1).max(BODY_MAX).describe("The swarm's final answer.") })
    .strict();
  const startSchema = z
    .object({
      task: z.string().min(1).max(BODY_MAX).describe("What the swarm should work out."),
      project: z
        .string()
        .optional()
        .describe("A registered keelson project; agents read its checkout."),
      max_agents: z.number().int().min(1).max(START_BOUNDS.maxAgents).optional(),
      max_turns: z.number().int().min(1).max(START_BOUNDS.maxTurns).optional(),
      work_tools: z
        .enum(["none", "read"])
        .optional()
        .describe("'read' (default) grants Read/Grep/Glob; 'none' is chat only."),
      provider: z.string().optional(),
      model: z.string().optional(),
      context: contextSchema
        .optional()
        .describe(
          "Evidence agents cannot fetch themselves: full issue bodies, PR diffs, reviews, check results. Snapshot it before starting; agents read it verbatim with chat_context.",
        ),
    })
    .strict();
  const swarmRef = z.object({ swarm: z.string().min(1).describe("The swarm id.") }).strict();
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
        "Swarm agents only. Answer inside a message's thread. Wakes the agents already in that thread, plus anyone @mentioned. NOT for starting a new topic (chat_post).",
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
        "Swarm agents only. Add a worker agent with its own context for a line of inquiry worth separating out. Posts the brief as an @mention so the new agent starts at once. Fails once the swarm's agent cap is reached. NOT for reaching an agent that already exists (@mention it).",
      inputSchema: spawnSchema,
      state_changing: true,
      execute: guarded(async (input, ctx) => {
        const args = spawnSchema.parse(input);
        const { swarm, agentId } = caller(ctx);
        const agent = await swarm.spawn(agentId, args);
        emitText(ctx, `spawned @${agent.handle}; it has been briefed and is starting.`);
      }),
    },
    {
      name: "chat_done",
      description:
        "Lead agent only. Conclude the swarm with its final answer. Posts the conclusion to the channel and ends the run; no further turns start.",
      inputSchema: doneSchema,
      state_changing: true,
      execute: guarded(async (input, ctx) => {
        const args = doneSchema.parse(input);
        const { swarm, agentId } = caller(ctx);
        await swarm.conclude(agentId, args.summary);
        emitText(ctx, "conclusion recorded; the swarm is ending. End your turn now.");
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
        const { swarm, opId } = await deps.startSwarm({
          task: args.task,
          workTools: args.work_tools ?? "read",
          ...(args.project ? { project: args.project } : {}),
          ...(args.max_agents ? { maxAgents: args.max_agents } : {}),
          ...(args.max_turns ? { maxTurns: args.max_turns } : {}),
          ...(args.provider ? { provider: args.provider } : {}),
          ...(args.model ? { model: args.model } : {}),
          ...(args.context?.length ? { context: toContextItems(args.context) } : {}),
        });
        const s = swarm.summary();
        emitText(
          ctx,
          `swarm ${s.id} started in #${s.channelName}${opId ? ` (run ${opId})` : ""}. Poll chat_swarm_status("${s.id}")${opId ? ` or run_status("${opId}")` : ""}.`,
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
          return emitText(ctx, JSON.stringify(summary, null, 1));
        }
        const all = [...[...deps.swarms.values()].map((s) => s.summary()), ...deps.ended.values()];
        emitText(
          ctx,
          JSON.stringify(
            all.map(({ id, status, task, turnsUsed, channelName }) => ({
              id,
              status,
              channelName,
              turnsUsed,
              task: task.slice(0, 120),
            })),
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
        const state = summary.status === "running" ? "RUNNING" : "ENDED";
        emitText(ctx, `${state}\n${JSON.stringify(summary, null, 1)}`);
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
