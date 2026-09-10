/**
 * Transaction history: one normalized shape for every chain.
 *
 * Every provider (Blockscout, NodeReal, TronScan, Esplora, …) is exposed as one
 * or more `HistorySource`s — newest-first paged streams of `SourceItem`s. The
 * merge engine (merge.ts) interleaves the sources of a network by timestamp and
 * keeps an opaque cursor so the agent can page further without duplicates.
 *
 * Strings copied from indexers (token symbols, addresses) are untrusted input;
 * providers must pass them through normalize.ts before they reach the agent.
 */

import type { NetworkId } from "../../networks.js";

export type HistoryDirection = "in" | "out" | "self";

/**
 * transfer        — native coin moved (ETH, BNB, TRX, BTC, …)
 * token_transfer  — fungible token moved (ERC-20 / TRC-20 / SPL / jetton / IOU)
 * contract_call   — the wallet called a contract; no recognised value transfer
 * other           — anything else the indexer returned for this address
 */
export type HistoryKind = "transfer" | "token_transfer" | "contract_call" | "other";

export type HistoryStatus = "confirmed" | "failed" | "pending";

export interface HistoryAsset {
  symbol: string;
  /** Token contract / mint / jetton master. Null for the native coin. */
  contractAddress: string | null;
  decimals: number;
  /**
   * Set when the symbol looks like an unsolicited / spam token (contains a
   * link, unusual characters, or mimics another ticker). Indexer data only —
   * never a guarantee either way.
   */
  warning?: string;
}

export interface HistoryAmount {
  /** Smallest unit as a decimal string (wei, sun, satoshi, lamports, …). */
  raw: string;
  /** Human readable, formatted with `asset.decimals`. */
  formatted: string;
}

export interface HistoryFee extends HistoryAmount {
  /** Native coin symbol the fee was paid in. */
  symbol: string;
}

export interface HistoryItem {
  /** Transaction hash / signature. */
  hash: string;
  /** ISO 8601 timestamp; null when the indexer did not return one (pending). */
  timestamp: string | null;
  /** Block height / slot / ledger index; null when pending or unknown. */
  block: number | null;
  kind: HistoryKind;
  direction: HistoryDirection;
  status: HistoryStatus;
  from: string | null;
  to: string | null;
  asset: HistoryAsset;
  amount: HistoryAmount;
  /** Fee paid by this wallet; null when the counterparty paid it or it is unknown. */
  fee: HistoryFee | null;
}

/** A normalized item plus the millisecond sort key the merge engine orders by. */
export interface SourceItem {
  /** Milliseconds since epoch. Pending items use Date.now() so they sort first. */
  ts: number;
  item: HistoryItem;
}

export interface SourcePage {
  /** Newest first. */
  items: SourceItem[];
  /** Opaque cursor for the following page; null when this was the last page. */
  next: string | null;
}

export interface SourceContext {
  correlationId: string;
  /**
   * Base options for every indexer call: correlation id plus a tighter
   * timeout / retry budget than the general HTTP defaults, so a dead primary
   * hands over to the fallback provider quickly.
   */
  http: { correlationId: string; timeoutMs: number; retries: number };
}

/** One newest-first paged stream for a wallet address. */
export interface HistorySource {
  /** Stable id used inside cursors, e.g. "native", "erc20". */
  name: string;
  fetchPage(pageCursor: string | null, pageSize: number, ctx: SourceContext): Promise<SourcePage>;
}

/** A provider bundles the sources of one indexer for one network/address. */
export interface HistoryProvider {
  /** Label reported to the agent, e.g. "blockscout", "tronscan", "trongrid". */
  label: string;
  sources: HistorySource[];
}

export type HistoryApiKind =
  | "etherscan"
  | "nodereal"
  | "tronscan"
  | "trongrid"
  | "esplora"
  | "blockcypher"
  | "solana-rpc"
  | "toncenter"
  | "tonapi"
  | "xrp-rpc";

/** One entry of the per-network provider chain in the baked profile. */
export interface HistoryApiSpec {
  kind: HistoryApiKind;
  /**
   * API base URL. Omit to reuse the network's existing endpoint from the
   * profile (tronApiUrl, bitcoinApiUrl, solanaRpcUrl, tonApiUrl, xrpRpcUrl, …).
   */
  url?: string;
}

export type HistoryApis = Partial<Record<NetworkId, HistoryApiSpec[]>>;

/** Rows per page: the default is also the cap — one page is one screen of history. */
export const HISTORY_MAX_LIMIT = 20;
export const HISTORY_DEFAULT_LIMIT = 20;

export const HISTORY_API_KINDS: readonly HistoryApiKind[] = [
  "etherscan",
  "nodereal",
  "tronscan",
  "trongrid",
  "esplora",
  "blockcypher",
  "solana-rpc",
  "toncenter",
  "tonapi",
  "xrp-rpc",
];
