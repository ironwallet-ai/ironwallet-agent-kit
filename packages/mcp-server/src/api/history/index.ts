/**
 * Transaction history façade: resolve the provider chain for a network from
 * config, run the merge engine against the first provider that answers, and
 * hand back one normalized page.
 *
 * Failure semantics matter here: an indexer outage must never look like an
 * empty history. When every provider fails the result is `unavailable` with
 * the per-provider errors; when the build has no indexer for the network it
 * is `unsupported`.
 */

import { getConfig, isEvmNetwork, type NetworkId } from "../../config.js";
import { logInfo, logWarn } from "../../log.js";
import { decodeCursor, encodeCursor, mergeSources, type CursorState } from "./merge.js";
import { blockcypherProvider } from "./providers/blockcypher.js";
import { esploraProvider } from "./providers/esplora.js";
import { etherscanProvider } from "./providers/etherscan.js";
import { noderealProvider } from "./providers/nodereal.js";
import { solanaProvider } from "./providers/solana.js";
import { tonapiProvider } from "./providers/tonapi.js";
import { toncenterProvider, toncenterV3 } from "./providers/toncenter.js";
import { trongridProvider } from "./providers/trongrid.js";
import { tronscanProvider } from "./providers/tronscan.js";
import { xrpProvider } from "./providers/xrp.js";
import {
  HISTORY_DEFAULT_LIMIT,
  HISTORY_MAX_LIMIT,
  type HistoryApiSpec,
  type HistoryItem,
  type HistoryProvider,
} from "./types.js";

export { HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT };
/**
 * Per-attempt timeout and retry cap for indexer calls. A dead primary costs
 * at most 2 × 8 s + backoff before the chain moves to the fallback provider;
 * MCP hosts typically give a tool call about a minute.
 */
const HISTORY_HTTP_TIMEOUT_MS = 8000;
const HISTORY_HTTP_RETRIES = 1;
/** Extra merge rounds to refill a page after carrier calls were folded into token rows. */
const MAX_REFILL_ROUNDS = 2;

export interface HistoryAttempt {
  provider: string;
  error: string;
}

export type HistoryResult =
  | {
      status: "ok";
      source: string;
      items: HistoryItem[];
      nextCursor: string | null;
      hasMore: boolean;
      /** Providers that failed before `source` answered. */
      failed: HistoryAttempt[];
    }
  | { status: "unavailable"; failed: HistoryAttempt[] }
  | { status: "unsupported"; reason: string };

/** Default endpoint for a kind when the profile entry has no `url`. */
function defaultUrlFor(kind: HistoryApiSpec["kind"], network: NetworkId): string | null {
  const cfg = getConfig();
  switch (kind) {
    case "trongrid":
      return cfg.tronApiUrl;
    case "esplora":
      return network === "bitcoin" ? cfg.bitcoinApiUrl : network === "litecoin" ? cfg.litecoinApiUrl : null;
    case "blockcypher":
      return cfg.dogeApiUrl;
    case "solana-rpc":
      return cfg.solanaRpcUrl;
    case "toncenter":
      return toncenterV3(cfg.tonApiUrl);
    case "xrp-rpc":
      return cfg.xrpRpcUrl;
    default:
      return null;
  }
}

export function buildProvider(spec: HistoryApiSpec, network: NetworkId, address: string): HistoryProvider | null {
  const url = (spec.url ?? defaultUrlFor(spec.kind, network))?.replace(/\/+$/, "");
  if (!url) return null;
  switch (spec.kind) {
    case "etherscan":
      return isEvmNetwork(network) ? etherscanProvider(url, address, network) : null;
    case "nodereal":
      return isEvmNetwork(network) ? noderealProvider(url, address, network) : null;
    case "tronscan":
      return network === "tron" ? tronscanProvider(url, address) : null;
    case "trongrid":
      return network === "tron" ? trongridProvider(url, address) : null;
    case "esplora":
      return network === "bitcoin" || network === "litecoin" ? esploraProvider(url, address, network) : null;
    case "blockcypher":
      return network === "doge" ? blockcypherProvider(url, address, network) : null;
    case "solana-rpc":
      return network === "solana" ? solanaProvider(url, address) : null;
    case "toncenter":
      return network === "ton" ? toncenterProvider(toncenterV3(url) ?? url, address) : null;
    case "tonapi":
      return network === "ton" ? tonapiProvider(url, address) : null;
    case "xrp-rpc":
      return network === "xrp" ? xrpProvider(url, address) : null;
    default:
      return null;
  }
}

export interface ConfiguredProvider {
  kind: HistoryApiSpec["kind"];
  provider: HistoryProvider;
}

export function providersFor(network: NetworkId, address: string): ConfiguredProvider[] {
  const specs = getConfig().historyApis[network] ?? [];
  const out: ConfiguredProvider[] = [];
  for (const spec of specs) {
    const provider = buildProvider(spec, network, address);
    if (provider) out.push({ kind: spec.kind, provider });
  }
  return out;
}

/**
 * A token transfer and the transaction that carried it arrive from different
 * sources with the same hash. Keep the informative token row, fold the fee of
 * the zero-value call into it, and drop the bare call. Page-local by design.
 */
export function collapseCarrierCalls(items: HistoryItem[]): HistoryItem[] {
  const tokenHashes = new Map<string, HistoryItem>();
  for (const it of items) {
    if (it.kind === "token_transfer" && !tokenHashes.has(it.hash)) tokenHashes.set(it.hash, it);
  }
  if (tokenHashes.size === 0) return items;
  const out: HistoryItem[] = [];
  for (const it of items) {
    const carrier = (it.kind === "contract_call" || it.kind === "other") && it.amount.raw === "0";
    const token = carrier ? tokenHashes.get(it.hash) : undefined;
    if (token) {
      if (!token.fee && it.fee && it.direction !== "in") token.fee = it.fee;
      if (token.block === null && it.block !== null) token.block = it.block;
      if (token.status === "confirmed" && it.status === "failed") token.status = "failed";
      continue;
    }
    out.push(it);
  }
  return out;
}

export async function getTransactionHistory(
  network: NetworkId,
  address: string,
  opts: { limit?: number; cursor?: string; correlationId: string },
): Promise<HistoryResult> {
  const limit = Math.min(HISTORY_MAX_LIMIT, Math.max(1, opts.limit ?? HISTORY_DEFAULT_LIMIT));
  const providers = providersFor(network, address);
  if (providers.length === 0) {
    return {
      status: "unsupported",
      reason: `No transaction-history indexer is configured for ${network} in this build.`,
    };
  }

  let previous: Pick<CursorState, "s" | "b"> | undefined;
  let candidates = providers;
  if (opts.cursor) {
    const decoded = decodeCursor(opts.cursor);
    // Cursor state is provider-kind specific (page numbers, fingerprints, …),
    // so later pages may use any configured provider of the same kind — that
    // keeps the fallback (e.g. a second Esplora or Solana RPC host) available.
    candidates = providers.filter((p) => p.kind === decoded.p);
    if (candidates.length === 0) {
      throw new Error(
        `Cursor was issued by a "${decoded.p}" provider, which is not configured for ${network}. Call again without cursor.`,
      );
    }
    previous = { s: decoded.s, b: decoded.b };
  }

  const failed: HistoryAttempt[] = [];
  const started = Date.now();
  const cfg = getConfig();
  const ctx = {
    correlationId: opts.correlationId,
    http: {
      correlationId: opts.correlationId,
      timeoutMs: Math.min(cfg.httpTimeoutMs, HISTORY_HTTP_TIMEOUT_MS),
      retries: Math.min(cfg.httpRetries, HISTORY_HTTP_RETRIES),
    },
  };
  for (const { kind, provider } of candidates) {
    try {
      // Folding a zero-value carrier call into its token row shortens the
      // page, so pull a little more until `limit` rows or the stream ends.
      let cursorState = previous;
      let raw: HistoryItem[] = [];
      let items: HistoryItem[] = [];
      let hasMore = true;
      for (let round = 0; round <= MAX_REFILL_ROUNDS && hasMore && items.length < limit; round++) {
        const merged = await mergeSources(provider.sources, limit - items.length, cursorState, ctx, limit);
        cursorState = { s: merged.state, b: merged.boundary };
        hasMore = merged.hasMore;
        raw = raw.concat(merged.items);
        items = collapseCarrierCalls(raw);
      }
      logInfo("history.ok", {
        correlationId: opts.correlationId,
        network,
        address,
        provider: provider.label,
        items: items.length,
        hasMore,
        failedProviders: failed.map((f) => f.provider),
        elapsedMs: Date.now() - started,
      });
      return {
        status: "ok",
        source: provider.label,
        items,
        nextCursor:
          hasMore && cursorState
            ? encodeCursor({ v: 1, p: kind, s: cursorState.s, ...(cursorState.b ? { b: cursorState.b } : {}) })
            : null,
        hasMore,
        failed,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (/^Invalid cursor/.test(message)) throw e;
      failed.push({ provider: provider.label, error: message });
      logWarn("history.provider.fail", {
        correlationId: opts.correlationId,
        network,
        address,
        provider: provider.label,
        error: message,
      });
    }
  }
  return { status: "unavailable", failed };
}
