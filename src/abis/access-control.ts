// Common access-control patterns used by security checks.
export const ownableAbi = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

// Gnosis Safe signature — presence of getThreshold() is a strong hint the address is a Safe.
export const gnosisSafeAbi = [
  { type: "function", name: "getThreshold", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getOwners", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
] as const;

// OZ TimelockController — presence of getMinDelay()/delay() is a strong hint the address is a timelock.
export const timelockAbi = [
  { type: "function", name: "getMinDelay", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "delay", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;
