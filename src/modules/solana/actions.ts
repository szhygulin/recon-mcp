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
  action: "native_send" | "spl_send";
  chain: "solana";
  from: string;
  description: string;
  decoded: { functionName: string; args: Record<string, string> };
  rentLamports?: number;
  priorityFeeMicroLamports?: number;
  computeUnitLimit?: number;
  estimatedFeeLamports?: number;
}

/**
 * Build a native SOL transfer. One `SystemProgram.transfer` instruction,
 * optionally preceded by a `ComputeBudget` pair when the network is
 * congested. Pre-flight: refuses if the wallet is short. Returns a DRAFT
 * (handle + metadata) — the blockhash is pinned later by
 * `preview_solana_send`.
 */
export async function buildSolanaNativeSend(
  p: SolanaNativeSendParams,
): Promise<PreparedSolanaTx> {
  const fromPubkey = assertSolanaAddress(p.wallet);
  const toPubkey = assertSolanaAddress(p.to);
  const conn = getSolanaConnection();

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

  // Build the draft tx. No recentBlockhash — that gets set at preview time.
  const draftTx = new Transaction();
  draftTx.feePayer = fromPubkey;
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
        },
      },
      ...(pfee
        ? {
            priorityFeeMicroLamports: pfee.microLamportsPerCu,
            computeUnitLimit: pfee.computeUnitLimit,
          }
        : {}),
      estimatedFeeLamports: totalFee,
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
 * Build an SPL token transfer. Uses `Token.TransferChecked` so the Ledger
 * Solana app clear-signs the mint + decimals + amount. If the recipient's
 * ATA doesn't exist yet, prepends `createAssociatedTokenAccount` — the
 * sender pays ~0.00204 SOL rent, surfaced in the preview via
 * `rentLamports`.
 */
export async function buildSolanaSplSend(
  p: SolanaSplSendParams,
): Promise<PreparedSolanaTx> {
  const fromPubkey = assertSolanaAddress(p.wallet);
  const toPubkey = assertSolanaAddress(p.to);
  const mintPubkey = assertSolanaAddress(p.mint);
  const conn = getSolanaConnection();

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

  // Build the draft tx. No recentBlockhash — that gets set at preview time.
  const draftTx = new Transaction();
  draftTx.feePayer = fromPubkey;
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
  };
}
