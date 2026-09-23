// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { ChatMessage } from "./types.ts";

// Who a message wakes. Pure: no I/O, no clock, no provider. The swarm engine
// owns everything with side effects, the same split Chamber draws between a
// room strategy and its driver.

export interface RoutableAgent {
  id: string;
  handle: string;
  botUserId: string;
  lead: boolean;
}

export interface RouteInput {
  message: ChatMessage;
  agents: readonly RoutableAgent[];
  // Agent ids already taking part in the message's thread.
  threadParticipants: ReadonlySet<string>;
  // The agent that started the message's thread, when an agent did.
  threadStarter?: string;
}

const MENTION = /(^|[^\w@/])@([a-z0-9][a-z0-9-]*)/gi;

export function mentionedHandles(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(MENTION)) {
    const handle = match[2];
    if (handle) found.add(handle.toLowerCase());
  }
  return [...found];
}

// Text that opens a sentence, ignoring markdown marks.
const OPENS = /(^|\n|[.!?:]\s)[\s*_>`~-]*$/;
const SENTENCE_END = /[.!?](\s|$)|\n/;

// Handles a message speaks to rather than about: the mention opens a sentence,
// or the sentence it sits in is a question.
export function addressedHandles(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(MENTION)) {
    const handle = match[2];
    if (!handle) continue;
    const at = (match.index ?? 0) + (match[1]?.length ?? 0);
    const rest = body.slice(at);
    const end = rest.search(SENTENCE_END);
    const asks = end >= 0 && rest[end] === "?";
    if (OPENS.test(body.slice(0, at)) || asks) found.add(handle.toLowerCase());
  }
  return [...found];
}

export function route(input: RouteInput): string[] {
  const { message, agents, threadParticipants, threadStarter } = input;
  const author = agents.find((a) => a.botUserId === message.authorId);
  const recipients = new Set<string>();

  const handles = new Set(mentionedHandles(message.body));
  for (const agent of agents) {
    if (handles.has(agent.handle.toLowerCase())) recipients.add(agent.id);
  }

  // A reply from the thread's starter, or from a human, addresses the whole
  // thread. Anyone else's reply answers the starter; peers join by @mention.
  const isReply = message.threadRootId !== message.id;
  if (isReply) {
    if (!author || !threadStarter || author.id === threadStarter) {
      for (const id of threadParticipants) recipients.add(id);
    } else {
      recipients.add(threadStarter);
    }
  }

  // An unaddressed top-level post wakes the lead only when a human wrote it. An
  // agent's unaddressed post wakes nobody: the board is free to write to, and
  // costing a peer a turn takes deliberate addressing.
  if (recipients.size === 0 && !isReply && !author) {
    const lead = agents.find((a) => a.lead);
    if (lead) recipients.add(lead.id);
  }

  if (author) recipients.delete(author.id);
  return [...recipients];
}
