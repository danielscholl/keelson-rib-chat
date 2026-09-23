import { describe, expect, test } from "bun:test";
import { addressedHandles, mentionedHandles, type RoutableAgent, route } from "../src/router.ts";
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

describe("addressedHandles", () => {
  const speaksTo = (body: string) => addressedHandles(body).includes("operator");

  test("a mention that opens the message or a sentence addresses the operator", () => {
    expect(speaksTo("@operator Both workers recommend it. Which name should we pick?")).toBe(true);
    expect(
      speaksTo("Caveat: use Partial outage. @operator please choose before we conclude."),
    ).toBe(true);
    expect(speaksTo("Done.\n\n**@operator** the release waits for you.")).toBe(true);
  });

  test("a question naming the operator addresses them wherever the mention sits", () => {
    expect(speaksTo("Could @operator merge v1.2 of the chart?")).toBe(true);
  });

  test("a mention in passing does not", () => {
    expect(speaksTo("Please send it now so I can present both options to @operator.")).toBe(false);
    expect(
      speaksTo(
        "@s1-lead Preferred: Degraded Performance. Before concluding, ask @operator to choose.",
      ),
    ).toBe(false);
    expect(speaksTo("@s1-naming-b I need both proposals before asking @operator.")).toBe(false);
  });

  test("other handles follow the same rule", () => {
    expect(addressedHandles("@s1-lead done. I told @s1-w2 already.")).toEqual(["s1-lead"]);
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

  test("another agent's reply wakes only the thread's starter", () => {
    const message = msg({
      id: "msg_3",
      threadRootId: "msg_1",
      authorId: "usr_scout",
      authorKind: "bot",
      body: "my finding",
    });
    const threadParticipants = new Set(["lead", "scout", "critic"]);
    expect(route({ message, agents, threadParticipants, threadStarter: "lead" })).toEqual(["lead"]);
  });

  test("a peer joins a starter's thread only by mention", () => {
    const message = msg({
      id: "msg_3",
      threadRootId: "msg_1",
      authorId: "usr_scout",
      authorKind: "bot",
      body: "@s1-critic this contradicts you",
    });
    const threadParticipants = new Set(["lead", "scout", "critic"]);
    const woken = route({ message, agents, threadParticipants, threadStarter: "lead" });
    expect(woken.sort()).toEqual(["critic", "lead"]);
  });

  test("the starter's own reply addresses the whole thread", () => {
    const message = msg({
      id: "msg_3",
      threadRootId: "msg_1",
      authorId: "usr_lead",
      authorKind: "bot",
      body: "one more thing",
    });
    const threadParticipants = new Set(["lead", "scout", "critic"]);
    const woken = route({ message, agents, threadParticipants, threadStarter: "lead" });
    expect(woken.sort()).toEqual(["critic", "scout"]);
  });

  test("a human's reply addresses the whole thread", () => {
    const message = msg({ id: "msg_3", threadRootId: "msg_1", body: "operator note" });
    const threadParticipants = new Set(["lead", "scout"]);
    const woken = route({ message, agents, threadParticipants, threadStarter: "scout" });
    expect(woken.sort()).toEqual(["lead", "scout"]);
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
