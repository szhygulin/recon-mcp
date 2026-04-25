/**
 * Shared Solana `Connection` mock. Replaces per-file `connectionStub = { ... }`
 * blocks repeated in 20+ tests. Each test stubs a slightly different subset
 * of methods; the union is the 18 below.
 *
 * Usage (`vi.mock` body has to stay inline — vitest hoists it above imports):
 *
 *   const connectionStub = makeConnectionStub();
 *   vi.mock("../src/modules/solana/rpc.js", () => ({
 *     getSolanaConnection: () => connectionStub,
 *     resetSolanaConnection: () => {},
 *   }));
 *   beforeEach(() => resetConnectionStub(connectionStub));
 */
import { vi } from "vitest";
import type { Mock } from "vitest";

export type SolanaConnectionStub = Record<string, Mock> & {
  getAccountInfo: Mock;
  getAddressLookupTable: Mock;
  getBalance: Mock;
  getBlockHeight: Mock;
  getEpochInfo: Mock;
  getLatestBlockhash: Mock;
  getMinimumBalanceForRentExemption: Mock;
  getParsedProgramAccounts: Mock;
  getParsedTokenAccountsByOwner: Mock;
  getParsedTransaction: Mock;
  getRecentPrioritizationFees: Mock;
  getSignatureStatuses: Mock;
  getSignaturesForAddress: Mock;
  getTokenAccountBalance: Mock;
  getTokenAccountsByOwner: Mock;
  getTokenSupply: Mock;
  sendRawTransaction: Mock;
  simulateTransaction: Mock;
};

const METHOD_NAMES = [
  "getAccountInfo",
  "getAddressLookupTable",
  "getBalance",
  "getBlockHeight",
  "getEpochInfo",
  "getLatestBlockhash",
  "getMinimumBalanceForRentExemption",
  "getParsedProgramAccounts",
  "getParsedTokenAccountsByOwner",
  "getParsedTransaction",
  "getRecentPrioritizationFees",
  "getSignatureStatuses",
  "getSignaturesForAddress",
  "getTokenAccountBalance",
  "getTokenAccountsByOwner",
  "getTokenSupply",
  "sendRawTransaction",
  "simulateTransaction",
] as const;

export function makeConnectionStub(): SolanaConnectionStub {
  const stub = {} as SolanaConnectionStub;
  for (const name of METHOD_NAMES) stub[name] = vi.fn();
  return stub;
}

export function resetConnectionStub(stub: SolanaConnectionStub): void {
  for (const fn of Object.values(stub)) fn.mockReset();
}
