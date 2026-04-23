/**
 * Solana mainnet configuration.
 *
 * Solana is not EVM: addresses are base58-encoded ed25519 public keys (32
 * bytes → 43 or 44 base58 chars), the RPC is a JSON-RPC server with a totally
 * different method set (getBalance, getTokenAccountsByOwner, etc.), and the
 * transaction signing path uses Ed25519 rather than secp256k1. The server
 * treats Solana as strictly additive via `AnyChain = SupportedChain |
 * SupportedNonEvmChain` — existing EVM modules never see Solana, and the
 * Solana reader lives in src/modules/solana/.
 */

/** Native SOL is always 9 decimals (1 SOL = 1_000_000_000 lamports). */
export const SOL_DECIMALS = 9;
export const SOL_SYMBOL = "SOL";

/**
 * Canonical SPL-token mints we enumerate in the portfolio summary. Keys are
 * the displayed symbol; values are the mint addresses. Verified live against
 * Solana mainnet RPC (`getTokenSupply`) — each address exists, decimals below
 * match on-chain, and the mint is owned by the SPL Token program.
 *
 * Decimals listed inline because we hardcode them below — a per-mint
 * `getMint()` call at portfolio time would double the RPC fan-out for no
 * practical gain (this list is tiny and stable).
 */
export const SOLANA_TOKENS = {
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  JUP: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  JTO: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",
  mSOL: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
  jitoSOL: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
} as const;

/** On-chain decimals for the canonical mints. Verified live via `getTokenSupply`. */
export const SOLANA_TOKEN_DECIMALS: Record<keyof typeof SOLANA_TOKENS, number> = {
  USDC: 6,
  USDT: 6,
  JUP: 6,
  BONK: 5,
  JTO: 9,
  mSOL: 9,
  jitoSOL: 9,
};

/**
 * Wrapped SOL mint — technically a Token Program mint, practically a
 * short-lived wrapper held only during swaps. We surface it in balance
 * reads (some callers legitimately hold it) but exclude it from the native
 * SOL total (that's `getBalance` directly).
 */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Shape check: base58 alphabet + length 43 or 44 chars. A 32-byte value
 * in base58 is always 43 or 44 chars — 32-char bases on the low end that
 * web3.js `PublicKey` accepts are short-key edge cases we don't want on
 * wallet-input paths (real wallets are 43/44).
 *
 * This is a FAST PATH reject for malformed input. For strict validation
 * (is this actually a 32-byte pubkey?), use `assertSolanaAddress` in
 * `src/modules/solana/address.ts` which rounds the value through
 * `@solana/web3.js` `PublicKey`.
 */
export function isSolanaAddress(s: string): boolean {
  return typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(s);
}

/**
 * Default Solana mainnet RPC. Public endpoint — rate-limited and unreliable
 * for production use. Tools that do real work MUST call `resolveSolanaRpcUrl`
 * in config/chains.ts which honors user config (Helius recommended) and the
 * `SOLANA_RPC_URL` env var before falling back here.
 */
export const SOLANA_PUBLIC_RPC_URL = "https://api.mainnet-beta.solana.com";
