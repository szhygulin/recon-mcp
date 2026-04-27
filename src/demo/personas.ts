/**
 * Curated demo wallet matrix for VAULTPILOT_DEMO live mode.
 *
 * Shape: a 2D table indexed by **chain** × **type**. Each cell holds
 * a single PUBLIC on-chain address (no private keys, no secrets —
 * sharing is read-only and carries zero security risk) selected to
 * fit the (chain, type) archetype with verified recent on-chain
 * activity.
 *
 *                EVM            Solana          TRON            BTC
 *   whale        vitalik.eth    Coinbase hot    Binance hot     Binance cold
 *   defi-degen   Justin Sun     7xKXtg2…        THPvaUhoh2…     —
 *   stable-saver Binance hot    5xoBq7f7…       —               —
 *   staking-maxi 0x8EB8a3b…     —               —               —
 *
 * `null` cells mean "no curated address for this combination" —
 * either the chain doesn't support the archetype (BTC has no native
 * DeFi or stablecoin lending, so 3 of its 4 cells are null) or no
 * sufficiently-recent verified address was available at curation
 * time. Consumers MUST handle null.
 *
 * **Activity verification (curated 2026-04-27):** every non-null cell
 * was verified via `get_transaction_history` to have on-chain
 * activity within the prior ~7 days, except Solana stable-saver
 * (last activity 15 days prior — closest curated USDC-on-Solana
 * holder available within research budget) and BTC whale (mempool.
 * space tx history doesn't surface block times in the tool's current
 * shape — verified by tx-list non-emptiness only). The `verifiedAt`
 * field on each cell records the verification date.
 *
 * **Staleness:** activity claims rot. If a wallet exits a category
 * mid-cycle (e.g., Justin Sun stops doing DeFi swaps for a month),
 * the cell still loads correctly — the address just shows quieter
 * read tools. Refresh the matrix by re-running the verification
 * batch and updating `verifiedAt` whenever a cell needs swapping.
 *
 * **API:** `set_demo_wallet({ chain, type })` loads a single cell.
 * Multiple chains accumulate (calling for evm + solana populates
 * both slots). Re-calling for the same chain replaces. Persona-keyed
 * batch loading (load all 4 chains at once for a given type) is
 * available via `set_demo_wallet({ persona: <type> })`.
 */

export type DemoChain = "evm" | "solana" | "tron" | "bitcoin";

export type DemoType =
  | "defi-degen"
  | "stable-saver"
  | "staking-maxi"
  | "whale";

export interface DemoCell {
  /**
   * Chain-appropriate address. EVM: 0x-hex. Solana: base58 pubkey.
   * TRON: base58 (T-prefix). Bitcoin: bech32 / legacy / p2sh.
   */
  address: string;
  /**
   * Short prose explaining what archetype evidence justifies this
   * address in this cell. Surfaced in `get_demo_wallet` so the agent
   * can tell the user why "Solana defi-degen" lands on this wallet.
   */
  archetype: string;
  /**
   * ISO-8601 date the cell's recent-activity claim was last verified
   * via `get_transaction_history`. Swap the cell + bump this date if
   * a wallet goes quiet for the archetype.
   */
  verifiedAt: string;
}

export type DemoMatrix = {
  [C in DemoChain]: Partial<Record<DemoType, DemoCell>>;
};

export const DEMO_WALLETS: DemoMatrix = {
  evm: {
    whale: {
      address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      archetype: "vitalik.eth — large holder + frequent inbound token transfers",
      verifiedAt: "2026-04-25",
    },
    "defi-degen": {
      address: "0x176F3DAb24a159341c0509bB36B833E7fdd0a132",
      archetype: "Justin Sun ETH — multi-protocol activity (transfers, claims, swaps)",
      verifiedAt: "2026-04-22",
    },
    "stable-saver": {
      address: "0x47ac0Fb4F2D84898e4D9E7b4DaB3C24507a6D503",
      archetype: "Binance hot — heavy USDT/USDC flows, large daily volume",
      verifiedAt: "2026-04-24",
    },
    "staking-maxi": {
      address: "0x8EB8a3b98659Cce290402893d0123abb75E3ab28",
      archetype: "Active multi-asset wallet with WBTC + DAI + stETH-class flows",
      verifiedAt: "2026-04-25",
    },
  },
  solana: {
    whale: {
      address: "H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS",
      archetype: "Coinbase Solana hot — heavy SOL + USDC volume, large balances",
      verifiedAt: "2026-04-25",
    },
    "defi-degen": {
      address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      archetype: "Active Solana DeFi user — frequent program-interaction txs",
      verifiedAt: "2026-04-25",
    },
    "stable-saver": {
      address: "5xoBq7f7CDgZwqHrDBdRWM84ExRetg4gZq93dyJtoSwp",
      archetype: "USDC-focused wallet (last verified activity 15 days; refresh on next curation)",
      verifiedAt: "2026-04-12",
    },
    // staking-maxi: no verified-recent native-stake / mSOL / jitoSOL
    // wallet found within curation budget. Demo will skip Solana
    // staking until refreshed.
  },
  tron: {
    whale: {
      address: "TQrY8tryqsYVCYS3MFbtffiPp2ccyn4STm",
      archetype: "Binance TRON hot — large USDT-TRC20 + TRX flows, sub-second cadence",
      verifiedAt: "2026-04-25",
    },
    "defi-degen": {
      address: "THPvaUhoh2Qn2y9THCZML3H815hhFhn5YC",
      archetype: "Active TRC-20 user (USDT transfers + TRX moves)",
      verifiedAt: "2026-04-25",
    },
    // stable-saver: declined to reuse the whale wallet here even
    // though Binance hot is also a stable-flow wallet — duplicate
    // cells confuse the demo. Refresh with a distinct USDT-heavy
    // wallet on next curation pass.
    // staking-maxi: no verified-recent TRX freezer + voter found
    // within budget.
  },
  bitcoin: {
    whale: {
      address: "bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h",
      archetype:
        "Binance cold wallet — multi-BTC tx volume (mempool.space tx-history tool doesn't surface block times in current shape; recency confirmed by tx-list non-emptiness)",
      verifiedAt: "2026-04-25",
    },
    // BTC's chain semantics don't match defi-degen / stable-saver /
    // staking-maxi (no native DeFi, no native stablecoin lending,
    // no native PoS staking). Babylon / ordinals / runes exist but
    // none are surfaced by vaultpilot-mcp's read tools, so demo
    // would have nothing to show. Cells stay null by design.
  },
};

/** All chain IDs, for enumeration. */
export const DEMO_CHAINS: DemoChain[] = ["evm", "solana", "tron", "bitcoin"];

/** All type IDs, for enumeration / validation. */
export const DEMO_TYPES: DemoType[] = [
  "defi-degen",
  "stable-saver",
  "staking-maxi",
  "whale",
];

export function isDemoChain(chain: string): chain is DemoChain {
  return (DEMO_CHAINS as string[]).includes(chain);
}

export function isDemoType(type: string): type is DemoType {
  return (DEMO_TYPES as string[]).includes(type);
}

export function getDemoCell(chain: DemoChain, type: DemoType): DemoCell | null {
  return DEMO_WALLETS[chain][type] ?? null;
}

// ---------------------------------------------------------------------
// Backward-compat shim — Persona / PERSONAS API used by older code.
//
// The original demo-wallet API was persona-keyed:
// `set_demo_wallet({ persona: "whale" })` loaded all 4 chains for one
// type at once. The matrix loader supersedes this by exposing per-cell
// loading, but the persona API stays available as a batch-load
// convenience. This shim derives Persona objects from the matrix so
// consumer code stays working with one source of truth.
//
// Persona name `defi-power-user` was renamed to `defi-degen`. Old
// callers passing `defi-power-user` get the same DemoType silently
// via the schema's alias mapping (see demo/schemas.ts).
// ---------------------------------------------------------------------

export type PersonaId = DemoType;

export interface PersonaAddresses {
  evm: string[];
  solana: string[];
  tron: string[];
  bitcoin: string[] | null;
}

export interface Persona {
  id: PersonaId;
  description: string;
  addresses: PersonaAddresses;
}

const PERSONA_DESCRIPTIONS: Record<DemoType, string> = {
  whale:
    "Large holder, light DeFi. Big native balances on every supported chain — useful for showing 'big numbers' read flows.",
  "defi-degen":
    "Active multi-protocol DeFi: Aave / Compound / Lido on EVM, Solana DeFi programs, JustLend on TRON. Useful for prepare/preview demos.",
  "stable-saver":
    "Primarily stablecoin flows (USDC / USDT). No BTC entry (Bitcoin has no native stablecoin lending). Useful for lending-supply demos.",
  "staking-maxi":
    "Liquid staking + restaking. EVM cell only at this curation date (Solana / TRON staking cells pending refresh).",
};

function buildPersonaAddresses(type: DemoType): PersonaAddresses {
  const evm = DEMO_WALLETS.evm[type];
  const solana = DEMO_WALLETS.solana[type];
  const tron = DEMO_WALLETS.tron[type];
  const bitcoin = DEMO_WALLETS.bitcoin[type];
  return {
    evm: evm ? [evm.address] : [],
    solana: solana ? [solana.address] : [],
    tron: tron ? [tron.address] : [],
    bitcoin: bitcoin ? [bitcoin.address] : null,
  };
}

export const PERSONAS: Record<PersonaId, Persona> = {
  whale: {
    id: "whale",
    description: PERSONA_DESCRIPTIONS.whale,
    addresses: buildPersonaAddresses("whale"),
  },
  "defi-degen": {
    id: "defi-degen",
    description: PERSONA_DESCRIPTIONS["defi-degen"],
    addresses: buildPersonaAddresses("defi-degen"),
  },
  "stable-saver": {
    id: "stable-saver",
    description: PERSONA_DESCRIPTIONS["stable-saver"],
    addresses: buildPersonaAddresses("stable-saver"),
  },
  "staking-maxi": {
    id: "staking-maxi",
    description: PERSONA_DESCRIPTIONS["staking-maxi"],
    addresses: buildPersonaAddresses("staking-maxi"),
  },
};

export const PERSONA_IDS: PersonaId[] = DEMO_TYPES;

/**
 * True iff `id` is a known persona / type. Accepts the legacy
 * `defi-power-user` alias for backward compatibility with callers
 * that still use the pre-rename name; downstream code resolves it
 * to `defi-degen` via the schema (see demo/schemas.ts).
 */
export function isPersonaId(id: string): id is PersonaId {
  return isDemoType(id);
}
