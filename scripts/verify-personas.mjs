#!/usr/bin/env node
/**
 * Persona address rotation watcher.
 *
 * Personas in `src/demo/personas.ts` point at real public wallets that
 * may drift over time — a "stable-saver" cell could exit all USDC
 * positions tomorrow, leaving the persona description false. This
 * script does cheap liveness checks against public RPC / public chain
 * APIs and prints a markdown report flagging cells that look dead or
 * drifted. Designed for `workflow_dispatch` (manual + weekly cron) so
 * a human reviews the report and refreshes the matrix when needed.
 *
 * Scope is intentionally minimal: we verify the address still exists
 * and has a non-zero native balance for the chain. We do NOT try to
 * verify per-flow rehearsability (e.g. "does this wallet actually
 * have an Aave V3 supply position?") — that would require per-protocol
 * SDK setup with API keys, which is out of scope for an out-of-tree
 * weekly watcher. Liveness is the cheap proxy: a wallet that's gone
 * from "exchange hot wallet" to zero balance has clearly rotated.
 *
 * Usage:
 *   npm run build                      # produce dist/demo/personas.js
 *   node scripts/verify-personas.mjs   # prints report, exits 0 / 1
 */
import { DEMO_WALLETS } from "../dist/demo/personas.js";

const TIMEOUT_MS = 15_000;

async function fetchWithTimeout(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function evmNativeBalance(address) {
  const res = await fetchWithTimeout("https://ethereum-rpc.publicnode.com", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBalance",
      params: [address, "latest"],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return BigInt(json.result);
}

async function solanaNativeBalance(address) {
  const res = await fetchWithTimeout("https://api.mainnet-beta.solana.com", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getBalance",
      params: [address],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return BigInt(json.result.value);
}

async function tronNativeBalance(address) {
  const res = await fetchWithTimeout(
    `https://api.trongrid.io/v1/accounts/${address}`,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const account = json.data?.[0];
  if (!account) return 0n;
  return BigInt(account.balance ?? 0);
}

async function btcAddressTxCount(address) {
  const res = await fetchWithTimeout(
    `https://mempool.space/api/address/${address}`,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return (json.chain_stats?.tx_count ?? 0) + (json.mempool_stats?.tx_count ?? 0);
}

function isTransientErr(err) {
  const msg = err instanceof Error ? err.message : String(err);
  // Rate-limit / abort / network reset: not drift, just public-API noise.
  return /HTTP 429|HTTP 5\d\d|aborted|fetch failed|ECONN/i.test(msg);
}

async function checkCell(chain, type, cell) {
  try {
    if (chain === "evm") {
      const wei = await evmNativeBalance(cell.address);
      return {
        status: wei > 0n ? "alive" : "drifted",
        detail: `${(Number(wei) / 1e18).toFixed(4)} ETH`,
      };
    }
    if (chain === "solana") {
      const lamports = await solanaNativeBalance(cell.address);
      return {
        status: lamports > 0n ? "alive" : "drifted",
        detail: `${(Number(lamports) / 1e9).toFixed(4)} SOL`,
      };
    }
    if (chain === "tron") {
      const sun = await tronNativeBalance(cell.address);
      return {
        status: sun > 0n ? "alive" : "drifted",
        detail: `${(Number(sun) / 1e6).toFixed(4)} TRX`,
      };
    }
    if (chain === "bitcoin") {
      const txCount = await btcAddressTxCount(cell.address);
      return {
        status: txCount > 0 ? "alive" : "drifted",
        detail: `${txCount} txs (lifetime)`,
      };
    }
    return { status: "drifted", detail: `unknown chain: ${chain}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: isTransientErr(err) ? "inconclusive" : "drifted",
      detail: `error: ${msg}`,
    };
  }
}

async function main() {
  const lines = [];
  lines.push("# Persona address rotation report");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("| Chain | Type | Address | Status | Detail |");
  lines.push("|-------|------|---------|--------|--------|");

  let drifted = 0;
  let inconclusive = 0;
  let total = 0;
  for (const [chain, byType] of Object.entries(DEMO_WALLETS)) {
    for (const [type, cell] of Object.entries(byType)) {
      if (!cell) continue;
      total++;
      const { status, detail } = await checkCell(chain, type, cell);
      const label =
        status === "alive" ? "✓ alive" : status === "inconclusive" ? "⚠ inconclusive" : "✗ drifted";
      if (status === "drifted") drifted++;
      else if (status === "inconclusive") inconclusive++;
      const shortAddr = cell.address.slice(0, 8) + "…" + cell.address.slice(-4);
      lines.push(`| ${chain} | ${type} | \`${shortAddr}\` | ${label} | ${detail} |`);
    }
  }

  lines.push("");
  const alive = total - drifted - inconclusive;
  lines.push(
    `**Summary:** ${alive} / ${total} cells alive, ${drifted} drifted, ${inconclusive} inconclusive (transient API errors — re-run later).`,
  );
  if (drifted > 0) {
    lines.push("");
    lines.push("Drifted cells need attention — refresh the wallet in `src/demo/personas.ts` and bump `verifiedAt`.");
  }

  const report = lines.join("\n");
  console.log(report);
  // Inconclusive results don't fail the workflow — they're rate-limit
  // noise, not real drift. A genuine drift requires a confirmed
  // empty-balance / no-activity response.
  process.exit(drifted > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("verify-personas failed:", err);
  process.exit(2);
});
