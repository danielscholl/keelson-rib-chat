import { describe, expect, test } from "bun:test";
import type { CanvasBoardView } from "@keelson/shared";
import { buildDoc } from "../src/surface/doc.ts";
import { OFFLINE_NOTE, offlineLinks } from "../src/surface/offline.ts";

const URL = "http://127.0.0.1:18080";

function board(): CanvasBoardView {
  return {
    view: "board",
    title: "Swarm s1",
    sections: [
      {
        kind: "rows",
        title: "About",
        items: [
          { icon: "◷", text: "ran Oct 6" },
          { text: "transcript ↗", href: `${URL}/app/w/c` },
          { text: "PR #4", href: "https://github.com/o/r/pull/4" },
        ],
      },
      {
        kind: "cards",
        items: [{ title: "a", fields: [{ value: "thread", href: `${URL}/app/w/t` }] }],
      },
    ],
  };
}

describe("offline ClickClack links", () => {
  test("a running or unknown server keeps the board as composed", () => {
    const view = board();
    expect(offlineLinks(view, undefined)).toBe(view);
    expect(offlineLinks(view, { mode: "managed", url: URL, running: true })).toBe(view);
  });

  test("a stopped server drops its links, keeps others, and says why once", () => {
    const view = offlineLinks(board(), { mode: "managed", url: `${URL}/`, running: false });
    const about = view.sections[0] as Extract<
      CanvasBoardView["sections"][number],
      { kind: "rows" }
    >;
    expect(about.items[1]).toEqual({ text: "transcript" });
    expect(about.items[2]).toEqual({ text: "PR #4", href: "https://github.com/o/r/pull/4" });
    expect(JSON.stringify(view.sections[1])).not.toContain(URL);
    expect(view.sections.at(-1)).toEqual({
      kind: "rows",
      items: [{ icon: "◌", text: OFFLINE_NOTE }],
    });
  });

  test("a stopped server with no links leaves the board alone", () => {
    const view: CanvasBoardView = { view: "board", title: "t", sections: [] };
    expect(offlineLinks(view, { mode: "managed", url: URL, running: false })).toBe(view);
  });

  test("the reading pane names the transcript without a dead link", () => {
    const s = {
      id: "s1",
      task: "t",
      status: "done",
      channelName: "swarm-s1",
      channelId: "c",
      clickclack: { url: URL, workspaceId: "w" },
      agents: [],
      conclusion: "ok",
    } as unknown as Parameters<typeof buildDoc>[0];
    expect(buildDoc(s, "s1")).toContain(`(${URL}/app/w/c)`);
    expect(buildDoc(s, "s1", false)).not.toContain(URL);
    expect(buildDoc(s, "s1", false)).toContain("start ClickClack from Server › Manage");
  });
});
