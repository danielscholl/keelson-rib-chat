import { describe, expect, test } from "bun:test";
import type { RibRunStatus } from "@keelson/shared";
import { applyStatus, isolationBreach, prUrlsIn, verified } from "../src/dispatch.ts";
import type { ChildRun } from "../src/types.ts";

function run(over: Partial<ChildRun> = {}): ChildRun {
  return {
    runId: "run_1",
    workflow: "fix-issue",
    purpose: "fix it",
    inputs: {},
    status: "running",
    startedAt: "",
    isolated: true,
    prUrls: [],
    verified: false,
    ...over,
  };
}

function status(over: Partial<RibRunStatus> = {}): RibRunStatus {
  return {
    runId: "run_1",
    workflowName: "fix-issue",
    status: "running",
    startedAt: "",
    checkout: { path: "/wt/1", branch: "b", worktreeEstablished: true },
    nodes: [],
    ...over,
  };
}

describe("dispatch evidence", () => {
  test("finds pull request links in node output and errors, once each", () => {
    const s = status({
      nodes: [
        {
          nodeId: "a",
          status: "ok",
          output: "see https://github.com/o/r/pull/3 and again https://github.com/o/r/pull/3",
        },
        { nodeId: "b", status: "failed", error: "https://github.com/o/r/pull/4 checks red" },
      ],
    });
    expect(prUrlsIn(s)).toEqual(["https://github.com/o/r/pull/3", "https://github.com/o/r/pull/4"]);
  });

  test("an isolated run is verified only with its worktree and a pull request", () => {
    expect(
      verified(
        run({
          status: "succeeded",
          checkout: { path: null, branch: null, worktreeEstablished: true },
          prUrls: ["u"],
        }),
      ),
    ).toBe(true);
    expect(
      verified(
        run({
          status: "succeeded",
          checkout: { path: null, branch: null, worktreeEstablished: true },
        }),
      ),
    ).toBe(false);
    expect(
      verified(
        run({
          status: "succeeded",
          checkout: { path: "/p", branch: "main", worktreeEstablished: false },
          prUrls: ["u"],
        }),
      ),
    ).toBe(false);
    expect(verified(run({ status: "succeeded", isolated: false }))).toBe(true);
    expect(verified(run({ status: "failed", isolated: false }))).toBe(false);
  });

  test("a live isolated run in a shared checkout is a breach; one not yet placed is not", () => {
    expect(
      isolationBreach(
        run({ checkout: { path: "/p", branch: "main", worktreeEstablished: false } }),
      ),
    ).toContain("/p");
    expect(
      isolationBreach(run({ checkout: { path: null, branch: null, worktreeEstablished: false } })),
    ).toBeUndefined();
    expect(
      isolationBreach(
        run({
          isolated: false,
          checkout: { path: "/p", branch: "main", worktreeEstablished: false },
        }),
      ),
    ).toBeUndefined();
  });

  test("a status read reports only what changed", () => {
    const r = run();
    expect(applyStatus(r, status())).toBeUndefined();
    expect(
      applyStatus(
        r,
        status({ status: "paused", pendingApproval: { nodeId: "gate", prompt: "ok?" } }),
      ),
    ).toContain("paused for human approval at node gate");
    expect(
      applyStatus(
        r,
        status({ status: "paused", pendingApproval: { nodeId: "gate", prompt: "ok?" } }),
      ),
    ).toBeUndefined();
    const done = applyStatus(
      r,
      status({
        status: "succeeded",
        nodes: [{ nodeId: "pr", status: "ok", output: "https://github.com/o/r/pull/9" }],
      }),
    );
    expect(done).toContain("is succeeded");
    expect(done).toContain("verified");
    expect(r.pendingApproval).toBeUndefined();
    expect(r.prUrls).toEqual(["https://github.com/o/r/pull/9"]);
  });
});
