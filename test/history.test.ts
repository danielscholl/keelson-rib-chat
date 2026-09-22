import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { historyPath, loadHistory, saveHistory } from "../src/history.ts";
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
    saveHistory(path, [summary("s1"), summary("s2")]);
    expect(loadHistory(path).map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  test("leaves no temp file behind", () => {
    const dir = tempDir();
    saveHistory(historyPath(dir), [summary("s1")]);
    expect(readdirSync(dir)).toEqual(["swarms.json"]);
  });

  test("a missing, corrupt, or foreign file is an empty history", () => {
    const dir = tempDir();
    const path = historyPath(dir);
    expect(loadHistory(path)).toEqual([]);
    writeFileSync(path, "{not json");
    expect(loadHistory(path)).toEqual([]);
    writeFileSync(path, JSON.stringify({ version: 99, ended: [summary("s1")] }));
    expect(loadHistory(path)).toEqual([]);
    writeFileSync(path, JSON.stringify({ version: 1, ended: [summary("s1"), { id: 3 }] }));
    expect(loadHistory(path).map((s) => s.id)).toEqual(["s1"]);
  });
});
