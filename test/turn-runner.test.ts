import { describe, expect, test } from "bun:test";
import type { RibAgentTurn, RibAgentTurnRequest } from "@keelson/shared";
import { type RunAgentTurn, runTurn } from "../src/turn-runner.ts";

// A host turn that never answers, then settles `settleAfterMs` after it is aborted.
function hungTurn(settleAfterMs: number | null): RunAgentTurn {
  return ((req: RibAgentTurnRequest): RibAgentTurn => {
    const result = new Promise<Awaited<RibAgentTurn["result"]>>((resolve) => {
      req.abortSignal?.addEventListener("abort", () => {
        if (settleAfterMs === null) return;
        setTimeout(
          () => resolve({ status: "aborted", text: "", sessionId: "sess_1" }),
          settleAfterMs,
        );
      });
    });
    const stream: AsyncIterable<never> = {
      [Symbol.asyncIterator]: () => ({
        next: () => result.then(() => ({ done: true, value: undefined as never })),
      }),
    };
    return { stream, result };
  }) as RunAgentTurn;
}

const req = { system: "s", prompt: "p", tools: [] };

describe("runTurn", () => {
  test("a timed-out turn waits for the host to release it before returning", async () => {
    const started = Date.now();
    const outcome = await runTurn(hungTurn(60), req, 20, undefined, 1_000);
    expect(outcome.status).toBe("timeout");
    expect(outcome.sessionId).toBe("sess_1");
    expect(Date.now() - started).toBeGreaterThanOrEqual(75);
  });

  test("a host that never settles is abandoned after the grace period", async () => {
    const started = Date.now();
    const outcome = await runTurn(hungTurn(null), req, 20, undefined, 50);
    expect(outcome.status).toBe("timeout");
    expect(outcome.sessionId).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(500);
  });
});
