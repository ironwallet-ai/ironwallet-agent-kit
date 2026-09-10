import assert from "node:assert/strict";
import { test } from "node:test";
import { SWAP_ORDER_NOT_FOUND, swapOrderNotFoundMessage } from "./swap.js";

test("10999 is the SWP 'order not found' code", () => {
  assert.equal(SWAP_ORDER_NOT_FOUND, 10999);
});

test("order-not-found message names the id and steers away from re-executing", () => {
  const msg = swapOrderNotFoundMessage("33b82e84d25642d7aa0e3bf8256d7f74");
  assert.match(msg, /33b82e84d25642d7aa0e3bf8256d7f74/);
  assert.match(msg, /estimate_swap is a quote/);
  assert.match(msg, /Only execute_swap creates an order/);
  assert.match(msg, /get_balance \/ get_transaction_history/);
  assert.doesNotMatch(msg, /10999/, "raw code is not what the agent should see");
});
