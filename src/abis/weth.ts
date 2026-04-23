/**
 * Minimal WETH9 ABI — just the two entry points we use for the native
 * unwrap path. Wrap is reachable via `prepare_native_send` (sending ETH to
 * the WETH contract triggers the fallback → `deposit()`), so we don't need
 * `deposit` here. Unwrap needs `withdraw(uint256)` and we spot-check
 * `balanceOf` for the "max" resolver and the pre-build balance guard.
 */
export const wethAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [{ name: "wad", type: "uint256" }],
    outputs: [],
  },
] as const;
