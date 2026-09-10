import assert from "node:assert/strict";
import { test } from "node:test";
import { diffWalletPolicy } from "./policy.js";

const ADDR = "0xbf456F241E2B9664925ebdB86Fa2A816594542C1";
const ADDR2 = "0x52908400098527886E0F7030069857D2E4169EE7";

test("omitting allowedRecipients on a rewrite is reported as a removed restriction", () => {
  const diff = diffWalletPolicy(
    { enabled: true, maxPerTxUsd: "20", allowedRecipients: [ADDR] },
    { enabled: true, maxPerTxUsd: "20" },
  );
  assert.equal(diff.unchanged, false);
  assert.deepEqual(diff.removedRestrictions, ["allowedRecipients"]);
  assert.deepEqual(diff.changes, {
    allowedRecipients: { from: [ADDR], to: null },
  });
  assert.equal(diff.warnings.length, 1);
  assert.match(diff.warnings[0], /allowedRecipients was removed \(was 1 address\)/);
  assert.match(diff.warnings[0], /full replace/);
});

test("identical rewrite is unchanged with no warnings", () => {
  const policy = { enabled: true, maxPerTxUsd: "20", allowedRecipients: [ADDR] };
  const diff = diffWalletPolicy(policy, { ...policy, allowedRecipients: [ADDR] });
  assert.equal(diff.unchanged, true);
  assert.deepEqual(diff.changes, {});
  assert.deepEqual(diff.removedRestrictions, []);
  assert.deepEqual(diff.warnings, []);
});

test("first enable from no policy adds restrictions without warnings", () => {
  const diff = diffWalletPolicy(undefined, {
    enabled: true,
    maxPerTxUsd: "20",
    allowedRecipients: [ADDR],
  });
  assert.equal(diff.unchanged, false);
  assert.deepEqual(diff.changes.enabled, { from: false, to: true });
  assert.deepEqual(diff.changes.maxPerTxUsd, { from: null, to: "20" });
  assert.deepEqual(diff.changes.allowedRecipients, { from: null, to: [ADDR] });
  assert.deepEqual(diff.removedRestrictions, []);
  assert.deepEqual(diff.warnings, []);
});

test("tightening maxPerTxUsd is a change but not a warning; raising it warns", () => {
  const lower = diffWalletPolicy(
    { enabled: true, maxPerTxUsd: "50" },
    { enabled: true, maxPerTxUsd: "20" },
  );
  assert.deepEqual(lower.changes, { maxPerTxUsd: { from: "50", to: "20" } });
  assert.deepEqual(lower.warnings, []);

  const higher = diffWalletPolicy(
    { enabled: true, maxPerTxUsd: "20" },
    { enabled: true, maxPerTxUsd: "50" },
  );
  assert.deepEqual(higher.removedRestrictions, []);
  assert.match(higher.warnings[0], /raised from 20 to 50 USD/);
});

test("dropping readOnly and maxPerTxUsd together lists both", () => {
  const diff = diffWalletPolicy(
    { enabled: true, readOnly: true, maxPerTxUsd: "20", allowedRecipients: [ADDR] },
    { enabled: true, allowedRecipients: [ADDR] },
  );
  assert.deepEqual(diff.removedRestrictions, ["readOnly", "maxPerTxUsd"]);
  assert.equal(diff.warnings.length, 2);
  assert.match(diff.warnings[0], /readOnly was removed/);
  assert.match(diff.warnings[1], /maxPerTxUsd was removed \(was 20 USD\)/);
});

test("enabled=false removes everything without the full-replace hint", () => {
  const diff = diffWalletPolicy(
    { enabled: true, readOnly: true, maxPerTxUsd: "20", allowedRecipients: [ADDR] },
    { enabled: false },
  );
  assert.deepEqual(diff.changes.enabled, { from: true, to: false });
  assert.deepEqual(diff.removedRestrictions, ["readOnly", "maxPerTxUsd", "allowedRecipients"]);
  assert.equal(diff.warnings.length, 3);
  for (const w of diff.warnings) assert.doesNotMatch(w, /full replace/);
});

test("allow-list membership changes are reported; additions warn", () => {
  const swapped = diffWalletPolicy(
    { enabled: true, allowedRecipients: [ADDR] },
    { enabled: true, allowedRecipients: [ADDR, ADDR2] },
  );
  assert.deepEqual(swapped.changes.allowedRecipients, { from: [ADDR], to: [ADDR, ADDR2] });
  assert.deepEqual(swapped.removedRestrictions, []);
  assert.match(swapped.warnings[0], new RegExp(`gained 1 address: ${ADDR2}`));

  const narrowed = diffWalletPolicy(
    { enabled: true, allowedRecipients: [ADDR, ADDR2] },
    { enabled: true, allowedRecipients: [ADDR] },
  );
  assert.deepEqual(narrowed.changes.allowedRecipients, { from: [ADDR, ADDR2], to: [ADDR] });
  assert.deepEqual(narrowed.warnings, []);

  const reordered = diffWalletPolicy(
    { enabled: true, allowedRecipients: [ADDR, ADDR2] },
    { enabled: true, allowedRecipients: [ADDR2, ADDR] },
  );
  assert.equal(reordered.unchanged, true);
});

test("a malformed stored maxPerTxUsd does not block the write that replaces it", () => {
  let diff: ReturnType<typeof diffWalletPolicy> | undefined;
  assert.doesNotThrow(() => {
    diff = diffWalletPolicy(
      { enabled: true, maxPerTxUsd: "abc" },
      { enabled: true, maxPerTxUsd: "20" },
    );
  });
  assert.deepEqual(diff!.changes.maxPerTxUsd, { from: "abc", to: "20" });
  assert.deepEqual(diff!.warnings, []);
});

test("a stored policy with enabled=false counts as no restrictions", () => {
  const diff = diffWalletPolicy(
    { enabled: false, maxPerTxUsd: "20", allowedRecipients: [ADDR] },
    { enabled: true, maxPerTxUsd: "20" },
  );
  assert.deepEqual(diff.removedRestrictions, []);
  assert.deepEqual(diff.warnings, []);
  assert.deepEqual(diff.changes.maxPerTxUsd, { from: null, to: "20" });
});
