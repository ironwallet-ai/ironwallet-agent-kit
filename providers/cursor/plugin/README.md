# IronWallet for Cursor

The IronWallet MCP server gives Cursor secure access to a **non-custodial** wallet. Seed phrases stay encrypted on the host and never leave this machine. The agent can retrieve balances, sign locally, transfer tokens, and swap across 10+ networks.

Seed-compatible with the [IronWallet](https://ironwallet.io) app. There is no per-transaction confirmation UI.

**Requirements:** Node.js 20+ (`npx`). Use a dedicated wallet with limited balance.

Product page: [ironwallet.io/ai](https://ironwallet.io/ai)

## Install

[ironwallet.io/ai](https://ironwallet.io/ai), then enable the IronWallet plugin. Reload so MCP picks up `PATH`.

## Tools

<!-- tools-table -->
| Tool | Purpose | Moves funds? |
|------|---------|:------------:|
| `get_runtime_info` | Running version vs published npm package | no |
| `prepare_update` | Stage the npm update for the next restart | no |
| `list_wallets` | Names, addresses, and `policy` | no |
| `accept_mcp_consent` | Record chat acceptance of the MCP disclaimer | no |
| `create_wallets` | New wallets; returns a browser `backup_url` | no |
| `open_wallet_manager` | Local browser UI to import / create / back up / delete | no |
| `set_wallet_policy` | Replace per-wallet limits (`readOnly`, `maxPerTxUsd`, allow-list) | no |
| `get_deposit_qr` | PNG QR (try chat; else local `qr_url`) | no |
| `get_balance` | Native or token balance | no |
| `get_transaction_history` | Recent txs from public explorers (paged) | no |
| `estimate_transfer` | Fee estimate, no broadcast | no |
| `send_transfer` | Sign locally and send | **yes** |
| `get_operation_status` | Poll a transfer | no |
| `list_swap_networks` | Networks available for swap | no |
| `list_swap_assets` | Sell / buy catalog | no |
| `estimate_swap` | Quote (may expire) | no |
| `execute_swap` | Fresh quote → sign → swap | **yes** |
| `get_swap_status` | Poll a swap | no |
<!-- /tools-table -->

No tool accepts or returns a seed. Import and backup only in the local browser (`open_wallet_manager` / `backup_url`).

Skill: `/ironwallet-mcp`. Agent: `ironwallet-operator`.

## Configuration

Nothing to paste into MCP config for normal use. On first launch the server writes a relay API key, keystore wrapping secret, device id, and installation id under `~/.ironwallet-mcp/` (mode `0600`). Override with `IW_RELAY_API_KEY` / `IW_PASSPHRASE` / `IW_DEVICE_ID` only if you must.

The user-facing backup is the **recovery phrase** in the wallet manager, not those files.

## Security

- Seeds are encrypted at rest. They never appear in tool results, agent chat, or backend requests.
- The agent **can move funds without asking again**.
- Anyone with the keystore **and** the wrapping secret controls the funds. A leaked seed cannot be revoked.
- Timeout is not always failure: poll status before retrying a send or swap.
- **Do not** put a main wallet here. Use a small hot wallet.

Details and private disclosure: [SECURITY.md](../../../SECURITY.md).
