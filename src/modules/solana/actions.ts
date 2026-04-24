import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { assertSolanaAddress } from "./address.js";
import { getSolanaConnection } from "./rpc.js";
import { SOL_DECIMALS, SOLANA_TOKEN_DECIMALS, SOLANA_TOKENS } from "../../config/solana.js";
import { resolveRecipientAta, SPL_TOKEN_ACCOUNT_RENT_LAMPORTS } from "./ata.js";
import { computePriorityFee } from "./priority-fee.js";
import {
  issueSolanaDraftHandle,
  type SolanaTxDraft,
} from "../../signing/solana-tx-store.js";
import {
  buildAdvanceNonceIx,
  buildCloseNonceIxs,
  buildInitNonceIxs,
  deriveNonceAccountAddress,
  getNonceAccountValue,
  NONCE_ACCOUNT_LENGTH,
} from "./nonce.js";

/** Minimum SOL balance we leave on the wallet after a `max` send — protects against accidentally emptying below the rent-exempt floor. */
const SOL_SAFETY_BUFFER_LAMPORTS = 10_000;

/** Solana base fee per signature (5000 lamports). Constant across mainnet. */
const SOLANA_BASE_FEE_LAMPORTS = 5_000;

/** Parse a human SOL amount ("0.5") into lamports. Accepts up to 9 decimal places. */
function parseSolAmount(amount: string): bigint {
  if (!/^\d+(\.\d{1,9})?$/.test(amount)) {
    throw new Error(
      `Invalid SOL amount "${amount}": expected a decimal with up to 9 fractional digits (e.g. "0.5", "1.25").`,
    );
  }
  const [whole, frac = ""] = amount.split(".");
  const padded = frac.padEnd(SOL_DECIMALS, "0");
  return BigInt(whole) * 10n ** BigInt(SOL_DECIMALS) + BigInt(padded);
}

/**
 * Parse a human SPL token amount into base units given the mint's decimals.
 * Accepts up to `decimals` fractional digits.
 */
function parseSplAmount(amount: string, decimals: number): bigint {
  const re = new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`);
  if (!re.test(amount)) {
    throw new Error(
      `Invalid token amount "${amount}" for ${decimals}-decimal mint: expected a decimal ` +
        `with up to ${decimals} fractional digits.`,
    );
  }
  const [whole, frac = ""] = amount.split(".");
  const padded = frac.padEnd(decimals, "0");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded);
}

/** Format lamports as a human SOL string. */
function formatSol(lamports: bigint): string {
  const whole = lamports / 10n ** 9n;
  const frac = lamports % 10n ** 9n;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(9, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

/** Format raw token units using decimals. */
function formatToken(raw: bigint, decimals: number): string {
  if (decimals === 0) return raw.toString();
  const whole = raw / 10n ** BigInt(decimals);
  const frac = raw % 10n ** BigInt(decimals);
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

/** Reverse map: mint address → canonical symbol + decimals (for known tokens). */
function resolveKnownMint(mint: string): { symbol: string; decimals: number } | null {
  for (const [sym, addr] of Object.entries(SOLANA_TOKENS) as [
    keyof typeof SOLANA_TOKENS,
    string,
  ][]) {
    if (addr === mint) {
      return { symbol: sym, decimals: SOLANA_TOKEN_DECIMALS[sym] };
    }
  }
  return null;
}

export interface SolanaNativeSendParams {
  wallet: string;
  to: string;
  /** Decimal SOL string ("0.5") or "max" for wallet balance minus safety buffer + fee. */
  amount: string;
}

/**
 * Shape returned by the builders — the handle, the draft metadata, and the
 * bits the agent can show to the user BEFORE `preview_solana_send` runs.
 * No `messageBase64` / `recentBlockhash` yet; those get populated by
 * `preview_solana_send` right before signing.
 */
export interface PreparedSolanaTx {
  handle: string;
  action: "native_send" | "spl_send" | "nonce_init" | "nonce_close";
  chain: "solana";
  from: string;
  description: string;
  decoded: { functionName: string; args: Record<string, string> };
  rentLamports?: number;
  priorityFeeMicroLamports?: number;
  computeUnitLimit?: number;
  estimatedFeeLamports?: number;
  /** Surfaced on native_send / spl_send / nonce_close so the summary can show "Nonce: <addr>". */
  nonceAccount?: string;
}

/**
 * Structured error thrown by `buildSolanaNativeSend` / `buildSolanaSplSend`
 * when the wallet hasn't initialized a durable-nonce account yet. The agent
 * relays the message verbatim to the user, who then runs
 * `prepare_solana_nonce_init` before retrying the send.
 */
function throwNonceRequired(wallet: string): never {
  throw new Error(
    `Solana nonce account not initialized for ${wallet}. Durable-nonce protection is required ` +
      `for all Solana sends in this server — the ~90s recentBlockhash window was eating into the ` +
      `Ledger blind-sign review time and causing intermittent failures. ` +
      `Run prepare_solana_nonce_init first (one-time setup, ~0.00144 SOL rent-exempt seed, fully ` +
      `reclaimable via prepare_solana_nonce_close) and then retry this send.`,
  );
}

/**
 * Build a native SOL transfer. One `SystemProgram.transfer` instruction,
 * preceded by `SystemProgram.nonceAdvance` (ix[0], required — Agave
 * detects durable-nonce txs via ix[0] only) and optionally a `ComputeBudget`
 * pair when the network is congested. Pre-flight: refuses if the wallet is
 * short OR if the nonce account doesn't exist yet. Returns a DRAFT
 * (handle + metadata) — the nonce value is pinned later by
 * `preview_solana_send`.
 */
export async function buildSolanaNativeSend(
  p: SolanaNativeSendParams,
): Promise<PreparedSolanaTx> {
  const fromPubkey = assertSolanaAddress(p.wallet);
  const toPubkey = assertSolanaAddress(p.to);
  const conn = getSolanaConnection();

  // Durable-nonce preflight: refuse if the user hasn't initialized yet.
  // The nonce PDA is deterministic — same seed + base → same pubkey — so
  // no lookup table is needed, just derive and check on-chain presence.
  const noncePubkey = await deriveNonceAccountAddress(fromPubkey);
  const nonceState = await getNonceAccountValue(conn, noncePubkey);
  if (!nonceState) throwNonceRequired(p.wallet);

  // Priority-fee decision BEFORE resolving "max" — the fee is baked into
  // the amount we're willing to hand back to the user on "max".
  const pfee = await computePriorityFee(conn, [fromPubkey, toPubkey]);
  const priorityFeeLamports = pfee
    ? Math.ceil((pfee.microLamportsPerCu * pfee.computeUnitLimit) / 1_000_000)
    : 0;
  const totalFee = SOLANA_BASE_FEE_LAMPORTS + priorityFeeLamports;

  let lamports: bigint;
  let displayAmount: string;
  if (p.amount === "max") {
    const balanceLamports = BigInt(await conn.getBalance(fromPubkey, "confirmed"));
    const reserved = BigInt(totalFee + SOL_SAFETY_BUFFER_LAMPORTS);
    if (balanceLamports <= reserved) {
      throw new Error(
        `Cannot "max": wallet ${p.wallet} balance ${formatSol(balanceLamports)} SOL is at or below ` +
          `the reserve (${formatSol(reserved)} SOL = tx fee + ${formatSol(
            BigInt(SOL_SAFETY_BUFFER_LAMPORTS),
          )} SOL safety buffer).`,
      );
    }
    lamports = balanceLamports - reserved;
    displayAmount = formatSol(lamports);
  } else {
    lamports = parseSolAmount(p.amount);
    const balanceLamports = BigInt(await conn.getBalance(fromPubkey, "confirmed"));
    if (balanceLamports < lamports + BigInt(totalFee)) {
      throw new Error(
        `Insufficient SOL: wallet ${p.wallet} has ${formatSol(balanceLamports)} SOL, ` +
          `requested ${p.amount} + ${formatSol(BigInt(totalFee))} SOL fee = ` +
          `${formatSol(lamports + BigInt(totalFee))} SOL. Reduce the amount or top up.`,
      );
    }
    displayAmount = p.amount;
  }

  // Build the draft tx. ix[0] MUST be nonceAdvance — that's the signal
  // Agave uses to detect durable-nonce txs and skip the blockhash validity
  // window check. Everything else (compute-budget, payload) stacks after.
  const draftTx = new Transaction();
  draftTx.feePayer = fromPubkey;
  draftTx.add(buildAdvanceNonceIx(noncePubkey, fromPubkey));
  if (pfee) {
    draftTx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: pfee.computeUnitLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: BigInt(pfee.microLamportsPerCu),
      }),
    );
  }
  draftTx.add(
    SystemProgram.transfer({
      fromPubkey,
      toPubkey,
      lamports,
    }),
  );

  const nonceAccountStr = noncePubkey.toBase58();
  const draft: SolanaTxDraft = {
    draftTx,
    meta: {
      action: "native_send",
      from: p.wallet,
      description: `Send ${displayAmount} SOL to ${p.to}`,
      decoded: {
        functionName: "solana.system.transfer",
        args: {
          from: p.wallet,
          to: p.to,
          amount: `${displayAmount} SOL`,
          lamports: lamports.toString(),
          nonceAccount: nonceAccountStr,
        },
      },
      ...(pfee
        ? {
            priorityFeeMicroLamports: pfee.microLamportsPerCu,
            computeUnitLimit: pfee.computeUnitLimit,
          }
        : {}),
      estimatedFeeLamports: totalFee,
      nonce: {
        account: nonceAccountStr,
        authority: fromPubkey.toBase58(),
        value: nonceState.nonce,
      },
    },
  };
  const { handle } = issueSolanaDraftHandle(draft);
  return {
    handle,
    action: "native_send",
    chain: "solana",
    from: p.wallet,
    description: draft.meta.description,
    decoded: draft.meta.decoded,
    ...(draft.meta.priorityFeeMicroLamports !== undefined
      ? { priorityFeeMicroLamports: draft.meta.priorityFeeMicroLamports }
      : {}),
    ...(draft.meta.computeUnitLimit !== undefined
      ? { computeUnitLimit: draft.meta.computeUnitLimit }
      : {}),
    ...(draft.meta.estimatedFeeLamports !== undefined
      ? { estimatedFeeLamports: draft.meta.estimatedFeeLamports }
      : {}),
    nonceAccount: nonceAccountStr,
  };
}

export interface SolanaSplSendParams {
  wallet: string;
  /** SPL mint address (base58). */
  mint: string;
  to: string;
  /** Decimal token amount. No "max" shortcut for SPL (needs mint decimals + balance — safer to ask explicitly). */
  amount: string;
}

/**
 * Build an SPL token transfer. ix[0] is `SystemProgram.nonceAdvance` (required
 * for durable-nonce protection — see the module docs in `nonce.ts`), followed
 * by optional ComputeBudget ixs, optional createAssociatedTokenAccount, and
 * finally `Token.TransferChecked`. TransferChecked makes the Ledger Solana
 * app clear-sign the mint + decimals + amount.
 */
export async function buildSolanaSplSend(
  p: SolanaSplSendParams,
): Promise<PreparedSolanaTx> {
  const fromPubkey = assertSolanaAddress(p.wallet);
  const toPubkey = assertSolanaAddress(p.to);
  const mintPubkey = assertSolanaAddress(p.mint);
  const conn = getSolanaConnection();

  // Durable-nonce preflight — same gate as buildSolanaNativeSend.
  const noncePubkey = await deriveNonceAccountAddress(fromPubkey);
  const nonceState = await getNonceAccountValue(conn, noncePubkey);
  if (!nonceState) throwNonceRequired(p.wallet);

  // Resolve decimals + symbol. Canonical mints (USDC/USDT/JUP/...) use the
  // static table; unknown mints hit the chain via getTokenSupply.
  let decimals: number;
  let symbol: string;
  const known = resolveKnownMint(p.mint);
  if (known) {
    decimals = known.decimals;
    symbol = known.symbol;
  } else {
    const supply = await conn.getTokenSupply(mintPubkey);
    decimals = supply.value.decimals;
    symbol = "UNKNOWN";
  }

  const amountBase = parseSplAmount(p.amount, decimals);

  // Sender ATA — derived deterministically. If it doesn't exist on chain
  // the wallet literally cannot hold this mint, so refuse.
  const senderAta = getAssociatedTokenAddressSync(mintPubkey, fromPubkey);
  const senderAtaInfo = await conn.getAccountInfo(senderAta, "confirmed");
  if (!senderAtaInfo) {
    throw new Error(
      `Wallet ${p.wallet} has no associated token account for mint ${p.mint} (no ${symbol} holdings). ` +
        `Cannot send what isn't there.`,
    );
  }

  // Check balance. `getTokenAccountBalance` returns the parsed amount.
  const balanceRes = await conn.getTokenAccountBalance(senderAta, "confirmed");
  const balanceBase = BigInt(balanceRes.value.amount);
  if (balanceBase < amountBase) {
    throw new Error(
      `Insufficient ${symbol}: wallet ${p.wallet} has ${formatToken(balanceBase, decimals)} ${symbol}, ` +
        `requested ${p.amount}. Reduce the amount.`,
    );
  }

  // Recipient ATA — may need to be created. Sender pays the rent if so.
  const recipient = await resolveRecipientAta(conn, mintPubkey, toPubkey);

  // Pre-flight: ensure the wallet has enough SOL for tx fee + ATA rent.
  const pfee = await computePriorityFee(conn, [senderAta, recipient.ataAddress]);
  const priorityFeeLamports = pfee
    ? Math.ceil((pfee.microLamportsPerCu * pfee.computeUnitLimit) / 1_000_000)
    : 0;
  const totalFee = SOLANA_BASE_FEE_LAMPORTS + priorityFeeLamports;
  const totalLamportsNeeded =
    totalFee + (recipient.needsCreation ? SPL_TOKEN_ACCOUNT_RENT_LAMPORTS : 0);
  const solBalance = BigInt(await conn.getBalance(fromPubkey, "confirmed"));
  if (solBalance < BigInt(totalLamportsNeeded)) {
    throw new Error(
      `Insufficient SOL for fees: wallet has ${formatSol(solBalance)} SOL, needs ` +
        `${formatSol(BigInt(totalLamportsNeeded))} SOL (${formatSol(BigInt(totalFee))} tx fee` +
        (recipient.needsCreation
          ? ` + ${formatSol(BigInt(SPL_TOKEN_ACCOUNT_RENT_LAMPORTS))} SOL to create the recipient's ${symbol} account`
          : "") +
        `). Top up and retry.`,
    );
  }

  // Build the draft tx. ix[0] = nonceAdvance (required); then compute-budget,
  // then optional ATA-create, then the SPL transfer.
  const draftTx = new Transaction();
  draftTx.feePayer = fromPubkey;
  draftTx.add(buildAdvanceNonceIx(noncePubkey, fromPubkey));
  if (pfee) {
    draftTx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: pfee.computeUnitLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: BigInt(pfee.microLamportsPerCu),
      }),
    );
  }
  if (recipient.needsCreation) {
    draftTx.add(
      createAssociatedTokenAccountInstruction(
        fromPubkey, // fee / rent payer
        recipient.ataAddress,
        toPubkey, // owner of the new ATA
        mintPubkey,
      ),
    );
  }
  draftTx.add(
    createTransferCheckedInstruction(
      senderAta,
      mintPubkey,
      recipient.ataAddress,
      fromPubkey,
      amountBase,
      decimals,
    ),
  );

  const descSuffix = recipient.needsCreation
    ? ` (+ create recipient ${symbol} account, costs ${formatSol(BigInt(SPL_TOKEN_ACCOUNT_RENT_LAMPORTS))} SOL rent)`
    : "";
  const estimatedFeeLamports =
    totalFee + (recipient.needsCreation ? SPL_TOKEN_ACCOUNT_RENT_LAMPORTS : 0);
  const nonceAccountStr = noncePubkey.toBase58();
  const draft: SolanaTxDraft = {
    draftTx,
    meta: {
      action: "spl_send",
      from: p.wallet,
      description: `Send ${p.amount} ${symbol} to ${p.to}${descSuffix}`,
      decoded: {
        functionName: "solana.spl.transferChecked",
        args: {
          from: p.wallet,
          to: p.to,
          mint: p.mint,
          symbol,
          amount: `${p.amount} ${symbol}`,
          amountBase: amountBase.toString(),
          decimals: decimals.toString(),
          nonceAccount: nonceAccountStr,
          ...(recipient.needsCreation
            ? { createsRecipientAta: "true", rentSol: formatSol(BigInt(SPL_TOKEN_ACCOUNT_RENT_LAMPORTS)) }
            : {}),
        },
      },
      ...(recipient.needsCreation ? { rentLamports: SPL_TOKEN_ACCOUNT_RENT_LAMPORTS } : {}),
      ...(pfee
        ? {
            priorityFeeMicroLamports: pfee.microLamportsPerCu,
            computeUnitLimit: pfee.computeUnitLimit,
          }
        : {}),
      estimatedFeeLamports,
      nonce: {
        account: nonceAccountStr,
        authority: fromPubkey.toBase58(),
        value: nonceState.nonce,
      },
    },
  };
  const { handle } = issueSolanaDraftHandle(draft);
  return {
    handle,
    action: "spl_send",
    chain: "solana",
    from: p.wallet,
    description: draft.meta.description,
    decoded: draft.meta.decoded,
    ...(draft.meta.rentLamports !== undefined
      ? { rentLamports: draft.meta.rentLamports }
      : {}),
    ...(draft.meta.priorityFeeMicroLamports !== undefined
      ? { priorityFeeMicroLamports: draft.meta.priorityFeeMicroLamports }
      : {}),
    ...(draft.meta.computeUnitLimit !== undefined
      ? { computeUnitLimit: draft.meta.computeUnitLimit }
      : {}),
    estimatedFeeLamports: draft.meta.estimatedFeeLamports,
    nonceAccount: nonceAccountStr,
  };
}

export interface SolanaNonceInitParams {
  wallet: string;
}

/**
 * Build the one-time durable-nonce account init tx for a wallet:
 *
 *   ix[0] = SystemProgram.createAccountWithSeed — creates the deterministic
 *           PDA at `deriveNonceAccountAddress(wallet)` and funds it with
 *           the rent-exempt minimum (~0.00144 SOL).
 *   ix[1] = SystemProgram.nonceInitialize — writes the initial nonce value
 *           and sets the authority to the same wallet.
 *
 * Refuses if the account already exists (re-running init would overwrite
 * a nonce value mid-use by another tx and brick it). Also refuses if the
 * wallet doesn't have enough SOL for rent + base fee.
 *
 * This tx uses a regular recent blockhash at preview time — it's the only
 * send without durable-nonce protection, because it's creating the account
 * that durable-nonce protection depends on.
 */
export async function buildSolanaNonceInit(
  p: SolanaNonceInitParams,
): Promise<PreparedSolanaTx> {
  const fromPubkey = assertSolanaAddress(p.wallet);
  const conn = getSolanaConnection();

  const noncePubkey = await deriveNonceAccountAddress(fromPubkey);
  const existing = await conn.getAccountInfo(noncePubkey, "confirmed");
  if (existing) {
    throw new Error(
      `Nonce account already exists for ${p.wallet} at ${noncePubkey.toBase58()}. ` +
        `Refusing to re-init — that would overwrite the current nonce value and break any in-flight ` +
        `txs using it. If you want to start fresh, run prepare_solana_nonce_close first.`,
    );
  }

  const rentLamports = await conn.getMinimumBalanceForRentExemption(
    NONCE_ACCOUNT_LENGTH,
  );
  const totalNeeded = rentLamports + SOLANA_BASE_FEE_LAMPORTS;
  const balance = BigInt(await conn.getBalance(fromPubkey, "confirmed"));
  if (balance < BigInt(totalNeeded)) {
    throw new Error(
      `Insufficient SOL to init nonce: wallet ${p.wallet} has ${formatSol(balance)} SOL, ` +
        `needs ${formatSol(BigInt(totalNeeded))} SOL ` +
        `(${formatSol(BigInt(rentLamports))} rent-exempt seed + ${formatSol(BigInt(SOLANA_BASE_FEE_LAMPORTS))} tx fee). ` +
        `Top up and retry.`,
    );
  }

  const draftTx = new Transaction();
  draftTx.feePayer = fromPubkey;
  for (const ix of buildInitNonceIxs(fromPubkey, noncePubkey, rentLamports)) {
    draftTx.add(ix);
  }

  const nonceAccountStr = noncePubkey.toBase58();
  const draft: SolanaTxDraft = {
    draftTx,
    meta: {
      action: "nonce_init",
      from: p.wallet,
      description:
        `Initialize durable-nonce account ${nonceAccountStr} for ${p.wallet} ` +
        `(${formatSol(BigInt(rentLamports))} SOL rent-exempt seed, reclaimable via prepare_solana_nonce_close)`,
      decoded: {
        functionName: "solana.system.createNonceAccount",
        args: {
          from: p.wallet,
          nonceAccount: nonceAccountStr,
          authority: p.wallet,
          rentLamports: rentLamports.toString(),
          rentSol: formatSol(BigInt(rentLamports)),
        },
      },
      rentLamports,
      estimatedFeeLamports: SOLANA_BASE_FEE_LAMPORTS,
    },
  };
  const { handle } = issueSolanaDraftHandle(draft);
  return {
    handle,
    action: "nonce_init",
    chain: "solana",
    from: p.wallet,
    description: draft.meta.description,
    decoded: draft.meta.decoded,
    rentLamports,
    estimatedFeeLamports: SOLANA_BASE_FEE_LAMPORTS,
    nonceAccount: nonceAccountStr,
  };
}

export interface SolanaNonceCloseParams {
  wallet: string;
}

/**
 * Build the durable-nonce teardown tx:
 *
 *   ix[0] = SystemProgram.nonceAdvance — same self-protecting pattern as
 *           any other send against this nonce. The close tx itself stays
 *           valid indefinitely so the user can take their time reviewing.
 *   ix[1] = SystemProgram.nonceWithdraw — transfers the FULL balance back
 *           to the user's main wallet, implicitly closing the account.
 *
 * Refuses if the nonce account doesn't exist (nothing to close).
 */
export async function buildSolanaNonceClose(
  p: SolanaNonceCloseParams,
): Promise<PreparedSolanaTx> {
  const fromPubkey = assertSolanaAddress(p.wallet);
  const conn = getSolanaConnection();

  const noncePubkey = await deriveNonceAccountAddress(fromPubkey);
  const nonceState = await getNonceAccountValue(conn, noncePubkey);
  if (!nonceState) {
    throw new Error(
      `No nonce account to close — ${p.wallet} has not run prepare_solana_nonce_init yet ` +
        `(or it's already been closed). Nothing to do.`,
    );
  }

  const info = await conn.getAccountInfo(noncePubkey, "confirmed");
  if (!info) {
    // Shouldn't happen — getNonceAccountValue just confirmed existence.
    throw new Error(
      `Nonce account ${noncePubkey.toBase58()} vanished between getNonceAccountValue and getAccountInfo. ` +
        `Retry after a few seconds.`,
    );
  }
  const balanceLamports = info.lamports;

  const draftTx = new Transaction();
  draftTx.feePayer = fromPubkey;
  for (const ix of buildCloseNonceIxs(
    noncePubkey,
    fromPubkey,
    fromPubkey,
    balanceLamports,
  )) {
    draftTx.add(ix);
  }

  const nonceAccountStr = noncePubkey.toBase58();
  const draft: SolanaTxDraft = {
    draftTx,
    meta: {
      action: "nonce_close",
      from: p.wallet,
      description:
        `Close durable-nonce account ${nonceAccountStr} for ${p.wallet}, ` +
        `returning ${formatSol(BigInt(balanceLamports))} SOL to the main wallet`,
      decoded: {
        functionName: "solana.system.nonceWithdraw",
        args: {
          from: p.wallet,
          nonceAccount: nonceAccountStr,
          authority: p.wallet,
          destination: p.wallet,
          withdrawLamports: balanceLamports.toString(),
          withdrawSol: formatSol(BigInt(balanceLamports)),
        },
      },
      estimatedFeeLamports: SOLANA_BASE_FEE_LAMPORTS,
      nonce: {
        account: nonceAccountStr,
        authority: fromPubkey.toBase58(),
        value: nonceState.nonce,
      },
    },
  };
  const { handle } = issueSolanaDraftHandle(draft);
  return {
    handle,
    action: "nonce_close",
    chain: "solana",
    from: p.wallet,
    description: draft.meta.description,
    decoded: draft.meta.decoded,
    estimatedFeeLamports: SOLANA_BASE_FEE_LAMPORTS,
    nonceAccount: nonceAccountStr,
  };
}
