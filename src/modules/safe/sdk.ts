// `@safe-global/api-kit` ships a dual ESM/CJS bundle whose package.json
// `exports` map advertises a single top-level `types` field (no per-condition
// types) and whose runtime ESM bundle re-exports only `default`. Under
// Node16 module resolution, both `import SafeApiKit from "..."` and
// `import * as Mod` paths confuse TS into binding the class identifier to
// the entire module namespace — `new X(...)` fails with "no construct
// signatures" and `InstanceType<typeof X>` fails the constraint check.
// Pulling the class through `createRequire` matches the runtime CJS shape
// (`module.exports = SafeApiKit`) and gives TS a real constructor to type
// against. Same workaround already used by `src/modules/btc/actions.ts` for
// `bitcoinjs-lib`.
import { createRequire } from "node:module";
import { CHAIN_IDS, type SupportedChain } from "../../types/index.js";
import { readUserConfig } from "../../config/user-config.js";

const requireCjs = createRequire(import.meta.url);
const SafeApiKit = requireCjs("@safe-global/api-kit").default as new (config: {
  chainId: bigint;
  txServiceUrl?: string;
  apiKey?: string;
}) => {
  getSafeInfo(safeAddress: string): Promise<{
    address: string;
    nonce: string;
    threshold: number;
    owners: string[];
    modules: string[];
    fallbackHandler: string;
    guard: string;
    version: string;
  }>;
  getSafesByOwner(ownerAddress: string): Promise<{ safes: string[] }>;
  getPendingTransactions(
    safeAddress: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ count: number; results: SafeServiceMultisigTx[] }>;
  getMultisigTransactions(
    safeAddress: string,
    options?: { executed?: boolean; limit?: number; offset?: number; ordering?: string },
  ): Promise<{ count: number; results: SafeServiceMultisigTx[] }>;
  /**
   * Returns the next nonce the Safe Transaction Service expects for a new
   * proposal. This may be HIGHER than the Safe contract's on-chain nonce
   * when there are already-pending proposals queued in the service —
   * using the on-chain nonce in that case would conflict.
   */
  getNextNonce(safeAddress: string): Promise<string>;
  getTransaction(safeTxHash: string): Promise<SafeServiceMultisigTx>;
  proposeTransaction(args: {
    safeAddress: string;
    safeTransactionData: {
      to: string;
      value: string;
      data?: string;
      operation: number;
      safeTxGas: string;
      baseGas: string;
      gasPrice: string;
      gasToken: string;
      refundReceiver: string;
      nonce: string;
    };
    safeTxHash: string;
    senderAddress: string;
    senderSignature: string;
    origin?: string;
  }): Promise<void>;
  confirmTransaction(safeTxHash: string, signature: string): Promise<{ signature: string }>;
};
type SafeApiKitInstance = InstanceType<typeof SafeApiKit>;

/**
 * Subset of `SafeMultisigTransactionResponse` (from `@safe-global/types-kit`)
 * that we actually consume. Mirrors the runtime fields the tx-service
 * returns; the full type has ~30 fields and pulling it via the CJS require
 * path would defeat the type isolation we get above.
 */
export interface SafeServiceMultisigTx {
  safeTxHash: string;
  nonce: string;
  to: string;
  value: string;
  data?: string;
  operation: number;
  confirmations?: { owner: string }[];
  confirmationsRequired: number;
  proposer: string | null;
  submissionDate: string;
  transactionHash: string | null;
  executionDate: string | null;
  isExecuted: boolean;
}

/**
 * Thrown when SAFE_API_KEY is not configured. Modern Safe Transaction Service
 * (`*.safe.global`) requires a per-org API key — the SDK enforces this at
 * `SafeApiKit` construction time, so we surface a friendlier error before the
 * SDK throws its generic "apiKey is required" message. Get a key from
 * https://developer.safe.global/.
 */
export class SafeApiKeyMissingError extends Error {
  constructor() {
    super(
      "SAFE_API_KEY is not configured. Safe Transaction Service requires an API key " +
        "(see https://developer.safe.global/). Set the SAFE_API_KEY env var or run " +
        "`vaultpilot-mcp-setup`.",
    );
    this.name = "SafeApiKeyMissingError";
  }
}

/** Pull the Safe API key from env (highest priority) or user config. */
export function resolveSafeApiKey(): string | undefined {
  const fromEnv = process.env.SAFE_API_KEY;
  if (fromEnv) return fromEnv;
  return readUserConfig()?.safeApiKey;
}

/**
 * Per-chain `SafeApiKit` cache. The kit holds the chainId + apiKey and a
 * resolved txServiceUrl; instantiating one is cheap, but reusing avoids the
 * URL-resolution work on every call.
 */
const apiKitCache = new Map<SupportedChain, SafeApiKitInstance>();

export function getSafeApiKit(chain: SupportedChain): SafeApiKitInstance {
  const cached = apiKitCache.get(chain);
  if (cached) return cached;
  const apiKey = resolveSafeApiKey();
  if (!apiKey) throw new SafeApiKeyMissingError();
  const kit = new SafeApiKit({
    chainId: BigInt(CHAIN_IDS[chain]),
    apiKey,
  });
  apiKitCache.set(chain, kit);
  return kit;
}
