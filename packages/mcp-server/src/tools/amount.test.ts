import assert from "node:assert/strict";
import { test } from "node:test";
import { isZeroAmount, requirePositiveAmount } from "./helpers.js";

test("requirePositiveAmount accepts positive decimals and trims", () => {
  assert.equal(requirePositiveAmount("1"), "1");
  assert.equal(requirePositiveAmount("0.5"), "0.5");
  assert.equal(requirePositiveAmount(" 12.000001 "), "12.000001");
  assert.equal(requirePositiveAmount("0.000000000000000001"), "0.000000000000000001");
});

test("requirePositiveAmount rejects zero", () => {
  for (const zero of ["0", "0.0", "00", "0.000"]) {
    assert.throws(() => requirePositiveAmount(zero), /greater than zero/);
  }
});

test("requirePositiveAmount rejects negative and malformed input", () => {
  for (const bad of ["-1", "-0.5", "", "   ", "abc", "1e18", "1,5", ".5", "5.", "+1", "0x10", "NaN"]) {
    assert.throws(() => requirePositiveAmount(bad), /positive decimal string/, bad);
  }
});

test("isZeroAmount recognises zero placeholders only", () => {
  for (const zero of ["0", "0.0", " 00 ", "0.000"]) assert.equal(isZeroAmount(zero), true, zero);
  for (const other of ["1", "0.1", "-0", "", "abc", "0."]) assert.equal(isZeroAmount(other), false, other);
});

test("requirePositiveAmount names the field in the message", () => {
  assert.throws(() => requirePositiveAmount("0", "sellAmount"), /^Error: sellAmount /);
});
