import assert from "node:assert/strict";
import { test } from "node:test";
import { commonHeaders, defaultDeviceInfo, type Config } from "./config.js";

test("defaultDeviceInfo is Web, not a phone spoof", () => {
  const info = JSON.parse(defaultDeviceInfo()) as Record<string, string>;
  assert.equal(info.systemName, "Web");
  assert.equal(info.model, "ironwallet-mcp");
  assert.equal(info.platform, process.platform);
  assert.doesNotMatch(JSON.stringify(info), /iPhone|iOS|Android/i);
});

test("commonHeaders: device info goes out plain and base64 with the same payload, plus installation id", () => {
  const cfg = {
    appVersion: "ironwallet-mcp/1.2.0",
    deviceId: "web:5f3c1e2a-9b8d-4c7e-a1f0-123456789abc",
    deviceFingerprint: "v1:abc",
    deviceLocale: "TimeZone=UTC;Language=en;Region=US;",
    deviceInfo: defaultDeviceInfo(),
    installationId: "0b7d2c9e-1d2f-4a3b-9c8d-7e6f5a4b3c2d:1757331600123000000",
    relayApiKey: "",
  } as unknown as Config;
  const h = commonHeaders(cfg);
  assert.equal(h["X-Device-Info"], cfg.deviceInfo);
  assert.equal(Buffer.from(h["X-Device-Info-Base64"], "base64").toString("utf8"), cfg.deviceInfo);
  assert.equal(h["X-Installation-ID"], cfg.installationId);
  assert.equal(h["X-Device-Id"], cfg.deviceId);
  assert.equal("x-api-key" in h, false, "empty relay key → header omitted");
});
