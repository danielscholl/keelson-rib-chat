import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectView } from "@keelson/shared";
import { historyPath, loadHistory, saveHistory } from "../src/history.ts";
import { buildSwarmBoard } from "../src/surface/swarm-board.ts";
import { DEFAULT_LIMITS, type SwarmSummary } from "../src/types.ts";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "chat-history-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function summary(id: string): SwarmSummary {
  return {
    id,
    task: `task ${id}`,
    status: "done",
    channelId: `ch_${id}`,
    channelName: `swarm-${id}`,
    startedAt: "2026-09-22T10:00:00.000Z",
    endedAt: "2026-09-22T10:30:00.000Z",
    turnsUsed: 3,
    limits: DEFAULT_LIMITS,
    size: "medium",
    sizeBase: "medium",
    agents: [],
    conclusion: "ok",
  };
}

describe("swarm history", () => {
  test("round-trips in order, creating the data directory", () => {
    const path = historyPath(join(tempDir(), "rib-chat"));
    saveHistory(path, { ended: [summary("s1"), summary("s2")], refusedApprovals: ["fix-issue"] });
    const history = loadHistory(path);
    expect(history.ended.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(history.refusedApprovals).toEqual(["fix-issue"]);
  });

  test("keeps turn spans, activity kinds and gate history", () => {
    const path = historyPath(join(tempDir(), "rib-chat"));
    const full: SwarmSummary = {
      ...summary("s3"),
      spans: [
        {
          agentId: "s3-lead",
          n: 1,
          startedAt: "2026-09-22T10:00:01.000Z",
          endedAt: "2026-09-22T10:00:40.000Z",
          outcome: "ok",
          messages: 1,
          wokeBy: ["rib"],
        },
      ],
      activity: [{ at: "2026-09-22T10:00:00.000Z", text: "swarm s3 started", kind: "start" }],
      pace: [1, 0, 2],
      rerunOf: "s1",
    };
    saveHistory(path, { ended: [full], refusedApprovals: [] });
    expect(loadHistory(path).ended[0]).toEqual(full);
  });

  test("round-trips writer evidence, capability, report and retained worktrees together", () => {
    const path = historyPath(tempDir());
    const full: SwarmSummary = {
      ...summary("s4"),
      writeEnabled: true,
      report: { title: "Shipped work", at: "2026-09-22T10:10:00.000Z", bytes: 3072 },
      prs: [
        {
          agent: "s4-coder",
          url: "https://github.com/o/r/pull/101",
          branch: "writer/feature",
          at: "2026-09-22T10:05:00.000Z",
          ci: { verdict: "running", detail: "build queued" },
        },
      ],
      worktrees: [
        {
          agent: "s4-coder",
          path: "/repo/.worktrees/swarm-s4-coder",
          branch: "writer/feature",
          reason: "1 commit not pushed",
        },
      ],
    };
    saveHistory(path, { ended: [full], refusedApprovals: [] });
    const restored = loadHistory(path).ended[0]!;
    expect(restored).toEqual(full);
    const view = buildSwarmBoard(restored);
    expect(() => expectView("swarm-s4", "board")(view)).not.toThrow();
    expect(JSON.stringify(view)).toContain("draft PR #101 · CI running");
    expect(JSON.stringify(view)).toContain("1 commit not pushed");
  });

  test("legacy writer PRs load without new fields and render CI as not reported", () => {
    const path = historyPath(tempDir());
    const legacy = {
      ...summary("s5"),
      prs: [
        {
          agent: "s5-coder",
          url: "https://github.com/o/r/pull/102",
          branch: "writer/legacy",
          at: "2026-09-22T10:05:00.000Z",
        },
      ],
    };
    writeFileSync(path, JSON.stringify({ version: 1, ended: [legacy], refusedApprovals: [] }));
    const restored = loadHistory(path).ended[0]!;
    expect(restored.writeEnabled).toBeUndefined();
    expect(restored.prs?.[0]?.ci).toBeUndefined();
    const view = buildSwarmBoard(restored);
    expect(() => expectView("swarm-s5", "board")(view)).not.toThrow();
    expect(JSON.stringify(view)).toContain("draft PR #102 · CI not reported");
    expect(JSON.stringify(view)).toContain("0 with CI passing");
  });

  test("leaves no temp file behind", () => {
    const dir = tempDir();
    saveHistory(historyPath(dir), { ended: [summary("s1")], refusedApprovals: [] });
    expect(readdirSync(dir)).toEqual(["swarms.json"]);
  });

  test("a missing, corrupt, or foreign file is an empty history", () => {
    const dir = tempDir();
    const path = historyPath(dir);
    const none = { ended: [], refusedApprovals: [] };
    expect(loadHistory(path)).toEqual(none);
    writeFileSync(path, "{not json");
    expect(loadHistory(path)).toEqual(none);
    writeFileSync(path, JSON.stringify({ version: 99, ended: [summary("s1")] }));
    expect(loadHistory(path)).toEqual(none);
    writeFileSync(
      path,
      JSON.stringify({ version: 1, ended: [summary("s1"), { id: 3 }], refusedApprovals: [1] }),
    );
    expect(loadHistory(path).ended.map((s) => s.id)).toEqual(["s1"]);
    expect(loadHistory(path).refusedApprovals).toEqual([]);
  });
});
