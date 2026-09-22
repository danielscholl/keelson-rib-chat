// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import {
  type AgentStatus,
  BODY_MAX,
  type ChatMessage,
  CONCLUSION_MAX,
  type DispatchGrant,
  type SwarmAgent,
  type SwarmLimits,
} from "./types.ts";

export interface TeamMember {
  handle: string;
  status: AgentStatus;
  turns: number;
}

const BACKGROUND_PREVIEW = 240;

export function systemPrompt(opts: {
  agent: SwarmAgent;
  task: string;
  channelName: string;
  limits: SwarmLimits;
  // Tools granted beside the chat_* set, e.g. Read, Grep, Glob.
  workTools?: readonly string[];
  // The rendered index of the task context, one line per item.
  contextIndex: string;
  // Workflows the lead may start on the project.
  grants?: readonly DispatchGrant[];
}): string {
  const { agent, task, channelName, limits, contextIndex } = opts;
  const workTools = opts.workTools ?? [];
  const grants = opts.grants ?? [];
  const duty = agent.lead
    ? [
        "You are the LEAD. You own the outcome. Plan the work, split it into pieces that can run in parallel, delegate with @mentions or chat_spawn, integrate what comes back, and call chat_done with the final answer. Do a piece yourself when delegating it would cost more than it saves.",
        "Before chat_done, check that every worker you delegated to has reported or is out of turns. Each of your turns lists who is still working.",
        `The conclusion is at most ${CONCLUSION_MAX} characters. If the answer needs more, post the detail with chat_post first and conclude with the summary. Calling chat_done ends the swarm.`,
      ].join("\n")
    : [
        "You are a WORKER. Own the piece you were given. Report once, to whoever asked, in their thread, with evidence. Then stop.",
        "If your piece splits into parts worth running in parallel, you may chat_spawn a helper with a narrow brief. If you find work nobody owns, tell the lead rather than taking over the task.",
      ].join("\n");
  const toolLine =
    workTools.length > 0
      ? `- Your tools are the chat_* tools plus ${workTools.join(", ")}. You have nothing else: no shell, no edits, no network. Do not try other tools.`
      : "- Your tools are the chat_* tools. You have nothing else: no files, no shell, no network. Do not try other tools.";
  const dispatch =
    grants.length > 0
      ? [
          "",
          "Workflow runs:",
          `- You can start these Keelson workflows on the project with chat_workflow_start: ${grants.map((g) => `${g.name}${g.isolated ? " (must run in its own worktree)" : ""}`).join(", ")}. A run does the changing: it edits, commits, and opens pull requests in an isolated worktree, so you never need write access yourself.`,
          "- Give each run one clear purpose and the inputs its workflow expects. Start independent runs in parallel.",
          "- Every run branches from the project's default branch, so a run cannot see another run's change until that pull request is merged. For work that depends on another run's change, ask the operator in the channel to merge its pull request, and start the dependent run only after they say it is merged.",
          "- A run's progress wakes you. chat_workflow_status shows every run with its branch, pull requests, and evidence; chat_workflow_cancel stops one.",
          "- A run can pause for human approval. You cannot answer it: tell the operator in the channel what it is waiting for, then wait.",
          "- A run that must be isolated but lands in the live checkout is cancelled for you. A run counts as verified only when it succeeded in its own worktree, opened a pull request, and reported passing CI; report anything less as unverified, with what it lacks.",
          "- You cannot conclude while a run is live. Wait for it, or cancel it.",
        ]
      : [];
  const turnLine = agent.lead
    ? `- Each time you wake is one turn from a shared budget of ${limits.maxTurns} for the whole swarm.`
    : `- Each time you wake is one turn: you have ${limits.maxTurnsPerAgent}, from a shared budget of ${limits.maxTurns} for the whole swarm.`;
  return [
    `You are ${agent.displayName} (@${agent.handle}), one agent in a swarm: a small team of AI agents working one task together in the chat channel #${channelName}. Each agent is a separate session. You share only this channel and the task context.`,
    `Role: ${agent.role}`,
    `Task: ${task}`,
    "",
    duty,
    "",
    "How the swarm works:",
    "- You work in turns. A turn starts when a message reaches you and ends when you stop calling tools. Between turns you sleep, and you wake only when someone addresses you.",
    "- You act only through tools. Your plain reply text is discarded and nobody sees it.",
    toolLine,
    "- chat_post writes a top-level note. It wakes no one unless it @mentions a handle.",
    "- chat_reply answers in a thread. It wakes whoever started the thread. @mention anyone else you need there.",
    "- Thread replies that did not wake you are listed as background the next time you wake.",
    "- chat_read re-reads the channel or one thread. chat_roster lists the agents, their roles, and their turns.",
    `- chat_spawn adds an agent for a line of work that deserves its own context. The swarm holds at most ${limits.maxAgents} agents.`,
    "- A human may post in the channel at any time. Treat it as direction from the operator.",
    ...dispatch,
    "",
    "Working norms:",
    turnLine,
    "- Post one complete report instead of several partial ones. Lead with the answer, then the evidence: file paths, line numbers, output.",
    "- Do not post to agree, thank, or acknowledge. Reply only to add a fact, a correction, or a decision. Ending a turn without posting is fine.",
    "- When a peer's claim is wrong, correct it with evidence and @mention them. When yours was wrong, say so once.",
    `- A message is at most ${BODY_MAX} characters.`,
    "",
    "Task context (authoritative evidence the operator snapshotted; read it with chat_context):",
    contextIndex,
    "",
    "Evidence rules:",
    "- You cannot reach an issue tracker, a forge, or CI. The task context above is the only external evidence you have.",
    "- Requirements live in the context items, not in the task text's summary of them. Read the item before relying on it, and cite its id when you quote it.",
    "- If something you need is not in the context, or an item is marked 'retrieval time unknown', or its head SHA is not the one under discussion, write MISSING EVIDENCE or STALE EVIDENCE and name what is needed. Never fill the gap from the name of a field, a guess, or memory.",
  ].join("\n");
}

function renderMessage(m: ChatMessage): string {
  const who = m.authorHandle ? `@${m.authorHandle}` : m.authorName;
  const kind = m.authorKind === "human" ? " [human]" : "";
  const where =
    m.threadRootId === m.id ? `top-level ${m.id}` : `${m.id} in thread ${m.threadRootId}`;
  return `--- ${who}${kind} (${where})\n${m.body}`;
}

function preview(m: ChatMessage): string {
  const who = m.authorHandle ? `@${m.authorHandle}` : m.authorName;
  const flat = m.body.replace(/\s+/g, " ").trim();
  const text = flat.length > BACKGROUND_PREVIEW ? `${flat.slice(0, BACKGROUND_PREVIEW)}…` : flat;
  return `- ${who} in thread ${m.threadRootId} (${m.id}): ${text}`;
}

export interface TurnInput {
  // A standing instruction for this turn, such as the idle nudge.
  note?: string;
  // Why messages are repeated: the previous turn failed before finishing.
  redelivered?: string;
  messages: readonly ChatMessage[];
  // Thread replies that did not wake this agent.
  background?: readonly ChatMessage[];
  budget: { turnsUsed: number; maxTurns: number; agentTurns: number; maxTurnsPerAgent?: number };
  // The lead's view of its workers.
  team?: readonly TeamMember[];
  // Workflow run updates since the lead's last turn.
  events?: readonly string[];
  // The lead's workflow runs, one line each.
  runs?: readonly string[];
}

export function renderTurn(input: TurnInput): string {
  const {
    note,
    redelivered,
    messages,
    background = [],
    budget,
    team,
    events = [],
    runs = [],
  } = input;
  const sections: string[] = [];
  if (note) sections.push(note);
  if (events.length > 0) {
    sections.push(["Workflow run updates:", ...events.map((e) => `- ${e}`)].join("\n"));
  }
  if (redelivered) {
    sections.push(
      `Your previous turn ended before it finished (${redelivered}). Its messages are delivered again below.`,
    );
  }
  if (messages.length > 0) {
    sections.push(
      [`New messages for you (${messages.length}):`, ...messages.map(renderMessage)].join("\n"),
    );
  }
  if (background.length > 0) {
    sections.push(
      [
        "Background: replies in your threads that did not wake you. No reply is needed; chat_read a thread for the full text.",
        ...background.map(preview),
      ].join("\n"),
    );
  }
  if (team && team.length > 0) {
    const members = team.map(
      (m) => `@${m.handle} ${m.status === "busy" ? "working" : m.status} (${m.turns} turns)`,
    );
    sections.push(`Workers: ${members.join(", ")}.`);
  }
  if (runs.length > 0) sections.push(["Runs:", ...runs.map((r) => `- ${r}`)].join("\n"));
  sections.push(
    `Budget: swarm ${budget.turnsUsed}/${budget.maxTurns} turns${budget.maxTurnsPerAgent ? `, you ${budget.agentTurns}/${budget.maxTurnsPerAgent}` : ""}.`,
  );
  return sections.join("\n\n");
}

export function nudgeText(conclusionMax: number): string {
  return `The swarm is idle: no agent is working and nothing is waiting. If work remains, delegate it with an @mention or chat_spawn, or do it yourself. If the task is resolved, or no further progress is likely, call chat_done with the final answer, in at most ${conclusionMax} characters.`;
}
