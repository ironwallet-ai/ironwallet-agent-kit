/**
 * Runtime configuration: baked environment profile (from configurations repo),
 * plus optional env overrides. Relay API key and keystore passphrase are
 * generated on first launch. There is no runtime IW_ENV switch — each build
 * embeds one profile via the repo-root `npm run bake`.
 */

import { readFileSync } from "node:fs";
import { arch, release, type as osType } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BAKED_ENV } from "./generated/env-config.js";
import { ALL_NETWORKS, EVM_NETWORKS, type NetworkId } from "./networks.js";
import {
  HISTORY_API_KINDS,
  type HistoryApiKind,
  type HistoryApiSpec,
  type HistoryApis,
} from "./api/history/types.js";
import { resolveDeviceFingerprint } from "./device-fingerprint.js";
import {
  formatDeviceId,
  resolveKeystoreDir,
  resolveInstallationId,
  resolveKeystorePassphrase,
  resolveRawDeviceId,
  resolveRelayApiKey,
} from "./local-secrets.js";

/** `package.json` version of this package (works from `src/` and compiled `dist/`). */
export function packageVersion(): string {
  try {
    const pkgPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "package.json",
    );
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export type { NetworkId } from "./networks.js";
export { ALL_NETWORKS, EVM_NETWORKS, NON_EVM_NETWORKS } from "./networks.js";

/**
 * Networks advertised during challenge login. Kept to the proven EVM+Tron set:
 * the backend authenticates against these public keys and the flow is verified
 * for them. Newly added chains are used for address/balance reads and don't need
 * to be part of the auth handshake.
 */
export const AUTH_NETWORKS: NetworkId[] = [...EVM_NETWORKS, "tron"];

/**
 * Networks whose transfer signing is implemented (send is allowed). All of these
 * go through the IronWallet relay forward flow (estimate → sign → forward),
 * including TON (IR-673 / mobile RelayV2).
 */
export const SIGNABLE_NETWORKS: NetworkId[] = [...ALL_NETWORKS];

export function canSend(network: NetworkId): boolean {
  return SIGNABLE_NETWORKS.includes(network);
}

/**
 * Networks that can sign swap txs (mobile NetType set). Litecoin/Doge are in
 * MCP for transfers but not in the mobile swap NetType enum.
 */
export const SWAP_SIGNABLE_NETWORKS: NetworkId[] = ALL_NETWORKS.filter(
  (n) => n !== "litecoin" && n !== "doge",
);

export function canSwap(network: NetworkId): boolean {
  return SWAP_SIGNABLE_NETWORKS.includes(network);
}

/** Parse a SWP network name ("Ethereum" / "ethereum") into NetworkId when known. */
export function parseNetworkId(name: string): NetworkId | undefined {
  const key = name.trim().toLowerCase();
  return ALL_NETWORKS.find((n) => n === key);
}

export function isEvmNetwork(network: NetworkId): boolean {
  return (EVM_NETWORKS as readonly NetworkId[]).includes(network);
}

/**
 * Relay path segment expected by the backend (PascalCase per network), e.g.
 * `https://iwio.app/txs/api/Ethereum/forward/estimate`.
 */
const RELAY_SEGMENT: Record<NetworkId, string> = {
  ethereum: "Ethereum",
  bsc: "Bsc",
  polygon: "Polygon",
  base: "Base",
  arbitrum: "Arbitrum",
  optimism: "Optimism",
  avalanche: "Avalanche",
  tron: "Tron",
  bitcoin: "Bitcoin",
  litecoin: "Litecoin",
  doge: "Doge",
  solana: "Solana",
  ton: "Ton",
  xrp: "Xrp",
};

export function relaySegment(network: NetworkId): string {
  return RELAY_SEGMENT[network];
}

export interface Config {
  authUrl: string;
  relayUrl: string;
  /** Swap API host (`/swp/exchange/*`, `/swp/refs/*`). */
  swapProxyUrl: string;
  /** Rates API host (`/api/v1/rate/rates`). Used only for USD policy limits. */
  ratesApiUrl: string;
  /** Static resources base with asset catalogs (`/assets/main/blockchains/...`). */
  staticResourcesUrl: string;
  /** Optional relay API key (x-api-key). Empty string means header is omitted. */
  relayApiKey: string;
  /** App version string sent as x-iwt-cli / X-App-Version. */
  appVersion: string;
  /** Device id sent as X-Device-Id: `web:<uuid>`. UUID file under the keystore dir unless overridden. */
  deviceId: string;
  /** Machine fingerprint sent as X-Device-Fingerprint. OS install id + platform, or device-id if that id is missing. */
  deviceFingerprint: string;
  /** X-Installation-ID, `<uuid>:<unix ns>`. File under the keystore dir. */
  installationId: string;
  /** X-Device-Locale value, format: TimeZone=..;Language=..;Region=..; */
  deviceLocale: string;
  /**
   * JSON for `X-Device-Info` (plain) and `X-Device-Info-Base64` (the form the
   * swap gateway decodes first). The swap API keys routing off `systemName`
   * (`Web` here — this is a desktop MCP).
   */
  deviceInfo: string;
  /** Directory holding the encrypted keystore. */
  keystoreDir: string;
  /** JSON-RPC endpoints for EVM chains only. */
  evmRpcUrls: Record<string, string>;
  /** Tron full-node HTTP API base (TronGrid) for on-chain balance reads. */
  tronApiUrl: string;
  /** Bitcoin Esplora REST API base. */
  bitcoinApiUrl: string;
  /** Litecoin Esplora REST API base. */
  litecoinApiUrl: string;
  /** Dogecoin BlockCypher API base (…/v1/doge/main). */
  dogeApiUrl: string;
  /** Solana JSON-RPC endpoint. */
  solanaRpcUrl: string;
  /** TON HTTP API base (TON Center v2). */
  tonApiUrl: string;
  /** XRP Ledger JSON-RPC endpoint. */
  xrpRpcUrl: string;
  /** True when Bitcoin should use testnet (dev). */
  bitcoinTestnet: boolean;
  /**
   * Transaction-history indexer chain per network (first entry is primary).
   * Empty array = history unsupported for that network in this build.
   */
  historyApis: Record<NetworkId, HistoryApiSpec[]>;
  /** Per-attempt HTTP/RPC timeout in milliseconds. */
  httpTimeoutMs: number;
  /**
   * Timeout for relay `POST .../forward` (broadcast). Longer than the general
   * HTTP timeout because the relay may wait on chain inclusion before responding,
   * while the tx can already be in flight if the client gives up early.
   */
  httpForwardTimeoutMs: number;
  /** Extra retry attempts for idempotent requests (total tries = retries + 1). */
  httpRetries: number;
  /** When true, `send_transfer` and `execute_swap` are rejected immediately. */
  readOnly: boolean;
}

function envOr(key: string, fallback: string): string {
  const v = process.env[key];
  return v && v.length > 0 ? v : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  return !/^(0|false|off|no)$/i.test(v);
}

/** Host-honest Web payload. Do not pretend to be iOS/Android. */
export function defaultDeviceInfo(): string {
  return JSON.stringify({
    systemName: "Web",
    systemVersion: packageVersion(),
    model: "ironwallet-mcp",
    platform: process.platform,
    arch: arch(),
    os: osType(),
    osRelease: release(),
  });
}

function defaultDeviceLocale(): string {
  let timeZone = "UTC";
  let language = "en";
  let region = "US";
  try {
    const opts = Intl.DateTimeFormat().resolvedOptions();
    if (opts.timeZone) timeZone = opts.timeZone;
    const parts = (opts.locale ?? "").split(/[-_]/);
    if (parts[0]) language = parts[0];
    if (parts[1]) region = parts[1];
  } catch {
    // keep UTC/en/US
  }
  return `TimeZone=${timeZone};Language=${language};Region=${region};`;
}

/** Parse an integer env var, clamped to [min, max], falling back on invalid input. */
function envInt(key: string, fallback: number, min: number, max: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function resolveEvmRpcUrls(
  profileUrls: Record<string, string>,
): Record<string, string> {
  const urls: Record<string, string> = { ...profileUrls };
  for (const net of EVM_NETWORKS) {
    const override = process.env[`IW_RPC_${net.toUpperCase()}`];
    if (override) urls[net] = override;
  }
  return urls;
}

/**
 * Non-EVM chains can read history from the same endpoints that serve balances,
 * so they work on every profile. EVM chains need an indexer (Blockscout /
 * Routescan / NodeReal) that only the profile knows about.
 */
const DEFAULT_HISTORY_APIS: Record<NetworkId, HistoryApiSpec[]> = {
  ethereum: [],
  bsc: [],
  polygon: [],
  base: [],
  arbitrum: [],
  optimism: [],
  avalanche: [],
  tron: [{ kind: "trongrid" }],
  bitcoin: [{ kind: "esplora" }],
  litecoin: [{ kind: "esplora" }],
  doge: [{ kind: "blockcypher" }],
  solana: [{ kind: "solana-rpc" }],
  ton: [{ kind: "toncenter" }],
  xrp: [{ kind: "xrp-rpc" }],
};

function isHistoryApiSpec(value: unknown): value is HistoryApiSpec {
  if (!value || typeof value !== "object") return false;
  const spec = value as { kind?: unknown; url?: unknown };
  if (!HISTORY_API_KINDS.includes(spec.kind as HistoryApiKind)) return false;
  return spec.url === undefined || (typeof spec.url === "string" && spec.url.length > 0);
}

/** Validate a per-network chain from the profile or `IW_HISTORY_APIS`; bad entries are dropped. */
function sanitizeHistoryApis(raw: unknown, origin: string): HistoryApis {
  const out: HistoryApis = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [network, chain] of Object.entries(raw as Record<string, unknown>)) {
    if (!(ALL_NETWORKS as readonly string[]).includes(network)) continue;
    if (!Array.isArray(chain)) continue;
    const specs = chain.filter(isHistoryApiSpec).map((s) => ({
      kind: s.kind,
      ...(s.url ? { url: s.url.replace(/\/+$/, "") } : {}),
    }));
    if (specs.length !== chain.length) {
      process.stderr.write(
        `[ironwallet-mcp] ${origin}: ignored ${chain.length - specs.length} invalid history API entr(ies) for ${network}\n`,
      );
    }
    out[network as NetworkId] = specs;
  }
  return out;
}

function resolveHistoryApis(profile: HistoryApis | undefined): Record<NetworkId, HistoryApiSpec[]> {
  const merged: Record<NetworkId, HistoryApiSpec[]> = { ...DEFAULT_HISTORY_APIS };
  Object.assign(merged, sanitizeHistoryApis(profile, "profile.historyApis"));
  const envRaw = process.env.IW_HISTORY_APIS;
  if (envRaw && envRaw.trim().length > 0) {
    try {
      Object.assign(merged, sanitizeHistoryApis(JSON.parse(envRaw), "IW_HISTORY_APIS"));
    } catch {
      process.stderr.write("[ironwallet-mcp] IW_HISTORY_APIS is not valid JSON; ignored\n");
    }
  }
  return merged;
}

let cached: Config | null = null;

export function getConfig(): Config {
  if (cached) return cached;
  resolveKeystorePassphrase();
  // Raw UUID stays the fingerprint fallback so existing installs keep the same
  // X-Device-Fingerprint; only the header value gains the `web:` prefix.
  const rawDeviceId = resolveRawDeviceId();
  const profile = BAKED_ENV;
  cached = {
    authUrl: envOr("IW_AUTH_URL", profile.authUrl),
    relayUrl: envOr("IW_RELAY_URL", profile.relayUrl),
    swapProxyUrl: envOr("IW_SWAP_PROXY_URL", profile.swapProxyUrl),
    // Hosts live only in the baked configurations profile (no fallbacks in
    // code). Empty string means USD policy limits fail closed.
    ratesApiUrl: envOr("IW_RATES_API_URL", profile.ratesApiUrl ?? ""),
    staticResourcesUrl: envOr("IW_STATIC_RESOURCES_URL", profile.staticResourcesUrl ?? ""),
    relayApiKey: resolveRelayApiKey(),
    // Identity headers are not overridable: the backend routes swaps off
    // deviceInfo.systemName and reads appVersion for client metrics, so a
    // spoofed value only breaks support.
    appVersion: `ironwallet-mcp/${packageVersion()}`,
    deviceId: formatDeviceId(rawDeviceId),
    deviceFingerprint: resolveDeviceFingerprint(rawDeviceId),
    installationId: resolveInstallationId(),
    deviceLocale: defaultDeviceLocale(),
    deviceInfo: defaultDeviceInfo(),
    keystoreDir: resolveKeystoreDir(),
    evmRpcUrls: resolveEvmRpcUrls(profile.evmRpcUrls),
    tronApiUrl: envOr("IW_TRON_API", profile.tronApiUrl),
    bitcoinApiUrl: envOr("IW_BTC_API", profile.bitcoinApiUrl),
    litecoinApiUrl: envOr("IW_LTC_API", profile.litecoinApiUrl),
    dogeApiUrl: envOr("IW_DOGE_API", profile.dogeApiUrl),
    solanaRpcUrl: envOr("IW_SOLANA_RPC", profile.solanaRpcUrl),
    tonApiUrl: envOr("IW_TON_API_URL", profile.tonApiUrl),
    xrpRpcUrl: envOr("IW_XRP_RPC", profile.xrpRpcUrl),
    bitcoinTestnet: profile.bitcoinTestnet,
    historyApis: resolveHistoryApis(profile.historyApis),
    httpTimeoutMs: envInt("IW_HTTP_TIMEOUT_MS", 15000, 1000, 120000),
    // Forward can take well over 15s on L2s when the relay waits for broadcast /
    // inclusion; default 60s. Cap raised to 5 min so slow envs can override.
    httpForwardTimeoutMs: envInt("IW_HTTP_FORWARD_TIMEOUT_MS", 60000, 5000, 300000),
    httpRetries: envInt("IW_HTTP_RETRIES", 2, 0, 10),
    readOnly: envBool("IW_READ_ONLY", false),
  };
  return cached;
}

/** Reject send/swap when `IW_READ_ONLY` is set. */
export function assertServerWritable(action: "send" | "swap"): void {
  if (!getConfig().readOnly) return;
  throw new Error(
    action === "swap"
      ? "Server is read-only (IW_READ_ONLY); swaps are disabled."
      : "Server is read-only (IW_READ_ONLY); sending is disabled.",
  );
}

/** Device headers sent to auth, relay, and swap APIs. */
export function commonHeaders(cfg: Config): Record<string, string> {
  const headers: Record<string, string> = {
    "x-iwt-cli": cfg.appVersion,
    "X-App-Version": cfg.appVersion,
    "X-Device-Id": cfg.deviceId,
    "X-Device-Fingerprint": cfg.deviceFingerprint,
    // Backend validates the format: TimeZone=..;Language=..;Region=..;
    "X-Device-Locale": cfg.deviceLocale,
    // Swap routing reads UserData.XDeviceInfo.systemName (`Web` for this client).
    // Plain JSON is what the MCP proxy reads for metrics; the swap gateway
    // decodes the base64 form first. Same payload in both.
    "X-Device-Info": cfg.deviceInfo,
    "X-Device-Info-Base64": Buffer.from(cfg.deviceInfo, "utf8").toString("base64"),
    "X-Installation-ID": cfg.installationId,
    "Content-Language": "en",
  };
  if (cfg.relayApiKey) headers["x-api-key"] = cfg.relayApiKey;
  return headers;
}
