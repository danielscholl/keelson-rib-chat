import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedServer, type ManagedServerDeps } from "../src/server.ts";

interface FakeProc {
  command: string;
  alive: boolean;
  ignoresTerm?: boolean;
}

// A process table and a port, enough to stand in for the OS and a clickclack binary.
class World {
  readonly home = mkdtempSync(join(tmpdir(), "rib-chat-"));
  readonly procs = new Map<number, FakeProc>();
  readonly signals: [number, string][] = [];
  readonly spawned: string[][] = [];
  readonly childEnvs: Record<string, string>[] = [];
  // The pid answering on the port, or "foreign" for something the rib never started.
  serving: number | "foreign" | undefined;
  onSpawn: "ready" | "exit" | "hang" = "ready";
  beforeSpawnReturns: (() => void) | undefined;
  env: Record<string, string | undefined> = { CLICKCLACK_BIN: "/opt/clickclack" };
  probes = 0;
  private nextPid = 4000;

  get root(): string {
    return join(this.home, "clickclack");
  }

  get statePath(): string {
    return join(this.root, "state.json");
  }

  state(): { pid: number } | undefined {
    return existsSync(this.statePath)
      ? (JSON.parse(readFileSync(this.statePath, "utf8")) as { pid: number })
      : undefined;
  }

  // A server some earlier process left behind, recorded and running.
  leave(opts: { alive?: boolean; command?: string; serving?: boolean } = {}): number {
    const pid = this.nextPid++;
    this.procs.set(pid, {
      command:
        opts.command ??
        `/opt/clickclack serve --data ${join(this.root, "data")} --dev-bootstrap=true `,
      alive: opts.alive ?? true,
    });
    if (opts.serving ?? true) this.serving = pid;
    mkdirSync(this.root, { recursive: true });
    writeFileSync(this.statePath, JSON.stringify({ pid, url: "http://127.0.0.1:18080" }));
    return pid;
  }

  deps(over: Partial<ManagedServerDeps> = {}): ManagedServerDeps {
    return {
      spawn: (cmd, { logPath, env }) => {
        this.spawned.push(cmd);
        this.childEnvs.push(env);
        const pid = this.nextPid++;
        const proc: FakeProc = { command: `${cmd.join(" ")} `, alive: true };
        this.procs.set(pid, proc);
        let exited: Promise<unknown> = new Promise(() => undefined);
        if (this.onSpawn === "ready") this.serving = pid;
        if (this.onSpawn === "exit") {
          writeFileSync(
            logPath,
            "migrating\nlisten tcp 127.0.0.1:18080: bind: address already in use\n",
          );
          proc.alive = false;
          exited = Promise.resolve(1);
        }
        this.beforeSpawnReturns?.();
        return { pid, exited };
      },
      fetch: (async (input: string | URL | Request) => {
        this.probes++;
        const { pathname } = new URL(String(input));
        const up =
          this.serving === "foreign" ||
          (this.serving !== undefined && this.procs.get(this.serving)?.alive === true);
        if (!up) throw new TypeError("fetch failed");
        if (pathname === "/api/auth/magic/request") return Response.json({ token: "mgt_1" });
        if (pathname === "/api/auth/magic/consume") return Response.json({ token: "sst_1" });
        return Response.json({ status: "ok" });
      }) as typeof fetch,
      which: () => null,
      pidCommand: async (pid) =>
        this.procs.get(pid)?.alive ? (this.procs.get(pid)?.command ?? "") : "",
      isPidAlive: (pid) => this.procs.get(pid)?.alive === true,
      kill: (pid, signal) => {
        this.signals.push([pid, signal]);
        const proc = this.procs.get(pid);
        if (proc && (signal === "SIGKILL" || !proc.ignoresTerm)) proc.alive = false;
      },
      sleep: () => Promise.resolve(),
      env: this.env,
      platform: "darwin",
      dataDir: () => this.home,
      timings: {
        readyTimeoutMs: 50,
        pollMs: 10,
        adoptWaitMs: 20,
        termMs: 300,
        killMs: 300,
        probeMs: 50,
      },
      ...over,
    };
  }
}

let world: World;
function fresh(): World {
  world = new World();
  return world;
}
afterEach(() => rmSync(world.home, { recursive: true, force: true }));

describe("ensure", () => {
  test("spawns on a loopback port with its own data directory, and records it", async () => {
    const w = fresh();
    const running = await new ManagedServer(w.deps()).ensure();
    expect(running).toEqual({ url: "http://127.0.0.1:18080", pid: 4000, adopted: false });
    expect(w.spawned[0]).toEqual([
      "/opt/clickclack",
      "serve",
      "--addr",
      "127.0.0.1:18080",
      "--data",
      join(w.root, "data"),
      "--dev-bootstrap=true",
      "--access-log",
      "errors",
    ]);
    expect(w.state()?.pid).toBe(4000);
  });

  test("the record exists before the server is ready, so a crash mid-start leaves no orphan", async () => {
    const w = fresh();
    let recordedAtSpawn: number | undefined;
    const deps = w.deps();
    const probe = deps.fetch;
    deps.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      recordedAtSpawn ??= w.state()?.pid;
      return probe(input, init);
    }) as typeof fetch;
    await new ManagedServer(deps).ensure();
    expect(recordedAtSpawn).toBe(4000);
  });

  test("passes none of the rib's CLICKCLACK_ variables to the child", async () => {
    const w = fresh();
    w.env = { ...w.env, CLICKCLACK_DB: "sqlite:///elsewhere.db", HOME: "/home/x" };
    await new ManagedServer(w.deps()).ensure();
    expect(Object.keys(w.childEnvs[0] ?? {}).filter((k) => k.startsWith("CLICKCLACK_"))).toEqual(
      [],
    );
    expect(w.childEnvs[0]?.HOME).toBe("/home/x");
  });

  test("honours CLICKCLACK_PORT and rejects a value that is not a port", async () => {
    const w = fresh();
    w.env = { ...w.env, CLICKCLACK_PORT: "19000" };
    expect((await new ManagedServer(w.deps()).ensure()).url).toBe("http://127.0.0.1:19000");
    w.env = { ...w.env, CLICKCLACK_PORT: "http" };
    await expect(new ManagedServer(w.deps()).ensure()).rejects.toThrow("CLICKCLACK_PORT");
  });

  test("concurrent callers share one spawn", async () => {
    const w = fresh();
    const server = new ManagedServer(w.deps());
    const [a, b] = await Promise.all([server.ensure(), server.ensure()]);
    expect(a).toEqual(b);
    expect(w.spawned).toHaveLength(1);
  });

  test("a second ensure finds the server it started and does not call it adopted", async () => {
    const w = fresh();
    const server = new ManagedServer(w.deps());
    await server.ensure();
    expect(await server.ensure()).toMatchObject({ pid: 4000, adopted: false });
    expect(w.spawned).toHaveLength(1);
  });

  test("adopts a server an earlier process left running", async () => {
    const w = fresh();
    const pid = w.leave();
    expect(await new ManagedServer(w.deps()).ensure()).toMatchObject({ pid, adopted: true });
    expect(w.spawned).toHaveLength(0);
    expect(w.signals).toEqual([]);
  });

  test("a recycled pid is never signalled: the record is dropped and a new server starts", async () => {
    const w = fresh();
    const pid = w.leave({ command: "/usr/bin/vim notes.txt ", serving: false });
    const running = await new ManagedServer(w.deps()).ensure();
    expect(running.pid).not.toBe(pid);
    expect(w.signals).toEqual([]);
    expect(w.procs.get(pid)?.alive).toBe(true);
  });

  test("a record whose process is gone is dropped", async () => {
    const w = fresh();
    w.leave({ alive: false, serving: false });
    expect(await new ManagedServer(w.deps()).ensure()).toMatchObject({ pid: 4001, adopted: false });
  });

  test("its own server that stopped answering is killed and replaced", async () => {
    const w = fresh();
    const pid = w.leave({ serving: false });
    const running = await new ManagedServer(w.deps()).ensure();
    expect(w.signals).toEqual([[pid, "SIGTERM"]]);
    expect(running).toMatchObject({ pid: 4001, adopted: false });
  });

  test("something else on the port is reported and left alone", async () => {
    const w = fresh();
    w.serving = "foreign";
    await expect(new ManagedServer(w.deps()).ensure()).rejects.toThrow(
      /did not start is already listening at http:\/\/127\.0\.0\.1:18080.*lsof -i :18080.*CLICKCLACK_PORT/,
    );
    expect(w.spawned).toHaveLength(0);
    expect(w.signals).toEqual([]);
  });

  test("a child that exits early fails with the tail of its log and leaves no record", async () => {
    const w = fresh();
    w.onSpawn = "exit";
    await expect(new ManagedServer(w.deps()).ensure()).rejects.toThrow(
      /exited before it was ready:\n.*address already in use/s,
    );
    expect(w.state()).toBeUndefined();
  });

  test("the loser of a simultaneous start adopts the winner and keeps its record", async () => {
    const w = fresh();
    w.onSpawn = "exit";
    let winner = 0;
    w.beforeSpawnReturns = () => {
      winner = w.leave();
    };
    expect(await new ManagedServer(w.deps()).ensure()).toMatchObject({
      pid: winner,
      adopted: true,
    });
    expect(w.state()?.pid).toBe(winner);
  });

  test("a child that wins the port is recorded even when another start recorded first", async () => {
    const w = fresh();
    let other = 0;
    w.beforeSpawnReturns = () => {
      // The other process's child is recorded and alive, but this one took the port.
      const serving = w.serving;
      other = w.leave({ serving: false });
      w.serving = serving;
    };
    const server = new ManagedServer(w.deps());
    const running = await server.ensure();
    expect(running.pid).not.toBe(other);
    expect(w.state()?.pid).toBe(running.pid);
    expect(await server.stop()).toBe(true);
    expect(w.procs.get(running.pid)?.alive).toBe(false);
  });

  test("a record with a pid that addresses a process group is ignored", async () => {
    const w = fresh();
    mkdirSync(w.root, { recursive: true });
    for (const pid of [0, -1, 1, 4.5]) {
      writeFileSync(w.statePath, JSON.stringify({ pid, url: "http://127.0.0.1:18080" }));
      expect(await new ManagedServer(w.deps({ isPidAlive: () => true })).stop()).toBe(false);
    }
    expect(w.signals).toEqual([]);
  });

  test("a pid that changes hands between signals is not killed", async () => {
    const w = fresh();
    await new ManagedServer(w.deps()).ensure();
    const proc = w.procs.get(4000) as FakeProc;
    proc.ignoresTerm = true;
    const deps = w.deps();
    const kill = deps.kill;
    const server = new ManagedServer({
      ...deps,
      kill: (pid, signal) => {
        kill(pid, signal);
        proc.command = "/usr/bin/vim notes.txt ";
      },
    });
    await server.stop();
    expect(w.signals).toEqual([[4000, "SIGTERM"]]);
    expect(proc.alive).toBe(true);
  });

  test("a child that never becomes ready is stopped, not left running", async () => {
    const w = fresh();
    w.onSpawn = "hang";
    await expect(new ManagedServer(w.deps()).ensure()).rejects.toThrow("was not ready within");
    expect(w.procs.get(4000)?.alive).toBe(false);
    expect(w.state()).toBeUndefined();
  });

  test.each([
    ["win32", undefined, "not supported on Windows"],
    ["darwin", "no-data-dir", "rib data directory"],
    ["darwin", "no-binary", "no clickclack binary"],
  ] as const)(
    "%s %s fails closed, pointing at an external server",
    async (platform, missing, text) => {
      const w = fresh();
      if (missing === "no-binary") w.env = {};
      const server = new ManagedServer(
        w.deps({ platform, ...(missing === "no-data-dir" ? { dataDir: () => undefined } : {}) }),
      );
      expect(server.unavailable()).toContain(text);
      await expect(server.ensure()).rejects.toThrow("CLICKCLACK_URL and CLICKCLACK_TOKEN");
      expect(w.spawned).toHaveLength(0);
    },
  );

  test("finds the binary on PATH when CLICKCLACK_BIN is unset", async () => {
    const w = fresh();
    w.env = {};
    await new ManagedServer(w.deps({ which: () => "/usr/local/bin/clickclack" })).ensure();
    expect(w.spawned[0]?.[0]).toBe("/usr/local/bin/clickclack");
  });
});

describe("stop", () => {
  test("terminates the server and removes the record", async () => {
    const w = fresh();
    const server = new ManagedServer(w.deps());
    await server.ensure();
    expect(await server.stop()).toBe(true);
    expect(w.signals).toEqual([[4000, "SIGTERM"]]);
    expect(w.state()).toBeUndefined();
    expect(await server.stop()).toBe(false);
  });

  test("escalates to SIGKILL when SIGTERM is ignored", async () => {
    const w = fresh();
    const server = new ManagedServer(w.deps());
    await server.ensure();
    (w.procs.get(4000) as FakeProc).ignoresTerm = true;
    await server.stop();
    expect(w.signals).toEqual([
      [4000, "SIGTERM"],
      [4000, "SIGKILL"],
    ]);
  });

  test("stops a server it adopted", async () => {
    const w = fresh();
    const pid = w.leave();
    expect(await new ManagedServer(w.deps()).stop()).toBe(true);
    expect(w.procs.get(pid)?.alive).toBe(false);
  });

  test("dispose stops the server and refuses any later start", async () => {
    const w = fresh();
    const server = new ManagedServer(w.deps());
    await server.ensure();
    await server.dispose();
    expect(w.procs.get(4000)?.alive).toBe(false);
    await expect(server.ensure()).rejects.toThrow("shutting down");
  });

  test("a start still in flight at dispose stops its own child", async () => {
    const w = fresh();
    const server = new ManagedServer(w.deps());
    let disposing: Promise<void> | undefined;
    w.beforeSpawnReturns = () => {
      disposing = server.dispose();
    };
    await expect(server.ensure()).rejects.toThrow("shutting down");
    await disposing;
    expect(w.procs.get(4000)?.alive).toBe(false);
    expect(w.state()).toBeUndefined();
  });

  test("dispose ends the wait for a child that is not ready yet", async () => {
    const w = fresh();
    w.onSpawn = "hang";
    const server = new ManagedServer(w.deps());
    let disposing: Promise<void> | undefined;
    w.beforeSpawnReturns = () => {
      disposing = server.dispose();
    };
    await expect(server.ensure()).rejects.toThrow("shutting down");
    await disposing;
    // Left alone it would have probed until the ready timeout.
    expect(w.probes).toBeLessThan(3);
    expect(w.procs.get(4000)?.alive).toBe(false);
  });
});

describe("a server a person started", () => {
  test("is adopted by the harness and left running when the harness shuts down", async () => {
    const w = fresh();
    const byHand = await new ManagedServer(w.deps({ operator: true })).ensure();
    const harness = new ManagedServer(w.deps());
    expect(await harness.ensure()).toMatchObject({ pid: byHand.pid, adopted: true });
    expect(await harness.status()).toMatchObject({ running: true, operator: true });
    await harness.dispose();
    expect(w.procs.get(byHand.pid)?.alive).toBe(true);
    expect(w.state()?.pid).toBe(byHand.pid);
  });

  test("still stops when asked to, and a reset hands it to the harness", async () => {
    const w = fresh();
    await new ManagedServer(w.deps({ operator: true })).ensure();
    const harness = new ManagedServer(w.deps());
    const fresh2 = await harness.reset();
    expect(w.procs.get(4000)?.alive).toBe(false);
    await harness.dispose();
    expect(w.procs.get(fresh2.pid)?.alive).toBe(false);
  });
});

describe("reset", () => {
  test("deletes the data directory and nothing beside it, then starts empty", async () => {
    const w = fresh();
    const server = new ManagedServer(w.deps());
    await server.ensure();
    writeFileSync(join(w.root, "data", "clickclack.db"), "rows");
    writeFileSync(join(w.root, "sentinel.txt"), "keep");
    writeFileSync(join(w.home, "neighbour.txt"), "keep");
    const running = await server.reset();
    expect(existsSync(join(w.root, "data", "clickclack.db"))).toBe(false);
    expect(readFileSync(join(w.root, "sentinel.txt"), "utf8")).toBe("keep");
    expect(readFileSync(join(w.home, "neighbour.txt"), "utf8")).toBe("keep");
    expect(running).toMatchObject({ pid: 4001, adopted: false });
    expect(w.state()?.pid).toBe(4001);
    expect(w.procs.get(4000)?.alive).toBe(false);
  });

  test("deletes nothing while a server it has no record of still answers", async () => {
    const w = fresh();
    const server = new ManagedServer(w.deps());
    mkdirSync(join(w.root, "data"), { recursive: true });
    writeFileSync(join(w.root, "data", "clickclack.db"), "rows");
    w.serving = "foreign";
    await expect(server.reset()).rejects.toThrow("nothing was deleted");
    expect(readFileSync(join(w.root, "data", "clickclack.db"), "utf8")).toBe("rows");
  });

  test("a start requested during a reset waits for it and shares the new server", async () => {
    const w = fresh();
    const server = new ManagedServer(w.deps());
    await server.ensure();
    const [reset, ensured] = await Promise.all([server.reset(), server.ensure()]);
    expect(ensured.pid).toBe(reset.pid);
    expect(w.spawned).toHaveLength(2);
  });
});

describe("status", () => {
  test("reports without spawning, minting, or dropping a record", async () => {
    const w = fresh();
    const server = new ManagedServer(w.deps());
    expect(await server.status()).toEqual({
      url: "http://127.0.0.1:18080",
      running: false,
      binary: "/opt/clickclack",
      dataDir: join(w.root, "data"),
    });
    const stale = w.leave({ alive: false, serving: false });
    await server.status();
    expect(w.state()?.pid).toBe(stale);
    expect(w.spawned).toHaveLength(0);
  });

  test("distinguishes a server it started from one it adopted", async () => {
    const w = fresh();
    const server = new ManagedServer(w.deps());
    await server.ensure();
    expect(await server.status()).toMatchObject({ running: true, pid: 4000, adopted: false });
    expect(await new ManagedServer(w.deps()).status()).toMatchObject({
      running: true,
      adopted: true,
    });
  });
});

describe("ownerSession", () => {
  test("exchanges a loopback magic link for a session token", async () => {
    const w = fresh();
    const server = new ManagedServer(w.deps());
    await server.ensure();
    expect(await server.ownerSession()).toBe("sst_1");
  });
});
