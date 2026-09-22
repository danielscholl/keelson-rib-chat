import { describe, expect, test } from "bun:test";
import { needsYou, oldestNeed } from "../src/needs.ts";
import { type ChildRun, DEFAULT_LIMITS, type SwarmSummary } from "../src/types.ts";

function run(id: string, answerer: "swarm" | "operator", openedAt: string): ChildRun {
  return {
    runId: id,
    workflow: "fix-issue",
    purpose: "p",
    inputs: {},
    status: "paused",
    startedAt: "2026-09-22T14:00:00.000Z",
    isolated: true,
    nodesDone: 3,
    pendingApproval: { nodeId: "approve-plan", prompt: "Approve?", openedAt, answerer },
    prUrls: [],
    verified: false,
  };
}

function swarm(patch: Partial<SwarmSummary> = {}): SwarmSummary {
  return {
    id: "s1",
    task: "t",
    status: "running",
    channelId: "ch",
    channelName: "swarm-s1",
    startedAt: "2026-09-22T14:00:00.000Z",
    turnsUsed: 4,
    limits: DEFAULT_LIMITS,
    size: "medium",
    sizeBase: "medium",
    agents: [],
    ...patch,
  };
}

describe("needsYou", () => {
  test("a healthy swarm, or a gate the swarm is reviewing, needs nothing", () => {
    expect(needsYou(swarm())).toEqual([]);
    expect(needsYou(swarm({ runs: [run("r1", "swarm", "2026-09-22T14:31:00.000Z")] }))).toEqual([]);
  });

  test("one socket close is a blip; two are ClickClack gone", () => {
    expect(needsYou(swarm({ health: { socketDrops: 1 } }))).toEqual([]);
    expect(needsYou(swarm({ health: { socketDrops: 2 } })).map((n) => n.kind)).toEqual([
      "clickclack",
    ]);
  });

  test("needs come in precedence order, and a quiet gate is one the swarm could answer", () => {
    const needs = needsYou(
      swarm({
        health: { socketDrops: 2, quietSince: "2026-09-22T14:40:00.000Z" },
        runs: [
          run("r1", "operator", "2026-09-22T14:11:00.000Z"),
          run("r2", "swarm", "2026-09-22T14:31:00.000Z"),
        ],
      }),
    );
    expect(needs.map((n) => [n.kind, n.run?.runId])).toEqual([
      ["clickclack", undefined],
      ["only-you", "r1"],
      ["quiet", "r2"],
    ]);
    expect(oldestNeed(needs)).toBe("2026-09-22T14:11:00.000Z");
  });

  test("quiet with only the operator's gates open adds nothing beyond only-you", () => {
    const needs = needsYou(
      swarm({
        health: { quietSince: "2026-09-22T14:40:00.000Z" },
        runs: [run("r1", "operator", "2026-09-22T14:11:00.000Z")],
      }),
    );
    expect(needs.map((n) => n.kind)).toEqual(["only-you"]);
  });

  test("an ended swarm needs nothing", () => {
    expect(needsYou(swarm({ status: "stopped", health: { socketDrops: 3 } }))).toEqual([]);
  });
});
