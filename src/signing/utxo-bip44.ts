/**
 * BIP-44 path helpers shared between the Bitcoin and Litecoin USB signers.
 * BTC and LTC differ only in `coin_type` (0 vs 2) and the chain-name used in
 * error messages; the address-type → purpose-number mapping (44/49/84/86)
 * and the path-shape validation are identical.
 */

export const UTXO_ADDRESS_TYPES = [
  "legacy",
  "p2sh-segwit",
  "segwit",
  "taproot",
] as const;

export type UtxoAddressType = (typeof UTXO_ADDRESS_TYPES)[number];

export const UTXO_PURPOSE_BY_TYPE: Record<UtxoAddressType, number> = {
  legacy: 44,
  "p2sh-segwit": 49,
  segwit: 84,
  taproot: 86,
};

export interface ParsedUtxoPath {
  addressType: UtxoAddressType;
  accountIndex: number;
  chain: 0 | 1;
  addressIndex: number;
}

export interface UtxoPathHelpers {
  accountLevelPath(accountIndex: number, addressType: UtxoAddressType): string;
  leafPath(
    accountIndex: number,
    addressType: UtxoAddressType,
    chain: 0 | 1,
    addressIndex: number,
  ): string;
  parsePath(path: string): ParsedUtxoPath | null;
}

export function makeUtxoPathHelpers(opts: {
  /** Display name used in error messages — "Bitcoin" / "Litecoin". */
  chainName: string;
  /** BIP-44 `coin_type` segment — 0 for BTC, 2 for LTC. */
  coinType: number;
  /** Inclusive upper bound on the account index. */
  maxAccountIndex: number;
}): UtxoPathHelpers {
  const { chainName, coinType, maxAccountIndex } = opts;
  const pathRegex = new RegExp(
    `^(44|49|84|86)'/${coinType}'/(\\d+)'/(0|1)/(\\d+)$`,
  );

  function validateAccountIndex(accountIndex: number): void {
    if (
      !Number.isInteger(accountIndex) ||
      accountIndex < 0 ||
      accountIndex > maxAccountIndex
    ) {
      throw new Error(
        `Invalid ${chainName} accountIndex ${accountIndex} — must be an integer in [0, ${maxAccountIndex}].`,
      );
    }
  }

  return {
    accountLevelPath(accountIndex, addressType) {
      validateAccountIndex(accountIndex);
      return `${UTXO_PURPOSE_BY_TYPE[addressType]}'/${coinType}'/${accountIndex}'`;
    },
    leafPath(accountIndex, addressType, chain, addressIndex) {
      validateAccountIndex(accountIndex);
      if (chain !== 0 && chain !== 1) {
        throw new Error(
          `Invalid BIP-32 chain ${chain} — must be 0 (receive) or 1 (change).`,
        );
      }
      if (!Number.isInteger(addressIndex) || addressIndex < 0) {
        throw new Error(
          `Invalid BIP-32 addressIndex ${addressIndex} — must be a non-negative integer.`,
        );
      }
      return `${UTXO_PURPOSE_BY_TYPE[addressType]}'/${coinType}'/${accountIndex}'/${chain}/${addressIndex}`;
    },
    parsePath(path) {
      const m = pathRegex.exec(path);
      if (!m) return null;
      const purpose = Number(m[1]);
      const accountIndex = Number(m[2]);
      const chain = Number(m[3]) as 0 | 1;
      const addressIndex = Number(m[4]);
      if (!Number.isInteger(accountIndex)) return null;
      if (!Number.isInteger(addressIndex)) return null;
      for (const t of UTXO_ADDRESS_TYPES) {
        if (UTXO_PURPOSE_BY_TYPE[t] === purpose) {
          return { addressType: t, accountIndex, chain, addressIndex };
        }
      }
      return null;
    },
  };
}
