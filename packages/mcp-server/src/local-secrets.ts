/**
 * Machine-local secrets and install identity. Generated on first use and stored
 * under the keystore directory (owner-only). Not written to User env, mcp.json, or
 * the plugin dashboard.
 *
 * Env vars still win when set to a real value. Unexpanded `${VAR}` placeholders
 * (Claude Code when the shell var is missing) are treated as unset.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { restrictPrivateFile } from "./restrict-private-file.js";

const RELAY_KEY_FILE = "relay-api-key";
const PASSPHRASE_FILE = "keystore-passphrase";
const DEVICE_ID_FILE = "device-id";
const INSTALLATION_ID_FILE = "installation-id";

export function resolveKeystoreDir(): string {
  if (process.env.IW_KEYSTORE_DIR) return process.env.IW_KEYSTORE_DIR;
  const home =
    process.env.HOME ??
    process.env.USERPROFILE ??
    process.env.HOMEPATH ??
    ".";
  return `${home}/.ironwallet-mcp`;
}

export function isUnsetSecret(value: string | undefined): boolean {
  if (!value) return true;
  const trimmed = value.trim();
  if (trimmed.length === 0) return true;
  return /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(trimmed);
}

function readOrCreate(filename: string, generate: () => string): string {
  const dir = resolveKeystoreDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, filename);
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length > 0 && !isUnsetSecret(existing)) return existing;
  }
  const value = generate();
  writeFileSync(path, `${value}\n`, { mode: 0o600 });
  restrictPrivateFile(path);
  return value;
}

/** x-api-key for relay and swap APIs. UUID, stable per machine directory. */
export function resolveRelayApiKey(): string {
  const fromEnv = process.env.IW_RELAY_API_KEY;
  if (!isUnsetSecret(fromEnv)) return fromEnv!.trim();
  return readOrCreate(RELAY_KEY_FILE, () => randomUUID());
}

/** Keystore wrapping secret. Not the recovery phrase. */
export function resolveKeystorePassphrase(): string {
  const fromEnv = process.env.IW_PASSPHRASE;
  if (!isUnsetSecret(fromEnv)) return fromEnv!.trim();
  return readOrCreate(PASSPHRASE_FILE, () => randomBytes(24).toString("base64url"));
}

/** Platform tag the backend expects in front of the device UUID. */
export const DEVICE_ID_PLATFORM = "web";

/**
 * Bare UUID as stored in `device-id` (or `IW_DEVICE_ID`). Stable per keystore
 * directory. Used as fingerprint fallback material; the wire value is
 * `formatDeviceId()` of this.
 */
export function resolveRawDeviceId(): string {
  const fromEnv = process.env.IW_DEVICE_ID;
  if (!isUnsetSecret(fromEnv)) return fromEnv!.trim();
  return readOrCreate(DEVICE_ID_FILE, () => randomUUID());
}

/**
 * `web:<uuid>` for X-Device-Id. A bare UUID (existing installs, env override)
 * gets the `web:` prefix so the identity part stays the same. A value that
 * already carries a `platform:` prefix is sent as is.
 */
export function formatDeviceId(raw: string): string {
  const value = raw.trim();
  if (/^[A-Za-z][A-Za-z0-9_-]*:/.test(value)) return value;
  return `${DEVICE_ID_PLATFORM}:${value}`;
}

/** X-Device-Id, `web:<uuid>`. */
export function resolveDeviceId(): string {
  return formatDeviceId(resolveRawDeviceId());
}

/**
 * `<uuid>:<unix nanoseconds>` — the X-Installation-ID format the backend
 * expects. Minted once per keystore directory and kept, so a new id means a
 * fresh install (or a wiped keystore).
 */
export function newInstallationId(now: number = Date.now()): string {
  return `${randomUUID()}:${BigInt(Math.trunc(now)) * 1_000_000n}`;
}

/** X-Installation-ID. Stable per keystore directory; no env override on purpose. */
export function resolveInstallationId(): string {
  return readOrCreate(INSTALLATION_ID_FILE, () => newInstallationId());
}
