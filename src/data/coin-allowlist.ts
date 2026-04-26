/**
 * Symbol → CoinGecko ID allowlist for the `get_coin_price` tool (issue #274).
 *
 * Why an allowlist (vs free-form ticker resolution): CoinGecko has dozens
 * of coins per ticker for popular ones (search "USDC" on
 * https://www.coingecko.com/en/coins and you'll find 30+ entries — most
 * are scams or wrapped variants on weird chains). Free-form `symbol →
 * top-result` resolution would silently price scam tickers when the user
 * meant the canonical asset. The allowlist hardcodes the canonical mapping
 * for the assets that actually matter to the kind of user this server has
 * (DeFi-aware self-custodial wallet holders).
 *
 * Coverage: top ~100 by market cap as of 2026-04, plus the major LSTs and
 * the assets natively supported by VaultPilot's signing flows
 * (BTC/LTC/SOL/TRX/EVM-natives are essential — others are convenience).
 *
 * Escape hatch: callers can bypass the allowlist by passing
 * `coingeckoId` directly to `get_coin_price`. The allowlist is the
 * default-safe path; the escape hatch is for the rare legitimate need
 * (e.g. a non-allowlisted long-tail asset the user cares about).
 *
 * IDs sourced from CoinGecko's coin pages — the URL path segment IS
 * the API ID (e.g. https://www.coingecko.com/en/coins/litecoin →
 * "litecoin"). DefiLlama uses these IDs verbatim under the
 * `coingecko:` key prefix.
 *
 * Refresh policy: hardcoded so the tool works without an extra HTTP
 * roundtrip per call. Refresh quarterly OR when a user asks about an
 * asset not in the list. Adding entries is a one-line PR.
 */

/**
 * Lowercase symbol → CoinGecko ID. Lookup is case-insensitive on the
 * symbol side; the tool normalizes the input before querying.
 */
export const COIN_SYMBOL_ALLOWLIST: Readonly<Record<string, string>> = {
  // ===== Native EVM / L1 currencies (essential — VaultPilot holds these) =====
  btc: "bitcoin",
  eth: "ethereum",
  sol: "solana",
  ltc: "litecoin",
  trx: "tron",
  bnb: "binancecoin",
  pol: "polygon-ecosystem-token", // formerly "matic-network" pre-2024 rebrand
  matic: "polygon-ecosystem-token", // alias for legacy users
  avax: "avalanche-2",
  xrp: "ripple",
  ada: "cardano",
  dot: "polkadot",
  atom: "cosmos",
  near: "near",
  apt: "aptos",
  sui: "sui",
  hbar: "hedera-hashgraph",
  algo: "algorand",
  ftm: "fantom",
  s: "sonic-3", // Sonic (Fantom successor)
  one: "harmony",
  cro: "crypto-com-chain",
  egld: "elrond-erd-2",
  flow: "flow",
  icp: "internet-computer",
  xlm: "stellar",
  xmr: "monero",
  xtz: "tezos",
  zec: "zcash",
  dash: "dash",
  etc: "ethereum-classic",
  bch: "bitcoin-cash",
  bsv: "bitcoin-cash-sv",
  fil: "filecoin",
  arb: "arbitrum",
  op: "optimism",
  base: "base", // wraps "no separate token" — placeholder, returns ETH
  kas: "kaspa",
  mina: "mina-protocol",
  inj: "injective-protocol",
  tia: "celestia",
  sei: "sei-network",
  jto: "jito-governance-token",
  pyth: "pyth-network",
  wld: "worldcoin-wld",
  ondo: "ondo-finance",
  tao: "bittensor",
  rndr: "render-token",
  fet: "fetch-ai",

  // ===== Stablecoins (every chain — these resolve to the canonical CoinGecko entry) =====
  usdc: "usd-coin",
  usdt: "tether",
  dai: "dai",
  busd: "binance-usd",
  tusd: "true-usd",
  usdd: "usdd",
  pyusd: "paypal-usd",
  fdusd: "first-digital-usd",
  usde: "ethena-usde",
  usds: "usds",
  frax: "frax",
  lusd: "liquity-usd",
  gho: "gho",
  crvusd: "crvusd",

  // ===== Liquid-staking tokens (VaultPilot has read/write integration) =====
  steth: "staked-ether", // Lido
  wsteth: "wrapped-steth", // Lido wrapped
  reth: "rocket-pool-eth",
  cbeth: "coinbase-wrapped-staked-eth",
  msol: "marinade-staked-sol", // Marinade
  jitosol: "jito-staked-sol", // Jito
  bsol: "blazestake-staked-sol",
  ezeth: "renzo-restaked-eth",
  weeth: "wrapped-eeth",

  // ===== Wrapped versions =====
  wbtc: "wrapped-bitcoin",
  weth: "weth",
  wsol: "wrapped-solana", // wraps native SOL — same price
  wbnb: "wbnb",

  // ===== Top DeFi governance tokens =====
  aave: "aave",
  comp: "compound-governance-token",
  mkr: "maker",
  uni: "uniswap",
  sushi: "sushi",
  crv: "curve-dao-token",
  cvx: "convex-finance",
  bal: "balancer",
  pendle: "pendle",
  gmx: "gmx",
  ldo: "lido-dao",
  rpl: "rocket-pool",
  ena: "ethena",
  morpho: "morpho",
  bgt: "berachain-bera", // Berachain governance

  // ===== Memecoins (high user-question volume despite being silly) =====
  doge: "dogecoin",
  shib: "shiba-inu",
  pepe: "pepe",
  bonk: "bonk",
  wif: "dogwifcoin",
  floki: "floki",
  mog: "mog-coin",
  trump: "official-trump",
  popcat: "popcat",

  // ===== Solana ecosystem =====
  jup: "jupiter-exchange-solana",
  ray: "raydium",
  orca: "orca",
  pyth_network: "pyth-network", // disambiguator — avoids collision with stripped "pyth" symbol

  // ===== TRON ecosystem =====
  win: "wink",
  jst: "just",
  sun: "sun-token",

  // ===== Privacy / niche but actively traded =====
  link: "chainlink",
  ar: "arweave",
  grt: "the-graph",
  imx: "immutable-x",
  manta: "manta-network",
  strk: "starknet",
  ens: "ethereum-name-service",
  rune: "thorchain",
} as const;

/**
 * Resolve a user-supplied symbol to its CoinGecko ID. Case-insensitive
 * on input. Returns undefined when the symbol isn't on the allowlist —
 * caller surfaces a "use coingeckoId instead" hint.
 */
export function resolveSymbolToCoingeckoId(symbol: string): string | undefined {
  const normalized = symbol.trim().toLowerCase();
  return COIN_SYMBOL_ALLOWLIST[normalized];
}

/**
 * Diagnostic: how many entries are on the allowlist. Used by the tool
 * description so the agent can tell the user "supports ~N tickers."
 */
export function allowlistSize(): number {
  return Object.keys(COIN_SYMBOL_ALLOWLIST).length;
}
