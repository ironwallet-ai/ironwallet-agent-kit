/**
 * MCP tools for local keystore wallet management.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createWallets, loadKeystore, resolveEntry, setPolicy } from "../keystore/store.js";
import type { WalletPolicy } from "../keystore/types.js";
import { requirePassphrase } from "../passphrase.js";
import {
  depositCaption,
  depositLabel,
  depositPayload,
  depositQrUrl,
  renderDepositQrPng,
  selectDepositTargets,
} from "../qr/deposit-qr.js";
import { ensureManager } from "../web/manager.js";
import { compareDecimalAmount, diffWalletPolicy, listWalletPolicy } from "../policy.js";
import { logInfo, logWarn } from "../log.js";
import { consentRequiredPayload, hasCurrentConsent, recordConsent } from "../consent/store.js";
import { mcpToolConfig, toolDefinition } from "./definitions.js";
import type { ToolHelpers } from "./helpers.js";

async function managerUrlOrUndefined(
  correlationId: string,
  event: string,
): Promise<string | undefined> {
  try {
    return await ensureManager();
  } catch (e) {
    logWarn(event, {
      correlationId,
      error: e instanceof Error ? e.message : String(e),
    });
    return undefined;
  }
}

export function registerWalletTools(server: McpServer, helpers: ToolHelpers): void {
  const { ok, withToolLog } = helpers;

  server.registerTool(
    "list_wallets",
    mcpToolConfig(toolDefinition("list_wallets")),
    async () =>
      withToolLog("list_wallets", {}, async ({ correlationId }) => {
        const ks = loadKeystore();
        const wallets = ks.wallets.map((w) => ({
          name: w.name,
          addresses: w.addresses,
          backedUp: w.backedUp,
          policy: listWalletPolicy(w.policy),
        }));
        logInfo("tool.list_wallets.result", {
          correlationId,
          count: wallets.length,
          names: wallets.map((w) => w.name),
        });
        // Keep the historical array shape for agents; correlationId is in the log.
        return ok(wallets);
      }),
  );

  server.registerTool(
    "accept_mcp_consent",
    mcpToolConfig(toolDefinition("accept_mcp_consent")),
    async ({ accepted }) =>
      withToolLog("accept_mcp_consent", { accepted }, async ({ correlationId }) => {
        if (accepted !== true) {
          throw new Error(
            "Consent was not accepted. Show the full disclaimer and call again with accepted=true, or open the wallet manager.",
          );
        }
        const record = recordConsent("chat");
        logInfo("tool.accept_mcp_consent.ok", {
          correlationId,
          version: record.version,
          channel: record.channel,
        });
        return ok({
          correlationId,
          accepted: true,
          ...record,
        });
      }),
  );

  server.registerTool(
    "create_wallets",
    mcpToolConfig(toolDefinition("create_wallets")),
    async ({ count, name_prefix }) =>
      withToolLog("create_wallets", { count, name_prefix }, async ({ correlationId }) => {
        if (!hasCurrentConsent()) {
          const managerUrl = await managerUrlOrUndefined(
            correlationId,
            "tool.create_wallets.manager_unavailable",
          );
          logWarn("tool.create_wallets.needs_consent", { correlationId });
          return ok({
            correlationId,
            ...consentRequiredPayload(),
            manager_url: managerUrl,
          });
        }
        const created = createWallets(count, requirePassphrase(), {
          namePrefix: name_prefix,
        });
        const backupUrl = await managerUrlOrUndefined(
          correlationId,
          "tool.create_wallets.manager_unavailable",
        );
        return ok({
          correlationId,
          created: created.map((c) => ({ name: c.name, addresses: c.addresses })),
          backup_url: backupUrl,
          backup_hint: backupUrl
            ? "Seed phrases were not shown to the agent. To view and back them up, open backup_url in a browser and click \"Reveal / backup\" for each wallet (words stay in the browser)."
            : "Seed phrases were not shown to the agent. Call open_wallet_manager and back up each wallet in the browser (Reveal / backup).",
        });
      }),
  );

  server.registerTool(
    "open_wallet_manager",
    mcpToolConfig(toolDefinition("open_wallet_manager")),
    async () =>
      withToolLog("open_wallet_manager", {}, async ({ correlationId }) => {
        const url = await ensureManager();
        const needsConsent = !hasCurrentConsent();
        return ok({
          correlationId,
          url,
          needs_consent: needsConsent,
          note: needsConsent
            ? "Open this URL and accept the MCP disclaimer before creating or importing a wallet. The recovery phrase stays in the browser."
            : "Open this URL in your browser to import/create/backup wallets. " +
              "The recovery phrase stays in the browser and is never sent to the agent. " +
              "The page is local-only (127.0.0.1) and closes itself after 15 minutes of inactivity.",
        });
      }),
  );

  server.registerTool(
    "set_wallet_policy",
    mcpToolConfig(toolDefinition("set_wallet_policy")),
    async ({ wallet, enabled, readOnly, maxPerTxUsd, allowedRecipients }) =>
      withToolLog(
        "set_wallet_policy",
        { wallet, enabled, readOnly, maxPerTxUsd, allowedRecipients },
        async ({ correlationId }) => {
          const entry = resolveEntry(wallet);
          const previous = listWalletPolicy(entry.policy);

          let policy: WalletPolicy;
          if (!enabled) {
            policy = { enabled: false };
          } else {
            const recipients = ((allowedRecipients ?? []) as string[])
              .map((a) => a.trim())
              .filter((a) => a.length > 0);

            if (maxPerTxUsd !== undefined) {
              let cmp: number;
              try {
                cmp = compareDecimalAmount(maxPerTxUsd, "0");
              } catch {
                throw new Error(
                  `maxPerTxUsd must be a non-negative decimal string like "50" or "12.5" (got "${maxPerTxUsd}").`,
                );
              }
              if (cmp === 0) {
                throw new Error(
                  "maxPerTxUsd of 0 would block every operation; use readOnly: true instead.",
                );
              }
            }

            if (!readOnly && maxPerTxUsd === undefined && recipients.length === 0) {
              throw new Error(
                "enabled=true needs at least one restriction (readOnly, maxPerTxUsd, or allowedRecipients). Use enabled=false to remove all limits.",
              );
            }

            policy = {
              enabled: true,
              ...(readOnly ? { readOnly: true } : {}),
              ...(maxPerTxUsd !== undefined ? { maxPerTxUsd } : {}),
              ...(recipients.length > 0 ? { allowedRecipients: recipients } : {}),
            };
          }

          const diff = diffWalletPolicy(previous, policy);
          setPolicy(entry.name, policy);
          logInfo("tool.set_wallet_policy.ok", {
            correlationId,
            wallet: entry.name,
            previous,
            policy,
            changes: diff.changes,
            removedRestrictions: diff.removedRestrictions,
          });
          if (diff.warnings.length > 0) {
            logWarn("tool.set_wallet_policy.weakened", {
              correlationId,
              wallet: entry.name,
              removedRestrictions: diff.removedRestrictions,
              warnings: diff.warnings,
            });
          }

          // Warnings go first so hosts that surface only `note` still show them.
          const notes: string[] = [...diff.warnings];
          if (diff.unchanged) {
            notes.push("Policy unchanged: the new policy equals the previous one.");
          }
          if (policy.enabled && policy.allowedRecipients?.length) {
            notes.push("The recipient allow-list applies to send_transfer.");
          }
          if (policy.enabled && policy.maxPerTxUsd) {
            notes.push(
              `Each send/swap is valued in USD at operation time; if no rate is available the operation is rejected (fail closed).`,
            );
          }
          if (!policy.enabled) {
            notes.push("All policy limits are removed; the wallet can send and swap freely.");
          }

          return ok({
            correlationId,
            wallet: entry.name,
            previous_policy: previous,
            policy: listWalletPolicy(policy),
            ...(diff.unchanged ? {} : { changes: diff.changes }),
            ...(diff.removedRestrictions.length > 0
              ? { removed_restrictions: diff.removedRestrictions }
              : {}),
            ...(diff.warnings.length > 0 ? { warnings: diff.warnings } : {}),
            ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
          });
        },
      ),
  );

  server.registerTool(
    "get_deposit_qr",
    mcpToolConfig(toolDefinition("get_deposit_qr")),
    async ({ wallet, network }) =>
      withToolLog("get_deposit_qr", { wallet, network }, async ({ correlationId }) => {
        const entry = resolveEntry(wallet);
        const targets = selectDepositTargets(entry.addresses, network);
        let managerUrl: string | undefined;
        try {
          managerUrl = await ensureManager();
        } catch (e) {
          logWarn("tool.get_deposit_qr.manager_unavailable", {
            correlationId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
        const qrs = [];
        for (const t of targets) {
          const payload = depositPayload(t.network, t.address);
          const png = await renderDepositQrPng(t.address, payload, depositCaption(t));
          qrs.push({
            network: t.network,
            label: depositLabel(t),
            ...(t.sharedWith?.length ? { sharedWith: t.sharedWith } : {}),
            address: t.address,
            payload,
            png,
            qr_url: managerUrl ? depositQrUrl(managerUrl, t.network, t.address) : undefined,
          });
        }
        logInfo("tool.get_deposit_qr.result", {
          correlationId,
          wallet: entry.name,
          networks: qrs.map((q) => q.network),
        });
        return ok(
          {
            correlationId,
            wallet: entry.name,
            qrs: qrs.map(({ png: _png, ...rest }) => rest),
            note:
              "Each PNG carries the network name above the code and the address below it; images are in the same order as qrs. When showing more than one, still name the network (label) next to each image. " +
              (managerUrl
                ? "If the user cannot see the QR, open qr_url (local-only, 15 minutes) and give the address."
                : "If the user cannot see the QR, call open_wallet_manager and use the QR button next to the address."),
          },
          qrs.map((q) => ({
            type: "image" as const,
            data: q.png.toString("base64"),
            mimeType: "image/png" as const,
          })),
        );
      }),
  );
}
