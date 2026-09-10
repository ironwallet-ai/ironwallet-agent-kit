/**
 * TonCenter v3 indexer: `/transactions` (account transactions, newest first)
 * and `/jetton/transfers` (owner-scoped jetton moves). Offset-based. Raw
 * `0:HEX` addresses are turned into user-friendly form via `address_book`
 * or @ton/ton when missing.
 */

import { httpJson } from "../../http.js";
import { logInfo } from "../../../log.js";
import { paced as pacedGate, retryRateLimited } from "../pace.js";
import {
  amountOf,
  asString,
  clampDecimals,
  feeOf,
  sanitizeSymbol,
  timeFrom,
  toBigInt,
  tokenAsset,
} from "../normalize.js";
import type {
  HistoryItem,
  HistoryProvider,
  HistorySource,
  SourceContext,
  SourceItem,
  SourcePage,
} from "../types.js";
import { TON_NATIVE_ASSET, isPlainOpcode, tonAddr, tonEquals, type TonAddressBook } from "./ton-shared.js";

interface TonMsg {
  source?: string | null;
  destination?: string | null;
  value?: string | null;
  opcode?: string | null;
}

export interface TonTx {
  hash?: string;
  lt?: string;
  now?: number;
  mc_block_seqno?: number;
  total_fees?: string;
  description?: { aborted?: boolean; compute_ph?: { success?: boolean; exit_code?: number } };
  in_msg?: TonMsg | null;
  out_msgs?: TonMsg[];
}

export interface TonJettonTransfer {
  transaction_hash?: string;
  transaction_now?: number;
  transaction_aborted?: boolean;
  source?: string | null;
  destination?: string | null;
  amount?: string;
  jetton_master?: string;
}

type AddressBook = TonAddressBook;
type JettonMetadata = Record<
  string,
  { token_info?: Array<{ type?: string; symbol?: string; extra?: { decimals?: unknown } }> }
>;

export function mapTonTx(tx: TonTx, address: string, book: AddressBook | undefined): SourceItem | null {
  const hash = asString(tx.hash);
  if (!hash) return null;
  const time = timeFrom(tx.now);
  const aborted = tx.description?.aborted === true || tx.description?.compute_ph?.success === false;
  const status = aborted ? "failed" : "confirmed";
  const fees = toBigInt(tx.total_fees ?? 0);
  const inMsg = tx.in_msg ?? null;
  const inValue = toBigInt(inMsg?.value ?? 0);
  const outMsgs = tx.out_msgs ?? [];
  const outValue = outMsgs.reduce((s, m) => s + toBigInt(m.value ?? 0), 0n);
  const block = typeof tx.mc_block_seqno === "number" ? tx.mc_block_seqno : null;
  const asset = { ...TON_NATIVE_ASSET };

  let item: HistoryItem;
  if (outValue > 0n) {
    const first = outMsgs.find((m) => toBigInt(m.value ?? 0) > 0n) ?? outMsgs[0];
    const to = tonAddr(first?.destination, book);
    item = {
      hash,
      timestamp: time?.iso ?? null,
      block,
      kind: isPlainOpcode(first?.opcode) ? "transfer" : "contract_call",
      direction: tonEquals(first?.destination, address) ? "self" : "out",
      status,
      from: tonAddr(address, book) ?? address,
      to,
      asset,
      amount: amountOf(outValue, 9),
      fee: feeOf(fees, 9, "TON"),
    };
  } else if (inValue > 0n && inMsg?.source) {
    item = {
      hash,
      timestamp: time?.iso ?? null,
      block,
      kind: isPlainOpcode(inMsg.opcode) ? "transfer" : "other",
      direction: tonEquals(inMsg.source, address) ? "self" : "in",
      status,
      from: tonAddr(inMsg.source, book),
      to: tonAddr(address, book) ?? address,
      asset,
      amount: amountOf(inValue, 9),
      fee: null,
    };
  } else {
    item = {
      hash,
      timestamp: time?.iso ?? null,
      block,
      kind: "other",
      direction: inMsg?.source ? "in" : "out",
      status,
      from: tonAddr(inMsg?.source, book),
      to: tonAddr(address, book) ?? address,
      asset,
      amount: amountOf(0n, 9),
      fee: inMsg?.source ? null : feeOf(fees, 9, "TON"),
    };
  }
  return { ts: time?.ts ?? 0, item };
}

function jettonMeta(master: string | undefined, metadata: JettonMetadata | undefined) {
  const entry = master ? metadata?.[master] ?? metadata?.[master.toUpperCase()] : undefined;
  const info = entry?.token_info?.find((t) => t.type === "jetton_masters") ?? entry?.token_info?.[0];
  return {
    symbol: sanitizeSymbol(info?.symbol, "JETTON"),
    decimals: clampDecimals(info?.extra?.decimals, 9),
  };
}

export function mapTonJettonTransfer(
  row: TonJettonTransfer,
  address: string,
  book: AddressBook | undefined,
  metadata: JettonMetadata | undefined,
): SourceItem | null {
  const hash = asString(row.transaction_hash);
  const master = asString(row.jetton_master);
  if (!hash || !master) return null;
  const time = timeFrom(row.transaction_now);
  const meta = jettonMeta(master, metadata);
  const fromSelf = tonEquals(row.source, address);
  const toSelf = tonEquals(row.destination, address);
  const item: HistoryItem = {
    hash,
    timestamp: time?.iso ?? null,
    block: null,
    kind: "token_transfer",
    direction: fromSelf && toSelf ? "self" : fromSelf ? "out" : "in",
    status: row.transaction_aborted ? "failed" : "confirmed",
    from: tonAddr(row.source, book),
    to: tonAddr(row.destination, book),
    asset: tokenAsset(meta.symbol, "JETTON", tonAddr(master, book) ?? master, meta.decimals),
    amount: amountOf(toBigInt(row.amount), meta.decimals),
    fee: null,
  };
  return { ts: time?.ts ?? 0, item };
}

function offsetOf(cursor: string | null): number {
  if (cursor === null) return 0;
  const n = Number.parseInt(cursor, 10);
  if (!Number.isInteger(n) || n < 0) throw new Error("Invalid cursor for toncenter source.");
  return n;
}

function apiKey(): string | undefined {
  const key = process.env.IW_TON_API_KEY?.trim();
  return key && key.length > 0 ? key : undefined;
}

function headers(): Record<string, string> | undefined {
  const key = apiKey();
  return key ? { "X-Api-Key": key } : undefined;
}

/**
 * Keyless TonCenter allows about one request per second per IP and answers
 * bursts with 429. The two sources of this provider (and their second pages)
 * are spaced out through one process-wide gate; with an API key the gate is off.
 *
 * Measured: a third request within a second gets 429 and the IP stays
 * suspended for ~2 s, without Retry-After. Traffic from another MCP process
 * or another machine behind the same NAT eats the same budget, so on 429 we
 * wait past the suspension and try again instead of failing the provider.
 */
const KEYLESS_GAP_MS = 1100;
const RATE_LIMIT_WAIT_MS = 2500;
const RATE_LIMIT_ATTEMPTS = 2;

function paced<T>(fn: () => Promise<T>, ctx: SourceContext): Promise<T> {
  const call = () => (apiKey() ? fn() : pacedGate("toncenter", KEYLESS_GAP_MS, fn));
  return retryRateLimited(call, {
    waitMs: RATE_LIMIT_WAIT_MS,
    attempts: RATE_LIMIT_ATTEMPTS,
    onRetry: (attempt) =>
      logInfo("history.toncenter.rate_limited", {
        correlationId: ctx.correlationId,
        attempt,
        waitMs: RATE_LIMIT_WAIT_MS,
      }),
  });
}

/** `…/api/v2` → `…/api/v3`; a v3 URL is used as is. */
export function toncenterV3(base: string): string | null {
  const b = base.replace(/\/$/, "");
  if (b.endsWith("/api/v3")) return b;
  if (b.endsWith("/api/v2")) return `${b.slice(0, -1)}3`;
  return null;
}

export function toncenterProvider(v3Base: string, address: string): HistoryProvider {
  const native: HistorySource = {
    name: "native",
    async fetchPage(cursor: string | null, pageSize: number, ctx: SourceContext): Promise<SourcePage> {
      const offset = offsetOf(cursor);
      const url =
        `${v3Base}/transactions?account=${encodeURIComponent(address)}` +
        `&limit=${pageSize}&offset=${offset}&sort=desc`;
      const res = await paced(
        () =>
          httpJson<{ transactions?: TonTx[]; address_book?: AddressBook }>(
            url,
            { method: "GET", headers: headers() },
            { ...ctx.http, label: "history.toncenter.transactions" },
          ),
        ctx,
      );
      const rows = Array.isArray(res.transactions) ? res.transactions : null;
      if (!rows) throw new Error("toncenter transactions: unexpected response");
      const items = rows.map((tx) => mapTonTx(tx, address, res.address_book)).filter((x): x is SourceItem => x !== null);
      return { items, next: rows.length < pageSize ? null : String(offset + rows.length) };
    },
  };
  const jettons: HistorySource = {
    name: "jetton",
    async fetchPage(cursor: string | null, pageSize: number, ctx: SourceContext): Promise<SourcePage> {
      const offset = offsetOf(cursor);
      const url =
        `${v3Base}/jetton/transfers?owner_address=${encodeURIComponent(address)}` +
        `&limit=${pageSize}&offset=${offset}&sort=desc`;
      const res = await paced(
        () =>
          httpJson<{
            jetton_transfers?: TonJettonTransfer[];
            address_book?: AddressBook;
            metadata?: JettonMetadata;
          }>(
            url,
            { method: "GET", headers: headers() },
            { ...ctx.http, label: "history.toncenter.jettons" },
          ),
        ctx,
      );
      const rows = Array.isArray(res.jetton_transfers) ? res.jetton_transfers : null;
      if (!rows) throw new Error("toncenter jetton/transfers: unexpected response");
      const items = rows
        .map((row) => mapTonJettonTransfer(row, address, res.address_book, res.metadata))
        .filter((x): x is SourceItem => x !== null);
      return { items, next: rows.length < pageSize ? null : String(offset + rows.length) };
    },
  };
  return { label: "toncenter", sources: [native, jettons] };
}
