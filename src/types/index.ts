// Shared domain types used across all modules.

/**
 * EVM chains supported by the server. Intentionally kept narrow so every
 * `Record<SupportedChain, …>` table in the codebase continues to represent
 * "per-EVM-chain" configuration — viem clients, Aave/Compound/Uniswap
 * addresses, numeric chain IDs, etc.
 *
 * Non-EVM chains (currently only TRON) live in `SupportedNonEvmChain`, and
 * the `AnyChain` union below is what cross-chain entry points (tool inputs,
 * portfolio summary) accept. This split keeps TRON strictly additive: EVM
 * internals don't need to learn that TRON exists.
 */
export type SupportedChain = "ethereum" | "arbitrum" | "polygon" | "base" | "optimism";

export const SUPPORTED_CHAINS: readonly SupportedChain[] = [
  "ethereum",
  "arbitrum",
  "polygon",
  "base",
  "optimism",
] as const;

/** Non-EVM chains. Kept as its own union so EVM-only tables keep their type. */
export type SupportedNonEvmChain = "tron" | "solana";

export const SUPPORTED_NON_EVM_CHAINS: readonly SupportedNonEvmChain[] = [
  "tron",
  "solana",
] as const;

/** Any chain the server knows about — EVM or non-EVM. */
export type AnyChain = SupportedChain | SupportedNonEvmChain;

export const ALL_CHAINS: readonly AnyChain[] = [
  ...SUPPORTED_CHAINS,
  ...SUPPORTED_NON_EVM_CHAINS,
] as const;

export function isEvmChain(c: AnyChain): c is SupportedChain {
  return (SUPPORTED_CHAINS as readonly string[]).includes(c);
}

export type RpcProvider = "infura" | "alchemy" | "custom";

/** Numeric chain IDs for the chains we support. */
export const CHAIN_IDS: Record<SupportedChain, number> = {
  ethereum: 1,
  arbitrum: 42161,
  polygon: 137,
  base: 8453,
  optimism: 10,
};

export const CHAIN_ID_TO_NAME: Record<number, SupportedChain> = {
  1: "ethereum",
  42161: "arbitrum",
  137: "polygon",
  8453: "base",
  10: "optimism",
};

/**
 * TRON mainnet chain id, as used by the WalletConnect `tron:` namespace and
 * the TronGrid mainnet endpoint. The numeric value is 0x2b6653dc (728126428),
 * the first 4 bytes of the genesis block hash.
 */
export const TRON_CHAIN_ID = 728126428;

/** A token balance with optional USD valuation. */
export interface TokenAmount {
  token: `0x${string}`;
  symbol: string;
  decimals: number;
  /** Raw integer amount as a decimal string (e.g. "1000000" for 1 USDC). */
  amount: string;
  /** Human-readable amount (e.g. "1.0" for 1 USDC). */
  formatted: string;
  valueUsd?: number;
  priceUsd?: number;
  /**
   * True when we could not resolve a USD price for this token. `valueUsd` is
   * `undefined` rather than 0, and portfolio totals will NOT include this
   * balance — callers should flag it to the user instead of silently treating
   * it as worthless.
   */
  priceMissing?: boolean;
}

/**
 * Per-subsystem status reported alongside a portfolio summary, so callers can
 * distinguish "no Aave position" (covered:true, positions empty) from "Aave
 * fetch failed" (covered:false, errored:true) from "not attempted" (covered:
 * false, errored:false — e.g. Morpho Blue, which requires caller-supplied
 * market ids and so has no on-chain enumeration path from a wallet).
 */
export interface CoverageStatus {
  covered: boolean;
  errored?: boolean;
  /** Free-form message explaining why `covered` is false when it is. */
  note?: string;
}

export interface PortfolioCoverage {
  aave: CoverageStatus;
  compound: CoverageStatus;
  morpho: CoverageStatus;
  uniswapV3: CoverageStatus;
  staking: CoverageStatus;
  /**
   * TRON balance fetch coverage. `covered:false, errored:false` means no TRON
   * address was queried (treated like Morpho's "not attempted"); errored:true
   * means a TronGrid call failed and TRX/TRC-20 are missing from totals.
   */
  tron?: CoverageStatus;
  /**
   * TRON staking fetch coverage — independent of the balance fetch so a
   * getReward/account outage doesn't mask that balances loaded fine.
   */
  tronStaking?: CoverageStatus;
  /**
   * Solana balance fetch coverage (SOL + SPL). `covered:false, errored:false`
   * means no Solana address was queried; errored:true means the Solana RPC
   * call failed and SOL/SPL are missing from totals. Staking coverage is
   * deferred to Phase 2.
   */
  solana?: CoverageStatus;
  /** Number of token balances whose USD valuation could not be resolved. */
  unpricedAssets: number;
  /**
   * Structured list of which specific tokens couldn't be priced — one entry
   * per affected balance. Previously only `unpricedAssets: N` (a count) was
   * surfaced, which left the agent unable to tell the user WHICH balance
   * was dropped from USD totals. With this list the agent can produce a
   * concrete warning like "705 MATIC on polygon couldn't be priced and isn't
   * included in the total" instead of a bare integer. Absent when
   * `unpricedAssets === 0` to keep happy-path responses lean (issue #94).
   */
  unpricedAssetsDetail?: UnpricedAsset[];
}

/**
 * A single unpriced balance the portfolio couldn't value in USD. The chain
 * is a string union spanning EVM + TRON + Solana so one array describes the
 * cross-chain set without needing per-chain buckets.
 */
export interface UnpricedAsset {
  chain: SupportedChain | "tron" | "solana";
  symbol: string;
  /** Human-readable balance (already-decimals-applied), e.g. "705.141". */
  amount: string;
}

export interface LendingPosition {
  protocol: "aave-v3";
  chain: SupportedChain;
  collateral: TokenAmount[];
  debt: TokenAmount[];
  totalCollateralUsd: number;
  totalDebtUsd: number;
  netValueUsd: number;
  /** Aave health factor (>1 safe, <1 liquidatable). Infinity if no debt. */
  healthFactor: number;
  /** Weighted average liquidation threshold (bps, e.g. 8250 = 82.5%). */
  liquidationThreshold: number;
  /** Weighted average loan-to-value (bps). */
  ltv: number;
  /**
   * Per-asset warnings derived from reserve.isPaused / reserve.isFrozen. Scoped
   * to assets the user actually holds or borrows — a pause on a market they
   * aren't in isn't a surprise for their position. Paused = all ops blocked
   * until governance unpauses; Frozen = no new supplies/borrows but existing
   * positions can still withdraw/repay.
   */
  warnings?: string[];
}

/**
 * A Compound V3 (Comet) position, flattened enough to slot alongside Aave in a unified
 * lending bucket. Kept as a thin projection of modules/compound/index.ts#CompoundPosition
 * so the types module doesn't need to pull in compound internals.
 */
export interface CompoundLendingPosition {
  protocol: "compound-v3";
  chain: SupportedChain;
  market: string;
  marketAddress: `0x${string}`;
  baseSupplied: TokenAmount | null;
  baseBorrowed: TokenAmount | null;
  collateral: TokenAmount[];
  totalCollateralUsd: number;
  totalDebtUsd: number;
  totalSuppliedUsd: number;
  netValueUsd: number;
  /**
   * Governance-paused actions on this Comet market. Subset of
   * {supply, transfer, withdraw, absorb, buy}. Omitted when nothing is paused
   * so the JSON shape of healthy positions doesn't change.
   */
  pausedActions?: ("supply" | "transfer" | "withdraw" | "absorb" | "buy")[];
}

/**
 * A Morpho Blue position, flattened enough to slot alongside Aave and Compound in a
 * unified lending bucket. Thin projection of modules/morpho/index.ts#MorphoPosition
 * so the types module doesn't need to pull in morpho internals.
 */
export interface MorphoLendingPosition {
  protocol: "morpho-blue";
  chain: SupportedChain;
  marketId: `0x${string}`;
  loanToken: `0x${string}`;
  collateralToken: `0x${string}`;
  lltv: string;
  supplied: TokenAmount | null;
  borrowed: TokenAmount | null;
  collateral: TokenAmount | null;
  totalCollateralUsd: number;
  totalDebtUsd: number;
  totalSuppliedUsd: number;
  netValueUsd: number;
}

/** Any lending/borrowing position reported by the portfolio aggregator. */
export type LendingPositionUnion =
  | LendingPosition
  | CompoundLendingPosition
  | MorphoLendingPosition;

export interface LPPosition {
  protocol: "uniswap-v3";
  chain: SupportedChain;
  tokenId: string;
  token0: TokenAmount;
  token1: TokenAmount;
  /** Fee tier in hundredths of a bip (500 = 0.05%, 3000 = 0.30%, 10000 = 1.0%). */
  feeTier: number;
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  inRange: boolean;
  liquidity: string;
  /**
   * Fees that have been checkpointed into NonfungiblePositionManager.tokensOwed
   * (e.g. by a prior collect/burn touch). Fees accrued since the last
   * checkpoint are NOT included — to see the full collectable amount, the
   * caller would need to simulate collect() against fork state. Treat this as
   * a LOWER BOUND on what a collect would return.
   */
  tokensOwedCached0: TokenAmount;
  tokensOwedCached1: TokenAmount;
  /**
   * USD value derived from token amounts computed at the current tick. This
   * is an approximation: withdrawing the position at a different price would
   * yield different amounts. Flagged as `valueUsdIsApproximate: true` so
   * callers don't display this as a precise number.
   */
  totalValueUsd: number;
  valueUsdIsApproximate: true;
}

export interface StakingPosition {
  protocol: "lido" | "eigenlayer";
  chain: SupportedChain;
  stakedAmount: TokenAmount;
  /** Current APR as a decimal (0.035 = 3.5%). */
  apr?: number;
  /** Optional delegation info (for EigenLayer). */
  delegatedTo?: `0x${string}`;
  /** Extra protocol-specific details (e.g. strategy address for EigenLayer). */
  meta?: Record<string, string | number | boolean>;
}

export interface PrivilegedRole {
  role: string;
  holder: `0x${string}`;
  isContract: boolean;
  isMultisig: boolean;
  hasTimelock: boolean;
  timelockDelaySeconds?: number;
}

export interface SecurityReport {
  address: `0x${string}`;
  chain: SupportedChain;
  isVerified: boolean;
  isProxy: boolean;
  implementation?: `0x${string}`;
  admin?: `0x${string}`;
  dangerousFunctions: string[];
  privilegedRoles: PrivilegedRole[];
}

/**
 * A TRON token balance. Shaped like TokenAmount but with a base58 `token`
 * address (TRC-20 contracts are base58, starting with 'T') and a `chain`
 * discriminator so consumers can tell TRC-20 apart from ERC-20 at runtime.
 * Kept separate from TokenAmount so existing EVM readers don't grow a
 * `chain: "tron"` branch they'd never exercise.
 */
export interface TronBalance {
  chain: "tron";
  /** Base58 TRC-20 contract address (prefix `T`), or "native" for TRX. */
  token: string;
  symbol: string;
  decimals: number;
  amount: string;
  formatted: string;
  valueUsd?: number;
  priceUsd?: number;
  priceMissing?: boolean;
}

/**
 * Solana balance shape — a parallel to TronBalance for SOL + SPL tokens.
 * `token` is a base58 SPL mint address (~32-44 chars), or "native" for SOL.
 * SPL balances come from Associated Token Accounts but we surface them by
 * mint; the ATA is an implementation detail the caller shouldn't care about.
 */
export interface SolanaBalance {
  chain: "solana";
  /** Base58 SPL mint address, or "native" for SOL. */
  token: string;
  symbol: string;
  decimals: number;
  amount: string;
  formatted: string;
  valueUsd?: number;
  priceUsd?: number;
  priceMissing?: boolean;
}

/**
 * Solana slice of a portfolio summary. Parallel to TronPortfolioSlice.
 * Phase 1 does not enumerate native validator staking; defer to Phase 2.
 */
export interface SolanaPortfolioSlice {
  /** Base58 Solana address the balances were resolved for. */
  address: string;
  native: SolanaBalance[];
  spl: SolanaBalance[];
  walletBalancesUsd: number;
}

/**
 * TRON slice of a portfolio summary. Contains the TRON-specific address the
 * balances were fetched for (base58, which can't fit into the `wallet:
 * 0x${string}` field on PortfolioSummary), TRX native balance, and TRC-20
 * balances. Wallet-level coverage for TRON is tracked via
 * PortfolioCoverage.tron.
 */
export interface TronPortfolioSlice {
  /** Base58 TRON address the balances were resolved for. */
  address: string;
  native: TronBalance[];
  trc20: TronBalance[];
  walletBalancesUsd: number;
  /**
   * Staking position (frozen TRX, pending unfreezes, claimable rewards).
   * Absent when the portfolio aggregator chose not to fetch staking (or
   * when the TRON staking fetch failed — see PortfolioCoverage.tronStaking).
   */
  staking?: TronStakingSlice;
}

/**
 * A single "frozen for resource" entry under TRON's Stake 2.0 model. Users
 * freeze TRX to obtain BANDWIDTH or ENERGY; the frozen TRX is what underlies
 * their voting rights. Amount is reported in SUN (raw) + TRX (formatted).
 */
export interface TronFrozenEntry {
  type: "bandwidth" | "energy";
  /** Raw SUN (1 TRX = 1_000_000 SUN). */
  amount: string;
  /** Human-formatted TRX. */
  formatted: string;
  valueUsd?: number;
}

/**
 * A pending unfreeze — the user initiated unstaking but the lockup window
 * (14 days on mainnet) hasn't elapsed yet. `unlockAt` is the ISO timestamp
 * after which `withdrawExpireUnfreeze` can claim the TRX back to liquid.
 */
export interface TronPendingUnfreeze {
  type: "bandwidth" | "energy";
  amount: string;
  formatted: string;
  /** ISO 8601 timestamp when the TRX becomes withdrawable. */
  unlockAt: string;
  valueUsd?: number;
}

/**
 * Claimable voting rewards (distributed by the Super Representative the user
 * voted for). Claiming requires a WithdrawBalance tx, landing in Phase 2.
 */
export interface TronClaimableReward {
  amount: string;
  formatted: string;
  valueUsd?: number;
}

/**
 * Live resource meter for a TRON account, in consumable UNITS (not TRX).
 * Units are what each contract call charges against; frozen TRX only
 * determines how many units you receive per day. `used` rolls off linearly
 * over the 24h regen window, so `available = limit - used` is the
 * instantaneous remaining headroom.
 */
export interface TronResourceMeter {
  /** Units consumed in the current 24h window. */
  usedUnits: number;
  /** Total units available per 24h window at current freeze level. */
  limitUnits: number;
  /** `limitUnits - usedUnits` — immediately consumable. */
  availableUnits: number;
}

/**
 * Live account-resource snapshot from TronGrid's `/wallet/getaccountresource`.
 * Distinct from `TronFrozenEntry`: that's the frozen TRX backing the
 * resource, this is the units-available-right-now meter.
 *
 * Bandwidth has two sub-pools: `free` (600 units/day granted to every
 * account, independent of stake) and `staked` (proportional to frozen TRX).
 * TronGrid returns them as separate fields; we expose both because a fresh
 * account with no stake still has the free pool and agents need to reason
 * about it.
 */
export interface TronAccountResources {
  bandwidth: {
    free: TronResourceMeter;
    staked: TronResourceMeter;
  };
  energy: TronResourceMeter;
  /**
   * Voting power derived from frozen TRX (1 TRX = 1 vote). `used` is how
   * many votes are currently cast across all SRs; `available` is the
   * unallocated headroom a new `prepare_tron_vote` can spend.
   */
  votingPower: TronResourceMeter;
}

/**
 * TRON staking view: frozen resources, pending unfreezes, claimable rewards.
 * Totals roll up into the portfolio's `tronUsd` via `totalStakedUsd`.
 */
export interface TronStakingSlice {
  address: string;
  claimableRewards: TronClaimableReward;
  frozen: TronFrozenEntry[];
  pendingUnfreezes: TronPendingUnfreeze[];
  /**
   * Live consumable-units meter (independent of frozen TRX). Absent only
   * when TronGrid's `/wallet/getaccountresource` fails — the rest of the
   * staking slice still returns.
   */
  resources?: TronAccountResources;
  /** Frozen + pending-unfreeze + claimable, in TRX (formatted). */
  totalStakedTrx: string;
  /** USD value of everything above at current TRX price. */
  totalStakedUsd: number;
}

/**
 * A single Super Representative / SR candidate entry from TronGrid's
 * `/wallet/listwitnesses`. Ranks are 1-based by voteCount DESC; active SRs
 * are rank ≤ 27 (those that actually produce blocks and distribute voter
 * rewards). Candidates have rank > 27 and receive no voter rewards.
 */
export interface TronWitnessInfo {
  /** Base58 TRON address (prefix T). */
  address: string;
  /** SR operator URL (self-declared; not validated). */
  url?: string;
  /** Total vote weight for this SR, as a decimal string (1 frozen TRX = 1 vote). */
  voteCount: string;
  /** True iff rank ≤ 27 — this SR produces blocks. */
  isActive: boolean;
  /** 1-based rank by voteCount DESC. */
  rank: number;
  totalProduced?: number;
  totalMissed?: number;
  /**
   * Rough annualised voter APR estimate as a decimal fraction (0.04 = 4 %).
   * Computed from mainnet reward constants (160 TRX/block voter pool, ~28 800
   * blocks/day, 365 days/year) divided by the total vote weight across the
   * top 127 witnesses — the APR is therefore roughly uniform for every
   * witness in the top 127. Witnesses ranked > 127 get 0. This is an
   * ESTIMATE — actual rewards depend on per-SR commission, missed blocks,
   * chain-param changes, and competing voters joining/leaving between your
   * vote tx and reward claim.
   */
  estVoterApr?: number;
}

/** The wallet's current vote allocation from `account.votes`. */
export interface TronVoteAllocation {
  /** Base58 SR address the vote is cast for. */
  address: string;
  /** Integer vote count (1 vote = 1 frozen TRX of TRON Power). */
  count: number;
}

export interface TronWitnessList {
  witnesses: TronWitnessInfo[];
  /** Present only when the caller passed `address`. */
  userVotes?: TronVoteAllocation[];
  /**
   * Total TRON Power available to the caller's wallet (= integer TRX frozen
   * under Stake 2.0, summed across bandwidth + energy). Set when `address`
   * is passed.
   */
  totalTronPower?: number;
  /** Sum of userVotes[].count. Set when `address` is passed. */
  totalVotesCast?: number;
  /** totalTronPower − totalVotesCast, floored at 0. Set when `address` is passed. */
  availableVotes?: number;
}

/** Per-wallet slice of a multi-wallet portfolio, or a stand-alone single-wallet summary. */
export interface PortfolioSummary {
  wallet: `0x${string}`;
  chains: SupportedChain[];
  walletBalancesUsd: number;
  lendingNetUsd: number;
  lpUsd: number;
  stakingUsd: number;
  totalUsd: number;
  perChain: Record<SupportedChain, number>;
  /**
   * TRON totals folded into the same number as EVM. Present when the caller
   * passed a `tronAddress` (or TRON is in the default chain set and an
   * address was resolvable).
   */
  tronUsd?: number;
  /**
   * TRON staking USD (frozen + pending-unfreeze + claimable). Already included
   * in `tronUsd` — this field surfaces it separately for UI. Present only when
   * staking was fetched successfully.
   */
  tronStakingUsd?: number;
  /**
   * Solana totals folded into the same aggregate as EVM/TRON. Present when
   * the caller passed a `solanaAddress`. Phase 1 covers balances only
   * (SOL native + SPL via ATAs); staking lands in Phase 2.
   */
  solanaUsd?: number;
  breakdown: {
    native: TokenAmount[];
    erc20: TokenAmount[];
    lending: LendingPositionUnion[];
    lp: LPPosition[];
    staking: StakingPosition[];
    /** TRON slice — absent when no TRON address was queried. */
    tron?: TronPortfolioSlice;
    /** Solana slice — absent when no Solana address was queried. */
    solana?: SolanaPortfolioSlice;
  };
  coverage: PortfolioCoverage;
}

/** Multi-wallet portfolio aggregation. */
export interface MultiWalletPortfolioSummary {
  wallets: `0x${string}`[];
  chains: SupportedChain[];
  totalUsd: number;
  walletBalancesUsd: number;
  lendingNetUsd: number;
  lpUsd: number;
  stakingUsd: number;
  perChain: Record<SupportedChain, number>;
  perWallet: PortfolioSummary[];
  coverage: PortfolioCoverage;
}

/**
 * Unsigned TRON transaction. Shape is unavoidably different from EVM:
 * TronGrid builds the tx server-side (raw_data + raw_data_hex) and the
 * device signs the serialized raw_data_hex. We keep the TRON tx shape
 * separate from UnsignedTx so send_transaction's EVM-only security pipeline
 * (eth_call re-simulation, chain-id check, spender allowlist) can't be
 * silently shortcut by a TRON handle masquerading as an EVM one.
 *
 * Phase 3 (this release) routes TRON handles through `send_transaction`:
 * the USB HID signer (@ledgerhq/hw-app-trx) verifies the device address
 * matches `from`, signs `rawDataHex`, and broadcasts via TronGrid.
 */
export interface UnsignedTronTx {
  chain: "tron";
  /** Discriminator for the preview + future signer branching. */
  action:
    | "native_send"
    | "trc20_send"
    | "claim_rewards"
    | "freeze"
    | "unfreeze"
    | "withdraw_expire_unfreeze"
    | "vote";
  /** Base58 owner address (prefix T). */
  from: string;
  /** TronGrid-returned transaction ID (sha256 of raw_data_hex, hex string). */
  txID: string;
  /** TronGrid's raw_data object — opaque to us; serialized in raw_data_hex. */
  rawData: unknown;
  /** Hex-encoded raw_data used by the signer. */
  rawDataHex: string;
  /** Human-readable description for the preview. */
  description: string;
  decoded: {
    functionName: string;
    args: Record<string, string>;
  };
  /**
   * Fee limit in SUN, present on contract calls (TRC-20 transfers require it;
   * TronGrid rejects triggersmartcontract without one). Absent on native TRX
   * sends and WithdrawBalance — those pay bandwidth only.
   */
  feeLimitSun?: string;
  /**
   * Energy units the pre-flight triggerconstantcontract call consumed. Only
   * present on contract calls where we pre-flight (TRC-20 transfers). The
   * on-chain burn will be within a few percent of this number.
   */
  estimatedEnergyUsed?: string;
  /**
   * Estimated fee in SUN that will actually burn on-chain — energy units
   * times the mainnet energy price (420 sun/energy as of 2024-10). The
   * preview shows this alongside `feeLimitSun` so the user can see
   * "expected ~15 TRX" next to "cap 100 TRX" and not think the cap is the
   * charge.
   */
  estimatedEnergyCostSun?: string;
  /** Opaque handle — see tron-tx-store.ts. Phase 3 signer consumes this. */
  handle?: string;
  /**
   * Pre-sign verification payload, stamped by `issueTronHandle` on every
   * prepared TRON tx. Optional during rollout; flipped to required after
   * all call sites are updated.
   */
  verification?: TxVerification;
}

/**
 * Unsigned Solana transaction. Parallel to `UnsignedTronTx` — kept separate
 * from `UnsignedTx` so `send_transaction`'s EVM-only security pipeline
 * (eth_call re-simulation, EIP-1559 pin, spender allowlist) can't be
 * silently shortcut by a Solana handle, and parallel to `UnsignedTronTx`
 * because Solana's wire format (Ed25519 sig over a serialized tx message)
 * is its own thing.
 *
 * Signing path: USB HID via `@ledgerhq/hw-app-solana` — Ledger Live's
 * WalletConnect integration does NOT expose Solana accounts, so we mirror
 * the TRON USB HID architecture (see `project_ledger_live_solana_wc.md`).
 */
export interface UnsignedSolanaTx {
  chain: "solana";
  /**
   * Discriminator for the preview + future signer branching.
   *
   * - `native_send` / `spl_send` — user-facing transfers. Durable-nonce-
   *   protected (ix[0] = nonceAdvance); every send refuses to build until
   *   the wallet has an initialized nonce account.
   * - `nonce_init` — one-time setup: createAccountWithSeed + nonceInitialize.
   *   Runs in legacy recent-blockhash mode (no nonce to use yet).
   * - `nonce_close` — teardown: nonceAdvance + nonceWithdraw. Drains the
   *   rent-exempt balance back to the user's main wallet.
   */
  action: "native_send" | "spl_send" | "nonce_init" | "nonce_close" | "jupiter_swap";
  /** Base58 owner address (44-char ed25519 pubkey). */
  from: string;
  /**
   * Base64-encoded serialized Solana tx MESSAGE (what the Ledger Solana app
   * signs). Post-sign, broadcast rebuilds the full tx = message + signature.
   * Message bytes bake the recent blockhash, fee payer, all instructions
   * and accounts — tampering with any of these at send time will cause
   * either the device address check or the on-chain signature verification
   * to fail.
   *
   * Pinned by `preview_solana_send` with a fresh blockhash, immediately before
   * signing. `prepare_solana_*` stores a draft (no blockhash); the pinned
   * form only exists after preview runs. `send_transaction` requires it.
   */
  messageBase64: string;
  /**
   * Blockhash baked into the message, pinned at `preview_solana_send` time.
   * Solana txs are valid for ~150 blocks (~60s) from this hash's slot, so
   * the preview → send window is bounded — `preview_solana_send` emits a
   * fresh hash right before broadcast so the full window is available.
   */
  recentBlockhash: string;
  /**
   * Last block height at which `recentBlockhash` remains valid. Captured
   * from `getLatestBlockhash` at pin time; carried through broadcast and
   * surfaced by `send_transaction` so the subsequent status-poller can
   * tell "dropped" (current slot > this) from "not-yet-propagated" when
   * `getSignatureStatuses` returns null.
   */
  lastValidBlockHeight?: number;
  /** Human-readable description for the preview. */
  description: string;
  decoded: {
    functionName: string;
    args: Record<string, string>;
  };
  /**
   * Rent cost in lamports when this tx includes a
   * `createAssociatedTokenAccount` instruction (recipient doesn't hold the
   * mint yet). Absent when the tx is a plain transfer. Surfaced so the
   * preview can say "+0.00204 SOL rent to create recipient's USDC account".
   */
  rentLamports?: number;
  /**
   * Priority fee (micro-lamports per compute unit) baked into the message.
   * Present only when `getRecentPrioritizationFees` indicated network
   * congestion at prepare time and we injected ComputeBudget instructions.
   * Absent means "no priority fee; base fee only".
   */
  priorityFeeMicroLamports?: number;
  /** Compute-unit limit when ComputeBudget was added. */
  computeUnitLimit?: number;
  /** Estimated total fee in lamports (base + priority). For the preview. */
  estimatedFeeLamports?: number;
  /** Opaque handle — see solana-tx-store.ts. `send_transaction` consumes this. */
  handle?: string;
  /**
   * Pre-sign verification payload, stamped by `issueSolanaHandle` on every
   * prepared Solana tx. Mirrors the TRON / EVM verification shape.
   */
  verification?: TxVerification;
  /**
   * Durable-nonce metadata — present when ix[0] = SystemProgram.nonceAdvance.
   * For `native_send` / `spl_send` / `nonce_close` this is always set; for
   * `nonce_init` it's absent (that's the tx that CREATES the nonce account;
   * it has no nonce to consume yet). Surfaced for the summary renderer
   * (`Nonce: <short addr>` bullet) and for future nonce-aware dropped-tx
   * polling (`getNonceAccountValue` to detect advance vs. stuck).
   */
  nonce?: {
    account: string;
    authority: string;
    value: string;
  };
}

/**
 * Per-argument decode from the calldata — one entry per ABI input field.
 * `valueHuman` is populated only when we can apply decimals + symbol (known
 * ERC-20 tokens via `TOKEN_META`). For everything else, `value` is the raw
 * stringified bigint / address / bytes and callers render that directly.
 */
export interface DecodedArg {
  name: string;
  type: string;
  value: string;
  valueHuman?: string;
}

/**
 * Local decode of the exact calldata that will be signed. Built from the
 * static ABI registry in `src/abis/*` via viem's `decodeFunctionData`. Never
 * calls a network — if the destination isn't in our registry, `source` is
 * `"none"` and the user is told to rely entirely on the swiss-knife URL.
 */
export interface HumanDecode {
  /** Function name (`"supply"`), or `"nativeTransfer"` / `"unknown"`. */
  functionName: string;
  /** Full signature like `supply(address,uint256,address,uint16)`. */
  signature?: string;
  args: DecodedArg[];
  /** `"local-abi"` when decoded from our ABI registry, `"native"` for pure ETH sends, `"none"` when unknown destination. */
  source: "local-abi" | "native" | "none";
}

/**
 * Pre-sign verification payload — attached to EVERY prepared transaction
 * unconditionally. The user is expected to open `decoderUrl` in a browser,
 * compare what swiss-knife.xyz decodes against `humanDecode` in chat, and
 * only approve on Ledger if the two agree. The `payloadHash` is a
 * domain-tagged keccak256 that can be recomputed independently from the
 * swiss-knife URL params and is re-checked at send time against the exact
 * bytes forwarded to WalletConnect (the bytes-we-previewed == bytes-we-sign
 * proof).
 */
export interface TxVerification {
  /** keccak256 of `("VaultPilot-txverify-v1:" ‖ chainId ‖ to ‖ value ‖ data)` for EVM; `("VaultPilot-txverify-v1:tron:" ‖ rawDataHex)` for TRON. */
  payloadHash: `0x${string}`;
  /** First 8 hex chars (no `0x`) of `payloadHash` — short enough to read off a Ledger screen and eyeball-match. */
  payloadHashShort: string;
  /** swiss-knife.xyz decoder URL with calldata, address, chainId preloaded. EVM only; absent when calldata is too large to fit or on TRON. */
  decoderUrl?: string;
  /** Fallback when `decoderUrl` can't be built — short instructions telling the user to paste calldata/address/chainId manually. */
  decoderPasteInstructions?: string;
  /** Local decode of the calldata (viem + ABI registry). */
  humanDecode: HumanDecode;
  /** Canonical comparison string `<chainId>:<to>:<value>:<data>` — exactly the four fields fed into the fingerprint. */
  comparisonString: string;
}

/** Unsigned transaction, ready to be sent to Ledger Live for signing. */
export interface UnsignedTx {
  chain: SupportedChain;
  to: `0x${string}`;
  data: `0x${string}`;
  /** Value in wei as a decimal string (so JSON-safe). */
  value: string;
  from?: `0x${string}`;
  /** Human-readable description (e.g. "Supply 1.0 USDC to Aave V3 on Ethereum"). */
  description: string;
  /** Decoded function name + args for display. */
  decoded?: {
    functionName: string;
    args: Record<string, string>;
  };
  /** Estimated gas as a decimal string. */
  gasEstimate?: string;
  /** Estimated gas cost in USD. */
  gasCostUsd?: number;
  /**
   * Result of an eth_call simulation against the current chain state. `ok:false`
   * with a revertReason is expected on the follow-up tx of an approve→action
   * pair at prepare time (the approve hasn't been mined yet). At sign time, the
   * same simulation is re-run and a revert aborts the signing path.
   */
  simulation?: {
    ok: boolean;
    revertReason?: string;
  };
  /** If this tx is a prerequisite (e.g. ERC-20 approve), the follow-up tx is in `next`. */
  next?: UnsignedTx;
  /**
   * Opaque handle issued by the tx-store when the prepared tx is returned to
   * the caller. `send_transaction` accepts ONLY this handle — raw calldata is
   * not acceptable, which binds the signed tx to the previewed one and closes
   * the prompt-injection → arbitrary-signing path.
   */
  handle?: string;
  /**
   * Pre-sign verification payload — decoder URL, local decode, and a
   * domain-tagged payload hash. Stamped by `issueHandles` on every prepared
   * EVM tx. Optional during rollout; flipped to required once all call
   * sites are updated.
   */
  verification?: TxVerification;
}

/** Shape of ~/.vaultpilot-mcp/config.json. */
/**
 * Cached Ledger pairing entry — what `pair_ledger_solana` populates and
 * `get_ledger_status` reads back. Persisted to ~/.vaultpilot-mcp/config.json
 * so a server restart doesn't force a re-pair (the address is deterministic
 * for a given device + path; the cache is just a hint, not a trust
 * boundary — `send_transaction` always re-derives from the live device
 * before signing).
 */
export interface PairedSolanaEntry {
  address: string;
  publicKey: string;
  path: string;
  appVersion: string;
  /** Null when the path is not in the standard `44'/501'/<n>'` layout. */
  accountIndex: number | null;
}

/** TRON pairing entry — same shape, different BIP-44 layout (`44'/195'/<n>'/0/0`). */
export interface PairedTronEntry {
  address: string;
  publicKey: string;
  path: string;
  appVersion: string;
  /** Null when the path is not in the standard `44'/195'/<n>'/0/0` layout. */
  accountIndex: number | null;
}

export interface UserConfig {
  rpc: {
    provider: RpcProvider;
    /** API key for infura/alchemy. Ignored when provider === "custom". */
    apiKey?: string;
    /** Only used when provider === "custom". */
    customUrls?: Partial<Record<SupportedChain, string>>;
  };
  etherscanApiKey?: string;
  /** Optional 1inch Developer Portal API key for intra-chain swap-quote comparison. */
  oneInchApiKey?: string;
  /**
   * TronGrid API key (`TRON-PRO-API-KEY` header). Required to read TRX and
   * TRC-20 balances on the `tron` chain — TronGrid rate-limits unauthenticated
   * calls to ~15 req/min, which is too tight for portfolio fan-out.
   */
  tronApiKey?: string;
  /**
   * Solana mainnet RPC URL. Paste the full URL from your provider (Helius,
   * QuickNode, Alchemy Solana, Triton, etc.) — most include the API key in
   * the URL (e.g. `https://mainnet.helius-rpc.com/?api-key=KEY`). The public
   * mainnet endpoint is rate-limited and unreliable for production use;
   * configuring a provider is strongly recommended. Env var `SOLANA_RPC_URL`
   * takes priority over this field.
   */
  solanaRpcUrl?: string;
  walletConnect?: {
    projectId?: string;
    /** Topic of the active WC session (so we can resume after restart). */
    sessionTopic?: string;
    pairingTopic?: string;
  };
  /**
   * Cached Ledger pairings, persisted across server restarts. Public fields
   * only (addresses, BIP-44 paths, app versions) — no private keys, no
   * secrets. The signing path always re-derives from the live device and
   * verifies the address before signing, so a planted/stale entry can at
   * worst surface a wrong address in `get_ledger_status` (which the user
   * notices when their balances don't match).
   */
  pairings?: {
    solana?: PairedSolanaEntry[];
    tron?: PairedTronEntry[];
  };
}
