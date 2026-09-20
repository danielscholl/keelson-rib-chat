import { describe, expect, test } from "bun:test";
import { mentionedHandles, type RoutableAgent, route } from "../src/router.ts";
import type { ChatMessage } from "../src/types.ts";

const agents: RoutableAgent[] = [
  { id: "lead", handle: "s1-lead", botUserId: "usr_lead", lead: true },
  { id: "scout", handle: "s1-scout", botUserId: "usr_scout", lead: false },
  { id: "critic", handle: "s1-critic", botUserId: "usr_critic", lead: false },
];

function msg(over: Partial<ChatMessage>): ChatMessage {
  return {
    id: "msg_1",
    channelId: "chn_1",
    authorId: "usr_human",
    authorKind: "human",
    authorHandle: "",
    authorName: "Human",
    body: "",
    threadRootId: over.id ?? "msg_1",
    createdAt: "",
    ...over,
  };
}

const none = new Set<string>();

describe("mentionedHandles", () => {
  test("finds handles and ignores emails and paths", () => {
    expect(mentionedHandles("hey @s1-scout and @S1-Critic, mail a@b.com or see x/@y")).toEqual([
      "s1-scout",
      "s1-critic",
    ]);
  });
});

describe("route", () => {
  test("a human's unaddressed top-level post wakes the lead", () => {
    expect(
      route({ message: msg({ body: "new direction" }), agents, threadParticipants: none }),
    ).toEqual(["lead"]);
  });

  test("an agent's unaddressed top-level post wakes nobody", () => {
    const message = msg({ authorId: "usr_scout", authorKind: "bot", body: "noting a finding" });
    expect(route({ message, agents, threadParticipants: none })).toEqual([]);
  });

  test("a mention wakes exactly the mentioned agent", () => {
    const message = msg({
      authorId: "usr_lead",
      authorKind: "bot",
      body: "@s1-scout check the logs",
    });
    expect(route({ message, agents, threadParticipants: none })).toEqual(["scout"]);
  });

  test("a thread reply wakes the thread's participants but never its author", () => {
    const message = msg({
      id: "msg_2",
      threadRootId: "msg_1",
      authorId: "usr_scout",
      authorKind: "bot",
    });
    const woken = route({ message, agents, threadParticipants: new Set(["lead", "scout"]) });
    expect(woken).toEqual(["lead"]);
  });

  test("a mention inside a thread adds to the participants", () => {
    const message = msg({
      id: "msg_2",
      threadRootId: "msg_1",
      authorId: "usr_lead",
      authorKind: "bot",
      body: "@s1-critic weigh in",
    });
    const woken = route({ message, agents, threadParticipants: new Set(["lead", "scout"]) });
    expect(woken.sort()).toEqual(["critic", "scout"]);
  });

  test("self-mention does not wake the author", () => {
    const message = msg({
      authorId: "usr_scout",
      authorKind: "bot",
      body: "@s1-scout note to self",
    });
    expect(route({ message, agents, threadParticipants: none })).toEqual([]);
  });
});
