import type { Connection, PublicKey } from "@solana/web3.js";
import BigNumber from "bignumber.js";
import { assertSolanaAddress } from "../solana/address.js";
import {
  __internals,
  deriveMarginfiAccountPda,
  getHardenedMarginfiClient,
} from "../solana/marginfi.js";

/**
 * Read-only MarginFi position reader. Parallels `getAaveLendingPosition` —
 * enumerates one wallet's MarginfiAccount balances across all banks,
 * computes the (USD-denominated) supplied + borrowed totals, and derives a
 * health factor.
 *
 * Health factor convention: MarginFi's on-chain health components are
 * `{assets, liabilities}` in USD. We publish `assets / liabilities` as the
 * health factor (Infinity when liabilities === 0), same convention as Aave
 * — user-facing semantics: >1 safe, <1 liquidatable.
 */

export interface MarginfiBalanceEntry {
  bank: string;
  mint: string;
  symbol: string;
  /** Human-readable decimal balance (already-decimals-applied). */
  amount: string;
  valueUsd: number;
}

export interface MarginfiPosition {
  protocol: "marginfi";
  chain: "solana";
  wallet: string;
  /** Base58 PDA of the MarginfiAccount this reader surfaced. */
  marginfiAccount: string;
  supplied: MarginfiBalanceEntry[];
  borrowed: MarginfiBalanceEntry[];
  totalSuppliedUsd: number;
  totalBorrowedUsd: number;
  netValueUsd: number;
  /** assets/liabilities from `computeHealthComponents`. Infinity when no debt. */
  healthFactor: number;
  /** Optional bank-level pause flags — empty array when all banks healthy. */
  warnings: string[];
}

interface MinimalBalance {
  active: boolean;
  bankPk: PublicKey;
  computeQuantityUi(bank: unknown): { assets: BigNumber; liabilities: BigNumber };
  computeUsdValue(
    bank: unknown,
    price: unknown,
  ): { assets: BigNumber; liabilities: BigNumber };
}

interface MinimalWrapper {
  address: PublicKey;
  activeBalances: MinimalBalance[];
  computeHealthComponents(req: unknown): {
    assets: BigNumber;
    liabilities: BigNumber;
  };
}

interface MinimalBank {
  address: PublicKey;
  mint: PublicKey;
  tokenSymbol?: string;
  isPaused?: boolean;
}

interface MinimalClient {
  banks: Map<string, MinimalBank>;
  oraclePrices: Map<string, unknown>;
  getOraclePriceByBank?(bankAddr: PublicKey): unknown;
}

/**
 * Resolve the first `limit` MarginfiAccounts for a wallet. Most users have
 * exactly one (accountIndex=0); we read up to 4 slots before giving up. The
 * aggregate position is surfaced as PER-ACCOUNT entries — MarginFi treats
 * separate MarginfiAccounts as independent borrowing containers, so mixing
 * their totals would mask a per-account liquidation risk.
 */
export async function getMarginfiPositions(
  conn: Connection,
  wallet: string,
): Promise<MarginfiPosition[]> {
  const authority = assertSolanaAddress(wallet);

  // Short-circuit BEFORE loading the heavy MarginfiClient. The PDA is
  // deterministic; a single getAccountInfo is cheap, and the common case
  // (wallet has no MarginfiAccount at all) should not pay the SDK-load
  // cost — nor expose users to the SDK's deep internals failing on an
  // empty wallet (issue #102: `MarginfiClient.fetch` + related hydration
  // paths have produced opaque `Cannot read properties of null (reading
  // 'property')` errors when the MarginfiAccount was freshly initialized
  // or missing). Probe the first 4 slots to find what's there.
  const MAX_SLOTS = 4;
  const existingSlots: { idx: number; pda: PublicKey }[] = [];
  for (let idx = 0; idx < MAX_SLOTS; idx++) {
    const pda = deriveMarginfiAccountPda(authority, idx);
    const info = await conn.getAccountInfo(pda, "confirmed");
    if (!info) {
      // Gap in the slot sequence means no further accounts. Users don't
      // skip slots in practice (UIs allocate 0, 1, 2 sequentially).
      break;
    }
    existingSlots.push({ idx, pda });
  }
  if (existingSlots.length === 0) {
    // Strict empty-array contract — this path replaces the prior code
    // where a wallet without a MarginfiAccount triggered the SDK's null-
    // property error before we ever reached the slot check (issue #101).
    return [];
  }

  // At least one PDA exists — now load the SDK client through the shared
  // hardened entry point so per-bank/per-oracle decode failures don't blow
  // up the whole load (issue #105). Wrap in a defensive try/catch for the
  // residual error surface (e.g. upstream RPC down, group account gone).
  let client: unknown;
  try {
    client = await getHardenedMarginfiClient(conn, authority);
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Failed to load MarginfiClient for wallet ${wallet} — this usually means the ` +
        `bundled SDK (v6.4.1, IDL 0.1.7) couldn't decode one of the banks or oracle ` +
        `prices fetched from the production group. Raw error: ${raw}. ` +
        `As a workaround, the PDA ${existingSlots[0]?.pda.toBase58()} exists on chain ` +
        `at accountIndex=${existingSlots[0]?.idx} — you can inspect it directly via ` +
        `Solana Explorer.`,
    );
  }

  // Hydrate each existing slot's wrapper. One failing slot shouldn't kill
  // the whole enumeration — we continue and report what we can.
  const { MarginfiAccountWrapper } = await import(
    "@mrgnlabs/marginfi-client-v2"
  );
  const results: MarginfiPosition[] = [];
  for (const { pda } of existingSlots) {
    let wrapper: MinimalWrapper;
    try {
      wrapper = (await MarginfiAccountWrapper.fetch(
        pda,
        client as never,
      )) as unknown as MinimalWrapper;
    } catch {
      // Hydration failure on one slot — skip it silently. The caller
      // sees this as an empty array or fewer entries than slots; not
      // a blocker.
      continue;
    }
    try {
      results.push(
        buildPositionFromWrapper(
          client as unknown as MinimalClient,
          wrapper,
          wallet,
        ),
      );
    } catch (e) {
      // Health-compute / balance-decode failures on a freshly-inited
      // account with no balances can trip the SDK's internal math
      // (issue #102). Surface a placeholder position with health=Infinity
      // so callers see the account exists rather than get a raw throw.
      const raw = e instanceof Error ? e.message : String(e);
      results.push({
        protocol: "marginfi",
        chain: "solana",
        wallet,
        marginfiAccount: pda.toBase58(),
        supplied: [],
        borrowed: [],
        totalSuppliedUsd: 0,
        totalBorrowedUsd: 0,
        netValueUsd: 0,
        healthFactor: Number.POSITIVE_INFINITY,
        warnings: [
          `MarginFi position compute failed (likely a fresh account with no balances, or an SDK decode issue). ` +
            `The account itself exists on chain. Raw error: ${raw}`,
        ],
      });
    }
  }
  return results;
}

function buildPositionFromWrapper(
  client: MinimalClient,
  wrapper: MinimalWrapper,
  wallet: string,
): MarginfiPosition {
  const supplied: MarginfiBalanceEntry[] = [];
  const borrowed: MarginfiBalanceEntry[] = [];
  const warnings: string[] = [];

  let totalSuppliedUsd = 0;
  let totalBorrowedUsd = 0;

  for (const balance of wrapper.activeBalances) {
    const bank = client.banks.get(balance.bankPk.toBase58());
    if (!bank) continue;
    const price = resolveOraclePrice(client, bank.address);
    if (!price) continue;

    const { assets: assetsUi, liabilities: liabilitiesUi } = balance.computeQuantityUi(
      bank as unknown,
    );
    const usd = balance.computeUsdValue(bank as unknown, price);
    const mint = bank.mint.toBase58();
    const symbol = bank.tokenSymbol ?? __internals.resolveMintSymbol(mint);

    if (assetsUi.gt(0)) {
      const usdValue = usd.assets.toNumber();
      supplied.push({
        bank: bank.address.toBase58(),
        mint,
        symbol,
        amount: assetsUi.toFixed(6).replace(/\.?0+$/, ""),
        valueUsd: round2(usdValue),
      });
      totalSuppliedUsd += usdValue;
    }
    if (liabilitiesUi.gt(0)) {
      const usdValue = usd.liabilities.toNumber();
      borrowed.push({
        bank: bank.address.toBase58(),
        mint,
        symbol,
        amount: liabilitiesUi.toFixed(6).replace(/\.?0+$/, ""),
        valueUsd: round2(usdValue),
      });
      totalBorrowedUsd += usdValue;
    }
    if (bank.isPaused) {
      warnings.push(`${symbol} bank is governance-paused (all actions blocked).`);
    }
  }

  // Maintenance margin type is the one users map to "can I be liquidated right now?".
  // MarginRequirementType.Maintenance === 1 in the SDK's enum; we use the numeric
  // literal to avoid importing the enum just for the one call.
  //
  // Guarded: a fresh account with no active balances has a healthCache the
  // SDK hasn't written to yet, and `marginfiAccount.healthCache.*Maint` can
  // be null → `null.toNumber()` throws (issue #102). Fall back to Infinity
  // (conceptually: no debt, can't be liquidated) so the reader returns a
  // usable entry instead of failing the whole call.
  let healthFactor = Number.POSITIVE_INFINITY;
  try {
    const health = wrapper.computeHealthComponents(1);
    const assetsUsd = health.assets.toNumber();
    const liabsUsd = health.liabilities.toNumber();
    healthFactor =
      liabsUsd <= 0 ? Number.POSITIVE_INFINITY : assetsUsd / liabsUsd;
  } catch {
    healthFactor = Number.POSITIVE_INFINITY;
    warnings.push(
      "Health factor unavailable — SDK couldn't read healthCache (likely a freshly-initialized account with no balances).",
    );
  }

  return {
    protocol: "marginfi",
    chain: "solana",
    wallet,
    marginfiAccount: wrapper.address.toBase58(),
    supplied,
    borrowed,
    totalSuppliedUsd: round2(totalSuppliedUsd),
    totalBorrowedUsd: round2(totalBorrowedUsd),
    netValueUsd: round2(totalSuppliedUsd - totalBorrowedUsd),
    healthFactor,
    warnings,
  };
}

/**
 * Resolve a bank's oracle price from the MarginFi client's `oraclePrices`
 * map. The SDK exposes both a getter (when available) and a raw Map; we
 * prefer the getter so per-bank price-age handling stays with the SDK.
 */
function resolveOraclePrice(client: MinimalClient, bank: PublicKey): unknown {
  if (typeof client.getOraclePriceByBank === "function") {
    return client.getOraclePriceByBank(bank);
  }
  return client.oraclePrices.get(bank.toBase58());
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
