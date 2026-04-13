// Shared domain types used across all modules.

export type SupportedChain = "ethereum" | "arbitrum" | "polygon";

export const SUPPORTED_CHAINS: readonly SupportedChain[] = [
  "ethereum",
  "arbitrum",
  "polygon",
] as const;

export type RpcProvider = "infura" | "alchemy" | "custom";

/** Numeric chain IDs for the chains we support. */
export const CHAIN_IDS: Record<SupportedChain, number> = {
  ethereum: 1,
  arbitrum: 42161,
  polygon: 137,
};

export const CHAIN_ID_TO_NAME: Record<number, SupportedChain> = {
  1: "ethereum",
  42161: "arbitrum",
  137: "polygon",
};

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

/** Any lending/borrowing position reported by the portfolio aggregator. */
export type LendingPositionUnion = LendingPosition | CompoundLendingPosition;

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
  breakdown: {
    native: TokenAmount[];
    erc20: TokenAmount[];
    lending: LendingPositionUnion[];
    lp: LPPosition[];
    staking: StakingPosition[];
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
  walletConnect?: {
    projectId?: string;
    /** Topic of the active WC session (so we can resume after restart). */
    sessionTopic?: string;
    pairingTopic?: string;
  };
}
