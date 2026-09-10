import assert from "node:assert/strict";
import { test } from "node:test";
import { DEVICE_ID_PLATFORM, formatDeviceId, newInstallationId } from "./local-secrets.js";

const UUID = "5f3c1e2a-9b8d-4c7e-a1f0-123456789abc";

test("device id is sent as web:<uuid>", () => {
  assert.equal(DEVICE_ID_PLATFORM, "web");
  assert.equal(formatDeviceId(UUID), `web:${UUID}`);
});

test("a bare UUID from an existing device-id file keeps its identity part", () => {
  assert.equal(formatDeviceId(` ${UUID}\n`), `web:${UUID}`);
});

test("an already prefixed override is sent as is, not double-prefixed", () => {
  assert.equal(formatDeviceId(`web:${UUID}`), `web:${UUID}`);
  assert.equal(formatDeviceId(`ios:${UUID}`), `ios:${UUID}`);
});

test("installation id is <uuid>:<unix nanoseconds>", () => {
  const id = newInstallationId(1_757_331_600_123);
  const m = /^([0-9a-f-]{36}):(\d+)$/.exec(id);
  assert.ok(m, `unexpected format: ${id}`);
  assert.equal(m![2], "1757331600123000000", "milliseconds → nanoseconds without float loss");
  assert.notEqual(newInstallationId(), newInstallationId(), "uuid part is random");
});
