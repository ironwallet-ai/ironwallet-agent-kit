/**
 * Shared MCP tool helpers: response shaping, logging wrapper, wallet session.
 */

import {
  resolveEntry,
  syncAddresses,
  unlockMnemonic,
} from "../keystore/store.js";
import type { WalletEntry } from "../keystore/types.js";
import { requirePassphrase } from "../passphrase.js";
import { getAccessToken } from "../api/auth.js";
import { compareDecimalAmount } from "../policy.js";
import {
  logError,
  logInfo,
  newCorrelationId,
} from "../log.js";

export type ImageContent = {
  type: "image";
  data: string;
  mimeType: "image/png";
  annotations?: {
    audience?: Array<"user" | "assistant">;
    priority?: number;
  };
};

/** MCP 2025-06-18: audience=user asks the host to show the image in the UI. */
const USER_VISIBLE_IMAGE: NonNullable<ImageContent["annotations"]> = {
  audience: ["user", "assistant"],
  priority: 0.9,
};

export function ok(payload: unknown, images: ImageContent[] = []) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
      ...images.map((img) => ({
        ...img,
        annotations: img.annotations ?? USER_VISIBLE_IMAGE,
      })),
    ],
  };
}

export function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: `Error: ${message}` }],
  };
}

/**
 * Validate a user-supplied asset amount before it reaches the relay or swap
 * backend. Neither backend rejects zero or negative values: the relay happily
 * quotes `amount: "-1"` as `-1000000000000000000` wei. Same rules as
 * `set_wallet_policy.maxPerTxUsd`: plain decimal digits, greater than zero.
 * Returns the trimmed amount.
 */
export function requirePositiveAmount(raw: string, field = "amount"): string {
  const amount = raw.trim();
  let cmp: number;
  try {
    cmp = compareDecimalAmount(amount, "0");
  } catch {
    throw new Error(
      `${field} must be a positive decimal string like "0.5" or "12" (got "${raw}").`,
    );
  }
  if (cmp === 0) {
    throw new Error(`${field} must be greater than zero (got "${raw}").`);
  }
  return amount;
}

/** "0", "0.0", " 00 " — a zero placeholder some agents send alongside maxMode. */
export function isZeroAmount(raw: string): boolean {
  return /^0+(\.0+)?$/.test(raw.trim());
}

export type ToolOk = ReturnType<typeof ok>;
export type ToolFail = ReturnType<typeof fail>;

/**
 * Wrap every MCP tool handler with start/ok/fail JSONL logging and a
 * correlation id. Nested modules (http/relay/auth/…) reuse the same id when
 * callers pass it through.
 */
export async function withToolLog<TArgs extends Record<string, unknown> | undefined>(
  tool: string,
  args: TArgs,
  fn: (ctx: { correlationId: string; started: number }) => Promise<ToolOk>,
): Promise<ToolOk | ToolFail> {
  const correlationId = newCorrelationId(
    tool.replace(/[^a-z0-9]+/gi, "").slice(0, 12) || "tool",
  );
  const started = Date.now();
  logInfo("tool.start", { correlationId, tool, args: args ?? {} });
  try {
    const result = await fn({ correlationId, started });
    logInfo("tool.ok", {
      correlationId,
      tool,
      elapsedMs: Date.now() - started,
      isError: false,
    });
    return result;
  } catch (e) {
    logError("tool.fail", e, {
      correlationId,
      tool,
      elapsedMs: Date.now() - started,
      args: args ?? {},
    });
    return fail(e);
  }
}

/** Resolve wallet + decrypt mnemonic + obtain a Bearer token. */
export async function session(
  walletName: string | undefined,
  correlationId?: string,
): Promise<{ entry: WalletEntry; mnemonic: string; token: string }> {
  const started = Date.now();
  logInfo("session.start", { correlationId, wallet: walletName ?? "<default>" });
  try {
    const resolved = resolveEntry(walletName);
    const mnemonic = unlockMnemonic(resolved, requirePassphrase());
    const entry = syncAddresses(resolved, mnemonic);
    const token = await getAccessToken(mnemonic, { correlationId });
    logInfo("session.ok", {
      correlationId,
      wallet: entry.name,
      elapsedMs: Date.now() - started,
      addressCount: Object.keys(entry.addresses).length,
    });
    return { entry, mnemonic, token };
  } catch (e) {
    logError("session.fail", e, {
      correlationId,
      wallet: walletName ?? "<default>",
      elapsedMs: Date.now() - started,
    });
    throw e;
  }
}

export type ToolHelpers = {
  ok: typeof ok;
  withToolLog: typeof withToolLog;
  session: typeof session;
};
