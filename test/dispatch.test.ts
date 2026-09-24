import { describe, expect, test } from "bun:test";
import type { RibRunStatus } from "@keelson/shared";
import {
  applyStatus,
  ciIn,
  describeRun,
  gateFiles,
  isolationBreach,
  missingEvidence,
  prUrlsIn,
  serialStarts,
  verified,
  withoutFileHints,
} from "../src/dispatch.ts";
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
    nodesDone: 1,
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

  test("reads the CI gate over the CI watch, the last of each, with its reason", () => {
    const s = status({
      nodes: [
        {
          nodeId: "await-ci",
          status: "ok",
          output: "failing check: lint — fail\nCI_STATUS: FAIL\nrerun...\nCI_STATUS: PASS",
        },
        {
          nodeId: "ci-green-gate",
          status: "ok",
          output: "CI_GATE: PASS — final pushed SHA is green with 3 criteria enforced",
        },
      ],
    });
    expect(ciIn(s)).toEqual({
      verdict: "pass",
      detail: "final pushed SHA is green with 3 criteria enforced",
    });
    const watchOnly = status({
      nodes: [{ nodeId: "await-ci", status: "ok", output: "CI_STATUS: UNKNOWN - no checks" }],
    });
    expect(ciIn(watchOnly)).toEqual({ verdict: "unknown", detail: "no checks" });
    const failed = status({
      nodes: [{ nodeId: "gate", status: "failed", error: "CI_GATE: FAIL" }],
    });
    expect(ciIn(failed)).toEqual({ verdict: "fail" });
    expect(
      ciIn(status({ nodes: [{ nodeId: "a", status: "ok", output: "no CI_GATE here" }] })),
    ).toBeUndefined();
  });

  test("an isolated run is verified only with its worktree, a pull request, and passing CI", () => {
    const own = { path: null, branch: null, worktreeEstablished: true };
    const pass = { verdict: "pass" as const };
    expect(verified(run({ status: "succeeded", checkout: own, prUrls: ["u"], ci: pass }))).toBe(
      true,
    );
    expect(missingEvidence(run({ status: "succeeded", checkout: own, ci: pass }))).toEqual([
      "a pull request",
    ]);
    expect(
      missingEvidence(
        run({
          status: "succeeded",
          checkout: { path: "/p", branch: "main", worktreeEstablished: false },
          prUrls: ["u"],
          ci: pass,
        }),
      ),
    ).toEqual(["its own worktree"]);
    expect(
      missingEvidence(
        run({ status: "succeeded", checkout: own, prUrls: ["u"], ci: { verdict: "unknown" } }),
      ),
    ).toEqual(["passing CI"]);
    expect(missingEvidence(run({ status: "succeeded", checkout: own, prUrls: ["u"] }))).toEqual([
      "passing CI",
    ]);
    expect(verified(run({ status: "failed", checkout: own, prUrls: ["u"], ci: pass }))).toBe(false);
  });

  test("a non-isolated run is verified unless it failed or its CI did", () => {
    expect(verified(run({ status: "succeeded", isolated: false }))).toBe(true);
    expect(
      verified(run({ status: "succeeded", isolated: false, ci: { verdict: "unknown" } })),
    ).toBe(true);
    expect(verified(run({ status: "succeeded", isolated: false, ci: { verdict: "fail" } }))).toBe(
      false,
    );
    expect(verified(run({ status: "failed", isolated: false }))).toBe(false);
  });

  test("an unverified run names what it lacks", () => {
    const text = describeRun(
      run({
        status: "succeeded",
        checkout: { path: null, branch: null, worktreeEstablished: true },
        prUrls: ["https://github.com/o/r/pull/3"],
        ci: { verdict: "unknown", detail: "final CI status was not recorded" },
      }),
    );
    expect(text).toContain("CI unknown (final CI status was not recorded)");
    expect(text).toContain("NOT verified: it lacks passing CI");
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
    // Before any node finishes, the harness reports the project root for a run
    // still creating its worktree.
    expect(
      isolationBreach(
        run({ nodesDone: 0, checkout: { path: "/p", branch: "main", worktreeEstablished: false } }),
      ),
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

  test("starts on one checkout wait for the previous run to set up", async () => {
    const events: string[] = [];
    const ready = new Set<string>();
    let n = 0;
    const start = serialStarts(
      async (name) => {
        const runId = `r${++n}`;
        events.push(`start ${name}`);
        return { runId };
      },
      async (runId) =>
        status({
          runId,
          checkout: { path: "/wt", branch: "b", worktreeEstablished: ready.has(runId) },
        }),
      { pollMs: 5 },
    );
    const first = start("a", {});
    const second = start("b", {});
    await first;
    await new Promise((r) => setTimeout(r, 30));
    expect(events).toEqual(["start a"]);
    ready.add("r1");
    await second;
    expect(events).toEqual(["start a", "start b"]);
  });

  test("a failed start does not hold the next one", async () => {
    let calls = 0;
    const start = serialStarts(
      async () => {
        calls++;
        if (calls === 1) throw new Error("boom");
        return { runId: "r2" };
      },
      async () => undefined,
      { pollMs: 5 },
    );
    await expect(start("a", {})).rejects.toThrow("boom");
    expect(await start("b", {})).toEqual({ runId: "r2" });
  });

  test("a run never claims a pull request another run owns", () => {
    const r = run({ checkout: { path: "/wt", branch: "b", worktreeEstablished: true } });
    const prior = "https://github.com/o/r/pull/6";
    const mine = "https://github.com/o/r/pull/7";
    const done = applyStatus(
      r,
      status({
        status: "succeeded",
        nodes: [
          { nodeId: "context", status: "ok", output: `depends on a bead landed by ${prior}` },
          { nodeId: "create-pr", status: "ok", output: mine },
          { nodeId: "ci", status: "ok", output: "CI_GATE: PASS" },
        ],
      }),
      (url) => url === prior,
    );
    expect(r.prUrls).toEqual([mine]);
    expect(done).toContain("; verified.");
    const onlyPrior = run({ checkout: { path: "/wt", branch: "b", worktreeEstablished: true } });
    applyStatus(
      onlyPrior,
      status({
        status: "succeeded",
        nodes: [
          { nodeId: "context", status: "ok", output: prior },
          { nodeId: "ci", status: "ok", output: "CI_GATE: PASS" },
        ],
      }),
      (url) => url === prior,
    );
    expect(onlyPrior.prUrls).toEqual([]);
    expect(onlyPrior.verified).toBe(false);
  });

  test("a status read reports only what changed", () => {
    const r = run();
    expect(applyStatus(r, status())).toBeUndefined();
    expect(
      applyStatus(
        r,
        status({ status: "paused", pendingApproval: { nodeId: "gate", prompt: "ok?" } }),
      ),
    ).toContain("paused for approval at node gate");
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
        nodes: [
          { nodeId: "pr", status: "ok", output: "https://github.com/o/r/pull/9" },
          { nodeId: "ci-green-gate", status: "ok", output: "CI_GATE: PASS" },
        ],
      }),
    );
    expect(done).toContain("is succeeded");
    expect(done).toContain("CI pass");
    expect(done).toContain("; verified.");
    expect(r.pendingApproval).toBeUndefined();
    expect(r.prUrls).toEqual(["https://github.com/o/r/pull/9"]);
    expect(r.ci).toEqual({ verdict: "pass" });
    expect(r.verified).toBe(true);
  });

  test("a gate keeps its thread while it stays open and drops it for the next gate", () => {
    const r = run();
    const gate = { nodeId: "approve-plan", prompt: "Approve?" };
    applyStatus(r, status({ status: "paused", pendingApproval: gate }));
    if (r.pendingApproval) r.pendingApproval.threadId = "msg_9";
    applyStatus(r, status({ status: "paused", pendingApproval: gate }));
    expect(r.pendingApproval).toEqual({ ...gate, threadId: "msg_9" });
    applyStatus(
      r,
      status({ status: "paused", pendingApproval: { nodeId: "deploy", prompt: "Ship?" } }),
    );
    expect(r.pendingApproval).toEqual({ nodeId: "deploy", prompt: "Ship?" });
  });

  test("a gate's files come from the status, and its hint lines drop from the prompt", () => {
    const files = [{ path: "plan.md", text: "# Plan" }];
    const gate = { nodeId: "approve-plan", prompt: "Approve?", artifacts: files };
    expect(gateFiles(status({ status: "paused", pendingApproval: gate }))).toEqual(files);
    expect(gateFiles(status())).toEqual([]);
    const prompt =
      "Approve this plan.\n\n$ARTIFACTS_DIR/plan.md\n\nSee $ARTIFACTS_DIR/plan.md first.";
    expect(withoutFileHints(prompt)).toBe(
      "Approve this plan.\n\nSee $ARTIFACTS_DIR/plan.md first.",
    );
  });

  test("a run's description points at its gate thread and lists the gates answered", () => {
    const text = describeRun(
      run({
        status: "paused",
        pendingApproval: { nodeId: "approve-plan", prompt: "Approve?", threadId: "msg_4" },
        approvals: [
          {
            nodeId: "check-scope",
            decision: "changes",
            reason: "r",
            feedback: "f",
            review: "msg_3",
            reviewer: "@s1-reviewer",
            at: "",
          },
        ],
      }),
    );
    expect(text).toContain(
      "waiting on approval at approve-plan, its prompt and files in thread msg_4",
    );
    expect(text).not.toContain("Approve?");
    expect(text).toContain("sent changes at check-scope on @s1-reviewer's review msg_3");
  });

  test("a loop gate pausing again on the same node is a new gate", () => {
    const r = run();
    const first = { nodeId: "refine", prompt: "Good?", pauseId: "p1" };
    expect(applyStatus(r, status({ status: "paused", pendingApproval: first }))).toContain(
      "paused for approval at node refine",
    );
    if (r.pendingApproval) r.pendingApproval.threadId = "msg_2";
    const again = { ...first, pauseId: "p2" };
    expect(applyStatus(r, status({ status: "paused", pendingApproval: again }))).toContain(
      "paused for approval at node refine",
    );
    expect(r.pendingApproval).toEqual(again);
  });
});
