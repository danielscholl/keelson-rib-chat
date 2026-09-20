// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { ChatMessage } from "./types.ts";

// The public ClickClack HTTP/WebSocket API, and only the slice a swarm needs.
// fetch and WebSocket are injected so tests drive it without a server.

export interface ClickClackTransport {
  fetch: typeof fetch;
  WebSocket: typeof WebSocket;
}

export interface ClickClackEvent {
  id: string;
  cursor: string;
  type: string;
  workspace_id: string;
  channel_id?: string;
  payload: Record<string, unknown>;
}

export interface CreatedBot {
  botUserId: string;
  handle: string;
  displayName: string;
  tokenId: string;
  token: string;
}

export interface Subscription {
  close: () => void;
}

export class ClickClackError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ClickClackError";
  }
}

interface RawAuthor {
  id?: string;
  kind?: string;
  handle?: string;
  display_name?: string;
}

interface RawMessage {
  id: string;
  channel_id: string;
  author_id: string;
  thread_root_id?: string;
  parent_message_id?: string;
  body?: string;
  created_at?: string;
  author?: RawAuthor;
}

export function toChatMessage(raw: RawMessage): ChatMessage {
  return {
    id: raw.id,
    channelId: raw.channel_id,
    authorId: raw.author_id,
    authorKind: raw.author?.kind === "bot" ? "bot" : "human",
    authorHandle: raw.author?.handle ?? "",
    authorName: raw.author?.display_name ?? raw.author_id,
    body: raw.body ?? "",
    threadRootId: raw.thread_root_id ?? raw.id,
    ...(raw.parent_message_id ? { parentId: raw.parent_message_id } : {}),
    createdAt: raw.created_at ?? "",
  };
}

export class ClickClackClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly transport: ClickClackTransport;

  constructor(baseUrl: string, token: string, transport?: Partial<ClickClackTransport>) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
    this.transport = {
      fetch: transport?.fetch ?? globalThis.fetch.bind(globalThis),
      WebSocket: transport?.WebSocket ?? globalThis.WebSocket,
    };
  }

  // Same server and transport, a different identity: how an agent's bot speaks.
  withToken(token: string): ClickClackClient {
    return new ClickClackClient(this.baseUrl, token, this.transport);
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    headers.set("Authorization", `Bearer ${this.token}`);
    if (init.body) headers.set("Content-Type", "application/json");
    const res = await this.transport.fetch(`${this.baseUrl}/api${path}`, { ...init, headers });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { error?: unknown };
        if (typeof parsed.error === "string") detail = parsed.error;
      } catch {
        // non-JSON error body: keep the raw slice
      }
      throw new ClickClackError(
        `${init.method ?? "GET"} ${path} -> ${res.status}: ${detail}`,
        res.status,
      );
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: "POST", body: JSON.stringify(body) });
  }

  async me(): Promise<{ id: string; kind: string; displayName: string }> {
    const data = await this.request<{ user: RawAuthor }>("/me");
    return {
      id: data.user.id ?? "",
      kind: data.user.kind ?? "human",
      displayName: data.user.display_name ?? "",
    };
  }

  async listWorkspaces(): Promise<{ id: string; name: string; role?: string }[]> {
    const data = await this.request<{ workspaces: { id: string; name: string; role?: string }[] }>(
      "/workspaces",
    );
    return data.workspaces ?? [];
  }

  async listChannels(workspaceId: string): Promise<{ id: string; name: string }[]> {
    const data = await this.request<{ channels: { id: string; name: string }[] }>(
      `/workspaces/${workspaceId}/channels`,
    );
    return data.channels ?? [];
  }

  async createChannel(workspaceId: string, name: string): Promise<{ id: string; name: string }> {
    const data = await this.post<{ channel: { id: string; name: string } }>(
      `/workspaces/${workspaceId}/channels`,
      { name },
    );
    return data.channel;
  }

  async createBot(
    workspaceId: string,
    input: { displayName: string; handle: string },
  ): Promise<CreatedBot> {
    const data = await this.post<{
      bot: RawAuthor;
      bot_token?: { id: string; token?: string };
    }>(`/workspaces/${workspaceId}/bots`, {
      display_name: input.displayName,
      handle: input.handle,
      scopes: ["bot:write"],
      token_name: "keelson-swarm",
      initial_token: true,
    });
    const token = data.bot_token?.token;
    if (!data.bot?.id || !data.bot_token?.id || !token) {
      throw new ClickClackError("bot created without an initial token", 500);
    }
    return {
      botUserId: data.bot.id,
      handle: data.bot.handle ?? input.handle,
      displayName: data.bot.display_name ?? input.displayName,
      tokenId: data.bot_token.id,
      token,
    };
  }

  async revokeBotToken(tokenId: string): Promise<void> {
    await this.post(`/bot-tokens/${tokenId}/revoke`, {});
  }

  async deleteBot(botUserId: string): Promise<void> {
    await this.request(`/bots/${botUserId}`, { method: "DELETE" });
  }

  async postMessage(channelId: string, body: string): Promise<ChatMessage> {
    const data = await this.post<{ message: RawMessage }>(`/channels/${channelId}/messages`, {
      body,
    });
    return toChatMessage(data.message);
  }

  async replyInThread(rootMessageId: string, body: string): Promise<ChatMessage> {
    const data = await this.post<{ message: RawMessage }>(
      `/messages/${rootMessageId}/thread/replies`,
      { body },
    );
    return toChatMessage(data.message);
  }

  async getMessage(messageId: string): Promise<ChatMessage> {
    const data = await this.request<{ message: RawMessage }>(`/messages/${messageId}`);
    return toChatMessage(data.message);
  }

  async listMessages(channelId: string, limit: number): Promise<ChatMessage[]> {
    const data = await this.request<{ messages: RawMessage[] }>(
      `/channels/${channelId}/messages?limit=${limit}`,
    );
    return (data.messages ?? []).map(toChatMessage);
  }

  async getThread(rootMessageId: string): Promise<ChatMessage[]> {
    const data = await this.request<{ root: RawMessage; replies: RawMessage[] }>(
      `/messages/${rootMessageId}/thread`,
    );
    return [data.root, ...(data.replies ?? [])].map(toChatMessage);
  }

  // The newest durable cursor, captured before a subscriber opens so it neither
  // replays old history nor races events created during startup.
  async tailCursor(workspaceId: string): Promise<string> {
    const data = await this.request<{ tail_cursor?: string }>(
      `/realtime/events?workspace_id=${workspaceId}&limit=1&include_tail=true`,
    );
    return data.tail_cursor ?? "";
  }

  subscribe(opts: {
    workspaceId: string;
    afterCursor: string;
    onEvent: (event: ClickClackEvent) => void;
    onClose: (code: number) => void;
  }): Subscription {
    const url = new URL(`${this.baseUrl}/api/realtime/ws`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("workspace_id", opts.workspaceId);
    if (opts.afterCursor) url.searchParams.set("after_cursor", opts.afterCursor);
    // Browsers cannot set headers on a WebSocket, so ClickClack takes the bearer
    // as a subprotocol.
    const socket = new this.transport.WebSocket(url, [`clickclack.bearer.${this.token}`]);
    socket.addEventListener("message", (msg) => {
      try {
        opts.onEvent(JSON.parse(String((msg as MessageEvent).data)) as ClickClackEvent);
      } catch {
        // a malformed frame is dropped; the durable log stays the source of truth
      }
    });
    socket.addEventListener("close", (ev) => opts.onClose((ev as CloseEvent).code ?? 1006));
    return { close: () => socket.close() };
  }
}
