# IronWallet for AI agents

The IronWallet MCP server gives AI agents secure access to a **non-custodial** wallet. Seed phrases stay encrypted on the host and never leave this machine. Agents can retrieve balances, sign locally, transfer tokens, and swap across 10+ networks.

Seed-compatible with the [IronWallet](https://ironwallet.io) app. There is no per-transaction confirmation UI.

**Requirements:** Node.js 20+ (`npx`). Use a dedicated wallet with limited balance.

Product page: [ironwallet.io/ai](https://ironwallet.io/ai). Machine-readable index: [llms.txt](llms.txt).

[![npm](https://img.shields.io/npm/v/@ironwallet/mcp-server)](https://www.npmjs.com/package/@ironwallet/mcp-server) [![Smithery](https://img.shields.io/badge/Smithery-ironwallet%2Fmcp--server-4B32C3)](https://smithery.ai/servers/ironwallet/mcp-server)

Opening this repository in Claude Code starts the wallet MCP via [`.mcp.json`](.mcp.json). See [CLAUDE.md](CLAUDE.md).

## Install

**Cursor:** [ironwallet.io/ai](https://ironwallet.io/ai)

**Claude Code:**

```bash
claude plugin marketplace add ironwallet/ironwallet-agent-kit
claude plugin install ironwallet-mcp@ironwallet
```

**Codex:**

```bash
codex plugin marketplace add ironwallet/ironwallet-agent-kit
codex plugin add ironwallet-mcp@ironwallet
```

**Grok:**

```bash
grok plugin marketplace add ironwallet/ironwallet-agent-kit
grok plugin install ironwallet-mcp --trust
```

Reload so MCP picks up `PATH`. From a local clone, use `.` instead of the GitHub repo.

### MCP only (no plugin)

Manually installed MCP does **not** auto-update with the plugin.

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

## What's included

### Skill

| Skill | When to use |
|-------|-------------|
| **ironwallet-mcp** | Non-custodial wallet: balances, local signing, transfers, swaps, deposit QR. Invoke as `/ironwallet-mcp` |

### Rules

| Rule | What it enforces |
|------|------------------|
| **wallet-transaction-safety** | Hot wallet; no extra confirmation UI; poll status on timeout, never resubmit blindly |
| **seed-phrase-handling** | Recovery phrases and private keys never appear in chat, files, or logs |
| **swap-asset-resolution** | Networks and tokens come from catalog tools, not model memory |

### Agent

| Agent | Purpose |
|-------|---------|
| **ironwallet-operator** | Operate the non-custodial wallet: balances, local signing, transfers, swaps, deposit QR |

### MCP server

`@ironwallet/mcp-server` over stdio. Networks: Ethereum, BSC, Polygon, Base, Arbitrum, Optimism, Avalanche, Tron, Bitcoin, Litecoin, Dogecoin, Solana, XRP, TON.

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

No tool accepts or returns a seed. Import, backup, and delete only in the local browser (`open_wallet_manager` / `backup_url`); deleting asks the user to retype the wallet name.

## Configuration

Nothing to paste into MCP config for normal use. On first launch the server writes a relay API key, keystore wrapping secret, device id, and installation id under `~/.ironwallet-mcp/` (mode `0600`). Override with `IW_RELAY_API_KEY` / `IW_PASSPHRASE` / `IW_DEVICE_ID` only if you must.

The user-facing backup is the **recovery phrase** in the wallet manager, not those files.

## Security

- Seeds are encrypted at rest. They never appear in tool results, agent chat, or backend requests.
- The agent **can move funds without asking again**. Optional wallet policy (`readOnly`, `maxPerTxUsd`, transfer recipient allow-list — set via `set_wallet_policy`) is off by default and applies to both sends and swaps.
- Anyone with the keystore **and** the wrapping secret controls the funds. A leaked seed cannot be revoked.
- Timeout is not always failure: poll status before retrying a send or swap.
- **Do not** put a main wallet here. Use a small hot wallet.

Details and private disclosure: [SECURITY.md](SECURITY.md).

## Contributing

This public tree is a release snapshot. See [CONTRIBUTING.md](CONTRIBUTING.md). Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE)
