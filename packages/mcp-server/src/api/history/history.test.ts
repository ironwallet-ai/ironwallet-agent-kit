import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeCursor, encodeCursor, mergeSources } from "./merge.js";
import {
  clampDecimals,
  sanitizeSymbol,
  symbolWarning,
  timeFrom,
  toBigInt,
  tokenAsset,
} from "./normalize.js";
import { collapseCarrierCalls } from "./index.js";
import { mapNativeTx, mapTokenTx, unwrapEtherscanResult } from "./providers/etherscan.js";
import { mapNodeRealTransfer } from "./providers/nodereal.js";
import { mapTronScanTrc20, mapTronScanTx } from "./providers/tronscan.js";
import { mapTronGridTrc20, mapTronGridTx, tronHexToBase58 } from "./providers/trongrid.js";
import { mapEsploraTx, utxoSummary } from "./providers/esplora.js";
import { mapBlockCypherTx } from "./providers/blockcypher.js";
import { mapSolanaTx } from "./providers/solana.js";
import { mapTonJettonTransfer, mapTonTx, toncenterV3 } from "./providers/toncenter.js";
import { mapTonapiJettonOp, mapTonapiTx, tonapiBlockSeqno } from "./providers/tonapi.js";
import { isRateLimited, retryRateLimited } from "./pace.js";
import { mapXrpEntry } from "./providers/xrp.js";
import type { HistoryItem, HistorySource, SourceContext, SourceItem } from "./types.js";

const CTX: SourceContext = {
  correlationId: "test",
  http: { correlationId: "test", timeoutMs: 1000, retries: 0 },
};

function item(hash: string, ts: number, kind: HistoryItem["kind"] = "transfer"): SourceItem {
  return {
    ts,
    item: {
      hash,
      timestamp: new Date(ts).toISOString(),
      block: null,
      kind,
      direction: "in",
      status: "confirmed",
      from: null,
      to: null,
      asset: { symbol: "X", contractAddress: null, decimals: 0 },
      amount: { raw: "1", formatted: "1" },
      fee: null,
    },
  };
}

/** Offset-paged in-memory source; records every page request. */
function pagedSource(name: string, items: SourceItem[], calls: string[] = []): HistorySource {
  return {
    name,
    async fetchPage(cursor, pageSize) {
      const offset = cursor === null ? 0 : Number(cursor);
      calls.push(`${name}:${offset}`);
      const slice = items.slice(offset, offset + pageSize);
      const end = offset + slice.length;
      return { items: slice, next: end >= items.length ? null : String(end) };
    },
  };
}

test("cursor round-trips and rejects garbage", () => {
  const state = { v: 1, p: "etherscan", s: { native: { cursor: "2", skip: 3, done: false } } };
  assert.deepEqual(decodeCursor(encodeCursor(state)), state);
  assert.throws(() => decodeCursor("not-a-cursor"), /Invalid cursor/);
  assert.throws(
    () => decodeCursor(Buffer.from(JSON.stringify({ v: 9, p: "x", s: {} })).toString("base64url")),
    /unsupported format/,
  );
  assert.throws(
    () => decodeCursor(Buffer.from(JSON.stringify({ v: 1, p: "x", s: { a: { cursor: 1 } } })).toString("base64url")),
    /bad state/,
  );
});

test("merge interleaves two sources newest-first and pages without gaps or duplicates", async () => {
  const a = [item("a5", 500), item("a4", 400), item("a2", 200), item("a1", 100)];
  const b = [item("b6", 600), item("b3", 300), item("b0", 50)];
  const sources = [pagedSource("a", a), pagedSource("b", b)];

  const seen: string[] = [];
  let state: Parameters<typeof mergeSources>[2];
  let hasMore = true;
  let pages = 0;
  while (hasMore) {
    const r = await mergeSources(sources, 3, state, CTX);
    seen.push(...r.items.map((i) => i.hash));
    state = { s: r.state, b: r.boundary };
    hasMore = r.hasMore;
    pages++;
    assert.ok(pages < 10, "pagination must terminate");
  }
  assert.deepEqual(seen, ["b6", "a5", "a4", "b3", "a2", "a1", "b0"]);
});

test("merge keeps rows of one transaction together and prefers the token row on ties", async () => {
  const native = [item("h1", 900, "contract_call"), item("h0", 800, "transfer")];
  const tokens = [item("h1", 900, "token_transfer")];
  const r = await mergeSources([pagedSource("native", native), pagedSource("erc20", tokens)], 1, undefined, CTX);
  // limit 1, but both h1 rows are emitted so the tx is not split across pages
  assert.deepEqual(
    r.items.map((i) => `${i.hash}:${i.kind}`),
    ["h1:token_transfer", "h1:contract_call"],
  );
  assert.equal(r.hasMore, true);
  const r2 = await mergeSources([pagedSource("native", native), pagedSource("erc20", tokens)], 1, { s: r.state, b: r.boundary }, CTX);
  assert.deepEqual(r2.items.map((i) => i.hash), ["h0"]);
  assert.equal(r2.hasMore, false);
});

test("merge re-fetches a partially consumed page instead of inventing a mid-page cursor", async () => {
  const calls: string[] = [];
  const a = [item("a3", 300), item("a2", 200), item("a1", 100)];
  const b = [item("b9", 900), item("b8", 800), item("b7", 700)];
  const sources = [pagedSource("a", a, calls), pagedSource("b", b, calls)];
  const r1 = await mergeSources(sources, 2, undefined, CTX);
  assert.deepEqual(r1.items.map((i) => i.hash), ["b9", "b8"]);
  // "a" was loaded but untouched: its state still points at page 0 with skip 0.
  assert.deepEqual(r1.state.a, { cursor: null, skip: 0, done: false });
  // "b" page 0 was fully consumed, so its state already points at page 1.
  assert.deepEqual(r1.state.b, { cursor: "2", skip: 0, done: false });
  const r2 = await mergeSources(sources, 2, { s: r1.state, b: r1.boundary }, CTX);
  assert.deepEqual(r2.items.map((i) => i.hash), ["b7", "a3"]);
  assert.equal(r2.state.b.done, true);
});

test("merge drops drifted duplicates when a new tx lands between pages (offset paging)", async () => {
  const feed = [item("t5", 500), item("t4", 400), item("t3", 300), item("t2", 200), item("t1", 100)];
  const live: SourceItem[] = [...feed];
  // Offset-paged source reading from a mutable feed, like Blockscout page/offset.
  const src: HistorySource = {
    name: "native",
    async fetchPage(cursor, pageSize) {
      const offset = cursor === null ? 0 : Number(cursor);
      const slice = live.slice(offset, offset + pageSize);
      return { items: slice, next: offset + slice.length >= live.length ? null : String(offset + slice.length) };
    },
  };
  const r1 = await mergeSources([src], 2, undefined, CTX);
  assert.deepEqual(r1.items.map((i) => i.hash), ["t5", "t4"]);
  assert.deepEqual(r1.boundary, { ts: 400, h: ["t4"] });

  // Two new transactions arrive: every offset now points two rows earlier.
  live.unshift(item("t7", 700), item("t6", 600));
  const r2 = await mergeSources([src], 2, { s: r1.state, b: r1.boundary }, CTX);
  assert.deepEqual(r2.items.map((i) => i.hash), ["t3", "t2"], "no t5/t4 repeat, no t7/t6 leak");
  const r3 = await mergeSources([src], 2, { s: r2.state, b: r2.boundary }, CTX);
  assert.deepEqual(r3.items.map((i) => i.hash), ["t1"]);
  assert.equal(r3.hasMore, false);
});

test("boundary keeps same-timestamp rows that were not emitted yet", async () => {
  // Two different txs in the same millisecond, split across the page limit.
  const a = [item("x", 900), item("y", 900), item("z", 100)];
  const src = pagedSource("a", a);
  const r1 = await mergeSources([src], 1, undefined, CTX);
  assert.deepEqual(r1.items.map((i) => i.hash), ["x"]);
  assert.deepEqual(r1.boundary, { ts: 900, h: ["x"] });
  const r2 = await mergeSources([src], 1, { s: r1.state, b: r1.boundary }, CTX);
  assert.deepEqual(r2.items.map((i) => i.hash), ["y"]);
  const r3 = await mergeSources([src], 1, { s: r2.state, b: r2.boundary }, CTX);
  assert.deepEqual(r3.items.map((i) => i.hash), ["z"]);
});

test("cursor carries the boundary and rejects a malformed one", () => {
  const state = { v: 1, p: "etherscan", s: {}, b: { ts: 5, h: ["a"] } };
  assert.deepEqual(decodeCursor(encodeCursor(state)), state);
  assert.throws(
    () => decodeCursor(Buffer.from(JSON.stringify({ v: 1, p: "x", s: {}, b: { ts: "5", h: [] } })).toString("base64url")),
    /bad boundary/,
  );
});

test("merge reports hasMore=false only when every source is drained", async () => {
  const r = await mergeSources([pagedSource("a", [item("a1", 1)]), pagedSource("b", [])], 10, undefined, CTX);
  assert.deepEqual(r.items.map((i) => i.hash), ["a1"]);
  assert.equal(r.hasMore, false);
  assert.equal(r.state.a.done, true);
  assert.equal(r.state.b.done, true);
});

test("merge surfaces a source failure", async () => {
  const failing: HistorySource = {
    name: "boom",
    async fetchPage() {
      throw new Error("HTTP 566");
    },
  };
  await assert.rejects(mergeSources([failing], 5, undefined, CTX), /HTTP 566/);
});

test("sanitizeSymbol strips control characters, folds ₮, caps length", () => {
  assert.equal(sanitizeSymbol("USD₮", "X"), "USDT");
  assert.equal(sanitizeSymbol("A\u0000B\u200bC", "X"), "ABC");
  assert.equal(sanitizeSymbol("   ", "TOKEN"), "TOKEN");
  assert.equal(sanitizeSymbol(42, "TOKEN"), "TOKEN");
  assert.equal(sanitizeSymbol("x".repeat(100), "T").length, 24);
});

test("symbolWarning flags links, look-alikes and odd symbols, not normal tickers", () => {
  assert.equal(symbolWarning("USDT"), undefined);
  assert.equal(symbolWarning("USDT.e"), undefined);
  assert.equal(symbolWarning("WBTC"), undefined);
  assert.match(symbolWarning("ARB | t.me/s/arb_pool") ?? "", /link/);
  assert.match(symbolWarning("www.lidogift.club") ?? "", /link/);
  assert.match(symbolWarning("⊤ℰꓡ") ?? "", /non-ASCII/);
  assert.match(symbolWarning("Visit<site>") ?? "", /Unusual/);
  assert.equal(tokenAsset("TOKEN", "TOKEN", "0xabc", 18).warning, undefined);
  assert.ok(tokenAsset("Claim: t.me/x", "TOKEN", "0xabc", 18).warning);
});

test("toBigInt / timeFrom / clampDecimals accept indexer quirks", () => {
  assert.equal(toBigInt("0x0a"), 10n);
  assert.equal(toBigInt("123"), 123n);
  assert.equal(toBigInt("123.000"), 123n);
  assert.equal(toBigInt(1.9), 1n);
  assert.equal(toBigInt("garbage"), 0n);
  assert.equal(timeFrom("1785276803")?.iso, "2026-07-28T22:13:23.000Z");
  assert.equal(timeFrom(1788350091000)?.iso, new Date(1788350091000).toISOString());
  assert.equal(timeFrom(1788350091000)?.ts, 1788350091000);
  assert.equal(timeFrom("2026-08-10T20:44:57Z")?.iso, "2026-08-10T20:44:57.000Z");
  assert.equal(timeFrom(0), null);
  assert.equal(clampDecimals("7", 18), 7);
  assert.equal(clampDecimals("999", 18), 18);
  assert.equal(clampDecimals(undefined, 6), 6);
});

const ME = "0xfbE22b699e57A5978C5D3Ddcd95D15B6a5dFc301";

test("etherscan txlist: outgoing zero-value call vs incoming native transfer", () => {
  const call = mapNativeTx(
    {
      blockNumber: "25634226",
      timeStamp: "1785276743",
      hash: "0xbba9",
      from: ME.toLowerCase(),
      to: "0xa2cd3d43c775978a96bdbf12d733d5a1ed94fb18",
      value: "0",
      gasPrice: "43414962",
      gasUsed: "56026",
      isError: "0",
      txreceipt_status: "1",
      input: "0xa9059cbb",
    },
    ME,
    "ethereum",
  )!;
  assert.equal(call.item.kind, "contract_call");
  assert.equal(call.item.direction, "out");
  assert.equal(call.item.fee?.raw, String(43414962n * 56026n));
  assert.equal(call.item.asset.symbol, "ETH");

  const incoming = mapNativeTx(
    { hash: "0x1", from: "0xabc", to: ME, value: "1000000000000000000", input: "0x", timeStamp: "1", isError: "1" },
    ME,
    "polygon",
  )!;
  assert.equal(incoming.item.kind, "transfer");
  assert.equal(incoming.item.direction, "in");
  assert.equal(incoming.item.status, "failed");
  assert.equal(incoming.item.fee, null);
  assert.equal(incoming.item.amount.formatted, "1.0");
  assert.equal(incoming.item.asset.symbol, "POL");
});

test("etherscan tokentx: decimals and spam symbol warning", () => {
  const t = mapTokenTx(
    {
      hash: "0xce55",
      from: "0x1159",
      to: ME,
      value: "11587147376",
      tokenSymbol: "ARB | t.me/s/arb_pool",
      tokenDecimal: "7",
      contractAddress: "0x516d",
      timeStamp: "1788085871",
      blockNumber: "25867502",
    },
    ME,
    "ethereum",
  )!;
  assert.equal(t.item.kind, "token_transfer");
  assert.equal(t.item.amount.formatted, "1158.7147376");
  assert.equal(t.item.asset.decimals, 7);
  assert.ok(t.item.asset.warning);
  assert.equal(t.item.block, 25867502);
  assert.equal(mapTokenTx({ hash: "0x1" }, ME, "ethereum"), null);
});

test("etherscan empty result envelope is not an error", () => {
  assert.deepEqual(
    unwrapEtherscanResult({ status: "0", message: "No token transfers found", result: [] }, "x"),
    [],
  );
  assert.throws(() => unwrapEtherscanResult({ status: "0", message: "NOTOK", result: "Max rate limit" }, "x"), /Max rate/);
});

test("nodereal rows: hex values, seconds timestamps, BEP-20 decimals", () => {
  const t = mapNodeRealTransfer(
    {
      category: "20",
      blockNum: "0x709b83d",
      from: "0x1159",
      to: ME.toLowerCase(),
      value: "0x58a3c545191b895c09",
      asset: "XCN",
      hash: "0x43f0",
      contractAddress: "0x7324",
      decimal: "18",
      blockTimeStamp: 1787695850,
      receiptsStatus: 1,
    },
    ME,
    "bsc",
  )!;
  assert.equal(t.item.kind, "token_transfer");
  assert.equal(t.item.block, 118077501);
  assert.equal(t.item.timestamp, "2026-08-25T22:10:50.000Z");
  assert.equal(t.item.amount.formatted, "1635.114392859173280777");
  const n = mapNodeRealTransfer(
    { category: "external", from: ME, to: "0x55d3", value: "0x0", asset: "BNB", hash: "0x1041", input: "0xa9059cbb", gasPrice: 100000000, gasUsed: 34515, receiptsStatus: 0, blockTimeStamp: 1 },
    ME,
    "bsc",
  )!;
  assert.equal(n.item.kind, "contract_call");
  assert.equal(n.item.status, "failed");
  assert.equal(n.item.fee?.raw, String(100000000n * 34515n));
});

const TME = "TNXoiAJ3dct8Fjg4M9fkLFh9S2v9TXc32G";

test("tronscan: TRX transfer, TRC-20 transfer, unsolidified is still confirmed", () => {
  const trx = mapTronScanTx(
    { hash: "h1", block: 85892829, timestamp: 1788350091000, ownerAddress: TME, toAddress: "TB6q", contractType: 1, confirmed: false, contractRet: "SUCCESS", amount: "1500000", cost: { fee: 1100000 } },
    TME,
  )!;
  assert.equal(trx.item.kind, "transfer");
  assert.equal(trx.item.direction, "out");
  assert.equal(trx.item.status, "confirmed");
  assert.equal(trx.item.amount.formatted, "1.5");
  assert.equal(trx.item.fee?.formatted, "1.1");
  const reverted = mapTronScanTx({ hash: "h2", block: 1, timestamp: 1, ownerAddress: "TX", toAddress: TME, contractType: 31, contractRet: "REVERT" }, TME)!;
  assert.equal(reverted.item.status, "failed");
  assert.equal(reverted.item.kind, "contract_call");
  const trc20 = mapTronScanTrc20(
    { transaction_id: "t1", block: 85750351, block_ts: 1787922534000, from_address: "TNXo", to_address: TME, contract_address: "TR7N", quant: "17500000", confirmed: true, finalResult: "SUCCESS", tokenInfo: { tokenAbbr: "USDT", tokenDecimal: 6 } },
    TME,
  )!;
  assert.equal(trc20.item.amount.formatted, "17.5");
  assert.equal(trc20.item.asset.symbol, "USDT");
  assert.equal(trc20.item.asset.contractAddress, "TR7N");
});

test("trongrid: hex addresses become base58, approvals are skipped", () => {
  assert.equal(tronHexToBase58("4184716914c0fdf7110a44030d04d0c4923504d9cc"), "TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9");
  assert.equal(tronHexToBase58("TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9"), "TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9");
  const tx = mapTronGridTx(
    {
      txID: "a778",
      blockNumber: 85892547,
      block_timestamp: 1788349245000,
      ret: [{ contractRet: "SUCCESS", fee: 0 }],
      raw_data: {
        contract: [
          {
            type: "TransferContract",
            parameter: { value: { amount: 2000000, owner_address: "414f76e71f3d94f9ff0f114747896e6363eaa220e0", to_address: "4184716914c0fdf7110a44030d04d0c4923504d9cc" } },
          },
        ],
      },
    },
    "TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9",
  )!;
  assert.equal(tx.item.direction, "in");
  assert.equal(tx.item.amount.formatted, "2.0");
  assert.equal(tx.item.from, tronHexToBase58("414f76e71f3d94f9ff0f114747896e6363eaa220e0"));
  assert.match(tx.item.from ?? "", /^T[1-9A-HJ-NP-Za-km-z]{33}$/);
  assert.equal(mapTronGridTrc20({ transaction_id: "x", type: "Approval", token_info: { address: "T" } }, TME), null);
  const t = mapTronGridTrc20(
    { transaction_id: "7623", block_timestamp: 1787922534000, from: "TNXo", to: TME, type: "Transfer", value: "17500000", token_info: { symbol: "USDT", address: "TR7N", decimals: 6 } },
    TME,
  )!;
  assert.equal(t.item.amount.formatted, "17.5");
});

test("utxo summary: in, out with change, self", () => {
  const A = "1A1z";
  const inbound = utxoSummary([{ address: "bc1q", value: 1000n }], [{ address: A, value: 546n }, { address: "bc1q", value: 400n }], A);
  assert.equal(inbound.direction, "in");
  assert.equal(inbound.amount.raw, "546");
  assert.equal(inbound.from, "bc1q");
  const outbound = utxoSummary([{ address: A, value: 10000n }], [{ address: "bc1x", value: 7000n }, { address: A, value: 2500n }], A);
  assert.equal(outbound.direction, "out");
  assert.equal(outbound.amount.raw, "7000");
  assert.equal(outbound.to, "bc1x");
  const self = utxoSummary([{ address: A, value: 10000n }], [{ address: A, value: 9500n }], A);
  assert.equal(self.direction, "self");
});

test("esplora and blockcypher rows: confirmed vs pending", () => {
  const A = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
  const pending = mapEsploraTx(
    { txid: "p", fee: 100, status: { confirmed: false }, vin: [{ prevout: { scriptpubkey_address: "bc1q", value: 1000 } }], vout: [{ scriptpubkey_address: A, value: 900 }] },
    A,
    "bitcoin",
  )!;
  assert.equal(pending.item.status, "pending");
  assert.equal(pending.item.timestamp, null);
  assert.ok(pending.ts > 1_700_000_000_000);
  const confirmed = mapEsploraTx(
    { txid: "c", fee: 538, status: { confirmed: true, block_height: 965158, block_time: 1788345901 }, vin: [{ prevout: { scriptpubkey_address: "bc1q", value: 42421 } }], vout: [{ scriptpubkey_address: A, value: 546 }] },
    A,
    "bitcoin",
  )!;
  assert.equal(confirmed.item.block, 965158);
  assert.equal(confirmed.item.amount.formatted, "0.00000546");
  assert.equal(confirmed.item.asset.symbol, "BTC");
  const D = "DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L";
  const doge = mapBlockCypherTx(
    { hash: "d", block_height: 6326671, confirmed: "2026-08-10T20:44:57Z", fees: 9674688, inputs: [{ addresses: ["D7VP"], output_value: 1777219008 }], outputs: [{ addresses: [D], value: 1767544320 }] },
    D,
    "doge",
  )!;
  assert.equal(doge.item.amount.formatted, "17.6754432");
  assert.equal(doge.item.timestamp, "2026-08-10T20:44:57.000Z");
  assert.equal(doge.item.from, "D7VP");
});

test("solana: SOL and SPL deltas from meta, fee only for the payer", () => {
  const S = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";
  const items = mapSolanaTx(
    "sig1",
    {
      slot: 443692095,
      blockTime: 1788350886,
      meta: {
        err: null,
        fee: 7000,
        preBalances: [2000000000, 500],
        postBalances: [1000000000 - 7000, 1000000500],
        preTokenBalances: [{ accountIndex: 2, mint: "MINT", owner: S, uiTokenAmount: { amount: "5000", decimals: 2 } }],
        postTokenBalances: [
          { accountIndex: 2, mint: "MINT", owner: S, uiTokenAmount: { amount: "1296", decimals: 2 } },
          { accountIndex: 3, mint: "MINT", owner: "OTHER", uiTokenAmount: { amount: "3704", decimals: 2 } },
        ],
      },
      transaction: { message: { accountKeys: [{ pubkey: S, signer: true }, { pubkey: "7txy" }, "TA1", "TA2"] } },
    },
    { signature: "sig1" },
    S,
  );
  assert.equal(items.length, 2);
  const [spl, sol] = items;
  assert.equal(spl.item.kind, "token_transfer");
  assert.equal(spl.item.amount.formatted, "37.04");
  assert.equal(spl.item.to, "OTHER");
  assert.equal(spl.item.fee?.raw, "7000");
  assert.equal(sol.item.kind, "transfer");
  assert.equal(sol.item.direction, "out");
  assert.equal(sol.item.amount.formatted, "1.0");
  assert.equal(sol.item.to, "7txy");
  assert.equal(sol.item.fee, null);
  const missing = mapSolanaTx("sig2", null, { signature: "sig2", slot: 1, blockTime: 1788350886, err: { x: 1 } }, S);
  assert.equal(missing[0].item.kind, "other");
  assert.equal(missing[0].item.status, "failed");
});

test("toncenter: incoming TON, outgoing jetton gas call, jetton transfer with metadata", () => {
  const RAW = "0:B113A994B5024A16719F69139328EB759596C38A25F59028B146FECDC3621DFE";
  const FRIENDLY = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
  assert.equal(toncenterV3("https://toncenter.com/api/v2"), "https://toncenter.com/api/v3");
  assert.equal(toncenterV3("https://x/api/v3/"), "https://x/api/v3");
  assert.equal(toncenterV3("https://x/other"), null);
  const incoming = mapTonTx(
    { hash: "h", now: 1788343492, mc_block_seqno: 90100471, total_fees: "449427", description: { aborted: false }, in_msg: { source: "0:69C4", destination: RAW, value: "12591002", opcode: "0x00000000" }, out_msgs: [] },
    FRIENDLY,
    undefined,
  )!;
  assert.equal(incoming.item.direction, "in");
  assert.equal(incoming.item.kind, "transfer");
  assert.equal(incoming.item.amount.formatted, "0.012591002");
  assert.equal(incoming.item.fee, null);
  const outgoing = mapTonTx(
    { hash: "o", now: 1788343492, total_fees: "449427", in_msg: { source: null, destination: RAW, value: "0" }, out_msgs: [{ destination: "0:69C4", value: "50000000", opcode: "0x0f8a7ea5" }] },
    FRIENDLY,
    undefined,
  )!;
  assert.equal(outgoing.item.direction, "out");
  assert.equal(outgoing.item.kind, "contract_call");
  assert.equal(outgoing.item.fee?.raw, "449427");
  const jetton = mapTonJettonTransfer(
    { transaction_hash: "j", transaction_now: 1788348301, source: "0:F1F3", destination: RAW, amount: "5000000", jetton_master: "0:B113" },
    FRIENDLY,
    { "0:B113": { user_friendly: "EQMaster" } },
    { "0:B113": { token_info: [{ type: "jetton_masters", symbol: "USD₮", extra: { decimals: "6" } }] } },
  )!;
  assert.equal(jetton.item.direction, "in");
  assert.equal(jetton.item.asset.symbol, "USDT");
  assert.equal(jetton.item.asset.contractAddress, "EQMaster");
  assert.equal(jetton.item.amount.formatted, "5.0");
});

test("tonapi: incoming TON, outgoing contract call, jetton transfer, block seqno", () => {
  const RAW = "0:B113A994B5024A16719F69139328EB759596C38A25F59028B146FECDC3621DFE";
  const FRIENDLY = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
  assert.equal(tonapiBlockSeqno("(0,8000000000000000,94053862)"), 94053862);
  assert.equal(tonapiBlockSeqno(undefined), null);
  assert.equal(tonapiBlockSeqno("garbage"), null);

  const incoming = mapTonapiTx(
    {
      hash: "173dfd",
      lt: 100377360000010,
      utime: 1788169613,
      success: true,
      aborted: false,
      total_fees: 7846,
      block: "(0,8000000000000000,94053862)",
      in_msg: { value: 30000000, source: { address: "0:EE1759" }, destination: { address: RAW }, op_code: "0x00000000" },
      out_msgs: [],
    },
    FRIENDLY,
  )!;
  assert.equal(incoming.item.direction, "in");
  assert.equal(incoming.item.kind, "transfer");
  assert.equal(incoming.item.amount.formatted, "0.03");
  assert.equal(incoming.item.block, 94053862);
  assert.equal(incoming.item.fee, null);
  assert.equal(incoming.item.to, "UQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_p0p", "raw 0:HEX → non-bounceable");
  assert.equal(incoming.item.timestamp, "2026-08-31T09:46:53.000Z");

  const outgoing = mapTonapiTx(
    {
      hash: "o",
      utime: 1788169613,
      success: true,
      total_fees: "449427",
      in_msg: { value: 0, source: null },
      out_msgs: [{ value: 50000000, destination: { address: "0:69C4" }, op_code: "0x0f8a7ea5" }],
    },
    FRIENDLY,
  )!;
  assert.equal(outgoing.item.direction, "out");
  assert.equal(outgoing.item.kind, "contract_call");
  assert.equal(outgoing.item.amount.formatted, "0.05");
  assert.equal(outgoing.item.fee?.raw, "449427");

  const failed = mapTonapiTx({ hash: "f", utime: 1, success: false, in_msg: { value: 1, source: { address: "0:69C4" } } }, FRIENDLY)!;
  assert.equal(failed.item.status, "failed");
  assert.equal(mapTonapiTx({ utime: 1 }, FRIENDLY), null);

  const jetton = mapTonapiJettonOp(
    {
      operation: "transfer",
      utime: 1787015716,
      lt: 97489872000004,
      transaction_hash: "d11674",
      source: { address: "0:1D0FD9" },
      destination: { address: RAW },
      amount: "10000000000000",
      jetton: { address: "0:E7B613", symbol: "USD₮", decimals: 6 },
    },
    FRIENDLY,
  )!;
  assert.equal(jetton.item.direction, "in");
  assert.equal(jetton.item.kind, "token_transfer");
  assert.equal(jetton.item.asset.symbol, "USDT");
  assert.equal(jetton.item.asset.decimals, 6);
  assert.equal(jetton.item.amount.formatted, "10000000.0");
  assert.equal(mapTonapiJettonOp({ transaction_hash: "x" }, FRIENDLY), null, "no jetton master → dropped");
});

test("retryRateLimited: waits out a 429 and retries, passes other errors through", async () => {
  const rate = Object.assign(new Error("HTTP 429"), { status: 429 });
  assert.equal(isRateLimited(rate), true);
  assert.equal(isRateLimited(new Error("boom")), false);

  let calls = 0;
  const retries: number[] = [];
  const value = await retryRateLimited(
    async () => {
      calls++;
      if (calls <= 2) throw rate;
      return "ok";
    },
    { waitMs: 1, attempts: 2, onRetry: (n) => retries.push(n) },
  );
  assert.equal(value, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(retries, [1, 2]);

  calls = 0;
  await assert.rejects(
    retryRateLimited(
      async () => {
        calls++;
        throw rate;
      },
      { waitMs: 1, attempts: 2 },
    ),
    /429/,
  );
  assert.equal(calls, 3, "attempts is the number of retries after the first call");

  calls = 0;
  await assert.rejects(
    retryRateLimited(
      async () => {
        calls++;
        throw Object.assign(new Error("HTTP 500"), { status: 500 });
      },
      { waitMs: 1, attempts: 2 },
    ),
    /500/,
  );
  assert.equal(calls, 1, "non-429 errors are not retried here");
});

test("xrp: drops payment, IOU payment, ripple epoch, non-payment", () => {
  const R = "rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh";
  const out = mapXrpEntry(
    { validated: true, meta: { TransactionResult: "tesSUCCESS", delivered_amount: "1432458145" }, tx: { TransactionType: "Payment", Account: R, Destination: "rDAE", Amount: "1432458145", Fee: "1000", date: 841395500, hash: "B906", ledger_index: 106641232 } },
    R,
  )!;
  assert.equal(out.item.direction, "out");
  assert.equal(out.item.amount.formatted, "1432.458145");
  assert.equal(out.item.fee?.formatted, "0.001");
  assert.equal(out.item.timestamp, "2026-08-30T08:58:20.000Z");
  const iou = mapXrpEntry(
    { validated: true, meta: { TransactionResult: "tesSUCCESS", delivered_amount: { currency: "USD", issuer: "rIss", value: "12.5" } }, tx_json: { TransactionType: "Payment", Account: "rOther", Destination: R, Fee: "12" }, hash: "H2", close_time_iso: "2026-08-30T08:58:20Z" },
    R,
  )!;
  assert.equal(iou.item.kind, "token_transfer");
  assert.equal(iou.item.direction, "in");
  assert.equal(iou.item.asset.symbol, "USD");
  assert.equal(iou.item.asset.contractAddress, "rIss");
  assert.equal(iou.item.amount.formatted, "12.5");
  assert.equal(iou.item.fee, null);
  const other = mapXrpEntry({ validated: true, meta: { TransactionResult: "tecPATH_DRY" }, tx: { TransactionType: "OfferCreate", Account: R, Fee: "10", hash: "H3", date: 1 } }, R)!;
  assert.equal(other.item.kind, "other");
  assert.equal(other.item.status, "failed");
});

test("collapseCarrierCalls folds the zero-value call into its token row", () => {
  const carrier = item("h", 1, "contract_call").item;
  carrier.amount = { raw: "0", formatted: "0.0" };
  carrier.fee = { raw: "5", formatted: "5", symbol: "ETH" };
  carrier.direction = "out";
  carrier.block = 10;
  const token = item("h", 1, "token_transfer").item;
  token.direction = "out";
  const unrelated = item("g", 0, "contract_call").item;
  unrelated.amount = { raw: "0", formatted: "0.0" };
  const out = collapseCarrierCalls([token, carrier, unrelated]);
  assert.deepEqual(out.map((i) => `${i.hash}:${i.kind}`), ["h:token_transfer", "g:contract_call"]);
  assert.equal(out[0].fee?.raw, "5");
  assert.equal(out[0].block, 10);
});
