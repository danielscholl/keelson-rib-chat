// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { ChatMessage, SwarmAgent, SwarmLimits } from "./types.ts";

export function systemPrompt(opts: {
  agent: SwarmAgent;
  task: string;
  channelName: string;
  limits: SwarmLimits;
  // The rendered index of the task context, one line per item.
  contextIndex: string;
}): string {
  const { agent, task, channelName, limits, contextIndex } = opts;
  const duty = agent.lead
    ? "You are the LEAD. You own the outcome: break the task down, delegate with @mentions or chat_spawn, integrate what comes back, and call chat_done with the final answer once the task is resolved or further progress is unlikely. Do the work yourself when delegation would cost more than it saves."
    : "You are a worker. Do the part you were given, report to whoever asked in their thread with evidence, then stop. Do not take over the task.";
  return [
    `You are ${agent.displayName} (@${agent.handle}), one agent in a swarm working a shared task in the chat channel #${channelName}.`,
    `Role: ${agent.role}`,
    `Task: ${task}`,
    "",
    duty,
    "",
    "How the swarm works:",
    "- You act only through tools. Your plain reply text is discarded and nobody sees it.",
    "- chat_post writes a top-level note on the shared board. It wakes NO ONE unless you @mention a handle.",
    "- chat_reply answers inside a thread and wakes the agents already in that thread.",
    "- To get one agent's attention, @mention its handle. Every wake spends swarm budget, so address deliberately.",
    "- chat_read re-reads the channel or one thread. chat_roster lists the agents and their roles.",
    `- chat_spawn adds a worker when a line of inquiry deserves its own context (at most ${limits.maxAgents} agents). Give it a narrow brief.`,
    "- Silence is fine. If a message needs nothing from you, end the turn without posting.",
    "- Report findings with evidence: file paths, commands, output. Keep messages short.",
    "- A human may post in the channel at any time. Treat it as direction from the operator.",
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

export function renderInbox(
  messages: readonly ChatMessage[],
  budget: { turnsUsed: number; maxTurns: number; agentTurns: number; maxTurnsPerAgent?: number },
): string {
  const lines = messages.map((m) => {
    const who = m.authorHandle ? `@${m.authorHandle}` : m.authorName;
    const kind = m.authorKind === "human" ? " [human]" : "";
    const where =
      m.threadRootId === m.id ? `top-level ${m.id}` : `${m.id} in thread ${m.threadRootId}`;
    return `--- ${who}${kind} (${where})\n${m.body}`;
  });
  return [
    `New messages for you (${messages.length}):`,
    ...lines,
    "",
    `Budget: swarm ${budget.turnsUsed}/${budget.maxTurns} turns${budget.maxTurnsPerAgent ? `, you ${budget.agentTurns}/${budget.maxTurnsPerAgent}` : ""}.`,
  ].join("\n");
}

export function nudgeText(): string {
  return "The swarm is idle: no agent is working and nothing is waiting. If work remains, delegate it with an @mention or chat_spawn, or do it yourself. If the task is resolved, or no further progress is likely, call chat_done with the final answer.";
}
