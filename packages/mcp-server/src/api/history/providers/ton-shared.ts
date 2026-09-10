/**
 * Address and opcode helpers shared by the TON history providers (TonCenter,
 * TonAPI). Both indexers emit raw `0:HEX` addresses; the agent gets the
 * user-friendly non-bounceable form.
 */

import { Address } from "@ton/ton";

export type TonAddressBook = Record<string, { user_friendly?: string }>;

/** Raw or friendly TON address → user-friendly form; `book` wins when it has the entry. */
export function tonAddr(
  raw: string | null | undefined,
  book?: TonAddressBook,
): string | null {
  if (!raw) return null;
  const friendly = book?.[raw]?.user_friendly ?? book?.[raw.toUpperCase()]?.user_friendly;
  if (friendly) return friendly;
  try {
    return Address.parse(raw).toString({ bounceable: false });
  } catch {
    return raw;
  }
}

export function tonEquals(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  try {
    return Address.parse(a).equals(Address.parse(b));
  } catch {
    return false;
  }
}

/** Plain transfer: no opcode, or opcode 0 (text comment). */
export function isPlainOpcode(opcode: string | null | undefined): boolean {
  if (!opcode) return true;
  return /^0x0*$/i.test(opcode);
}

export const TON_NATIVE_ASSET = { symbol: "TON", contractAddress: null, decimals: 9 } as const;
