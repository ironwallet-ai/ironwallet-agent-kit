/**
 * Process-wide request gates for keyless public indexers with per-IP rate
 * limits (TonCenter ≈ 1 rps, TronGrid 3 rps). A provider's sources run in
 * parallel and may load two pages each, so without a gate a single tool call
 * bursts past the limit and the indexer suspends the IP for several seconds.
 */

const gates = new Map<string, number>();

/** Run `fn` no sooner than `gapMs` after the previous call through the same gate. */
export async function paced<T>(gate: string, gapMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const startAt = Math.max(now, gates.get(gate) ?? 0);
  gates.set(gate, startAt + gapMs);
  if (startAt > now) await new Promise((resolve) => setTimeout(resolve, startAt - now));
  return fn();
}

export function isRateLimited(e: unknown): boolean {
  return e instanceof Error && (e as { status?: number }).status === 429;
}

/**
 * The gate only spaces this process's own calls. Another MCP host on the same
 * machine, or colleagues behind one NAT, share the per-IP budget, and the
 * indexers answer the overflow with 429 and no Retry-After — so the generic
 * HTTP retry (~0.3 s) fires inside the penalty window and fails again. Wait
 * out the penalty, then go through the gate once more.
 */
export async function retryRateLimited<T>(
  fn: () => Promise<T>,
  opts: { waitMs: number; attempts: number; onRetry?: (attempt: number) => void },
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isRateLimited(e) || attempt >= opts.attempts) throw e;
      opts.onRetry?.(attempt + 1);
      await new Promise((resolve) => setTimeout(resolve, opts.waitMs));
    }
  }
}
