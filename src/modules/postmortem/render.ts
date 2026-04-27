/**
 * Render a `ExplainTxResult` to a narrative string suitable for
 * verbatim relay. Format mirrors the agent-facing convention used by
 * `get_portfolio_diff` — a heading, one-sentence summary, then bullet
 * sections. Values are formatted for terminal width; long contract
 * addresses are truncated to head/tail.
 */

import type { ExplainTxResult } from "./schemas.js";

function shortAddr(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function signed(n: number): string {
  if (n > 0) return `+${n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
  if (n < 0) return n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return "0";
}

function signedUsd(n: number): string {
  if (n > 0) return `+$${n.toFixed(2)}`;
  if (n < 0) return `-$${Math.abs(n).toFixed(2)}`;
  return "$0.00";
}

export function renderPostmortemNarrative(r: ExplainTxResult): string {
  const lines: string[] = [];
  const chainLabel =
    r.chain.charAt(0).toUpperCase() + r.chain.slice(1);
  lines.push(`TRANSACTION ANALYSIS (${chainLabel})`);
  lines.push("");
  lines.push(`Hash: ${r.hash}`);
  lines.push(`Status: ${r.status.toUpperCase()}`);
  if (r.blockNumber) {
    lines.push(
      `Block: ${r.blockNumber}${r.blockTimeIso ? ` (${r.blockTimeIso})` : ""}`,
    );
  }
  lines.push(`From: ${r.from}`);
  if (r.to) lines.push(`To:   ${r.to}`);
  if (r.feeNative) {
    const feeBit = `${r.feeNative} ${r.feeNativeSymbol ?? ""}`;
    const usdBit =
      r.feeUsd !== undefined ? ` (~$${r.feeUsd.toFixed(2)} USD)` : "";
    lines.push(`Fee:  ${feeBit}${usdBit}`);
  }
  lines.push("");
  lines.push(`Summary: ${r.summary}`);
  lines.push("");

  if (r.steps.length > 0) {
    lines.push("Step-by-step:");
    for (let i = 0; i < r.steps.length; i++) {
      const s = r.steps[i];
      lines.push(`  ${i + 1}. [${s.kind}] ${s.label} — ${s.detail}`);
    }
    lines.push("");
  }

  if (r.balanceChanges.length > 0) {
    lines.push(`Balance changes (perspective: ${shortAddr(r.perspective)}):`);
    for (const b of r.balanceChanges) {
      const usd =
        b.valueUsd !== undefined ? ` (${signedUsd(b.valueUsd)})` : "";
      lines.push(`  • ${b.symbol}: ${signed(b.deltaApprox)}${usd}`);
    }
    lines.push("");
  }

  if (r.approvalChanges.length > 0) {
    lines.push("Approval changes:");
    for (const a of r.approvalChanges) {
      const allowance = a.isUnlimited ? "UNLIMITED" : a.newAllowance;
      lines.push(
        `  • ${a.symbol ?? shortAddr(a.token)} → ${shortAddr(a.spender)}: ${allowance}`,
      );
    }
    lines.push("");
  }

  if (r.heuristics.length > 0) {
    lines.push("Things you might want to know:");
    for (const h of r.heuristics) {
      lines.push(`  ⚠ [${h.rule}] ${h.message}`);
    }
    lines.push("");
  }

  if (r.notes.length > 0) {
    lines.push("Notes:");
    for (const n of r.notes) lines.push(`  · ${n}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
