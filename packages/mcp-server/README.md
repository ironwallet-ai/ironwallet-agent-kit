# @ironwallet/mcp-server

Local [MCP](https://modelcontextprotocol.io) server for **IronWallet** (`ironwallet-mcp` bin).

The IronWallet MCP server gives AI agents secure access to a **non-custodial** wallet. Seed phrases stay encrypted on the host and never leave this machine — they never pass through the agent. Agents can retrieve balances, sign locally, transfer tokens, and swap across 10+ networks.

Seed-compatible with the [IronWallet](https://ironwallet.io) app.

There is no per-transaction confirmation UI.

> **Hot-wallet only.** Use a dedicated wallet with limited balance. See [Security](#security).

Product page: [ironwallet.io/ai](https://ironwallet.io/ai)

**Requirements:** Node.js 20+ (`npx`).

---

## Install

```bash
npx -y @ironwallet/mcp-server
```

Or add to MCP config (Cursor: `.cursor/mcp.json` or global):

```json
{
  "mcpServers": {
    "ironwallet": {
      "command": "npx",
      "args": ["-y", "@ironwallet/mcp-server"]
    }
  }
}
```

`npx` pulls the latest published build. First launch can take ~30s while dependencies install. If the MCP client times out, run the same command once in a terminal to warm the cache, then reconnect.

The plugin install on [ironwallet.io/ai](https://ironwallet.io/ai) wires this up automatically.

---

## How it works

```
MCP client  →  ironwallet-mcp (stdio)
                    ├── encrypted keystore on disk
                    ├── signs on this machine
                    └── HTTPS to IronWallet backends
```

The mnemonic never appears in tool inputs/outputs, logs meant for the agent, or requests to backends / the LLM / the MCP client’s cloud.

---

## Features

| Area | Capability |
|------|------------|
| **Networks** | Ethereum, BSC, Polygon, Base, Arbitrum, Optimism, Avalanche, Tron, Bitcoin, Litecoin, Dogecoin, Solana, XRP, TON |
| **Wallets** | Create, import, list, deposit QR, and back up (local browser for secrets) |
| **Balances** | Native coins and tokens |
| **Transfers** | Fee estimate and send through IronWallet’s transfer relay |
| **Swaps** | Quotes and execution through IronWallet |
| **Policy** | Optional per-wallet limits (`readOnly`, `maxPerTxUsd`, transfer recipient allow-list) set via `set_wallet_policy`. Applies to `send_transfer` and `execute_swap`. |

---

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

No tool accepts or returns a seed. Import, backup, and delete only in the local browser (`open_wallet_manager` / `backup_url`).

### Wallets

- **Create:** `create_wallets` — the agent gets names and addresses; open `backup_url` in a browser to view and back up recovery phrases.
- **Import / back up:** `open_wallet_manager` — loopback-only page; the phrase is typed or shown only in the browser.
- **Delete:** the Delete button in the manager. A separate confirmation page asks the user to retype the wallet name; a wallet that was never backed up also needs an explicit acknowledgement that its recovery phrase is destroyed. Funds are not moved. There is no MCP tool for this.
- **List:** `list_wallets`
- **Deposit QR:** `get_deposit_qr` — PNG (generated on the fly) plus `qr_url`. Show the image in chat when the host renders it; otherwise open `qr_url`. Pass `network` for one chain. The wallet manager also has a QR button next to each address.

The browser page binds to `127.0.0.1` under an unguessable path and shuts down after 15 minutes of inactivity.

### Transfers

1. `list_wallets` / `get_balance`
2. `estimate_transfer` (optional)
3. `send_transfer`
4. `get_operation_status` when you need to wait on the operation

`send_transfer` may reduce the amount slightly so the fee still fits the balance; the response reports when that happened.

### Swaps

Swaps are a separate flow from transfers.

1. `list_swap_networks`
2. `list_swap_assets` (`direction=from`, then `direction=to` with the chosen sell asset)
3. Copy **network, symbol, address, decimals** from the catalog into `estimate_swap` / `execute_swap` (especially for tokens)
4. `estimate_swap` for a preview, or go straight to `execute_swap`
5. Poll with `get_swap_status` using the `operationId` from `execute_swap` (`estimate_swap` is a quote and has no status)

**Useful options**

- `maxMode: true` — sell as much of the balance as the service allows (fees are accounted for server-side). `amount` can be omitted when `maxMode` is set.
- Omit `address` only for native coins. For tokens, always pass `address` (and ideally `decimals`) from `list_swap_assets`.

**Operational notes**

- Quotes expire. Prefer `execute_swap` (fresh quote). If execute times out, **poll status** before retrying — do not blindly re-run execute.
- Wallet policy: `readOnly` blocks sends and swaps. `maxPerTxUsd` values the transfer amount (or the corrected swap sell amount) in USD at operation time via IronWallet backend rates; when no rate is available the operation is rejected (fail closed). The recipient allow-list applies to `send_transfer`. `set_wallet_policy` replaces the whole policy — read `list_wallets.policy` first.

---

## Configuration

Nothing to paste into MCP config for normal use. On first launch the server writes a relay API key, keystore wrapping secret, and device id under `~/.ironwallet-mcp/` (`keystore-passphrase`, `relay-api-key`, `device-id`; owner-only POSIX `0600` or NTFS ACL on Windows). Set the env vars only to override.

The user-facing backup is the **recovery phrase** in the wallet manager, not those files.

| Variable | Default | Notes |
|----------|---------|-------|
| `IW_PASSPHRASE` | generated locally | Override keystore wrapping secret |
| `IW_READ_ONLY` | `false` | Process-wide: reject `send_transfer` and `execute_swap`. `true`/`1` enable; `false`/`0`/`off`/`no` disable. Distinct from per-wallet `policy.readOnly`. |
| `IW_RELAY_API_KEY` | generated UUID | Override `x-api-key` |
| `IW_DEVICE_ID` | generated UUID | Override the device UUID (stable per keystore directory). Sent as `X-Device-Id: web:<uuid>`; a value that already has a `platform:` prefix is sent unchanged |
| `IW_KEYSTORE_DIR` | `~/.ironwallet-mcp` | Keystore directory |
| `IW_RATES_API_URL` | baked profile | Rates backend for `maxPerTxUsd` valuation. Unset in the profile → USD limits reject (fail closed) |
| `IW_STATIC_RESOURCES_URL` | baked profile | Static asset catalogs (token → rates id) |
| `IW_HTTP_TIMEOUT_MS` | `15000` | General HTTP timeout (1s–120s) |
| `IW_HTTP_FORWARD_TIMEOUT_MS` | `60000` | Longer timeout for broadcast-style calls. A client timeout does not always mean the operation failed — check status |
| `IW_HTTP_RETRIES` | `2` | Retries for safe/idempotent calls; broadcasts are not auto-retried |
| `IW_HISTORY_APIS` | baked profile | JSON `{ "<network>": [{ "kind", "url"? }, …] }` — per-network chain of history indexers for `get_transaction_history`, tried in order. Kinds: `etherscan`, `nodereal`, `tronscan`, `trongrid`, `esplora`, `blockcypher`, `solana-rpc`, `toncenter`, `tonapi`, `xrp-rpc` |
| `IW_TON_API_KEY` | unset | TonCenter API key. Keyless TonCenter is ~1 request/s per IP (shared by every process behind the same NAT) |
| `IW_TONAPI_KEY` | unset | tonapi.io Bearer token for the `tonapi` history fallback; keyless is ~1 request/s per IP |
| `IW_LOG_ENABLED` | `1` | JSONL diagnostics to a log file (`0` to disable) |
| `IW_LOG_FILE` | `{keystoreDir}/logs/iw-mcp-YYYY-MM-DD.jsonl` | Log path |
| `IW_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `IW_LOG_STDERR` | `0` | Mirror logs to stderr (stdout is reserved for MCP) |

---

## Security

- Seeds are encrypted at rest. They never appear in tool results, agent chat, or backend requests.
- The agent **can move funds without asking again**. Optional wallet policy (`readOnly`, `maxPerTxUsd`, transfer recipient allow-list — set via `set_wallet_policy`) is off by default and applies to both `send_transfer` and `execute_swap`.
- Anyone with the keystore **and** the wrapping secret controls the funds. A leaked seed cannot be revoked.
- Timeout is not always failure: poll status before retrying a send or swap.
- Desktop / stdio only. A phone or remote agent would need a design where signing stays on a trusted device.
- **Do not** put a main wallet here. Use a small hot wallet.

Details and private disclosure: [SECURITY.md](../../SECURITY.md).

## License

[MIT](LICENSE)
