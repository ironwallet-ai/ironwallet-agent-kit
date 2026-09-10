/**
 * MCP tools for balance reads and transfer relay (estimate → sign → forward).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { assertServerWritable, canSend, type NetworkId } from "../config.js";
import { resolveEntry } from "../keystore/store.js";
import { estimate, forward, operationState, type SignedEstimate } from "../api/relay.js";
import { getBalance } from "../api/balances.js";
import { parseUnits, formatUnits } from "ethers";
import { signForward } from "../signing/index.js";
import { tonPublicKeyHex } from "../signing/ton.js";
import { enforcePolicy, enforceUsdLimit } from "../policy.js";
import { logInfo, logWarn } from "../log.js";
import { mcpToolConfig, toolDefinition } from "./definitions.js";
import { requirePositiveAmount, type ToolHelpers } from "./helpers.js";

interface ResolvedAmount {
  est: SignedEstimate;
  /** Final amount to send (decimal string), possibly reduced to fit the fee. */
  amount: string;
  /** True if the amount was reduced so the fee fits within the balance. */
  adjusted: boolean;
  requestedAmount: string;
  balance: string;
  fee: string;
  symbol: string;
}

/**
 * Estimate a transfer and, if the amount + fee would exceed the balance, reduce
 * the amount to `balance - fee` and re-estimate. Fees for native coins are paid
 * in the coin (`coinFee`); for tokens the gasless fee is paid in the token
 * (`tokenFee`). The returned `est` always matches the returned `amount`.
 */
async function resolveAmountForFee(opts: {
  network: NetworkId;
  token: string;
  address: string;
  to: string;
  tokenAddress?: string;
  amount: string;
  memo?: string;
  fromPublicKey?: string;
  correlationId?: string;
}): Promise<ResolvedAmount> {
  const {
    network,
    token,
    address,
    to,
    tokenAddress,
    memo,
    fromPublicKey,
    correlationId,
  } = opts;
  const bal = await getBalance(network, address, tokenAddress);
  const decimals = bal.decimals;
  const balanceRaw = BigInt(bal.raw);

  logInfo("send.resolve_amount.start", {
    correlationId,
    network,
    address,
    to,
    requestedAmount: opts.amount,
    balance: bal.formatted,
    balanceRaw: bal.raw,
    symbol: bal.symbol,
    decimals,
    tokenAddress,
    hasFromPublicKey: Boolean(fromPublicKey),
  });

  let amount = opts.amount;
  let adjusted = false;
  let est = await estimate(
    network,
    token,
    {
      fromAddress: address,
      toAddress: to,
      tokenAddress,
      amount,
      memo,
      fromPublicKey,
    },
    { correlationId },
  );

  const feeOf = (e: SignedEstimate): bigint =>
    BigInt(
      (tokenAddress ? e.estimateResult?.tokenFee : e.estimateResult?.coinFee) ??
        "0",
    );

  const amountRawOf = (e: SignedEstimate, amt: string): bigint => {
    const fromEst = e.estimateResult?.amount;
    if (fromEst != null && /^\d+$/.test(fromEst)) return BigInt(fromEst);
    return parseUnits(amt, decimals);
  };

  // A few passes in case the fee shifts slightly when the amount changes.
  for (let i = 0; i < 4; i++) {
    const feeRaw = feeOf(est);
    const requestedRaw = amountRawOf(est, amount);
    logInfo("send.resolve_amount.pass", {
      correlationId,
      pass: i,
      amount,
      amountRaw: requestedRaw.toString(),
      feeRaw: feeRaw.toString(),
      fee: formatUnits(feeRaw, decimals),
      balanceRaw: balanceRaw.toString(),
      fits: requestedRaw + feeRaw <= balanceRaw,
      adjusted,
      estimateTraceId: est.traceId,
    });
    if (requestedRaw + feeRaw <= balanceRaw) {
      logInfo("send.resolve_amount.ok", {
        correlationId,
        amount,
        adjusted,
        requestedAmount: opts.amount,
        fee: formatUnits(feeRaw, decimals),
        symbol: bal.symbol,
      });
      return {
        est,
        amount,
        adjusted,
        requestedAmount: opts.amount,
        balance: bal.formatted,
        fee: formatUnits(feeRaw, decimals),
        symbol: bal.symbol,
      };
    }
    const correctedRaw = balanceRaw - feeRaw;
    if (correctedRaw <= 0n) {
      throw new Error(
        `Balance ${bal.formatted} ${bal.symbol} is too low to cover the fee ` +
          `(${formatUnits(feeRaw, decimals)} ${bal.symbol}).`,
      );
    }
    const prev = amount;
    amount = formatUnits(correctedRaw, decimals);
    adjusted = true;
    logWarn("send.resolve_amount.adjust", {
      correlationId,
      pass: i,
      fromAmount: prev,
      toAmount: amount,
      fee: formatUnits(feeRaw, decimals),
      balance: bal.formatted,
      symbol: bal.symbol,
    });
    est = await estimate(
      network,
      token,
      {
        fromAddress: address,
        toAddress: to,
        tokenAddress,
        amount,
        memo,
        fromPublicKey,
      },
      { correlationId },
    );
  }

  throw new Error(
    "Could not fit the amount under balance minus fee (fee kept changing). Try a smaller amount.",
  );
}

export function registerTransferTools(server: McpServer, helpers: ToolHelpers): void {
  const { ok, withToolLog, session } = helpers;

  server.registerTool(
    "get_balance",
    mcpToolConfig(toolDefinition("get_balance")),
    async ({ wallet, network, tokenAddress }) =>
      withToolLog("get_balance", { wallet, network, tokenAddress }, async ({ correlationId }) => {
        const entry = resolveEntry(wallet);
        const address = entry.addresses[network];
        if (!address) {
          throw new Error(`Wallet "${entry.name}" has no ${network} address.`);
        }
        const result = await getBalance(network, address, tokenAddress);
        return ok({ ...result, correlationId });
      }),
  );

  server.registerTool(
    "estimate_transfer",
    mcpToolConfig(toolDefinition("estimate_transfer")),
    async ({ wallet, network, to, amount: rawAmount, tokenAddress, memo }) =>
      withToolLog(
        "estimate_transfer",
        { wallet, network, to, amount: rawAmount, tokenAddress, hasMemo: Boolean(memo) },
        async ({ correlationId }) => {
          if (!canSend(network)) {
            throw new Error(`Sending on "${network}" is not supported.`);
          }
          const amount = requirePositiveAmount(rawAmount);
          const { entry, mnemonic, token } = await session(wallet, correlationId);
          const address = entry.addresses[network];
          const fromPublicKey =
            network === "ton" ? tonPublicKeyHex(mnemonic) : undefined;
          const est = await estimate(
            network,
            token,
            {
              fromAddress: address,
              toAddress: to,
              tokenAddress,
              amount,
              memo,
              fromPublicKey,
            },
            { correlationId },
          );
          return ok({
            amount: est.estimateResult?.amount,
            coinFee: est.estimateResult?.coinFee,
            tokenFee: est.estimateResult?.tokenFee,
            transactionsToSign: est.estimateResult?.transactionsToSign?.length ?? 0,
            traceId: est.traceId,
            correlationId,
          });
        },
      ),
  );

  server.registerTool(
    "send_transfer",
    mcpToolConfig(toolDefinition("send_transfer")),
    async ({ wallet, network, to, amount: rawAmount, tokenAddress, memo }) =>
      withToolLog(
        "send_transfer",
        { wallet, network, to, amount: rawAmount, tokenAddress, hasMemo: Boolean(memo) },
        async ({ correlationId, started }) => {
          assertServerWritable("send");
          if (!canSend(network)) {
            throw new Error(`Sending on "${network}" is not supported.`);
          }
          const amount = requirePositiveAmount(rawAmount);
          const { entry, mnemonic, token } = await session(wallet, correlationId);
          const address = entry.addresses[network];
          logInfo("tool.send_transfer.session", {
            correlationId,
            wallet: entry.name,
            fromAddress: address,
            network,
          });

          const fromPublicKey =
            network === "ton" ? tonPublicKeyHex(mnemonic) : undefined;

          const resolved = await resolveAmountForFee({
            network,
            token,
            address,
            to,
            tokenAddress,
            amount,
            memo,
            fromPublicKey,
            correlationId,
          });

          enforcePolicy(entry, {
            kind: "transfer",
            network,
            toAddress: to,
          });

          await enforceUsdLimit(entry, {
            kind: "transfer",
            network,
            amount: resolved.amount,
            symbol: resolved.symbol,
            tokenAddress,
            correlationId,
          });

          const params = {
            fromAddress: address,
            toAddress: to,
            tokenAddress,
            amount: resolved.amount,
            memo,
            fromPublicKey,
          };

          const txs = resolved.est.estimateResult?.transactionsToSign ?? [];
          if (txs.length === 0) {
            throw new Error("Estimate returned no transactions to sign.");
          }

          logInfo("tool.send_transfer.sign.start", {
            correlationId,
            network,
            txCount: txs.length,
            amount: resolved.amount,
            adjustedForFee: resolved.adjusted,
          });
          const signStarted = Date.now();
          const signed = await signForward(network, mnemonic, txs);
          logInfo("tool.send_transfer.sign.ok", {
            correlationId,
            network,
            elapsedMs: Date.now() - signStarted,
            signedCount: signed.length,
          });

          const result = await forward(
            network,
            token,
            params,
            resolved.est,
            signed,
            { correlationId },
          );

          return ok({
            txHash: result.txHash,
            operationId: result.operationId,
            chainId: result.chainId,
            amountSent: resolved.amount,
            adjustedForFee: resolved.adjusted,
            requestedAmount: resolved.requestedAmount,
            correlationId,
            elapsedMs: Date.now() - started,
            ...(resolved.adjusted
              ? {
                  note: `Requested ${resolved.requestedAmount} exceeded balance minus fee; reduced to ${resolved.amount} ${resolved.symbol} (fee ${resolved.fee} ${resolved.symbol}).`,
                }
              : {}),
          });
        },
      ),
  );

  server.registerTool(
    "get_operation_status",
    mcpToolConfig(toolDefinition("get_operation_status")),
    async ({ wallet, network, operationId }) =>
      withToolLog(
        "get_operation_status",
        { wallet, network, operationId },
        async ({ correlationId }) => {
          const { token } = await session(wallet, correlationId);
          const state = await operationState(network, token, operationId, {
            correlationId,
          });
          return ok({ ...state, correlationId });
        },
      ),
  );
}
