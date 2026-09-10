import assert from "node:assert/strict";
import { test } from "node:test";
import {
  depositCaption,
  depositLabel,
  depositPayload,
  depositQrUrl,
  renderDepositQrPng,
  selectDepositTargets,
  uniqueDepositTargets,
  walletOwnsDeposit,
} from "./deposit-qr.js";

test("depositQrUrl points at the manager PNG route", () => {
  assert.equal(
    depositQrUrl(
      "http://127.0.0.1:9/aabb",
      "ethereum",
      "0xAbc",
    ),
    "http://127.0.0.1:9/aabb/qr?network=ethereum&address=0xAbc",
  );
});

test("depositPayload uses chain URIs", () => {
  assert.equal(depositPayload("ethereum", "0xAbc"), "ethereum:0xAbc");
  assert.equal(depositPayload("bsc", "0xAbc"), "ethereum:0xAbc");
  assert.equal(depositPayload("bitcoin", "bc1qtest"), "bitcoin:bc1qtest");
  assert.equal(depositPayload("ton", "EQabc"), "ton://transfer/EQabc");
});

test("selectDepositTargets filters by network", () => {
  const addresses = { ethereum: "0xaaa", tron: "Txyz" };
  assert.deepEqual(selectDepositTargets(addresses, "tron"), [
    { network: "tron", address: "Txyz" },
  ]);
  assert.equal(selectDepositTargets(addresses).length, 2);
  assert.equal(walletOwnsDeposit(addresses, "ethereum", "0xaaa"), true);
  assert.equal(walletOwnsDeposit(addresses, "ethereum", "0xbbb"), false);
});

test("uniqueDepositTargets collapses shared EVM address", () => {
  const rows = uniqueDepositTargets({
    ethereum: "0xaaa",
    bsc: "0xaaa",
    tron: "Txyz",
    bitcoin: "bc1q",
  });
  assert.deepEqual(
    rows.map((r) => r.network),
    ["ethereum", "tron", "bitcoin"],
  );
  assert.deepEqual(rows[0].sharedWith, ["bsc"]);
  assert.equal(rows[1].sharedWith, undefined);
});

test("captions name the network and list the chains sharing an address", () => {
  assert.deepEqual(depositCaption({ network: "bitcoin", address: "bc1q" }), {
    title: "Bitcoin",
  });
  assert.equal(depositLabel({ network: "doge", address: "D1" }), "Dogecoin");

  const evm = uniqueDepositTargets({
    ethereum: "0xaaa",
    bsc: "0xaaa",
    polygon: "0xaaa",
    base: "0xaaa",
    arbitrum: "0xaaa",
    optimism: "0xaaa",
    avalanche: "0xaaa",
  })[0];
  assert.deepEqual(depositCaption(evm), {
    title: "Ethereum",
    subtitle: "Same address on BSC, Polygon, Base, Arbitrum, Optimism, Avalanche",
  });
  assert.equal(
    depositLabel(evm),
    "Ethereum (same address on BSC, Polygon, Base, Arbitrum, Optimism, Avalanche)",
  );
  // An explicit network request is not collapsed, so no "same address" note.
  assert.deepEqual(
    depositCaption(selectDepositTargets({ ethereum: "0xaaa", bsc: "0xaaa" }, "bsc")[0]),
    { title: "BSC" },
  );
});

test("renderDepositQrPng writes a PNG with the IW mark and grows for the caption", async () => {
  const address = "0x1234567890abcdef1234567890abcdef12345678";
  const payload = `ethereum:${address}`;
  const plain = await renderDepositQrPng(address, payload, { title: "Ethereum" });
  assert.equal(plain.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.ok(plain.length > 800);

  const heightOf = (png: Buffer) => png.readUInt32BE(20);
  const withNote = await renderDepositQrPng(address, payload, {
    title: "Ethereum",
    subtitle: "Same address on BSC, Polygon, Base, Arbitrum, Optimism, Avalanche",
  });
  assert.ok(heightOf(withNote) > heightOf(plain), "subtitle adds header lines");
});
