// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import type { MessageChunk, RibAgentTurn, RibContext, TokenUsage } from "@keelson/shared";

// One agent turn run to its settled result: own an AbortController linked to the
// parent signal, drain the stream (the result stays the source of truth for
// text), and race the result against a timeout so a hung provider cannot wedge
// the swarm. Never throws.

export type RunAgentTurn = NonNullable<RibContext["runAgentTurn"]>;
export type TurnRequest = Omit<Parameters<RunAgentTurn>[0], "abortSignal" | "timeoutMs">;

export interface TurnOutcome {
  status: "ok" | "error" | "timeout" | "aborted";
  text: string;
  error?: string;
  // Passed back as resumeSessionId so an agent keeps one continuous session.
  sessionId?: string;
  // The provider the host resolved the turn to.
  providerId?: string;
  toolCalls: string[];
  usage?: TokenUsage;
  durationMs: number;
}

const TOOL_CALL_CAP = 32;
// How long a timed-out turn waits for the host to finish tearing it down. The
// next turn resumes the same provider session, and resuming it before the old
// turn has released it can leave the new turn hung with no model call.
export const SETTLE_GRACE_MS = 15_000;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function runTurn(
  run: RunAgentTurn,
  req: TurnRequest,
  timeoutMs: number,
  parentSignal?: AbortSignal,
  settleGraceMs = SETTLE_GRACE_MS,
): Promise<TurnOutcome> {
  const startedAt = Date.now();
  const toolCalls: string[] = [];
  const base = () => ({ toolCalls: [...toolCalls], durationMs: Date.now() - startedAt });
  if (parentSignal?.aborted) return { status: "aborted", text: "", ...base() };

  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const turn: RibAgentTurn = run({ ...req, abortSignal: controller.signal, timeoutMs });
    // Wrapped so neither branch rejects: a timed-out turn's still-pending drain
    // must not surface as an unhandled rejection after the race settles.
    const settled = drain(turn, toolCalls).then(
      (result) => ({ kind: "result" as const, result }),
      (err) => ({ kind: "error" as const, err }),
    );
    const timed = new Promise<{ kind: "timeout" }>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ kind: "timeout" });
      }, timeoutMs);
    });

    const outcome = await Promise.race([settled, timed]);
    if (outcome.kind === "timeout") {
      let grace: ReturnType<typeof setTimeout> | undefined;
      const late = await Promise.race([
        settled,
        new Promise<undefined>((resolve) => {
          grace = setTimeout(() => resolve(undefined), settleGraceMs);
        }),
      ]);
      if (grace) clearTimeout(grace);
      const lateResult = late?.kind === "result" ? late.result : undefined;
      const sessionId = {
        ...(lateResult?.sessionId ? { sessionId: lateResult.sessionId } : {}),
        ...(lateResult?.usage ? { usage: lateResult.usage } : {}),
      };
      return {
        status: "timeout",
        text: "",
        error: `agent turn exceeded ${timeoutMs}ms`,
        ...sessionId,
        ...base(),
      };
    }
    if (outcome.kind === "error") {
      return { status: "error", text: "", error: errText(outcome.err), ...base() };
    }
    const result = outcome.result;
    const kept = {
      ...(result.sessionId ? { sessionId: result.sessionId } : {}),
      ...(result.providerId ? { providerId: result.providerId } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
    };
    if (controller.signal.aborted || result.status === "aborted") {
      return { status: "aborted", text: result.text ?? "", ...kept, ...base() };
    }
    if (result.status === "ok") {
      return {
        status: "ok",
        text: result.text,
        ...kept,
        ...base(),
      };
    }
    return {
      status: result.status,
      text: "",
      error: result.error ?? result.text ?? `turn ${result.status}`,
      ...kept,
      ...base(),
    };
  } catch (e) {
    return { status: "error", text: "", error: errText(e), ...base() };
  } finally {
    if (timer) clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

async function drain(turn: RibAgentTurn, toolCalls: string[]) {
  try {
    for await (const chunk of turn.stream) noteToolUse(chunk, toolCalls);
  } catch {
    // a stream error resurfaces via result.status
  }
  return await turn.result;
}

function noteToolUse(chunk: MessageChunk, toolCalls: string[]): void {
  if (chunk.type !== "tool_use") return;
  toolCalls.push(chunk.toolName);
  if (toolCalls.length > TOOL_CALL_CAP) toolCalls.shift();
}
