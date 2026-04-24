import { fetchWithTimeout } from "../../data/http.js";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { assertSolanaAddress } from "./address.js";
import { getSolanaConnection } from "./rpc.js";
import { resolveAddressLookupTables } from "./alt.js";
import {
  buildAdvanceNonceIx,
  deriveNonceAccountAddress,
  getNonceAccountValue,
} from "./nonce.js";
import { throwNonceRequired } from "./actions.js";
import { SOLANA_TOKEN_DECIMALS, SOLANA_TOKENS } from "../../config/solana.js";
import {
  issueSolanaDraftHandle,
  type SolanaTxDraft,
} from "../../signing/solana-tx-store.js";

/**
 * Jupiter swap integration — uses the `/swap-instructions` endpoint rather
 * than `/swap`.
 *
 * Why instructions, not the pre-built transaction:
 * Jupiter's `/swap` returns a fully-assembled base64 VersionedTransaction.
 * That would work, but we'd have to deserialize it, surgically prepend our
 * `SystemProgram.nonceAdvance` as ix[0], then re-serialize — fragile
 * surgery on bytes the user already inspected once. `/swap-instructions`
 * returns the constituent pieces (compute-budget, setup, swap, cleanup,
 * ALTs) so we can compose `[nonceAdvance, ...computeBudget, ...setup,
 * swap, cleanup?, ...other]` cleanly and let Milestone A's v0 pin build
 * the MessageV0 from scratch with our nonce value in recentBlockhash.
 *
 * Base URL: `https://lite-api.jup.ag/swap/v1` — Jupiter's public tier,
 * no API key required. The authenticated `api.jup.ag` endpoint is a drop-
 * in (same OpenAPI spec) if the user needs higher rate limits; switching
 * is a one-constant change.
 */
const JUPITER_BASE = "https://lite-api.jup.ag/swap/v1";

/**
 * Minimal shape of Jupiter's `QuoteResponse`. We preserve the full opaque
 * object to pass back to `/swap-instructions` (adding/removing fields on
 * our side would invalidate Jupiter's signing of the quote), but we
 * surface a typed subset for downstream callers and for constructing
 * human-readable previews.
 */
export interface JupiterQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: "ExactIn" | "ExactOut";
  slippageBps: number;
  priceImpactPct: string;
  routePlan: Array<{
    swapInfo: {
      ammKey: string;
      label: string;
      inputMint: string;
      outputMint: string;
      inAmount: string;
      outAmount: string;
    };
    percent: number;
  }>;
  contextSlot?: number;
  // Everything else (platformFee, mostReliableAmmsQuoteReport, etc.) we
  // preserve opaquely — the full object is what /swap-instructions needs.
  [key: string]: unknown;
}

interface JupiterRawInstruction {
  programId: string;
  accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  data: string; // base64
}

interface JupiterSwapInstructionsResponse {
  computeBudgetInstructions: JupiterRawInstruction[];
  setupInstructions: JupiterRawInstruction[];
  swapInstruction: JupiterRawInstruction;
  cleanupInstruction: JupiterRawInstruction | null;
  otherInstructions: JupiterRawInstruction[];
  addressLookupTableAddresses: string[];
}

function toWeb3Instruction(raw: JupiterRawInstruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(raw.programId),
    keys: raw.accounts.map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data: Buffer.from(raw.data, "base64"),
  });
}

/** Wrapped-SOL mint — Jupiter auto-wraps/unwraps, so users swap "SOL" via this mint. */
const WSOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Reverse map: mint address → canonical symbol + decimals (for known tokens).
 * Handles wSOL specially (the swap table in `config/solana.ts` tracks SPL
 * tokens the portfolio cares about; wSOL is a Jupiter-interop concern
 * only, not a holdable balance, so it's not in SOLANA_TOKENS).
 *
 * Near-duplicate of the helper in actions.ts — kept local to avoid an
 * import cycle. If this grows to more than the two call sites, extract to
 * a shared module.
 */
function resolveKnownMint(
  mint: string,
): { symbol: string; decimals: number } | null {
  if (mint === WSOL_MINT) return { symbol: "SOL", decimals: 9 };
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

/** Format a raw token integer amount into human units given decimals. */
function formatTokenUnits(raw: string, decimals: number): string {
  const rawBig = BigInt(raw);
  if (decimals === 0) return rawBig.toString();
  const base = 10n ** BigInt(decimals);
  const whole = rawBig / base;
  const frac = rawBig % base;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

export interface JupiterQuoteParams {
  inputMint: string;
  outputMint: string;
  /** Raw integer amount in base units (e.g. "1000000" for 1 USDC). */
  amount: string;
  slippageBps: number;
  swapMode?: "ExactIn" | "ExactOut";
}

/**
 * Fetch a Jupiter quote. Read-only — no on-chain or signing side effects.
 * Returns the opaque `quoteResponse` object the user will hand back to
 * `buildJupiterSwap` (or `prepare_solana_swap`) along with a few derived
 * human-facing fields for the preview.
 */
export async function getJupiterQuote(
  p: JupiterQuoteParams,
): Promise<{
  quote: JupiterQuote;
  human: {
    inputSymbol: string;
    outputSymbol: string;
    inputAmountHuman: string;
    outputAmountHuman: string;
    minOutputHuman: string;
    priceImpactPct: string;
    routeLabels: string[];
  };
}> {
  // Validate mints look like Solana pubkeys up front — Jupiter's error
  // otherwise comes back as a 400 with opaque JSON.
  assertSolanaAddress(p.inputMint);
  assertSolanaAddress(p.outputMint);

  const qs = new URLSearchParams({
    inputMint: p.inputMint,
    outputMint: p.outputMint,
    amount: p.amount,
    slippageBps: String(p.slippageBps),
    swapMode: p.swapMode ?? "ExactIn",
    // Constrain route size — Jupiter can otherwise route through 60+ accounts
    // which pushes v0 txs toward the 1232-byte packet ceiling. 40 is a safe
    // cap that still lets most routes through (Jupiter's own UI default).
    maxAccounts: "40",
  });
  const res = await fetchWithTimeout(`${JUPITER_BASE}/quote?${qs}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Jupiter /quote failed (HTTP ${res.status}): ${body.slice(0, 500)}`,
    );
  }
  const quote = (await res.json()) as JupiterQuote;

  // Derive human-facing fields. Unknown mints → use raw amounts with
  // decimals=0 as a conservative fallback (caller still sees the raw
  // base-units string so no precision loss).
  const inputInfo = resolveKnownMint(quote.inputMint);
  const outputInfo = resolveKnownMint(quote.outputMint);
  const inputSymbol = inputInfo?.symbol ?? "UNKNOWN";
  const outputSymbol = outputInfo?.symbol ?? "UNKNOWN";
  const inputAmountHuman = inputInfo
    ? formatTokenUnits(quote.inAmount, inputInfo.decimals)
    : quote.inAmount;
  const outputAmountHuman = outputInfo
    ? formatTokenUnits(quote.outAmount, outputInfo.decimals)
    : quote.outAmount;
  const minOutputHuman = outputInfo
    ? formatTokenUnits(quote.otherAmountThreshold, outputInfo.decimals)
    : quote.otherAmountThreshold;
  const routeLabels = quote.routePlan.map((r) => r.swapInfo.label);

  return {
    quote,
    human: {
      inputSymbol,
      outputSymbol,
      inputAmountHuman,
      outputAmountHuman,
      minOutputHuman,
      priceImpactPct: quote.priceImpactPct,
      routeLabels,
    },
  };
}

export interface JupiterSwapParams {
  wallet: string;
  quote: JupiterQuote;
  /** Optional priority fee in lamports. Defaults to "auto" (Jupiter's recommendation). */
  prioritizationFeeLamports?: number | "auto";
}

export interface PreparedJupiterSwap {
  handle: string;
  action: "jupiter_swap";
  chain: "solana";
  from: string;
  description: string;
  decoded: { functionName: string; args: Record<string, string> };
  nonceAccount: string;
}

/**
 * Build the Jupiter swap tx as a v0 MessageV0 draft. Composition:
 *
 *   ix[0]                   = SystemProgram.nonceAdvance   (our durable-nonce)
 *   ix[1..k]                = Jupiter's compute-budget ixs (set CU limit + price)
 *   ix[k+1..m]              = Jupiter's setup ixs          (create ATAs if needed, wrap SOL, etc.)
 *   ix[m+1]                 = Jupiter's swap ix            (the actual route)
 *   ix[m+2]                 = Jupiter's cleanup ix         (close temp WSOL account, etc. — optional)
 *   ix[m+3..n]              = Jupiter's other ixs          (jito tip if priorityFee set that way)
 *
 * Jupiter's `/swap-instructions` also returns `addressLookupTableAddresses`
 * — the ALTs that compress the account list so the v0 message fits. We
 * resolve those via Milestone A's `resolveAddressLookupTables` helper so
 * Milestone A's v0 pin path can compile MessageV0 with them at preview
 * time. Without the ALTs the account list wouldn't fit.
 *
 * Nonce-required preflight: same gate as every other Solana send — if the
 * wallet hasn't run `prepare_solana_nonce_init`, we throw a structured
 * error pointing to that tool.
 */
export async function buildJupiterSwap(
  p: JupiterSwapParams,
): Promise<PreparedJupiterSwap> {
  const fromPubkey = assertSolanaAddress(p.wallet);
  const conn = getSolanaConnection();

  // Durable-nonce preflight (shared helper from actions.ts).
  const noncePubkey = await deriveNonceAccountAddress(fromPubkey);
  const nonceState = await getNonceAccountValue(conn, noncePubkey);
  if (!nonceState) throwNonceRequired(p.wallet);

  // Fetch Jupiter's deconstructed ix list. NOTE: we pass the quote
  // verbatim — Jupiter computes a signature over the quote object and
  // will reject on /swap-instructions if we mutate any field.
  const body = {
    userPublicKey: p.wallet,
    quoteResponse: p.quote,
    // Skip shared-account routing to preserve the ability to pass our
    // own nonce authority in instruction accounts. useSharedAccounts
    // worked in testing but costs us control; Jupiter's fallback path
    // creates any intermediate ATAs the user's wallet actually needs.
    useSharedAccounts: true,
    wrapAndUnwrapSol: true,
    // dynamicComputeUnitLimit simulates the swap server-side to size the
    // CU limit properly. Adds one RPC call but reduces priority-fee
    // overpay and improves landing rates. Recommended by Jupiter for all
    // normal flows.
    dynamicComputeUnitLimit: true,
    // Priority fee: let Jupiter pick by default (it reads the local fee
    // market). If caller specified an integer, pass it through.
    ...(typeof p.prioritizationFeeLamports === "number"
      ? { prioritizationFeeLamports: p.prioritizationFeeLamports }
      : {}),
  };
  const res = await fetchWithTimeout(`${JUPITER_BASE}/swap-instructions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const rawBody = await res.text();
    throw new Error(
      `Jupiter /swap-instructions failed (HTTP ${res.status}): ${rawBody.slice(0, 500)}`,
    );
  }
  const j = (await res.json()) as JupiterSwapInstructionsResponse;

  // Compose the full ix list with our nonce advance at ix[0].
  const instructions: TransactionInstruction[] = [
    buildAdvanceNonceIx(noncePubkey, fromPubkey),
    ...j.computeBudgetInstructions.map(toWeb3Instruction),
    ...j.setupInstructions.map(toWeb3Instruction),
    toWeb3Instruction(j.swapInstruction),
    ...(j.cleanupInstruction ? [toWeb3Instruction(j.cleanupInstruction)] : []),
    ...j.otherInstructions.map(toWeb3Instruction),
  ];

  // Resolve ALTs (may be empty for simple routes).
  const altPubkeys = j.addressLookupTableAddresses.map((s) => new PublicKey(s));
  const alts = await resolveAddressLookupTables(conn, altPubkeys);

  // Build human-facing description for the bullet summary.
  const inputInfo = resolveKnownMint(p.quote.inputMint);
  const outputInfo = resolveKnownMint(p.quote.outputMint);
  const inSym = inputInfo?.symbol ?? p.quote.inputMint;
  const outSym = outputInfo?.symbol ?? p.quote.outputMint;
  const inAmt = inputInfo
    ? formatTokenUnits(p.quote.inAmount, inputInfo.decimals)
    : p.quote.inAmount;
  const outAmt = outputInfo
    ? formatTokenUnits(p.quote.outAmount, outputInfo.decimals)
    : p.quote.outAmount;
  const minOut = outputInfo
    ? formatTokenUnits(p.quote.otherAmountThreshold, outputInfo.decimals)
    : p.quote.otherAmountThreshold;
  const routeLabels = p.quote.routePlan.map((r) => r.swapInfo.label).join(" → ");

  const nonceAccountStr = noncePubkey.toBase58();
  const draft: SolanaTxDraft = {
    kind: "v0",
    payerKey: fromPubkey,
    instructions,
    addressLookupTableAccounts: alts,
    meta: {
      action: "jupiter_swap",
      from: p.wallet,
      description: `Swap ${inAmt} ${inSym} → ${outAmt} ${outSym} via Jupiter (${routeLabels}); min output ${minOut} ${outSym} @ ${p.quote.slippageBps} bps slippage`,
      decoded: {
        functionName: "solana.jupiter.swap",
        args: {
          from: p.wallet,
          inputMint: p.quote.inputMint,
          outputMint: p.quote.outputMint,
          inputSymbol: inSym,
          outputSymbol: outSym,
          inputAmount: `${inAmt} ${inSym}`,
          outputAmount: `${outAmt} ${outSym}`,
          minOutput: `${minOut} ${outSym}`,
          slippageBps: String(p.quote.slippageBps),
          priceImpactPct: p.quote.priceImpactPct,
          route: routeLabels,
          addressLookupTables: String(alts.length),
          nonceAccount: nonceAccountStr,
        },
      },
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
    action: "jupiter_swap",
    chain: "solana",
    from: p.wallet,
    description: draft.meta.description,
    decoded: draft.meta.decoded,
    nonceAccount: nonceAccountStr,
  };
}
