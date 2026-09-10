/**
 * TonAPI v2 (tonapi.io) — fallback indexer for TON when TonCenter is rate
 * limited or down. `/blockchain/accounts/{a}/transactions` for native moves
 * and `/accounts/{a}/jettons/history` for jetton moves; both page by
 * `before_lt` (exclusive), so the cursor is the last logical time seen.
 *
 * Keyless access is about one request per second per IP; `IW_TONAPI_KEY`
 * (Bearer) lifts that. Amounts come as JSON numbers: exact below 2^53
 * nanotons (~9 million TON), which covers a hot wallet.
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
import { TON_NATIVE_ASSET, isPlainOpcode, tonAddr, tonEquals } from "./ton-shared.js";

interface TonapiAccount {
  address?: string;
}

interface TonapiMsg {
  value?: number | string;
  source?: TonapiAccount | null;
  destination?: TonapiAccount | null;
  op_code?: string | null;
}

export interface TonapiTx {
  hash?: string;
  lt?: number | string;
  utime?: number;
  success?: boolean;
  aborted?: boolean;
  total_fees?: number | string;
  /** "(workchain,shard,seqno)" */
  block?: string;
  in_msg?: TonapiMsg | null;
  out_msgs?: TonapiMsg[];
}

export interface TonapiJettonOp {
  operation?: string;
  utime?: number;
  lt?: number | string;
  transaction_hash?: string;
  source?: TonapiAccount | null;
  destination?: TonapiAccount | null;
  amount?: string | number;
  jetton?: { address?: string; symbol?: string; decimals?: unknown };
}

/** "(0,8000000000000000,94053862)" → 94053862 */
export function tonapiBlockSeqno(block: string | undefined): number | null {
  if (!block) return null;
  const m = /,(\d+)\)$/.exec(block);
  return m ? Number.parseInt(m[1], 10) : null;
}

export function mapTonapiTx(tx: TonapiTx, address: string): SourceItem | null {
  const hash = asString(tx.hash);
  if (!hash) return null;
  const time = timeFrom(tx.utime);
  const status = tx.aborted === true || tx.success === false ? "failed" : "confirmed";
  const fees = toBigInt(tx.total_fees ?? 0);
  const inMsg = tx.in_msg ?? null;
  const inValue = toBigInt(inMsg?.value ?? 0);
  const outMsgs = tx.out_msgs ?? [];
  const outValue = outMsgs.reduce((s, m) => s + toBigInt(m.value ?? 0), 0n);
  const block = tonapiBlockSeqno(tx.block);
  const asset = { ...TON_NATIVE_ASSET };
  const self = tonAddr(address) ?? address;

  let item: HistoryItem;
  if (outValue > 0n) {
    const first = outMsgs.find((m) => toBigInt(m.value ?? 0) > 0n) ?? outMsgs[0];
    const dest = first?.destination?.address;
    item = {
      hash,
      timestamp: time?.iso ?? null,
      block,
      kind: isPlainOpcode(first?.op_code) ? "transfer" : "contract_call",
      direction: tonEquals(dest, address) ? "self" : "out",
      status,
      from: self,
      to: tonAddr(dest),
      asset,
      amount: amountOf(outValue, 9),
      fee: feeOf(fees, 9, "TON"),
    };
  } else if (inValue > 0n && inMsg?.source?.address) {
    item = {
      hash,
      timestamp: time?.iso ?? null,
      block,
      kind: isPlainOpcode(inMsg.op_code) ? "transfer" : "other",
      direction: tonEquals(inMsg.source.address, address) ? "self" : "in",
      status,
      from: tonAddr(inMsg.source.address),
      to: self,
      asset,
      amount: amountOf(inValue, 9),
      fee: null,
    };
  } else {
    const src = inMsg?.source?.address;
    item = {
      hash,
      timestamp: time?.iso ?? null,
      block,
      kind: "other",
      direction: src ? "in" : "out",
      status,
      from: tonAddr(src),
      to: self,
      asset,
      amount: amountOf(0n, 9),
      fee: src ? null : feeOf(fees, 9, "TON"),
    };
  }
  return { ts: time?.ts ?? 0, item };
}

export function mapTonapiJettonOp(row: TonapiJettonOp, address: string): SourceItem | null {
  const hash = asString(row.transaction_hash);
  const master = asString(row.jetton?.address);
  if (!hash || !master) return null;
  const time = timeFrom(row.utime);
  const src = row.source?.address;
  const dst = row.destination?.address;
  const fromSelf = tonEquals(src, address);
  const toSelf = tonEquals(dst, address);
  const symbol = sanitizeSymbol(row.jetton?.symbol, "JETTON");
  const decimals = clampDecimals(row.jetton?.decimals, 9);
  const item: HistoryItem = {
    hash,
    timestamp: time?.iso ?? null,
    block: null,
    kind: "token_transfer",
    direction: fromSelf && toSelf ? "self" : fromSelf ? "out" : "in",
    status: "confirmed",
    from: tonAddr(src),
    to: tonAddr(dst),
    asset: tokenAsset(symbol, "JETTON", tonAddr(master) ?? master, decimals),
    amount: amountOf(toBigInt(row.amount), decimals),
    fee: null,
  };
  return { ts: time?.ts ?? 0, item };
}

/** Cursor is the `lt` of the last row; tonapi's `before_lt` is exclusive. */
function beforeLt(cursor: string | null): string {
  if (cursor === null) return "";
  if (!/^\d+$/.test(cursor)) throw new Error("Invalid cursor for tonapi source.");
  return `&before_lt=${cursor}`;
}

function nextFrom(rows: Array<{ lt?: number | string }>, pageSize: number): string | null {
  if (rows.length < pageSize) return null;
  const last = rows[rows.length - 1]?.lt;
  return last === undefined ? null : String(last);
}

function apiKey(): string | undefined {
  const key = process.env.IW_TONAPI_KEY?.trim();
  return key && key.length > 0 ? key : undefined;
}

function headers(): Record<string, string> | undefined {
  const key = apiKey();
  return key ? { Authorization: `Bearer ${key}` } : undefined;
}

const KEYLESS_GAP_MS = 1100;
const RATE_LIMIT_WAIT_MS = 2500;
const RATE_LIMIT_ATTEMPTS = 2;

function paced<T>(fn: () => Promise<T>, ctx: SourceContext): Promise<T> {
  const call = () => (apiKey() ? fn() : pacedGate("tonapi", KEYLESS_GAP_MS, fn));
  return retryRateLimited(call, {
    waitMs: RATE_LIMIT_WAIT_MS,
    attempts: RATE_LIMIT_ATTEMPTS,
    onRetry: (attempt) =>
      logInfo("history.tonapi.rate_limited", {
        correlationId: ctx.correlationId,
        attempt,
        waitMs: RATE_LIMIT_WAIT_MS,
      }),
  });
}

export function tonapiProvider(base: string, address: string): HistoryProvider {
  const acct = encodeURIComponent(address);
  const native: HistorySource = {
    name: "native",
    async fetchPage(cursor: string | null, pageSize: number, ctx: SourceContext): Promise<SourcePage> {
      const url =
        `${base}/blockchain/accounts/${acct}/transactions?limit=${pageSize}&sort_order=desc` +
        beforeLt(cursor);
      const res = await paced(
        () =>
          httpJson<{ transactions?: TonapiTx[] }>(
            url,
            { method: "GET", headers: headers() },
            { ...ctx.http, label: "history.tonapi.transactions" },
          ),
        ctx,
      );
      const rows = Array.isArray(res?.transactions) ? res.transactions : null;
      if (!rows) throw new Error("tonapi transactions: unexpected response");
      const items = rows.map((tx) => mapTonapiTx(tx, address)).filter((x): x is SourceItem => x !== null);
      return { items, next: nextFrom(rows, pageSize) };
    },
  };
  const jettons: HistorySource = {
    name: "jetton",
    async fetchPage(cursor: string | null, pageSize: number, ctx: SourceContext): Promise<SourcePage> {
      const url = `${base}/accounts/${acct}/jettons/history?limit=${pageSize}` + beforeLt(cursor);
      const res = await paced(
        () =>
          httpJson<{ operations?: TonapiJettonOp[]; next_from?: number | string }>(
            url,
            { method: "GET", headers: headers() },
            { ...ctx.http, label: "history.tonapi.jettons" },
          ),
        ctx,
      );
      const rows = Array.isArray(res?.operations) ? res.operations : null;
      if (!rows) throw new Error("tonapi jettons/history: unexpected response");
      const items = rows
        .map((row) => mapTonapiJettonOp(row, address))
        .filter((x): x is SourceItem => x !== null);
      return { items, next: nextFrom(rows, pageSize) };
    },
  };
  return { label: "tonapi", sources: [native, jettons] };
}
