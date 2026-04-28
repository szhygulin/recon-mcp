// Rocket Pool — RocketDepositPool (deposit) + RocketTokenRETH (burn / read).
// Minimal functions only: deposit + capacity preflight on the pool, burn +
// balance + collateral preflight on rETH. RocketStorage lookup is intentionally
// omitted — addresses are pinned in `config/contracts.ts` and any upgrade is a
// canonical-dispatch test failure first.
export const rocketDepositPoolAbi = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "payable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "getMaximumDepositAmount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getBalance",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

export const rocketTokenRETHAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "burn",
    stateMutability: "nonpayable",
    inputs: [{ name: "_rethAmount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "getEthValue",
    stateMutability: "view",
    inputs: [{ name: "_rethAmount", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getRethValue",
    stateMutability: "view",
    inputs: [{ name: "_ethAmount", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getExchangeRate",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getTotalCollateral",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;
