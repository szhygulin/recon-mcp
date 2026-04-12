// EigenLayer DelegationManager — read who the staker is delegated to.
export const eigenDelegationManagerAbi = [
  {
    type: "function",
    name: "delegatedTo",
    stateMutability: "view",
    inputs: [{ name: "staker", type: "address" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "isDelegated",
    stateMutability: "view",
    inputs: [{ name: "staker", type: "address" }],
    outputs: [{ type: "bool" }],
  },
] as const;
