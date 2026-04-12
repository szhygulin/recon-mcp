// EigenLayer StrategyManager — enumerate strategies and share balances.
export const eigenStrategyManagerAbi = [
  {
    type: "function",
    name: "stakerStrategyList",
    stateMutability: "view",
    inputs: [{ name: "staker", type: "address" }],
    outputs: [{ type: "address[]" }],
  },
  {
    type: "function",
    name: "stakerStrategyShares",
    stateMutability: "view",
    inputs: [
      { name: "staker", type: "address" },
      { name: "strategy", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "depositIntoStrategy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "strategy", type: "address" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

export const eigenStrategyAbi = [
  {
    type: "function",
    name: "underlyingToken",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "sharesToUnderlyingView",
    stateMutability: "view",
    inputs: [{ name: "amountShares", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
] as const;
