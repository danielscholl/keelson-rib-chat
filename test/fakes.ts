import type {
  MessageChunk,
  RibAgentTurn,
  RibAgentTurnRequest,
  RibRunStatus,
  ToolDefinition,
} from "@keelson/shared";
import type { ClickClackTransport } from "../src/clickclack.ts";

// An in-memory ClickClack: the HTTP routes a swarm uses plus a WebSocket that
// echoes durable events, ids only, the way the real server does.

interface FakeUser {
  id: string;
  kind: "human" | "bot";
  handle: string;
  display_name: string;
}

interface FakeMessage {
  id: string;
  channel_id: string;
  author_id: string;
  thread_root_id: string;
  parent_message_id?: string;
  body: string;
  created_at: string;
  author: FakeUser;
}

export const OWNER_TOKEN = "sst_owner";
export const WORKSPACE = "wsp_1";

export class FakeClickClack {
  readonly owner: FakeUser = { id: "usr_owner", kind: "human", handle: "", display_name: "Owner" };
  readonly users = new Map<string, FakeUser>([[this.owner.id, this.owner]]);
  readonly tokens = new Map<string, { userId: string; tokenId: string; revoked: boolean }>([
    [OWNER_TOKEN, { userId: this.owner.id, tokenId: "tok_owner", revoked: false }],
  ]);
  readonly messages: FakeMessage[] = [];
  readonly channels: { id: string; name: string }[] = [];
  readonly sockets = new Set<FakeSocket>();
  // When false the socket never echoes, proving local ingestion alone suffices.
  echo = true;
  // Holds a message write's response so its realtime echo arrives first.
  writeDelayMs = 0;
  // A refused connection, and a server that is up with its store unavailable.
  down = false;
  ready = true;
  private seq = 0;

  private next(prefix: string): string {
    this.seq++;
    return `${prefix}_${String(this.seq).padStart(4, "0")}`;
  }

  get transport(): ClickClackTransport {
    const server = this;
    return {
      fetch: ((input: string | URL | Request, init?: RequestInit) =>
        server.handle(String(input), init ?? {})) as typeof fetch,
      WebSocket: class extends FakeSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(server, String(url), protocols);
        }
      } as unknown as typeof WebSocket,
    };
  }

  postAsOwner(channelId: string, body: string, rootId?: string): FakeMessage {
    return this.addMessage(this.owner, channelId, body, rootId);
  }

  bodiesBy(handle: string): string[] {
    return this.messages.filter((m) => m.author.handle === handle).map((m) => m.body);
  }

  private addMessage(
    author: FakeUser,
    channelId: string,
    body: string,
    rootId?: string,
  ): FakeMessage {
    const id = this.next("msg");
    const message: FakeMessage = {
      id,
      channel_id: channelId,
      author_id: author.id,
      thread_root_id: rootId ?? id,
      ...(rootId ? { parent_message_id: rootId } : {}),
      body,
      created_at: new Date().toISOString(),
      author,
    };
    this.messages.push(message);
    if (this.echo) {
      const event = {
        id: this.next("evt"),
        cursor: this.next("cur"),
        type: rootId ? "thread.reply_created" : "message.created",
        workspace_id: WORKSPACE,
        channel_id: channelId,
        payload: { message_id: id },
      };
      setTimeout(() => {
        for (const socket of this.sockets) socket.deliver(event);
      }, 0);
    }
    return message;
  }

  private json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status });
  }

  private async handle(url: string, init: RequestInit): Promise<Response> {
    if (this.down) throw new TypeError("fetch failed");
    const { pathname } = new URL(url);
    if (pathname === "/readyz") {
      return this.ready
        ? this.json(200, { status: "ready" })
        : this.json(503, { status: "unavailable" });
    }
    const path = pathname.replace(/^\/api/, "");
    const method = (init.method ?? "GET").toUpperCase();
    const bearer = new Headers(init.headers).get("Authorization")?.replace("Bearer ", "") ?? "";
    const grant = this.tokens.get(bearer);
    if (!grant || grant.revoked) return this.json(401, { error: "authentication required" });
    const actor = this.users.get(grant.userId);
    if (!actor) return this.json(401, { error: "authentication required" });
    const input = init.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
    let m: RegExpMatchArray | null;

    if (path === "/me") return this.json(200, { user: actor });
    if (path === "/workspaces") {
      return this.json(200, { workspaces: [{ id: WORKSPACE, name: "Test", role: "owner" }] });
    }
    if (path === "/realtime/events") return this.json(200, { events: [], tail_cursor: "cur_0" });
    if (method === "POST" && path === `/workspaces/${WORKSPACE}/channels`) {
      const channel = { id: this.next("chn"), name: input.name ?? "" };
      this.channels.push(channel);
      return this.json(201, { channel });
    }
    if (method === "POST" && path === `/workspaces/${WORKSPACE}/bots`) {
      if (actor.kind !== "human") return this.json(403, { error: "bots cannot create bots" });
      const bot: FakeUser = {
        id: this.next("usr"),
        kind: "bot",
        handle: input.handle ?? "",
        display_name: input.display_name ?? "",
      };
      this.users.set(bot.id, bot);
      const tokenId = this.next("tok");
      const token = `ccb_${bot.handle}`;
      this.tokens.set(token, { userId: bot.id, tokenId, revoked: false });
      return this.json(201, { bot, bot_token: { id: tokenId, token } });
    }
    m = path.match(/^\/bot-tokens\/([^/]+)\/revoke$/);
    if (method === "POST" && m) {
      for (const t of this.tokens.values()) if (t.tokenId === m[1]) t.revoked = true;
      return this.json(200, {});
    }
    m = path.match(/^\/channels\/([^/]+)\/messages$/);
    if (m?.[1]) {
      if (method === "POST") {
        const message = this.addMessage(actor, m[1], input.body ?? "");
        if (this.writeDelayMs) await new Promise((r) => setTimeout(r, this.writeDelayMs));
        return this.json(201, { message });
      }
      const channelId = m[1];
      return this.json(200, {
        messages: this.messages.filter(
          (x) => x.channel_id === channelId && x.thread_root_id === x.id,
        ),
      });
    }
    m = path.match(/^\/messages\/([^/]+)\/thread\/replies$/);
    if (method === "POST" && m?.[1]) {
      const root = this.messages.find((x) => x.id === m?.[1]);
      if (!root) return this.json(404, { error: "message not found" });
      const message = this.addMessage(actor, root.channel_id, input.body ?? "", root.id);
      if (this.writeDelayMs) await new Promise((r) => setTimeout(r, this.writeDelayMs));
      return this.json(201, { message });
    }
    m = path.match(/^\/messages\/([^/]+)\/thread$/);
    if (m?.[1]) {
      const rootId = m[1];
      const root = this.messages.find((x) => x.id === rootId);
      if (!root) return this.json(404, { error: "message not found" });
      return this.json(200, {
        root,
        replies: this.messages.filter((x) => x.thread_root_id === rootId && x.id !== rootId),
      });
    }
    m = path.match(/^\/messages\/([^/]+)$/);
    if (m?.[1]) {
      const message = this.messages.find((x) => x.id === m?.[1]);
      return message ? this.json(200, { message }) : this.json(404, { error: "message not found" });
    }
    return this.json(404, { error: `route not found: ${method} ${path}` });
  }
}

export class FakeSocket {
  private listeners = new Map<string, ((ev: unknown) => void)[]>();
  readonly url: string;
  readonly protocols: string[];

  constructor(
    private readonly server: FakeClickClack,
    url: string,
    protocols?: string | string[],
  ) {
    this.url = url;
    this.protocols = protocols ? [protocols].flat() : [];
    server.sockets.add(this);
  }

  addEventListener(type: string, fn: (ev: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  deliver(event: unknown): void {
    for (const fn of this.listeners.get("message") ?? []) fn({ data: JSON.stringify(event) });
  }

  open(): void {
    for (const fn of this.listeners.get("open") ?? []) fn({});
  }

  drop(code: number): void {
    this.server.sockets.delete(this);
    for (const fn of this.listeners.get("close") ?? []) fn({ code });
  }

  close(): void {
    this.server.sockets.delete(this);
  }
}

// ---- Scripted agents: a stand-in provider that drives the REAL tools. ----

export interface ScriptTurn {
  agentId: string;
  prompt: string;
  turn: number;
  call: (tool: string, input: unknown) => Promise<{ content: string; isError: boolean }>;
}

export type Script = (t: ScriptTurn) => Promise<void>;

// What each scripted turn reports spending, errors included.
export const TURN_USAGE = { inputTokens: 1_200, outputTokens: 300, cacheReadInputTokens: 800 };

// A class serves as `<class>-1`, like a provider's map would pick one of its models.
function servedBy(req: RibAgentTurnRequest): string | undefined {
  return req.model ?? (req.modelClass ? `${req.modelClass}-1` : undefined);
}

export function scriptedProvider(tools: readonly ToolDefinition[], script: Script) {
  const turns = new Map<string, number>();
  const requests: RibAgentTurnRequest[] = [];
  const run = (req: RibAgentTurnRequest): RibAgentTurn => {
    requests.push(req);
    const agentId = String(req.turnContext?.agentId);
    const turn = (turns.get(agentId) ?? 0) + 1;
    turns.set(agentId, turn);
    const granted = new Set((req.tools ?? []).map((t) => t.name));

    const call: ScriptTurn["call"] = async (name, input) => {
      if (!granted.has(name)) return { content: `tool ${name} not granted`, isError: true };
      const tool = tools.find((t) => t.name === name);
      if (!tool) return { content: `no tool ${name}`, isError: true };
      let result = { content: "", isError: false };
      await tool.execute(input, {
        cwd: "/tmp",
        abortSignal: req.abortSignal ?? new AbortController().signal,
        ...(req.turnContext ? { turnContext: req.turnContext } : {}),
        emit: (chunk: MessageChunk) => {
          if (chunk.type === "tool_result") {
            result = { content: String(chunk.content), isError: chunk.isError === true };
          }
        },
      });
      return result;
    };

    // Like a real provider, an aborted turn settles as aborted even when the
    // script behind it never finishes.
    const aborted = new Promise<{ status: "aborted"; text: string }>((resolve) => {
      const signal = req.abortSignal;
      if (signal?.aborted) resolve({ status: "aborted", text: "" });
      signal?.addEventListener("abort", () => resolve({ status: "aborted", text: "" }), {
        once: true,
      });
    });
    const result = Promise.race([
      script({ agentId, prompt: req.prompt, turn, call }).then(
        () => ({
          status: "ok" as const,
          text: "",
          sessionId: `sess_${agentId}`,
          providerId: req.provider ?? "fake",
          ...(servedBy(req) ? { model: servedBy(req) } : {}),
          usage: TURN_USAGE,
        }),
        (e) => ({ status: "error" as const, text: "", error: String(e), usage: TURN_USAGE }),
      ),
      aborted,
    ]);
    // An empty stream that ends when the scripted turn does.
    const stream: AsyncIterable<MessageChunk> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          await result;
          return { done: true as const, value: undefined };
        },
      }),
    };
    return { stream, result };
  };
  return { run, requests };
}

// A workflow host whose runs move only when a test sets their status.
export function fakeDispatcher(
  opts: { live?: boolean; refuseAnswers?: string; answers?: boolean } = {},
) {
  const states = new Map<string, RibRunStatus>();
  const started: { name: string; inputs: Record<string, string> }[] = [];
  const cancelled: string[] = [];
  const answered: { runId: string; nodeId: string; text: string; pauseId?: string }[] = [];
  let n = 0;
  const set = (runId: string, patch: Partial<RibRunStatus>) => {
    const current = states.get(runId);
    if (current) states.set(runId, { ...current, ...patch });
  };
  const respond = async (runId: string, nodeId: string, text: string, pauseId?: string) => {
    if (opts.refuseAnswers) return { ok: false as const, error: opts.refuseAnswers };
    answered.push({ runId, nodeId, text, ...(pauseId ? { pauseId } : {}) });
    set(runId, { status: "running", pendingApproval: undefined });
    return { ok: true as const };
  };
  return {
    started,
    cancelled,
    answered,
    set,
    dispatcher: {
      ...(opts.answers || opts.refuseAnswers ? { respond } : {}),
      start: async (name: string, inputs: Record<string, string>) => {
        n++;
        const runId = `run_${n}`;
        started.push({ name, inputs });
        states.set(runId, {
          runId,
          workflowName: name,
          status: "running",
          startedAt: new Date().toISOString(),
          checkout: opts.live
            ? { path: "/project", branch: "main", worktreeEstablished: false }
            : { path: `/wt/${runId}`, branch: `keelson/${runId}`, worktreeEstablished: true },
          nodes: [],
        });
        return { runId };
      },
      status: async (runId: string) => states.get(runId),
      cancel: async (runId: string) => {
        cancelled.push(runId);
        set(runId, { status: "cancelled" });
        return { ok: true as const };
      },
    },
  };
}

// The host's runText for git and gh, answering from per-path state a test sets.
export function fakeGit(
  opts: {
    defaultBranch?: string | null;
    ignored?: boolean;
    holdAdd?: Promise<void>;
    failBranchDelete?: boolean;
  } = {},
) {
  const calls: { cmd: string; args: string[]; cwd: string }[] = [];
  const dirty = new Map<string, string>();
  const ahead = new Map<string, number>();
  const appended: { file: string; line: string }[] = [];
  const ok = (data = "") => ({ ok: true as const, data, exitCode: 0 });
  const fail = (error: string) => ({ ok: false as const, error, code: 1 });
  const run = async (cmd: string, args: string[], o: { cwd?: string } = {}) => {
    const cwd = o.cwd ?? "";
    calls.push({ cmd, args, cwd });
    const sub = args.join(" ");
    if (cmd !== "git") return ok();
    if (sub.startsWith("symbolic-ref")) {
      return opts.defaultBranch === null
        ? fail("not a symbolic ref")
        : ok(`refs/remotes/origin/${opts.defaultBranch ?? "main"}\n`);
    }
    if (sub.startsWith("rev-parse --verify")) return fail("");
    if (sub.startsWith("check-ignore")) return opts.ignored ? ok() : fail("exit 1");
    if (sub === "rev-parse --git-common-dir") return ok(".git\n");
    if (sub.startsWith("worktree add")) await opts.holdAdd;
    if (sub.startsWith("branch -D") && opts.failBranchDelete) return fail("cannot lock ref");
    if (sub === "status --porcelain") return ok(dirty.get(cwd) ?? "");
    if (sub.startsWith("rev-list --count")) return ok(`${ahead.get(cwd) ?? 0}\n`);
    return ok();
  };
  return {
    calls,
    dirty,
    ahead,
    appended,
    deps: { run, append: (file: string, line: string) => appended.push({ file, line }) },
    ran: (prefix: string) => calls.filter((c) => `${c.cmd} ${c.args.join(" ")}`.startsWith(prefix)),
  };
}
