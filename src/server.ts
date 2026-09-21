// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { ensureSpawnPath } from "@keelson/shared/exec";

// A local ClickClack the rib owns: spawned on demand, adopted when a previous
// process left it running, stopped with the harness. Process and clock seams
// are injected so tests drive it without a binary.

export interface SpawnedChild {
  pid: number;
  exited: Promise<unknown>;
}

export interface ManagedServerDeps {
  spawn(cmd: string[], opts: { logPath: string; env: Record<string, string> }): SpawnedChild;
  fetch: typeof fetch;
  which(name: string): string | null;
  // The full command line of a pid, or "" when there is no such process.
  pidCommand(pid: number): Promise<string>;
  isPidAlive(pid: number): boolean;
  kill(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
  sleep(ms: number): Promise<void>;
  env: Record<string, string | undefined>;
  platform: string;
  dataDir(): string | undefined;
  // True when a person starts the server by hand: it then outlives the harness.
  operator?: boolean;
  timings?: Partial<ServerTimings>;
}

export interface ServerTimings {
  readyTimeoutMs: number;
  pollMs: number;
  adoptWaitMs: number;
  termMs: number;
  killMs: number;
  probeMs: number;
}

export const DEFAULT_TIMINGS: ServerTimings = {
  readyTimeoutMs: 30_000,
  pollMs: 250,
  adoptWaitMs: 5_000,
  // ClickClack drains for up to 5 s on SIGTERM.
  termMs: 6_000,
  killMs: 2_000,
  probeMs: 1_500,
};

export const DEFAULT_PORT = 18080;
// The user --dev-bootstrap creates; it owns the bootstrap workspace.
const BOOTSTRAP_EMAIL = "local@clickclack.chat";
const LOG_TAIL_LINES = 15;

interface ServerState {
  pid: number;
  url: string;
  startedAt: string;
  binary: string;
  operator?: boolean;
}

export interface RunningServer {
  url: string;
  pid: number;
  // True when this process found the server running rather than spawning it.
  adopted: boolean;
}

export interface ServerStatus {
  url: string;
  running: boolean;
  // Started by hand, so it stays up when the harness shuts down.
  operator?: boolean;
  pid?: number;
  adopted?: boolean;
  binary?: string;
  dataDir?: string;
}

export const UNMANAGED_HINT =
  "or run ClickClack yourself and set CLICKCLACK_URL and CLICKCLACK_TOKEN";

export class ManagedServer {
  private readonly timings: ServerTimings;
  private chain: Promise<unknown> = Promise.resolve();
  private ensuring: Promise<RunningServer> | undefined;
  private spawnedPid: number | undefined;
  private disposed = false;

  constructor(private readonly deps: ManagedServerDeps) {
    this.timings = { ...DEFAULT_TIMINGS, ...deps.timings };
  }

  get url(): string {
    return `http://127.0.0.1:${this.port()}`;
  }

  binary(): string | undefined {
    return this.deps.env.CLICKCLACK_BIN || this.deps.which("clickclack") || undefined;
  }

  // Start the server unless it is already running. Concurrent callers share one attempt.
  ensure(): Promise<RunningServer> {
    if (!this.ensuring) {
      this.ensuring = this.serial(() => this.ensureInner()).finally(() => {
        this.ensuring = undefined;
      });
    }
    return this.ensuring;
  }

  stop(): Promise<boolean> {
    return this.serial(() => this.stopInner());
  }

  // Stop, delete every channel, transcript, and session, and start empty.
  reset(): Promise<RunningServer> {
    return this.serial(async () => {
      await this.stopInner();
      if (await this.answers("/healthz", this.timings.probeMs)) {
        throw new Error(
          `a server the rib has no record of is still listening at ${this.url}; nothing was deleted. Find it with 'lsof -i :${this.port()}'`,
        );
      }
      rmSync(this.paths().data, { recursive: true, force: true });
      return this.ensureInner();
    });
  }

  // A server a person started is theirs to stop, so shutdown leaves it running.
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.serial(async () => {
      if (!this.readState()?.operator) await this.stopInner();
    });
  }

  // Never spawns and never mints: safe to call from a status probe.
  async status(): Promise<ServerStatus> {
    const binary = this.binary();
    const base: ServerStatus = { url: this.url, running: false, ...(binary ? { binary } : {}) };
    const dir = this.deps.dataDir();
    if (!dir || !isAbsolute(dir)) return base;
    const paths = this.paths();
    const pid = await this.ownedPid(false);
    if (pid === undefined) return { ...base, dataDir: paths.data };
    return {
      ...base,
      dataDir: paths.data,
      pid,
      adopted: pid !== this.spawnedPid,
      ...(this.readState()?.operator ? { operator: true } : {}),
      running: await this.answers("/readyz", this.timings.probeMs),
    };
  }

  // A fresh human owner session. --dev-bootstrap lets a loopback client mint
  // one; minting per use means nothing to store and nothing to expire.
  async ownerSession(): Promise<string> {
    const link = await this.postJson<{ token?: string }>("/api/auth/magic/request", {
      email: BOOTSTRAP_EMAIL,
    });
    if (!link.token) throw new Error("the managed ClickClack returned no magic-link token");
    const session = await this.postJson<{ token?: string }>("/api/auth/magic/consume", {
      token: link.token,
    });
    if (!session.token) throw new Error("the managed ClickClack returned no session token");
    return session.token;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private port(): number {
    const raw = this.deps.env.CLICKCLACK_PORT;
    if (!raw) return DEFAULT_PORT;
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`CLICKCLACK_PORT must be a port number, got '${raw}'`);
    }
    return port;
  }

  private paths(): { root: string; data: string; state: string; log: string } {
    const dir = this.deps.dataDir();
    if (!dir || !isAbsolute(dir)) throw new Error("the rib has no data directory");
    const root = join(dir, "clickclack");
    return {
      root,
      data: join(root, "data"),
      state: join(root, "state.json"),
      log: join(root, "server.log"),
    };
  }

  private readState(): ServerState | undefined {
    try {
      const raw = JSON.parse(readFileSync(this.paths().state, "utf8")) as Partial<ServerState>;
      // 0 and negatives address process groups, so they are never a server's pid.
      if (Number.isInteger(raw.pid) && (raw.pid as number) > 1 && typeof raw.url === "string") {
        return raw as ServerState;
      }
    } catch {
      // absent or unreadable: there is no record
    }
    return undefined;
  }

  private record(pid: number, url: string, binary: string): void {
    this.writeState({
      pid,
      url,
      startedAt: new Date().toISOString(),
      binary,
      ...(this.deps.operator ? { operator: true } : {}),
    });
  }

  private writeState(state: ServerState): void {
    const { state: path } = this.paths();
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 1), { mode: 0o600 });
    renameSync(tmp, path);
  }

  // The recorded pid, only when it is alive and its command line carries our
  // data directory. The OS recycles pids, so a live pid alone proves nothing.
  private async ownedPid(dropStale: boolean): Promise<number | undefined> {
    const state = this.readState();
    if (!state) return undefined;
    if (await this.isOurs(state.pid)) return state.pid;
    if (dropStale) rmSync(this.paths().state, { force: true });
    return undefined;
  }

  private async isOurs(pid: number): Promise<boolean> {
    if (!this.deps.isPidAlive(pid)) return false;
    return (await this.deps.pidCommand(pid)).includes(`--data ${this.paths().data} `);
  }

  private async answers(path: string, timeoutMs: number): Promise<boolean> {
    try {
      const res = await this.deps.fetch(`${this.url}${path}`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async waitReady(timeoutMs: number, exited?: () => boolean): Promise<boolean> {
    for (let waited = 0; waited <= timeoutMs; waited += this.timings.pollMs) {
      if (this.disposed || exited?.()) return false;
      if (await this.answers("/readyz", this.timings.probeMs)) return true;
      await this.deps.sleep(this.timings.pollMs);
    }
    return false;
  }

  // Why this host cannot run a managed server, or undefined when it can.
  unavailable(): string | undefined {
    if (this.deps.platform === "win32") {
      return `a managed ClickClack is not supported on Windows; ${UNMANAGED_HINT}`;
    }
    const dir = this.deps.dataDir();
    if (!dir || !isAbsolute(dir)) {
      return `a managed ClickClack needs a keelson host that provides a rib data directory, ${UNMANAGED_HINT}`;
    }
    if (!this.binary()) {
      return `no clickclack binary: set CLICKCLACK_BIN or put clickclack on PATH, ${UNMANAGED_HINT}`;
    }
    return undefined;
  }

  private async ensureInner(): Promise<RunningServer> {
    if (this.disposed) throw new Error("keelson is shutting down");
    const why = this.unavailable();
    if (why) throw new Error(why);
    const paths = this.paths();
    const url = this.url;
    const binary = this.binary() as string;

    const owned = await this.ownedPid(true);
    if (owned !== undefined) {
      // A server another process spawned a moment ago may still be starting.
      if (await this.waitReady(this.timings.adoptWaitMs)) {
        return { url, pid: owned, adopted: owned !== this.spawnedPid };
      }
      await this.stopPid(owned);
    } else if (await this.answers("/healthz", this.timings.probeMs)) {
      throw new Error(
        `something the rib did not start is already listening at ${url}; find it with 'lsof -i :${this.port()}', or set CLICKCLACK_PORT to a free port`,
      );
    }

    mkdirSync(paths.data, { recursive: true });
    if (existsSync(paths.log)) renameSync(paths.log, `${paths.log}.old`);
    const child = this.deps.spawn(
      [
        binary,
        "serve",
        "--addr",
        `127.0.0.1:${this.port()}`,
        "--data",
        paths.data,
        "--dev-bootstrap=true",
        "--access-log",
        "errors",
      ],
      { logPath: paths.log, env: this.childEnv() },
    );
    // Stale records were dropped above, so a live one now belongs to a concurrent
    // start whose server holds the port. Leave it for the adoption below.
    const prior = this.readState();
    if (!prior || !this.deps.isPidAlive(prior.pid)) {
      this.record(child.pid, url, binary);
    }
    this.spawnedPid = child.pid;
    const life = { exited: false };
    void child.exited.then(() => {
      life.exited = true;
    });
    // The port answering proves nothing about which process answered it.
    const gone = (): boolean => life.exited || !this.deps.isPidAlive(child.pid);

    const ready = await this.waitReady(this.timings.readyTimeoutMs, gone);
    if (this.disposed) {
      await this.stopPid(child.pid);
      throw new Error("keelson is shutting down");
    }
    if (ready && !gone()) {
      // It holds the port, so the record is its own whatever was there before.
      this.record(child.pid, url, binary);
      return { url, pid: child.pid, adopted: false };
    }

    if (gone()) {
      // Lost the port to another process of ours that spawned at the same moment.
      const winner = await this.ownedPid(false);
      if (
        winner !== undefined &&
        winner !== child.pid &&
        (await this.waitReady(this.timings.adoptWaitMs))
      ) {
        return { url, pid: winner, adopted: true };
      }
      if (this.readState()?.pid === child.pid) rmSync(paths.state, { force: true });
      throw new Error(`clickclack exited before it was ready:\n${this.logTail()}`);
    }
    await this.stopPid(child.pid);
    throw new Error(
      `clickclack was not ready within ${Math.round(this.timings.readyTimeoutMs / 1000)}s:\n${this.logTail()}`,
    );
  }

  private async stopInner(): Promise<boolean> {
    const dir = this.deps.dataDir();
    if (!dir || !isAbsolute(dir)) return false;
    const pid = await this.ownedPid(true);
    if (pid === undefined) return false;
    await this.stopPid(pid);
    return true;
  }

  // Ownership is proved again before each signal: seconds pass between them, and
  // the pid could have gone to another process in that time.
  private async stopPid(pid: number): Promise<void> {
    for (const [signal, budget] of [
      ["SIGTERM", this.timings.termMs],
      ["SIGKILL", this.timings.killMs],
    ] as const) {
      if (!(await this.isOurs(pid))) break;
      this.deps.kill(pid, signal);
      for (let waited = 0; waited < budget && this.deps.isPidAlive(pid); waited += 100) {
        await this.deps.sleep(100);
      }
    }
    if (await this.isOurs(pid)) throw new Error(`clickclack (pid ${pid}) did not exit`);
    if (this.readState()?.pid === pid) rmSync(this.paths().state, { force: true });
    if (this.spawnedPid === pid) this.spawnedPid = undefined;
  }

  // ClickClack reads CLICKCLACK_* itself (CLICKCLACK_DB would move the database
  // out of the directory reset deletes), so none of ours reach the child.
  private childEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.deps.env)) {
      if (value !== undefined && !key.startsWith("CLICKCLACK_")) env[key] = value;
    }
    return ensureSpawnPath(env);
  }

  private logTail(): string {
    try {
      const lines = readFileSync(this.paths().log, "utf8").trimEnd().split("\n");
      return lines.slice(-LOG_TAIL_LINES).join("\n");
    } catch {
      return "(no server log)";
    }
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const res = await this.deps.fetch(`${this.url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`POST ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  }
}

export function realServerDeps(
  dataDir: () => string | undefined,
  opts: { operator?: boolean } = {},
): ManagedServerDeps {
  return {
    ...(opts.operator ? { operator: true } : {}),
    spawn: (cmd, { logPath, env }) => {
      // A file, not a pipe: the server must survive this process being killed.
      const fd = openSync(logPath, "a");
      try {
        const proc = Bun.spawn(cmd, {
          env,
          stdin: "ignore",
          stdout: fd,
          stderr: fd,
          // Its own process group, so a terminal's Ctrl-C reaches the harness
          // alone and swarms can still revoke their bots before the server stops.
          // biome-ignore lint/suspicious/noTsIgnore: Bun supports `detached` at runtime; types lag.
          // @ts-ignore
          detached: true,
        });
        proc.unref();
        return { pid: proc.pid, exited: proc.exited };
      } finally {
        closeSync(fd);
      }
    },
    fetch: globalThis.fetch.bind(globalThis),
    which: (name) => Bun.which(name),
    pidCommand: async (pid) => {
      const proc = Bun.spawn(["ps", "-ww", "-o", "command=", "-p", String(pid)], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      // The trailing space lets a match on the last argument still end in one.
      return `${out.trim()} `;
    },
    isPidAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    kill: (pid, signal) => {
      try {
        process.kill(-pid, signal);
      } catch {
        try {
          process.kill(pid, signal);
        } catch {
          // already gone
        }
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    env: process.env,
    platform: process.platform,
    dataDir,
  };
}
