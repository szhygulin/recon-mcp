// Lido — stETH, wstETH, and the withdrawal queue. Minimal functions only.
export const stETHAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getPooledEthByShares",
    stateMutability: "view",
    inputs: [{ name: "sharesAmount", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "submit",
    stateMutability: "payable",
    inputs: [{ name: "referral", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export const wstETHAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "stEthPerToken",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getStETHByWstETH",
    stateMutability: "view",
    inputs: [{ name: "wstETHAmount", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "wrap",
    stateMutability: "nonpayable",
    inputs: [{ name: "_stETHAmount", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "unwrap",
    stateMutability: "nonpayable",
    inputs: [{ name: "_wstETHAmount", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export const lidoWithdrawalQueueAbi = [
  {
    type: "function",
    name: "requestWithdrawals",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amounts", type: "uint256[]" },
      { name: "owner", type: "address" },
    ],
    outputs: [{ type: "uint256[]" }],
  },
] as const;
