import { describe, expect, test } from "bun:test";
import { ClickClackClient } from "../src/clickclack.ts";
import { FakeClickClack, OWNER_TOKEN } from "./fakes.ts";

function client(server: FakeClickClack, token = OWNER_TOKEN): ClickClackClient {
  return new ClickClackClient("http://fake", token, server.transport);
}

describe("ready", () => {
  test("resolves against a ready server, whatever the token", async () => {
    await expect(client(new FakeClickClack(), "not-a-token").ready()).resolves.toBeUndefined();
  });

  test("names the url when the connection is refused", async () => {
    const server = new FakeClickClack();
    server.down = true;
    await expect(client(server).ready()).rejects.toThrow(
      "ClickClack is not reachable at http://fake",
    );
  });

  test("treats a server whose store is unavailable as unreachable", async () => {
    const server = new FakeClickClack();
    server.ready = false;
    await expect(client(server).ready()).rejects.toThrow("not reachable");
  });

  test("gives up on a server that never answers", async () => {
    const hung = new ClickClackClient("http://fake", OWNER_TOKEN, {
      fetch: ((_input: string | URL | Request, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })) as typeof fetch,
    });
    await expect(hung.ready(10)).rejects.toThrow("not reachable");
  });
});
