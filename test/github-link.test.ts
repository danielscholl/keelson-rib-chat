import { describe, expect, test } from "bun:test";
import { CONTEXT_BOUNDS, contextItemSchema } from "../src/context.ts";
import { contextFromView, githubLinks, MAX_LINKS, withoutGithubLinks } from "../src/github-link.ts";

const at = new Date("2026-09-22T14:00:00.000Z");

describe("githubLinks", () => {
  test("parses repo, issue or PR, and number, and drops repeats", () => {
    expect(
      githubLinks(
        "Fix https://github.com/owner/repo.js/issues/12 after https://github.com/my-org/a_b/pull/7#discussion_r1 " +
          "(same as https://github.com/owner/repo.js/issues/12?x=1)",
      ),
    ).toEqual([
      { repo: "owner/repo.js", kind: "issue", number: 12 },
      { repo: "my-org/a_b", kind: "pr", number: 7 },
    ]);
  });

  test("keeps equal numbers in different repositories apart", () => {
    expect(
      githubLinks("https://github.com/a/b/issues/1 https://github.com/c/d/issues/1").map(
        (l) => l.repo,
      ),
    ).toEqual(["a/b", "c/d"]);
  });

  test("ignores other links, other GitHub pages, plain http and bare numbers", () => {
    expect(
      githubLinks(
        "https://gitlab.com/a/b/issues/1 https://github.com/a/b http://github.com/a/b/issues/2 " +
          "https://github.com/a/b/discussions/3 #4",
      ),
    ).toEqual([]);
    expect(MAX_LINKS).toBe(5);
  });
});

describe("withoutGithubLinks", () => {
  test("removes each issue or PR link with its suffix and leaves other text", () => {
    expect(
      withoutGithubLinks(
        "Fix https://github.com/o/r/issues/12#top and https://github.com/o/r/pull/3/files, see #4",
      ),
    ).toBe("Fix  and  see #4");
    expect(withoutGithubLinks("see https://example.com/x")).toBe("see https://example.com/x");
  });
});

describe("contextFromView", () => {
  test("builds a valid issue item with the repo in the title and comments appended", () => {
    const item = contextFromView(
      { repo: "owner/repo", kind: "issue", number: 12 },
      {
        title: "Title",
        body: "  The body.  ",
        url: "https://github.com/owner/repo/issues/12",
        comments: [
          { author: { login: "ada" }, body: " First. " },
          { author: { login: "bob" }, body: "   " },
          { body: "Anonymous." },
        ],
      },
      at,
    );
    expect(item).toEqual({
      id: "issue-12",
      kind: "issue",
      title: "issue owner/repo#12: Title",
      body: "The body.\n\n--- comment by @ada\nFirst.\n\n--- comment by @unknown\nAnonymous.",
      sourceUrl: "https://github.com/owner/repo/issues/12",
      retrievedAt: "2026-09-22T14:00:00.000Z",
    });
    const { sourceUrl, retrievedAt, ...rest } = item;
    expect(
      contextItemSchema.safeParse({ ...rest, source_url: sourceUrl, retrieved_at: retrievedAt })
        .success,
    ).toBe(true);
  });

  test("names a PR, fills an empty body, and keeps the title one bounded line", () => {
    const item = contextFromView(
      { repo: "o/r", kind: "pr", number: 41 },
      { title: `Two\nlines ${"x".repeat(300)}`, body: " ", url: "https://github.com/o/r/pull/41" },
      at,
    );
    expect(item.id).toBe("pr-41");
    expect(item.kind).toBe("pr");
    expect(item.title).toStartWith("PR o/r#41: Two lines ");
    expect(item.title).toHaveLength(200);
    expect(item.body).toBe("(no description)");
  });

  test("caps the body at the per-item bound", () => {
    const item = contextFromView(
      { repo: "o/r", kind: "issue", number: 1 },
      { title: "Big", body: "y".repeat(CONTEXT_BOUNDS.maxItemChars + 10), url: "https://x.test" },
      at,
    );
    expect(item.body).toHaveLength(CONTEXT_BOUNDS.maxItemChars);
  });
});
