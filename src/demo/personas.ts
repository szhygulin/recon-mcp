/**
 * Curated showcase wallets for VAULTPILOT_DEMO live mode (issue #371 PR 4).
 *
 * Each persona is a real, on-chain identity that fits a recognizable user
 * archetype. When the user calls `set_demo_wallet({ persona: "..." })`,
 * subsequent reads + prepare_* calls run against these addresses on real
 * chain RPC. The broadcast step is intercepted and returns a simulation
 * envelope (no real signing, no real broadcast). All persona addresses are
 * PUBLIC pubkeys / addresses — sharing them is read-only and carries zero
 * security risk.
 *
 * Multi-address-per-chain is intentional: real users hold multiple
 * accounts; the agent picks the appropriate one via `set_demo_wallet`'s
 * `addressIndex` arg or by enumerating with `get_demo_wallet`. Each persona
 * has at least one address per supported chain (with explicit `null` where
 * the persona's archetype doesn't fit a chain — e.g., stable-saver has no
 * BTC entry because Bitcoin has no native stablecoin lending).
 *
 * Address verification: the addresses below were proposed at PR #378
 * planning time based on public knowledge. Chain state moves; if a
 * persona's archetype no longer fits its address (e.g., the wallet
 * exited every Aave position), swap the address — the persona ID stays
 * stable so consumer code doesn't break.
 */

export type PersonaId =
  | "defi-power-user"
  | "stable-saver"
  | "staking-maxi"
  | "whale";

export interface PersonaAddresses {
  /** EVM address(es) — used for ethereum / arbitrum / polygon / base / optimism. */
  evm: string[];
  /** Solana base58 pubkey(s). */
  solana: string[];
  /** TRON base58 address(es). */
  tron: string[];
  /** Bitcoin address(es). `null` when the persona's shape doesn't fit BTC. */
  bitcoin: string[] | null;
}

export interface Persona {
  id: PersonaId;
  description: string;
  addresses: PersonaAddresses;
}

export const PERSONAS: Record<PersonaId, Persona> = {
  "defi-power-user": {
    id: "defi-power-user",
    description:
      "Active multi-protocol DeFi: Aave + Compound + Uniswap V3 LP + Lido on EVM, Solend/MarginFi on Solana, JustLend on TRON.",
    addresses: {
      evm: [
        "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", // vitalik.eth
        "0x176F3DAb24a159341c0509bB36B833E7fdd0a132", // Justin Sun ETH
        "0x95222290DD7278Aa3Ddd389Cc1E1d165CC4BAfe5", // Beaverbuild
      ],
      solana: ["7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"],
      tron: ["TXmVthrK7n2tdRmAyFx5LerwiNJrn6kTPB"],
      bitcoin: ["bc1qgdjqv0av3rd9j7p4ck4q3uhtfm95mfk0xag5y8"],
    },
  },

  "stable-saver": {
    id: "stable-saver",
    description:
      "Primarily stablecoin lending: large USDC/USDT supply on Aave / Compound, conservative shape, no BTC exposure.",
    addresses: {
      evm: [
        "0x25f2226B597E8F9514B3F68F00f494cF4f286491", // Ethereum Foundation cold wallet
        "0x47ac0Fb4F2D84898e4D9E7b4DaB3C24507a6D503", // Binance hot wallet
      ],
      solana: ["5xoBq7f7CDgZwqHrDBdRWM84ExRetg4gZq93dyJtoSwp"],
      tron: ["TMuA6YqfCeX8EhbfYEg5y7S4DqzSJireY9"],
      bitcoin: null, // BTC has no native stablecoin lending — persona omits it
    },
  },

  "staking-maxi": {
    id: "staking-maxi",
    description:
      "Lido stETH + EigenLayer restaking on Ethereum, Marinade/Jito liquid staking on Solana, TRON staking. No BTC (no native staking).",
    addresses: {
      evm: [
        "0x40B38765696e3d5d8d9d834D8AaD4bB6e418E489", // known stETH staker
        "0xCfFAd3200574698b78f32232aa9D63eABD290703", // known EigenLayer restaker
      ],
      solana: ["Mer1aut5HJN1bj62fxGfUC1NjpJVNDNBMt5MQbTQYc8"],
      tron: ["TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"],
      bitcoin: null, // BTC has no native staking — persona omits it
    },
  },

  whale: {
    id: "whale",
    description:
      "Large multi-chain holdings, light DeFi. Big native balances, mostly hold rather than yield-farm.",
    addresses: {
      evm: [
        "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", // vitalik.eth
        "0x73AF3bcf944a6559933396c1577B257e2054D935", // Whale.fi or similar
      ],
      solana: ["2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S"],
      tron: ["TUNeqc5AohC8H1mbJ7XR3yjWcSeWKKLcTo"],
      bitcoin: ["bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h"], // Binance cold wallet
    },
  },
};

/** All persona IDs, for enumeration / validation. */
export const PERSONA_IDS: PersonaId[] = Object.keys(PERSONAS) as PersonaId[];

/** True iff `id` is a known persona. Narrows the type for callers. */
export function isPersonaId(id: string): id is PersonaId {
  return (PERSONA_IDS as string[]).includes(id);
}
