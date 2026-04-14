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
export type SupportedChain = "ethereum" | "arbitrum" | "polygon" | "base";

export const SUPPORTED_CHAINS: readonly SupportedChain[] = [
  "ethereum",
  "arbitrum",
  "polygon",
  "base",
] as const;

/** Non-EVM chains. Kept as its own union so EVM-only tables keep their type. */
export type SupportedNonEvmChain = "tron";

export const SUPPORTED_NON_EVM_CHAINS: readonly SupportedNonEvmChain[] = ["tron"] as const;

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
};

export const CHAIN_ID_TO_NAME: Record<number, SupportedChain> = {
  1: "ethereum",
  42161: "arbitrum",
  137: "polygon",
  8453: "base",
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
  /** Number of token balances whose USD valuation could not be resolved. */
  unpricedAssets: number;
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
 * TRON staking view: frozen resources, pending unfreezes, claimable rewards.
 * Totals roll up into the portfolio's `tronUsd` via `totalStakedUsd`.
 */
export interface TronStakingSlice {
  address: string;
  claimableRewards: TronClaimableReward;
  frozen: TronFrozenEntry[];
  pendingUnfreezes: TronPendingUnfreeze[];
  /** Frozen + pending-unfreeze + claimable, in TRX (formatted). */
  totalStakedTrx: string;
  /** USD value of everything above at current TRX price. */
  totalStakedUsd: number;
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
  breakdown: {
    native: TokenAmount[];
    erc20: TokenAmount[];
    lending: LendingPositionUnion[];
    lp: LPPosition[];
    staking: StakingPosition[];
    /** TRON slice — absent when no TRON address was queried. */
    tron?: TronPortfolioSlice;
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
 * Phase 2 ships preparation only — there is no send_tron_transaction yet.
 * Handles are issued so the Phase 3 signer (USB HID via @ledgerhq/hw-app-trx)
 * can consume them exactly the way send_transaction consumes EVM handles.
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
    | "withdraw_expire_unfreeze";
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
  /** Opaque handle — see tron-tx-store.ts. Phase 3 signer consumes this. */
  handle?: string;
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
}

/** Shape of ~/.recon-crypto-mcp/config.json. */
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
  walletConnect?: {
    projectId?: string;
    /** Topic of the active WC session (so we can resume after restart). */
    sessionTopic?: string;
    pairingTopic?: string;
  };
}
