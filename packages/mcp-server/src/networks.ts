/** Canonical network identifiers used across the server. No baked env. */

export const EVM_NETWORKS = [
  "ethereum",
  "bsc",
  "polygon",
  "base",
  "arbitrum",
  "optimism",
  "avalanche",
] as const;

export const NON_EVM_NETWORKS = [
  "tron",
  "bitcoin",
  "litecoin",
  "doge",
  "solana",
  "ton",
  "xrp",
] as const;

export const ALL_NETWORKS = [...EVM_NETWORKS, ...NON_EVM_NETWORKS] as const;

export type NetworkId = (typeof ALL_NETWORKS)[number];

/** Human-readable network names for captions (deposit QR, manager). */
export const NETWORK_LABEL: Record<NetworkId, string> = {
  ethereum: "Ethereum",
  bsc: "BSC",
  polygon: "Polygon",
  base: "Base",
  arbitrum: "Arbitrum",
  optimism: "Optimism",
  avalanche: "Avalanche",
  tron: "Tron",
  bitcoin: "Bitcoin",
  litecoin: "Litecoin",
  doge: "Dogecoin",
  solana: "Solana",
  ton: "TON",
  xrp: "XRP",
};

export function networkLabel(network: string): string {
  return NETWORK_LABEL[network as NetworkId] ?? network;
}
