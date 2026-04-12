// Shared domain types used across all modules.

export type SupportedChain = "ethereum" | "arbitrum";

export const SUPPORTED_CHAINS: readonly SupportedChain[] = ["ethereum", "arbitrum"] as const;

export type RpcProvider = "infura" | "alchemy" | "custom";

/** Numeric chain IDs for the chains we support. */
export const CHAIN_IDS: Record<SupportedChain, number> = {
  ethereum: 1,
  arbitrum: 42161,
};

export const CHAIN_ID_TO_NAME: Record<number, SupportedChain> = {
  1: "ethereum",
  42161: "arbitrum",
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
  /** Already-accrued fees available to collect. Lower bound — in-flight fees not counted in MVP. */
  unclaimedFees0: TokenAmount;
  unclaimedFees1: TokenAmount;
  totalValueUsd: number;
  /** Approximate impermanent loss vs. holding — expressed as a fraction (e.g. -0.02 = -2%). */
  impermanentLossEstimate?: number;
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
    lending: LendingPosition[];
    lp: LPPosition[];
    staking: StakingPosition[];
  };
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
}

/** Shape of ~/.recon-mcp/config.json. */
export interface UserConfig {
  rpc: {
    provider: RpcProvider;
    /** API key for infura/alchemy. Ignored when provider === "custom". */
    apiKey?: string;
    /** Only used when provider === "custom". */
    customUrls?: Partial<Record<SupportedChain, string>>;
  };
  etherscanApiKey?: string;
  walletConnect?: {
    projectId?: string;
    /** Topic of the active WC session (so we can resume after restart). */
    sessionTopic?: string;
    pairingTopic?: string;
  };
}
