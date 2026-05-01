/**
 * Curve Finance ABIs — v0.1 minimal surface.
 *
 * Per `claude-work/plan-curve-v1.md`'s rnd-verified gates (2026-04-27):
 * Curve has 109 ABIs across pool generations. v0.1 scopes to:
 *   - Stable NG factory (newest stable; covers crvUSD/USDC, USDe/USDC, etc.)
 *   - Plain pools only (NOT meta pools — separate follow-up)
 *   - Gauge v5 (newest gauge generation)
 *   - Ethereum mainnet only
 *
 * Source for every selector: @curvefi/api v2.69.0 bundled ABIs at
 *   node_modules/@curvefi/api/lib/constants/abis/factory-stable-ng.json
 *   node_modules/@curvefi/api/lib/constants/abis/factory-stable-ng/plain-stableswap-ng.json
 *   node_modules/@curvefi/api/lib/constants/abis/gauge_v5.json
 *
 * We inline only the function fragments we call. Smaller surface area than
 * shipping the full ABI files reduces the chance of selector drift going
 * unnoticed: every fragment here corresponds to a single live call site.
 */

/**
 * StableNG Factory — pool discovery + per-pool views.
 * Address: 0x6A8cbed756804B16E05E741eDaBd5cB544AE21bf (Ethereum mainnet,
 * verified via @curvefi/api/lib/constants/network_constants.js).
 */
export const curveStableNgFactoryAbi = [
  {
    type: "function",
    name: "pool_count",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "pool_list",
    stateMutability: "view",
    inputs: [{ name: "i", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "get_n_coins",
    stateMutability: "view",
    inputs: [{ name: "pool", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "get_coins",
    stateMutability: "view",
    inputs: [{ name: "pool", type: "address" }],
    outputs: [{ type: "address[]" }],
  },
  {
    type: "function",
    name: "get_balances",
    stateMutability: "view",
    inputs: [{ name: "pool", type: "address" }],
    outputs: [{ type: "uint256[]" }],
  },
  {
    type: "function",
    name: "is_meta",
    stateMutability: "view",
    inputs: [{ name: "pool", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "get_gauge",
    stateMutability: "view",
    inputs: [{ name: "pool", type: "address" }],
    outputs: [{ type: "address" }],
  },
] as const;

/**
 * StableNG Plain Pool — the pool contract itself. Note: stable_ng pools
 * use the LP token address == pool address (LP-as-pool pattern), so
 * balanceOf(user) on the pool address gives the user's LP balance.
 *
 * Plain pool variants use **dynamic-array** signatures
 * (`add_liquidity(uint256[],uint256)`); meta pool variants use fixed
 * `uint256[2]` — different selectors. v0.1 only handles plain pools;
 * dispatch routes to the right ABI via factory.is_meta(pool) before
 * encoding.
 */
export const curveStableNgPlainPoolAbi = [
  {
    type: "function",
    name: "add_liquidity",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amounts", type: "uint256[]" },
      { name: "min_mint_amount", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "calc_token_amount",
    stateMutability: "view",
    inputs: [
      { name: "amounts", type: "uint256[]" },
      { name: "is_deposit", type: "bool" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "N_COINS",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

/**
 * Legacy StableSwap pool ABI — used by the canonical Curve stETH/ETH
 * pool at `0xDC24316b9AE028F1497c275EB9192a3Ea0f67022`. Predates the
 * stable_ng generation: exchange takes `int128` indices (not `uint256`)
 * and the pool is `payable` so coin0=ETH can be sent as `msg.value`.
 * Issue #615.
 *
 * Source: Etherscan-verified Vyper source for the pool, cross-checked
 * against `lib/constants/abis/stable-swap-pool.json` in @curvefi/api.
 * `coins(0)` returns the ETH sentinel `0xeeee...eeee`; `coins(1)`
 * returns the stETH token address.
 */
export const curveLegacyStableSwapAbi = [
  {
    type: "function",
    name: "exchange",
    stateMutability: "payable",
    inputs: [
      { name: "i", type: "int128" },
      { name: "j", type: "int128" },
      { name: "dx", type: "uint256" },
      { name: "min_dy", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "get_dy",
    stateMutability: "view",
    inputs: [
      { name: "i", type: "int128" },
      { name: "j", type: "int128" },
      { name: "dx", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "coins",
    stateMutability: "view",
    inputs: [{ name: "i", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
] as const;

/**
 * Gauge V5 — staking + reward claims for stable_ng pool LP tokens.
 * Source: gauge_v5.json bundled in @curvefi/api. Only the methods we use.
 */
export const curveGaugeV5Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "claimable_tokens",
    stateMutability: "nonpayable",
    inputs: [{ name: "addr", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;
