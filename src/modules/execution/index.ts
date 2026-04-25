import { randomUUID } from "node:crypto";
import { encodeFunctionData, formatUnits, isAddress, parseEther, parseUnits } from "viem";
import qrcodeTerminal from "qrcode-terminal";
import {
  initiatePairing,
  requestSendTransaction,
  getConnectedAccounts,
} from "../../signing/walletconnect.js";
import {
  consumeHandle,
  retireHandle,
  attachPinnedGas,
  getPinnedGas,
  type StashedPin,
} from "../../signing/tx-store.js";
import { consumeTronHandle, retireTronHandle } from "../../signing/tron-tx-store.js";
import {
  consumeSolanaHandle,
  retireSolanaHandle,
  hasSolanaHandle,
  getSolanaDraft,
  pinSolanaHandle,
} from "../../signing/solana-tx-store.js";
import {
  consumeBitcoinHandle,
  retireBitcoinHandle,
  hasBitcoinHandle,
} from "../../signing/btc-tx-store.js";
import {
  signBtcPsbtOnLedger,
  getPairedBtcByAddress,
} from "../../signing/btc-usb-signer.js";
import {
  getTronLedgerAddress,
  signTronTxOnLedger,
  setPairedTronAddress,
  getPairedTronByAddress,
  tronPathForAccountIndex,
} from "../../signing/tron-usb-signer.js";
import {
  getSolanaLedgerAddress,
  signSolanaTxOnLedger,
  setPairedSolanaAddress,
  getPairedSolanaByAddress,
  solanaPathForAccountIndex,
} from "../../signing/solana-usb-signer.js";
import { broadcastTronTx } from "../tron/broadcast.js";
import { getTronTransactionStatus } from "../tron/status.js";
import { broadcastSolanaTx } from "../solana/broadcast.js";
import { getSolanaTransactionStatus } from "../solana/status.js";
import {
  buildSolanaNativeSend,
  buildSolanaSplSend,
  buildSolanaNonceInit,
  buildSolanaNonceClose,
  type PreparedSolanaTx,
} from "../solana/actions.js";
import { getSolanaConnection } from "../solana/rpc.js";
import { getDeviceStateHint } from "../diagnostics/ledger-device-info.js";
import { assertTransactionSafe } from "../../signing/pre-sign-check.js";
import {
  eip1559PreSignHash,
  payloadFingerprint,
  tronPayloadFingerprint,
  solanaPayloadFingerprint,
  solanaLedgerMessageHash,
} from "../../signing/verification.js";
import { isClearSignOnlyTx } from "../../signing/render-verification.js";
import { getClient, verifyChainId } from "../../data/rpc.js";
import { erc20Abi } from "../../abis/erc20.js";
import { resolveTokenMeta } from "../shared/token-meta.js";
import { simulateTx } from "../simulation/index.js";
import {
  buildAaveSupply,
  buildAaveWithdraw,
  buildAaveBorrow,
  buildAaveRepay,
} from "../positions/actions.js";
import {
  buildLidoStake,
  buildLidoUnstake,
  buildEigenLayerDeposit,
} from "../staking/actions.js";
import { buildWethUnwrap } from "../weth/actions.js";
import { getTokenPrice } from "../../data/prices.js";
import type {
  PairLedgerTronArgs,
  PairLedgerSolanaArgs,
  PairLedgerBitcoinArgs,
  PrepareAaveSupplyArgs,
  PrepareAaveWithdrawArgs,
  PrepareAaveBorrowArgs,
  PrepareAaveRepayArgs,
  PrepareLidoStakeArgs,
  PrepareLidoUnstakeArgs,
  PrepareEigenLayerDepositArgs,
  PrepareNativeSendArgs,
  PrepareWethUnwrapArgs,
  PrepareTokenSendArgs,
  PrepareSolanaNativeSendArgs,
  PrepareSolanaSplSendArgs,
  PrepareSolanaNonceInitArgs,
  PrepareSolanaNonceCloseArgs,
  GetSolanaSwapQuoteArgs,
  PrepareSolanaSwapArgs,
  PrepareMarginfiInitArgs,
  PrepareMarginfiSupplyArgs,
  PrepareMarginfiWithdrawArgs,
  PrepareMarginfiBorrowArgs,
  PrepareMarginfiRepayArgs,
  PrepareMarinadeStakeArgs,
  PrepareMarinadeUnstakeImmediateArgs,
  PrepareNativeStakeDelegateArgs,
  PrepareNativeStakeDeactivateArgs,
  PrepareNativeStakeWithdrawArgs,
  PrepareSolanaLifiSwapArgs,
  PrepareTronLifiSwapArgs,
  PrepareKaminoInitUserArgs,
  PrepareKaminoSupplyArgs,
  PrepareKaminoBorrowArgs,
  PrepareKaminoWithdrawArgs,
  PrepareKaminoRepayArgs,
  GetKaminoPositionsArgs,
  GetBitcoinBalanceArgs,
  GetBitcoinBalancesArgs,
  GetBitcoinFeeEstimatesArgs,
  GetBitcoinTxHistoryArgs,
  PrepareBitcoinNativeSendArgs,
  GetMarginfiPositionsArgs,
  GetSolanaStakingPositionsArgs,
  PreviewSendArgs,
  SendTransactionArgs,
  GetTransactionStatusArgs,
  GetTxVerificationArgs,
  GetVerificationArtifactArgs,
} from "./schemas.js";
import { CHAIN_IDS } from "../../types/index.js";
import type {
  SupportedChain,
  UnsignedTx,
  UnsignedTronTx,
  UnsignedSolanaTx,
} from "../../types/index.js";
import { hasTronHandle } from "../../signing/tron-tx-store.js";
import { hasHandle } from "../../signing/tx-store.js";
import { round } from "../../data/format.js";
import {
  notApplicableForTron,
  verifyEvmCalldata,
  type VerifyDecodeResult,
} from "../../signing/verify-decode.js";

/** Render a QR code as an ASCII string (returns promise with the string). */
function qrString(uri: string): Promise<string> {
  return new Promise((resolve) => {
    qrcodeTerminal.generate(uri, { small: true }, (qr: string) => resolve(qr));
  });
}

export async function pairLedgerLive(): Promise<{
  uri: string;
  qr: string;
  instructions: string;
  waitingForApproval: true;
}> {
  const { uri, approval } = await initiatePairing();
  const qr = await qrString(uri);
  // Fire-and-forget: once approval resolves, the session is persisted automatically.
  approval.catch(() => {
    // WalletConnect will surface any error on the next call.
  });
  // If this is a re-pair (prior session exists on disk), surface the
  // cached peer version so the generated instructions lead with the UI
  // path that matched last time. Fresh first-ever pairs have no cached
  // session → version is undefined → instructions fall back to listing
  // both common UI paths.
  const { getCurrentSession } = await import("../../signing/walletconnect.js");
  const { parseLedgerLiveVersion, ledgerLivePairingInstructions } = await import(
    "../../signing/session.js"
  );
  const cached = getCurrentSession();
  const cachedVersion = parseLedgerLiveVersion(cached?.peer?.metadata);
  return {
    uri,
    qr,
    instructions: ledgerLivePairingInstructions(cachedVersion),
    waitingForApproval: true,
  };
}

/**
 * Pair the host's directly-connected Ledger device for TRON signing. Unlike
 * `pair_ledger_live` (WalletConnect relay for EVM), TRON signs over USB HID —
 * the Ledger must be plugged into the host running this MCP, unlocked, with
 * the TRON app open. Reads + caches the device address at the BIP-44 path
 * derived from `accountIndex` (default 0 = first Ledger Live TRON account)
 * so subsequent `get_ledger_status` calls can report it without re-probing.
 * Call with different `accountIndex` values to expose multiple TRON accounts.
 */
export async function pairLedgerTron(args: PairLedgerTronArgs = {}): Promise<{
  address: string;
  path: string;
  appVersion: string;
  accountIndex: number;
  instructions: string;
}> {
  const accountIndex = args.accountIndex ?? 0;
  const path = tronPathForAccountIndex(accountIndex);
  let result;
  try {
    result = await getTronLedgerAddress(path);
  } catch (e) {
    // Enrich the error with device-state probe data (which app is open
    // RIGHT NOW). The probe runs only on the failure path so successful
    // pairs don't pay the extra USB round-trip. If the probe itself
    // fails — likely because the same USB-HID resource is still busy —
    // we silently fall through to the original error message.
    const hint = await getDeviceStateHint("Tron");
    if (hint && e instanceof Error) {
      throw new Error(`${e.message} ${hint}`, { cause: e });
    }
    throw e;
  }
  setPairedTronAddress(result);
  return {
    address: result.address,
    path: result.path,
    appVersion: result.appVersion,
    accountIndex,
    instructions:
      "TRON account paired. You can now call `prepare_tron_*` with this address and " +
      "forward the handle via `send_transaction`. Keep the Ledger plugged in with the " +
      "TRON app open — each sign re-opens USB and re-verifies the device address. " +
      "To pair a different slot, call `pair_ledger_tron` again with another `accountIndex`.",
  };
}

/**
 * Pair the host's directly-connected Ledger device for Solana signing.
 * Unlike `pair_ledger_live` (WalletConnect relay for EVM), Solana signs
 * over USB HID because Ledger Live's WalletConnect integration does not
 * expose Solana accounts (confirmed 2026-04-23). The Ledger must be
 * plugged in, unlocked, with the Solana app open. Reads + caches the
 * device address at path `44'/501'/<accountIndex>'` (default 0 = first
 * Ledger Live Solana account).
 */
/**
 * Pair the host's directly-connected Ledger device for Bitcoin signing.
 * Same USB-HID rationale as `pair_ledger_solana` and `pair_ledger_tron`:
 * Ledger Live's WalletConnect relay does not expose `bip122` accounts
 * to dApps, so Bitcoin signing happens over USB HID. The Ledger must be
 * plugged in, unlocked, with the Bitcoin app open.
 *
 * One call enumerates ALL FOUR address types (legacy / p2sh-segwit /
 * segwit / taproot) for the given account index — the user sees their
 * full footprint per Ledger Live Bitcoin account in a single round-trip.
 * Each derivation is just `getWalletPublicKey` (read-only); no on-device
 * confirmation is requested by default. Subsequent calls with different
 * `accountIndex` values expose more accounts.
 */
export async function pairLedgerBitcoin(args: PairLedgerBitcoinArgs = {}): Promise<{
  accountIndex: number;
  appVersion: string;
  addresses: Array<{
    addressType: "legacy" | "p2sh-segwit" | "segwit" | "taproot";
    address: string;
    path: string;
  }>;
  instructions: string;
}> {
  const accountIndex = args.accountIndex ?? 0;
  const { deriveBtcLedgerAccount, setPairedBtcAddress } = await import(
    "../../signing/btc-usb-signer.js"
  );
  let derived;
  try {
    derived = await deriveBtcLedgerAccount(accountIndex);
  } catch (e) {
    // Same enrichment pattern as pairLedgerTron / pairLedgerSolana —
    // probe which app is currently open so the agent can tell the user
    // to switch to Bitcoin.
    const hint = await getDeviceStateHint("Bitcoin");
    if (hint && e instanceof Error) {
      throw new Error(`${e.message} ${hint}`, { cause: e });
    }
    throw e;
  }
  for (const entry of derived.entries) {
    setPairedBtcAddress({
      address: entry.address,
      publicKey: entry.publicKey,
      path: entry.path,
      appVersion: entry.appVersion,
      addressType: entry.addressType,
      accountIndex: entry.accountIndex,
    });
  }
  return {
    accountIndex,
    appVersion: derived.appVersion,
    addresses: derived.entries.map((e) => ({
      addressType: e.addressType,
      address: e.address,
      path: e.path,
    })),
    instructions:
      "Bitcoin account paired. All four standard mainnet address types " +
      "(legacy / p2sh-segwit / segwit / taproot) for this index are now cached. " +
      "Use `get_btc_balance` / `get_btc_balances` / `get_btc_tx_history` against " +
      "any of the four addresses. Send + message-signing flows ship in Phase 1 PR3/PR4. " +
      "Keep the Ledger plugged in with the Bitcoin app open — every device call " +
      "re-opens USB and re-verifies the path → address mapping.",
  };
}

export async function pairLedgerSolana(
  args: PairLedgerSolanaArgs = {},
): Promise<{
  address: string;
  path: string;
  appVersion: string;
  accountIndex: number;
  instructions: string;
}> {
  const accountIndex = args.accountIndex ?? 0;
  const path = solanaPathForAccountIndex(accountIndex);
  let result;
  try {
    result = await getSolanaLedgerAddress(path);
  } catch (e) {
    // Same enrichment pattern as pairLedgerTron — see comment there.
    const hint = await getDeviceStateHint("Solana");
    if (hint && e instanceof Error) {
      throw new Error(`${e.message} ${hint}`, { cause: e });
    }
    throw e;
  }
  setPairedSolanaAddress(result);
  return {
    address: result.address,
    path: result.path,
    appVersion: result.appVersion,
    accountIndex,
    instructions:
      "Solana account paired. You can now call `prepare_solana_native_send` / " +
      "`prepare_solana_spl_send` with this address and forward the handle via " +
      "`send_transaction`. Keep the Ledger plugged in with the Solana app open " +
      "— each sign re-opens USB and re-verifies the device address. Native SOL " +
      "sends clear-sign (amount + recipient shown on-device). SPL token sends " +
      "BLIND-SIGN — the Ledger Solana app requires a signed Trusted-Name " +
      "descriptor that only Ledger Live supplies, so the device shows a " +
      "'Message Hash' instead of decoded fields. For SPL: (1) enable 'Allow " +
      "blind signing' in Solana app → Settings, (2) match the Message Hash " +
      "surfaced in the preview against the on-device value. To pair another " +
      "slot, call `pair_ledger_solana` again with a different `accountIndex`.",
  };
}

export async function prepareSolanaNativeSend(
  args: PrepareSolanaNativeSendArgs,
): Promise<PreparedSolanaTx> {
  return buildSolanaNativeSend({
    wallet: args.wallet,
    to: args.to,
    amount: args.amount,
  });
}

export async function prepareSolanaSplSend(
  args: PrepareSolanaSplSendArgs,
): Promise<PreparedSolanaTx> {
  return buildSolanaSplSend({
    wallet: args.wallet,
    mint: args.mint,
    to: args.to,
    amount: args.amount,
  });
}

export async function prepareSolanaNonceInit(
  args: PrepareSolanaNonceInitArgs,
): Promise<PreparedSolanaTx> {
  return buildSolanaNonceInit({ wallet: args.wallet });
}

export async function prepareSolanaNonceClose(
  args: PrepareSolanaNonceCloseArgs,
): Promise<PreparedSolanaTx> {
  return buildSolanaNonceClose({ wallet: args.wallet });
}

export async function getSolanaSwapQuote(args: GetSolanaSwapQuoteArgs) {
  const { getJupiterQuote } = await import("../solana/jupiter.js");
  return getJupiterQuote({
    inputMint: args.inputMint,
    outputMint: args.outputMint,
    amount: args.amount,
    slippageBps: args.slippageBps,
    swapMode: args.swapMode,
  });
}

export async function prepareMarginfiInit(
  args: PrepareMarginfiInitArgs,
): Promise<PreparedSolanaTx> {
  const { buildMarginfiInit } = await import("../solana/marginfi.js");
  const prepared = await buildMarginfiInit({
    wallet: args.wallet,
    ...(args.accountIndex !== undefined ? { accountIndex: args.accountIndex } : {}),
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareMarginfiSupply(
  args: PrepareMarginfiSupplyArgs,
): Promise<PreparedSolanaTx> {
  const { buildMarginfiSupply } = await import("../solana/marginfi.js");
  const prepared = await buildMarginfiSupply({
    wallet: args.wallet,
    ...(args.symbol !== undefined ? { symbol: args.symbol } : {}),
    ...(args.mint !== undefined ? { mint: args.mint } : {}),
    amount: args.amount,
    ...(args.accountIndex !== undefined ? { accountIndex: args.accountIndex } : {}),
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareMarginfiWithdraw(
  args: PrepareMarginfiWithdrawArgs,
): Promise<PreparedSolanaTx> {
  const { buildMarginfiWithdraw } = await import("../solana/marginfi.js");
  const prepared = await buildMarginfiWithdraw({
    wallet: args.wallet,
    ...(args.symbol !== undefined ? { symbol: args.symbol } : {}),
    ...(args.mint !== undefined ? { mint: args.mint } : {}),
    amount: args.amount,
    ...(args.accountIndex !== undefined ? { accountIndex: args.accountIndex } : {}),
    ...(args.withdrawAll !== undefined ? { withdrawAll: args.withdrawAll } : {}),
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareMarginfiBorrow(
  args: PrepareMarginfiBorrowArgs,
): Promise<PreparedSolanaTx> {
  const { buildMarginfiBorrow } = await import("../solana/marginfi.js");
  const prepared = await buildMarginfiBorrow({
    wallet: args.wallet,
    ...(args.symbol !== undefined ? { symbol: args.symbol } : {}),
    ...(args.mint !== undefined ? { mint: args.mint } : {}),
    amount: args.amount,
    ...(args.accountIndex !== undefined ? { accountIndex: args.accountIndex } : {}),
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareMarginfiRepay(
  args: PrepareMarginfiRepayArgs,
): Promise<PreparedSolanaTx> {
  const { buildMarginfiRepay } = await import("../solana/marginfi.js");
  const prepared = await buildMarginfiRepay({
    wallet: args.wallet,
    ...(args.symbol !== undefined ? { symbol: args.symbol } : {}),
    ...(args.mint !== undefined ? { mint: args.mint } : {}),
    amount: args.amount,
    ...(args.accountIndex !== undefined ? { accountIndex: args.accountIndex } : {}),
    ...(args.repayAll !== undefined ? { repayAll: args.repayAll } : {}),
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareMarinadeStake(
  args: PrepareMarinadeStakeArgs,
): Promise<PreparedSolanaTx> {
  const { buildMarinadeStake } = await import("../solana/marinade.js");
  const prepared = await buildMarinadeStake({
    wallet: args.wallet,
    amountSol: args.amountSol,
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareMarinadeUnstakeImmediate(
  args: PrepareMarinadeUnstakeImmediateArgs,
): Promise<PreparedSolanaTx> {
  const { buildMarinadeUnstakeImmediate } = await import(
    "../solana/marinade.js"
  );
  const prepared = await buildMarinadeUnstakeImmediate({
    wallet: args.wallet,
    amountMSol: args.amountMSol,
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareNativeStakeDelegate(
  args: PrepareNativeStakeDelegateArgs,
): Promise<PreparedSolanaTx> {
  const { buildNativeStakeDelegate } = await import(
    "../solana/native-stake.js"
  );
  const prepared = await buildNativeStakeDelegate({
    wallet: args.wallet,
    validator: args.validator,
    amountSol: args.amountSol,
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareNativeStakeDeactivate(
  args: PrepareNativeStakeDeactivateArgs,
): Promise<PreparedSolanaTx> {
  const { buildNativeStakeDeactivate } = await import(
    "../solana/native-stake.js"
  );
  const prepared = await buildNativeStakeDeactivate({
    wallet: args.wallet,
    stakeAccount: args.stakeAccount,
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareNativeStakeWithdraw(
  args: PrepareNativeStakeWithdrawArgs,
): Promise<PreparedSolanaTx> {
  const { buildNativeStakeWithdraw } = await import(
    "../solana/native-stake.js"
  );
  const prepared = await buildNativeStakeWithdraw({
    wallet: args.wallet,
    stakeAccount: args.stakeAccount,
    amountSol: args.amountSol,
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareSolanaLifiSwap(
  args: PrepareSolanaLifiSwapArgs,
): Promise<PreparedSolanaTx> {
  const { buildLifiSolanaSwap } = await import("../solana/lifi-swap.js");
  const slippage =
    args.slippageBps !== undefined ? args.slippageBps / 10_000 : undefined;
  const prepared = await buildLifiSolanaSwap({
    wallet: args.wallet,
    fromMint: args.fromMint,
    fromAmount: args.fromAmount,
    toChain: args.toChain as Parameters<typeof buildLifiSolanaSwap>[0]["toChain"],
    toToken: args.toToken,
    ...(args.toAddress !== undefined ? { toAddress: args.toAddress } : {}),
    ...(slippage !== undefined ? { slippage } : {}),
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareTronLifiSwap(
  args: PrepareTronLifiSwapArgs,
): Promise<UnsignedTronTx> {
  const { buildTronLifiSwap } = await import("../tron/lifi-swap.js");
  const slippage =
    args.slippageBps !== undefined ? args.slippageBps / 10_000 : undefined;
  return buildTronLifiSwap({
    wallet: args.wallet,
    fromToken: args.fromToken,
    fromAmount: args.fromAmount,
    toChain: args.toChain as Parameters<typeof buildTronLifiSwap>[0]["toChain"],
    toToken: args.toToken,
    toAddress: args.toAddress,
    ...(slippage !== undefined ? { slippage } : {}),
  });
}

export async function prepareKaminoInitUser(
  args: PrepareKaminoInitUserArgs,
): Promise<PreparedSolanaTx> {
  const { buildKaminoInitUser } = await import("../solana/kamino-actions.js");
  const prepared = await buildKaminoInitUser({ wallet: args.wallet });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareKaminoSupply(
  args: PrepareKaminoSupplyArgs,
): Promise<PreparedSolanaTx> {
  const { buildKaminoSupply } = await import("../solana/kamino-actions.js");
  const prepared = await buildKaminoSupply({
    wallet: args.wallet,
    mint: args.mint,
    amount: args.amount,
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareKaminoBorrow(
  args: PrepareKaminoBorrowArgs,
): Promise<PreparedSolanaTx> {
  const { buildKaminoBorrow } = await import("../solana/kamino-actions.js");
  const prepared = await buildKaminoBorrow({
    wallet: args.wallet,
    mint: args.mint,
    amount: args.amount,
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareKaminoWithdraw(
  args: PrepareKaminoWithdrawArgs,
): Promise<PreparedSolanaTx> {
  const { buildKaminoWithdraw } = await import("../solana/kamino-actions.js");
  const prepared = await buildKaminoWithdraw({
    wallet: args.wallet,
    mint: args.mint,
    amount: args.amount,
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareKaminoRepay(
  args: PrepareKaminoRepayArgs,
): Promise<PreparedSolanaTx> {
  const { buildKaminoRepay } = await import("../solana/kamino-actions.js");
  const prepared = await buildKaminoRepay({
    wallet: args.wallet,
    mint: args.mint,
    amount: args.amount,
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function getKaminoPositions(args: GetKaminoPositionsArgs) {
  const { getKaminoPositions: reader } = await import(
    "../positions/kamino.js"
  );
  const conn = getSolanaConnection();
  return { positions: await reader(conn, args.wallet) };
}

export async function getBitcoinBalance(args: GetBitcoinBalanceArgs) {
  const { getBitcoinBalance: reader } = await import(
    "../btc/balances.js"
  );
  return reader(args.address);
}

export async function getBitcoinBalances(args: GetBitcoinBalancesArgs) {
  const { getBitcoinBalances: reader } = await import(
    "../btc/balances.js"
  );
  return { balances: await reader(args.addresses) };
}

export async function getBitcoinFeeEstimates(_args: GetBitcoinFeeEstimatesArgs) {
  void _args;
  const { getBitcoinIndexer } = await import("../btc/indexer.js");
  return getBitcoinIndexer().getFeeEstimates();
}

export async function getBitcoinTxHistory(args: GetBitcoinTxHistoryArgs) {
  const { getBitcoinIndexer } = await import("../btc/indexer.js");
  const { assertBitcoinAddress } = await import("../btc/address.js");
  assertBitcoinAddress(args.address);
  const txs = await getBitcoinIndexer().getAddressTxs(args.address, {
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
  });
  return { address: args.address, txs };
}

export async function prepareBitcoinNativeSend(
  args: PrepareBitcoinNativeSendArgs,
) {
  const { buildBitcoinNativeSend } = await import("../btc/actions.js");
  return buildBitcoinNativeSend({
    wallet: args.wallet,
    to: args.to,
    amount: args.amount,
    ...(args.feeRateSatPerVb !== undefined
      ? { feeRateSatPerVb: args.feeRateSatPerVb }
      : {}),
    ...(args.rbf !== undefined ? { rbf: args.rbf } : {}),
    ...(args.allowHighFee !== undefined ? { allowHighFee: args.allowHighFee } : {}),
  });
}

export async function getMarginfiPositions(args: GetMarginfiPositionsArgs) {
  const { getMarginfiPositions: reader } = await import(
    "../positions/marginfi.js"
  );
  const conn = getSolanaConnection();
  return { positions: await reader(conn, args.wallet) };
}

export async function getSolanaStakingPositions(
  args: GetSolanaStakingPositionsArgs,
) {
  const { getSolanaStakingPositions: reader } = await import(
    "../positions/solana-staking.js"
  );
  const conn = getSolanaConnection();
  return reader(conn, args.wallet);
}

/**
 * Read-only diagnostic surface for the hardened MarginFi client load.
 * Returns per-bank skip records (address, best-effort mint, step, reason)
 * from the last `fetchGroupData` pass in this process — the data that
 * powers `findBankForMint`'s "bank listed but skipped" branch (issue #107).
 *
 * Triggers a fresh load if the cache is cold so the snapshot is always
 * recent on demand.
 */
export async function getMarginfiDiagnostics(
  _args?: Record<string, never>,
): Promise<{
  group: string;
  fetchedAt: number | null;
  addressesFetched: number;
  banksHydrated: number;
  skippedIntegrator: number;
  skipped: Array<{
    address: string;
    mint: string | null;
    symbol: string;
    step: "decode" | "hydrate" | "tokenData" | "priceInfo";
    reason: string;
  }>;
}> {
  const marginfi = await import("../solana/marginfi.js");
  const conn = getSolanaConnection();
  let snap = marginfi.getLastMarginfiGroupDiagnostics();
  if (!snap) {
    // Warm the cache — picks a valid pubkey as the stub authority since
    // the hardened fetch doesn't actually use it, only the SDK's wallet
    // type-check does.
    const { PublicKey } = await import("@solana/web3.js");
    await marginfi.getHardenedMarginfiClient(
      conn,
      new PublicKey("11111111111111111111111111111111"),
    );
    snap = marginfi.getLastMarginfiGroupDiagnostics();
  }
  if (!snap) {
    return {
      group: marginfi.__internals.MAINNET_GROUP.toBase58(),
      fetchedAt: null,
      addressesFetched: 0,
      banksHydrated: 0,
      skippedIntegrator: 0,
      skipped: [],
    };
  }
  return {
    group: marginfi.__internals.MAINNET_GROUP.toBase58(),
    fetchedAt: snap.fetchedAt,
    addressesFetched: snap.addressesFetched,
    banksHydrated: snap.banksHydrated,
    skippedIntegrator: snap.skippedIntegrator,
    skipped: snap.records.map((r) => ({
      address: r.address,
      mint: r.mint,
      symbol: r.mint
        ? marginfi.__internals.resolveMintSymbol(r.mint)
        : "UNKNOWN",
      step: r.step,
      reason: r.reason,
    })),
  };
}

/**
 * Read-only setup probe for a Solana wallet. Returns which one-time-setup
 * prerequisites are already in place (durable-nonce account + MarginFi
 * PDAs) so agents planning a supply/borrow/etc. don't re-propose a
 * redundant prepare_solana_nonce_init or prepare_marginfi_init step.
 *
 * Mirrors `get_ledger_status` in spirit: a cheap inspection tool that
 * turns "ask the user what's set up" into "read the chain". Issue #101.
 */
export async function getSolanaSetupStatus(args: {
  wallet: string;
}): Promise<{
  wallet: string;
  nonce: {
    exists: boolean;
    address: string;
    lamports?: number;
    currentNonce?: string;
    authority?: string;
  };
  marginfi: {
    accounts: Array<{ index: number; address: string }>;
  };
}> {
  const { assertSolanaAddress } = await import("../solana/address.js");
  const { deriveNonceAccountAddress, getNonceAccountValue } = await import(
    "../solana/nonce.js"
  );
  const { deriveMarginfiAccountPda } = await import("../solana/marginfi.js");

  const authority = assertSolanaAddress(args.wallet);
  const conn = getSolanaConnection();

  // Nonce lookup — one RPC + one decode.
  const noncePubkey = await deriveNonceAccountAddress(authority);
  const nonceInfo = await conn.getAccountInfo(noncePubkey, "confirmed");
  let nonceState: { nonce: string; authority: string } | undefined;
  let nonceLamports: number | undefined;
  if (nonceInfo) {
    nonceLamports = nonceInfo.lamports;
    try {
      const v = await getNonceAccountValue(conn, noncePubkey);
      if (v) {
        nonceState = { nonce: v.nonce, authority: v.authority.toBase58() };
      }
    } catch {
      // Account exists but isn't a System-owned nonce — surface as
      // exists:true without the nonce value. Caller should inspect the
      // lamports + our own nonce tool's refusal to explain.
    }
  }

  // MarginFi PDA probe — same 4-slot pattern as getMarginfiPositions, but
  // stops at the existence check. No SDK load, no oracle fetch — cheap.
  const marginfiAccounts: Array<{ index: number; address: string }> = [];
  const MAX_SLOTS = 4;
  for (let idx = 0; idx < MAX_SLOTS; idx++) {
    const pda = deriveMarginfiAccountPda(authority, idx);
    const info = await conn.getAccountInfo(pda, "confirmed");
    if (!info) {
      if (marginfiAccounts.length === 0 && idx === 0) break; // common: none
      break; // gap in the slot sequence
    }
    marginfiAccounts.push({ index: idx, address: pda.toBase58() });
  }

  return {
    wallet: args.wallet,
    nonce: {
      exists: nonceInfo !== null,
      address: noncePubkey.toBase58(),
      ...(nonceLamports !== undefined ? { lamports: nonceLamports } : {}),
      ...(nonceState
        ? {
            currentNonce: nonceState.nonce,
            authority: nonceState.authority,
          }
        : {}),
    },
    marginfi: { accounts: marginfiAccounts },
  };
}

export async function prepareSolanaSwap(
  args: PrepareSolanaSwapArgs,
): Promise<PreparedSolanaTx> {
  const { buildJupiterSwap } = await import("../solana/jupiter.js");
  // The `quote` arg is the full Jupiter QuoteResponse — typed loosely as
  // Record<string, unknown> at the schema boundary, narrowed here by the
  // Jupiter module (which expects a JupiterQuote shape).
  const prepared = await buildJupiterSwap({
    wallet: args.wallet,
    quote: args.quote as never, // JupiterQuote is a superset of Record<string, unknown>
    ...(args.prioritizationFeeLamports !== undefined
      ? { prioritizationFeeLamports: args.prioritizationFeeLamports }
      : {}),
  });
  // buildJupiterSwap returns a narrower type (PreparedJupiterSwap). The
  // handlers all converge on PreparedSolanaTx, and jupiter_swap is already
  // in that action union, so the assignment is shape-compatible.
  return prepared as PreparedSolanaTx;
}

/**
 * Pin a prepared Solana tx's draft with a fresh blockhash, serialize the
 * message bytes, compute the Ledger Message Hash (base58(sha256(bytes))),
 * and return the fully-pinned tx the user must match on-device.
 *
 * Why this step exists: blockhashes expire after ~150 blocks (~60s), and
 * prepare → CHECKS → user-approve → broadcast routinely runs 90+ seconds.
 * Fetching the blockhash at prepare time burned the full window before the
 * device ever prompted. This step refreshes the blockhash right before the
 * user matches the hash on the device, giving the full ~60s window for the
 * broadcast path.
 *
 * Re-callable on the same handle — the store overwrites the pinned form
 * with the newer blockhash. Useful if the user paused between the first
 * preview and the actual "send".
 */
export async function previewSolanaSend(args: {
  handle: string;
}): Promise<UnsignedSolanaTx> {
  // Verify the handle exists before hitting the RPC so we fail fast on stale
  // handles without burning a network call.
  const draft = getSolanaDraft(args.handle);
  const conn = getSolanaConnection();

  let pinned: UnsignedSolanaTx;
  if (draft.meta.nonce) {
    // Durable-nonce path: refresh the nonce value in case someone else
    // advanced it between prepare and preview (edge case — another tx
    // against the same nonce in flight — but cheap to handle correctly).
    // The nonce account pubkey never changes, so we just re-fetch.
    const { PublicKey } = await import("@solana/web3.js");
    const { getNonceAccountValue } = await import("../solana/nonce.js");
    const noncePubkey = new PublicKey(draft.meta.nonce.account);
    const fresh = await getNonceAccountValue(conn, noncePubkey);
    if (!fresh) {
      throw new Error(
        `Nonce account ${draft.meta.nonce.account} has disappeared between prepare and preview. ` +
          `Did it get closed mid-flight? Re-run prepare_solana_nonce_init and then re-prepare the send.`,
      );
    }
    // Update meta so pinSolanaHandle's consistency check passes.
    draft.meta.nonce.value = fresh.nonce;
    pinned = pinSolanaHandle(args.handle, fresh.nonce);
  } else {
    // Legacy recent-blockhash path — only reachable for `nonce_init` now,
    // since every send/close is durable-nonce-protected.
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(
      "confirmed",
    );
    pinned = pinSolanaHandle(args.handle, blockhash, lastValidBlockHeight);
  }

  // Pre-sign simulation gate (issue #115). Run `simulateTransaction` on the
  // pinned versioned tx so program-level reverts (MarginFi OperationBorrowOnly,
  // stale-oracle rejects, bank-paused asserts, etc.) surface BEFORE the user
  // is asked to blind-sign on Ledger. Mirrors the EVM enrichTx path which
  // runs eth_call at prepare_* time.
  //
  // Skip for `nonce_init`: that's a legacy-message one-time setup (createAccount
  // + nonceInitialize) with no interesting revert surface worth a pre-sign
  // RPC. Every other Solana action here is v0.
  if (pinned.action !== "nonce_init") {
    const { simulatePinnedSolanaTx } = await import("../solana/simulate.js");
    try {
      const sim = await simulatePinnedSolanaTx(conn, pinned.messageBase64);
      if (!sim.ok) {
        const header = sim.anchorError
          ? `Pre-sign simulation REJECTED the ${pinned.action} tx — ` +
            `${sim.anchorError.name} (${sim.anchorError.code}): ${sim.anchorError.message}.`
          : `Pre-sign simulation REJECTED the ${pinned.action} tx. Raw err: ${sim.err ?? "(unknown)"}.`;
        const logTail = sim.logs && sim.logs.length
          ? `\nLast program logs:\n  ${sim.logs.slice(-8).join("\n  ")}`
          : "";
        // Issue #116 — enrich with a targeted root-cause diagnosis for
        // ambiguous MarginFi errors (currently just 6009 RiskEngineInitRejected,
        // which collapses "stale oracle" and "bad health" into one message).
        // Best-effort: diagnosis failure must NOT mask the real sim error.
        let diagnosis = "";
        if (
          pinned.action.startsWith("marginfi_") &&
          sim.anchorError &&
          draft.meta.marginfiTouchedBanks
        ) {
          try {
            const { diagnoseMarginfiSimRejection } = await import(
              "../solana/marginfi.js"
            );
            const result = await diagnoseMarginfiSimRejection(
              draft.meta.marginfiTouchedBanks,
              sim.anchorError,
            );
            if (result) diagnosis = `\n${result}`;
          } catch {
            // Swallow — diagnosis is additive, not gating.
          }
        }
        // Issue #125 — split the two NotEnoughSamples failure modes. A
        // "Rotating mega slot" log line immediately before the Anchor
        // 6030 means the feed is mid oracle-set rotation: consensus can't
        // be reached for ~60–120s regardless of how many samples we
        // requested (#120's N=3 tuning doesn't help during rotation).
        // The right user action is to WAIT, not loop-retry. The plain
        // stale-samples branch still tells the user to re-prepare.
        const isNotEnoughSamples = sim.anchorError?.code === 6030;
        const { isSwitchboardRotation } = await import(
          "../solana/simulate.js"
        );
        const rotating =
          isNotEnoughSamples && isSwitchboardRotation(sim.logs);
        const remediation = rotating
          ? `\nThis is a transient SWITCHBOARD ORACLE ROTATION ("Rotating mega slot" ` +
            `in the logs) — the feed is between oracle sets and consensus is ` +
            `temporarily unreachable. Wait 60–120s before retrying; tight retry ` +
            `loops will fail identically until rotation completes. No code bug ` +
            `on our side; no fix on retry. Durable nonce was not advanced.`
          : isNotEnoughSamples
            ? `\nOracle samples fetched at preview time are already past their ` +
              `max-staleness window. This is unusual at preview time (the fetch ` +
              `is seconds-old) and typically indicates extreme RPC lag or a ` +
              `freshly-rotated feed. Call prepare_* again to fetch fresh samples.`
            : `\nRefusing to surface the Ledger hash — the tx would revert on broadcast. ` +
              `Resolve the underlying issue (e.g. withdraw conflicting collateral, wait for oracle freshness, ` +
              `pick a different bank) and call prepare_* again.`;
        throw new Error(header + logTail + diagnosis + remediation);
      }
      pinned.simulation = sim;
    } catch (e) {
      // Distinguish our own throw (preview-level rejection — re-raise) from
      // an RPC-level error (transient — swallow and proceed without the
      // simulation field; broadcast-side preflight is the backstop).
      if (
        e instanceof Error &&
        /Pre-sign simulation REJECTED/.test(e.message)
      ) {
        throw e;
      }
      // eslint-disable-next-line no-console
      console.warn(
        `[vaultpilot/solana] pre-sign simulate RPC failed: ${e instanceof Error ? e.message : String(e)}. ` +
          `Proceeding without simulation — broadcast-side preflight will still catch reverts.`,
      );
    }
  }

  return pinned;
}

/**
 * Send a Solana tx: consume handle, re-hash the stored message bytes and
 * compare against the preview fingerprint, sign over USB HID, stitch the
 * signature into the serialized tx, broadcast via RPC. Mirror of
 * `sendTronTransaction`.
 */
async function sendSolanaTransaction(args: SendTransactionArgs): Promise<{
  txHash: string;
  chain: "solana";
  lastValidBlockHeight?: number;
  durableNonce?: { noncePubkey: string; nonceValue: string };
}> {
  const tx: UnsignedSolanaTx = consumeSolanaHandle(args.handle);
  // Preview-gate enforcement (parity with the EVM path). These two args
  // prove the agent ran `preview_solana_send` AND surfaced the CHECKS
  // PERFORMED block before the user replied "send". Missing / mismatched
  // values mean the agent either skipped preview entirely, collapsed
  // preview + send into one silent step, or replayed an old token after
  // a refresh — in all three cases the user hasn't had a chance to match
  // the on-device Message Hash against the chat-side value and the
  // defense collapses for blind-sign flows (SPL / MarginFi / Jupiter).
  // Error text is verbose on purpose — the agent reads it and self-corrects.
  if (!args.previewToken) {
    throw new Error(
      "Missing `previewToken` arg on send_transaction. preview_solana_send " +
        "returned a `previewToken` field in its top-level JSON response — " +
        "pass it back here verbatim. This is the schema-enforced proof " +
        "that the preview step actually ran and that the CHECKS PERFORMED " +
        "block was surfaced to the user. If you skipped preview_solana_send, " +
        "call it first.",
    );
  }
  if (args.userDecision !== "send") {
    throw new Error(
      "Missing `userDecision: \"send\"` arg on send_transaction. Set this " +
        "AFTER presenting the CHECKS PERFORMED block from preview_solana_send " +
        "and receiving the user's explicit 'send' reply. The literal proves " +
        "the preview-time gate was shown to the user rather than silently " +
        "bypassed.",
    );
  }
  if (tx.previewToken && args.previewToken !== tx.previewToken) {
    throw new Error(
      "SECURITY: `previewToken` does not match the current pin on this " +
        "Solana handle. The benign explanation is that preview_solana_send " +
        "was re-called after the token was captured (e.g. to refresh a stale " +
        "nonce) — in that case, the new pin has a new token AND a new Message " +
        "Hash the user MUST re-match on-device. Do NOT retry with the old " +
        "token: call preview_solana_send again, surface the fresh CHECKS " +
        "PERFORMED block and the new blind-sign hash to the user, and pass " +
        "the new token.",
    );
  }
  // Proof-of-identity guard: same logic as the TRON sender. Recompute the
  // domain-tagged hash of the exact message bytes the Ledger will sign
  // and require equality with the hash the user previewed.
  if (tx.verification) {
    const rehash = solanaPayloadFingerprint(tx.messageBase64);
    if (rehash !== tx.verification.payloadHash) {
      throw new Error(
        `SECURITY: Solana payload hash mismatch at send time. Previewed ${tx.verification.payloadHash}, ` +
          `about to sign ${rehash}. The message bytes changed between preview and send — refusing ` +
          `to forward to the Ledger. Do NOT retry this handle. Re-prepare from scratch and compare ` +
          `the new preview carefully.`,
      );
    }
  }
  // Use the paired path for `from` if available; otherwise fall through to
  // the default (`44'/501'/0'`) and let the device-address check inside
  // `signSolanaTxOnLedger` surface a "pair the right slot" error.
  const paired = getPairedSolanaByAddress(tx.from);
  const messageBytes = Buffer.from(tx.messageBase64, "base64");
  const { signature } = await signSolanaTxOnLedger({
    messageBytes,
    expectedFrom: tx.from,
    ...(paired ? { path: paired.path } : {}),
  });

  // Assemble the final serialized tx: one signature count byte (0x01), the
  // 64-byte signature, then the message bytes. Matches what
  // `Transaction.serialize()` produces for a single-signer tx after
  // `addSignature` — but we construct it by hand so we never need a
  // `Keypair`/`Signer` object (which would imply a key in the server).
  const signedTxBytes = Buffer.concat([
    Buffer.from([1]), // signature count = 1 (single signer)
    signature,
    messageBytes,
  ]);

  const txSignature = await broadcastSolanaTx(signedTxBytes);
  // Retire the handle only after successful broadcast. A signing or
  // broadcast failure leaves the handle valid for retry within its 15-min
  // TTL (though on-chain validity is bounded by the ~60s blockhash window).
  retireSolanaHandle(args.handle);
  return {
    txHash: txSignature,
    chain: "solana",
    // `lastValidBlockHeight` is for legacy-blockhash txs (nonce_init only);
    // `durableNonce` is for every other send. The status poller uses one
    // or the other to distinguish dropped from pending — always surface
    // the applicable field so the agent can hand it back to
    // `get_transaction_status` verbatim.
    ...(tx.lastValidBlockHeight !== undefined
      ? { lastValidBlockHeight: tx.lastValidBlockHeight }
      : {}),
    ...(tx.nonce
      ? {
          durableNonce: {
            noncePubkey: tx.nonce.account,
            nonceValue: tx.nonce.value,
          },
        }
      : {}),
  };
}

/**
 * Send a Bitcoin tx: consume handle, sign PSBT on the Ledger BTC app
 * (which clear-signs every output + fee on-screen), broadcast the
 * finalized raw tx hex to the indexer's `/tx` endpoint, return the txid.
 *
 * No preview-gate: the Ledger BTC app's clear-signing UX *is* the
 * review step. Every output (address + amount), the fee, and the change
 * label are shown on-device — there's no blind-sign hash for the user
 * to pre-match in chat. The agent-side verification block surfaces the
 * same projection, so the user can cross-check before the device prompt.
 */
async function sendBitcoinTransaction(args: SendTransactionArgs): Promise<{
  txHash: string;
  chain: "bitcoin";
}> {
  const tx = consumeBitcoinHandle(args.handle);
  const paired = getPairedBtcByAddress(tx.from);
  if (!paired) {
    throw new Error(
      `Bitcoin source ${tx.from} is no longer in the pairing cache. The cache may have ` +
        `been cleared since prepare_btc_send. Re-pair via \`pair_ledger_btc\` and re-run ` +
        `prepare_btc_send to get a fresh handle.`,
    );
  }
  const { rawTxHex } = await signBtcPsbtOnLedger({
    psbtBase64: tx.psbtBase64,
    expectedFrom: tx.from,
    path: paired.path,
    accountPath: tx.accountPath,
    addressFormat: tx.addressFormat,
  });
  const { getBitcoinIndexer } = await import("../btc/indexer.js");
  const txid = await getBitcoinIndexer().broadcastTx(rawTxHex);
  // Retire only after successful broadcast — the same retry-on-failure
  // policy as the Solana / TRON branches.
  retireBitcoinHandle(args.handle);
  return { txHash: txid, chain: "bitcoin" };
}

/** Attach eth_call simulation result, gas estimate, and USD cost. */
async function enrichTx(tx: UnsignedTx): Promise<UnsignedTx> {
  const client = getClient(tx.chain);
  const from = tx.from;
  // Always simulate — even when gas estimation would succeed — so the caller
  // can see the decoded revert reason alongside the preview. A failed sim on
  // a standalone tx is a red flag; a failed sim on `tx.next` of an
  // approve→action pair is expected until the approve mines.
  tx.simulation = await simulateTx({
    chain: tx.chain,
    from,
    to: tx.to,
    data: tx.data,
    value: tx.value,
  });
  try {
    const gas = await client.estimateGas({
      account: from ?? "0x0000000000000000000000000000000000000001",
      to: tx.to,
      data: tx.data,
      value: BigInt(tx.value),
    });
    tx.gasEstimate = gas.toString();

    const gasPrice = await client.getGasPrice();
    const gasWei = gas * gasPrice;
    const ethPrice = await getTokenPrice(tx.chain, "native");
    if (ethPrice) {
      const gasEth = Number(formatUnits(gasWei, 18));
      tx.gasCostUsd = round(gasEth * ethPrice, 2);
    }
  } catch {
    // Gas estimation fails for many legitimate reasons (insufficient allowance on
    // a follow-up step, etc.) — we surface the tx anyway. The simulation field
    // above has already captured any revert reason.
  }
  if (tx.next) tx.next = await enrichTx(tx.next);
  return tx;
}

// ----- Aave preparation handlers -----

export async function prepareAaveSupply(args: PrepareAaveSupplyArgs): Promise<UnsignedTx> {
  const meta = await resolveTokenMeta(args.chain as SupportedChain, args.asset as `0x${string}`);
  return enrichTx(
    await buildAaveSupply({
      wallet: args.wallet as `0x${string}`,
      chain: args.chain as SupportedChain,
      asset: args.asset as `0x${string}`,
      amount: args.amount,
      decimals: meta.decimals,
      symbol: meta.symbol,
      approvalCap: args.approvalCap,
    })
  );
}

export async function prepareAaveWithdraw(args: PrepareAaveWithdrawArgs): Promise<UnsignedTx> {
  const meta = await resolveTokenMeta(args.chain as SupportedChain, args.asset as `0x${string}`);
  return enrichTx(
    await buildAaveWithdraw({
      wallet: args.wallet as `0x${string}`,
      chain: args.chain as SupportedChain,
      asset: args.asset as `0x${string}`,
      amount: args.amount,
      decimals: meta.decimals,
      symbol: meta.symbol,
    })
  );
}

export async function prepareAaveBorrow(args: PrepareAaveBorrowArgs): Promise<UnsignedTx> {
  const meta = await resolveTokenMeta(args.chain as SupportedChain, args.asset as `0x${string}`);
  return enrichTx(
    await buildAaveBorrow({
      wallet: args.wallet as `0x${string}`,
      chain: args.chain as SupportedChain,
      asset: args.asset as `0x${string}`,
      amount: args.amount,
      decimals: meta.decimals,
      symbol: meta.symbol,
    })
  );
}

export async function prepareAaveRepay(args: PrepareAaveRepayArgs): Promise<UnsignedTx> {
  const meta = await resolveTokenMeta(args.chain as SupportedChain, args.asset as `0x${string}`);
  return enrichTx(
    await buildAaveRepay({
      wallet: args.wallet as `0x${string}`,
      chain: args.chain as SupportedChain,
      asset: args.asset as `0x${string}`,
      amount: args.amount,
      decimals: meta.decimals,
      symbol: meta.symbol,
      approvalCap: args.approvalCap,
    })
  );
}

// ----- Staking preparation handlers -----

export async function prepareLidoStake(args: PrepareLidoStakeArgs): Promise<UnsignedTx> {
  return enrichTx(buildLidoStake({ wallet: args.wallet as `0x${string}`, amountEth: args.amountEth }));
}

export async function prepareLidoUnstake(args: PrepareLidoUnstakeArgs): Promise<UnsignedTx> {
  return enrichTx(
    await buildLidoUnstake({
      wallet: args.wallet as `0x${string}`,
      amountStETH: args.amountStETH,
      approvalCap: args.approvalCap,
    })
  );
}

export async function prepareEigenLayerDeposit(args: PrepareEigenLayerDepositArgs): Promise<UnsignedTx> {
  const meta = await resolveTokenMeta("ethereum", args.token as `0x${string}`);
  return enrichTx(
    await buildEigenLayerDeposit({
      wallet: args.wallet as `0x${string}`,
      strategy: args.strategy as `0x${string}`,
      token: args.token as `0x${string}`,
      amount: args.amount,
      decimals: meta.decimals,
      symbol: meta.symbol,
      approvalCap: args.approvalCap,
    })
  );
}

// ----- Native + ERC-20 transfers -----

/**
 * Accept recipient addresses that are either all-lowercase hex (no checksum
 * intent) or valid EIP-55 checksummed. Reject mixed-case with a wrong
 * checksum — that is the class of error where a user pasted an address with
 * a single-character case typo; viem's bare `as 0x${string}` cast would
 * otherwise pass it through silently. viem's `isAddress(x, { strict: true })`
 * encodes exactly this policy.
 */
function assertRecipient(addr: string): `0x${string}` {
  if (!isAddress(addr, { strict: true })) {
    throw new Error(
      `Invalid recipient address ${addr}: failed EIP-55 checksum or malformed hex. ` +
        `If you pasted a mixed-case address, a single-character case typo is the most ` +
        `likely cause — re-check the source.`,
    );
  }
  return addr as `0x${string}`;
}

export async function prepareNativeSend(args: PrepareNativeSendArgs): Promise<UnsignedTx> {
  const wallet = args.wallet as `0x${string}`;
  const chain = args.chain as SupportedChain;
  const to = assertRecipient(args.to);
  const value = parseEther(args.amount);
  return enrichTx({
    chain,
    to,
    data: "0x",
    value: value.toString(),
    from: wallet,
    description: `Send ${args.amount} native coin to ${to} on ${chain}`,
    decoded: { functionName: "transfer", args: { to, amount: args.amount } },
  });
}

export async function prepareWethUnwrap(args: PrepareWethUnwrapArgs): Promise<UnsignedTx> {
  return enrichTx(
    await buildWethUnwrap({
      wallet: args.wallet as `0x${string}`,
      chain: args.chain as SupportedChain,
      amount: args.amount,
    }),
  );
}

export async function prepareTokenSend(args: PrepareTokenSendArgs): Promise<UnsignedTx> {
  const wallet = args.wallet as `0x${string}`;
  const chain = args.chain as SupportedChain;
  const token = args.token as `0x${string}`;
  const to = assertRecipient(args.to);
  const meta = await resolveTokenMeta(chain, token);

  let amountWei: bigint;
  let displayAmount = args.amount;
  if (args.amount === "max") {
    const client = getClient(chain);
    amountWei = (await client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [wallet],
    })) as bigint;
    displayAmount = formatUnits(amountWei, meta.decimals);
  } else {
    amountWei = parseUnits(args.amount, meta.decimals);
  }

  return enrichTx({
    chain,
    to: token,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [to, amountWei],
    }),
    value: "0",
    from: wallet,
    description: `Send ${displayAmount} ${meta.symbol} to ${to} on ${chain}`,
    decoded: {
      functionName: "transfer",
      args: { to, amount: displayAmount, symbol: meta.symbol },
    },
  });
}

// ----- Send + status -----

/**
 * Sign a prepared TRON tx on the connected Ledger and broadcast via TronGrid.
 * Called internally from `sendTransaction` when the handle belongs to the
 * TRON store.
 *
 * Security pipeline (intentionally narrower than the EVM one — many EVM
 * checks don't translate to TRON):
 *   - consumeTronHandle gives us the exact tx the user previewed.
 *   - signTronTxOnLedger re-opens USB, re-derives the address, and refuses
 *     if it doesn't match `tx.from`. This is the TRON equivalent of EVM's
 *     "tx.from must be a paired account" guard.
 *   - broadcastTronTx posts the signed envelope; TronGrid validates the
 *     contract before inclusion.
 *
 * We don't re-simulate. TronGrid's createtransaction / triggersmartcontract
 * already validates at prepare time (insufficient balance, fee_limit too low,
 * contract revert), and there's no equivalent of eth_call against a specific
 * block on TRON that we'd gain from re-running. A genuine drift between
 * prepare and send (someone drained the balance in the interim) surfaces as
 * a broadcast error, which we propagate verbatim.
 */
async function sendTronTransaction(args: SendTransactionArgs): Promise<{
  txHash: string;
  chain: "tron";
}> {
  const tx: UnsignedTronTx = consumeTronHandle(args.handle);
  // Preview-gate enforcement. TRON has no preview step — prepare_tron_*
  // produces the signable artifact directly — so the gate here is just
  // the `userDecision: "send"` literal, without a token. It pins the
  // same careless-mistake invariant as on EVM: an agent collapsing
  // prepare + send into a single silent step without pausing to surface
  // the VERIFY block gets a clear-error refusal naming the missing arg.
  // TRON clear-signs every supported action on-device, so even if a
  // hostile agent forges this literal, the Ledger screen's decoded
  // fields are the source of truth — but skipping the reply is the
  // UX-honesty bar we want to enforce.
  if (args.userDecision !== "send") {
    throw new Error(
      "Missing `userDecision: \"send\"` arg on send_transaction. Set this " +
        "AFTER presenting the VERIFY-BEFORE-SIGNING block from the " +
        "prepare_tron_* tool result and receiving the user's explicit " +
        "'send' reply. The literal proves the prepare-time summary was " +
        "shown to the user rather than silently bypassed.",
    );
  }
  // Proof-of-identity guard: recompute the domain-tagged hash of the EXACT
  // rawDataHex that the USB signer is about to hand to the Ledger, and
  // require equality with the hash the user previewed. A drift here means
  // tx state mutated between handle issuance and send — should never
  // happen, but the invariant is cheap to enforce and exactly what turns
  // "trust me" into "same bytes, same hash".
  if (tx.verification) {
    const rehash = tronPayloadFingerprint(tx.rawDataHex);
    if (rehash !== tx.verification.payloadHash) {
      throw new Error(
        `SECURITY: TRON payload hash mismatch at send time. Previewed ${tx.verification.payloadHash}, ` +
          `about to sign ${rehash}. The rawDataHex changed between preview and send — refusing ` +
          `to forward to the Ledger. Do NOT retry this handle. Re-prepare the transaction from ` +
          `scratch (call the prepare_* tool again) and compare the new preview carefully — a ` +
          `drift here means the bytes mutated inside the MCP process between the moment the user ` +
          `reviewed them and the moment they would have been signed, which is not a normal ` +
          `operating condition and may indicate a compromised intermediary.`,
      );
    }
  }
  // If the user paired this `from` via `pair_ledger_tron`, use the path they
  // paired on (covers non-default account slots). If we have no paired entry
  // for `from`, fall through to the signer's default path — the device
  // address check inside signTronTxOnLedger will then surface a clear error
  // telling the user to pair the right slot.
  const paired = getPairedTronByAddress(tx.from);
  const { signature } = await signTronTxOnLedger({
    rawDataHex: tx.rawDataHex,
    expectedFrom: tx.from,
    ...(paired ? { path: paired.path } : {}),
  });
  const { txID } = await broadcastTronTx(tx, signature);
  // Only retire the handle after successful broadcast. If signing fails
  // (user rejected, device disconnected) or the broadcast fails (transient
  // TronGrid error), the handle stays valid and the caller can retry
  // within the 15-min TTL without re-preparing.
  retireTronHandle(args.handle);
  return { txHash: txID, chain: "tron" };
}

/**
 * Minimum priority fee floor in wei. viem's `estimateFeesPerGas` returns the
 * node's priority-fee estimate, which on quiet blocks can drop below what
 * mempool-aware miners actually include (observed: 20 mwei on Ethereum at
 * 14:00 UTC while the inclusion floor was ~1 gwei). Floor at 0.5 gwei so a
 * tx we pinned during a lull doesn't sit stuck when activity picks up.
 */
const MIN_PRIORITY_FEE_WEI = 500_000_000n;

/**
 * Multiplier applied to `baseFeePerGas` before adding priority fee. viem's
 * default is `1.2x` — safe on average, too tight for user-review windows
 * (observed live test: a tx pinned at 1.2x baseFee stuck in mempool after
 * the block's baseFee bumped mid-review). 2x gives one full EIP-1559 double
 * worth of headroom, which covers ~4 blocks of consecutive 12.5% baseFee
 * rises — enough for a user to read, confirm, and press a Ledger button.
 */
const BASE_FEE_MULTIPLIER = 2n;

/**
 * Fetch `{nonce, maxFeePerGas, maxPriorityFeePerGas, gas}` from the chain
 * for a single tx. Extracted so `previewSend` has one clearly-defined place
 * to pick fee levels. All four fields land verbatim in the WalletConnect
 * `eth_sendTransaction` params (hex-encoded in `walletconnect.ts`), and all
 * four feed the EIP-1559 pre-sign RLP hash — so if this helper's output
 * drifts, so does the hash the user matches on-device.
 *
 * Throws on RPC failure; unpinned sends defeat the hash-match UX by design
 * (Ledger Live would substitute its own nonce + fees, making the on-device
 * hash unpredictable).
 */
async function pinSendFields(
  chain: SupportedChain,
  from: `0x${string}`,
  to: `0x${string}`,
  data: `0x${string}`,
  value: string,
): Promise<{
  nonce: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gas: bigint;
}> {
  const rpcClient = getClient(chain);
  const [nonceRaw, latestBlock, priorityEstimate, gasLimit] = await Promise.all([
    rpcClient.getTransactionCount({ address: from, blockTag: "pending" }),
    rpcClient.getBlock({ blockTag: "latest" }),
    rpcClient.estimateMaxPriorityFeePerGas(),
    rpcClient.estimateGas({
      account: from,
      to,
      data,
      value: BigInt(value),
    }),
  ]);
  const baseFee = latestBlock.baseFeePerGas ?? 0n;
  const maxPriorityFeePerGas =
    priorityEstimate < MIN_PRIORITY_FEE_WEI ? MIN_PRIORITY_FEE_WEI : priorityEstimate;
  const maxFeePerGas = baseFee * BASE_FEE_MULTIPLIER + maxPriorityFeePerGas;
  return {
    nonce: Number(nonceRaw),
    maxFeePerGas,
    maxPriorityFeePerGas,
    gas: gasLimit,
  };
}

/**
 * Run the full EVM pre-sign guard pipeline against the tx named by `handle`:
 * chainId verification, destination/selector allowlist, re-simulation,
 * account-match check against the paired WC session, and the payload-hash
 * fingerprint. Re-used by `previewSend` (early surfacing before the user
 * invests time matching a hash) and — tests only — for individual guard
 * assertions.
 *
 * Handle is NOT retired here; `consumeHandle` is a non-destructive peek.
 */
async function runEvmPreSignGuards(tx: UnsignedTx): Promise<void> {
  await verifyChainId(tx.chain);
  await assertTransactionSafe(tx);
  const sim = await simulateTx({
    chain: tx.chain,
    from: tx.from,
    to: tx.to,
    data: tx.data,
    value: tx.value,
  });
  if (!sim.ok) {
    throw new Error(
      `Pre-sign simulation failed: ${sim.revertReason ?? "execution reverted"}. ` +
        `Refusing to forward to Ledger — signing this tx would burn gas on a revert. ` +
        `If a prerequisite step (e.g. an ERC-20 approve) must be mined first, send it ` +
        `and wait for confirmation before retrying. Use simulate_transaction to debug.`,
    );
  }
  if (tx.from) {
    const accounts = (await getConnectedAccounts()).map((a) => a.toLowerCase());
    const from = tx.from.toLowerCase();
    if (accounts.length > 0 && !accounts.includes(from)) {
      throw new Error(
        `Pre-sign check: tx.from (${tx.from}) is not one of the accounts exposed by the paired ` +
          `WalletConnect session (${accounts.join(", ")}). Refusing to submit. If this is a ` +
          `different Ledger account, re-pair with that account unlocked.`,
      );
    }
  }
  if (tx.verification) {
    const rehash = payloadFingerprint({
      chain: tx.chain,
      to: tx.to,
      value: tx.value,
      data: tx.data,
    });
    if (rehash !== tx.verification.payloadHash) {
      throw new Error(
        `SECURITY: payload hash mismatch at preview/send time. Previewed ${tx.verification.payloadHash}, ` +
          `about to sign ${rehash}. The transaction bytes (chain/to/value/data) changed between ` +
          `prepare and preview — refusing to proceed. Do NOT retry this handle. Re-prepare the ` +
          `transaction from scratch and compare the new preview against user intent carefully: ` +
          `this drift means the bytes mutated inside the MCP process after the user reviewed ` +
          `them, which is not a normal operating condition and may indicate a compromised ` +
          `intermediary swapping bytes at send time.`,
      );
    }
  }
}

/**
 * Server-side pin of nonce + EIP-1559 fees + gasLimit for the tx named by
 * `handle`. Runs the full EVM pre-sign guard pipeline (chainId, safety
 * allowlist, simulation, account match, payload hash) BEFORE pinning so a
 * tx that would have been refused at send time never gets as far as the
 * user matching a hash. Computes the EIP-1559 pre-sign RLP hash from the
 * pinned tuple and stashes both on the handle.
 *
 * The caller (typically the `preview_send` MCP tool) surfaces the returned
 * hash to the user as a `LEDGER BLIND-SIGN HASH` block — the user reads
 * it BEFORE `send_transaction` is called and the Ledger device prompt
 * appears. `send_transaction` then reads the stashed pin verbatim and
 * forwards it through WalletConnect, so the on-device hash is deterministic.
 *
 * Re-entrant with an explicit opt-in: calling `previewSend` a second time on
 * the same handle returns the existing pin verbatim. Pass `refresh: true` to
 * re-pin (e.g. if the user paused for minutes and wants fresh fees). Without
 * this guard, a buggy or adversarial agent could silently swap the pre-sign
 * hash between the moment the user reads it in chat and the moment Ledger
 * displays it — the hash-match UX would still catch the change, but the
 * guard makes the default deterministic.
 */
export async function previewSend(args: PreviewSendArgs): Promise<{
  handle: string;
  chain: SupportedChain;
  to: `0x${string}`;
  valueWei: string;
  preSignHash: `0x${string}`;
  pinned: {
    nonce: number;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
    gas: string;
  };
  previewToken: string;
  refreshed?: boolean;
  /**
   * Swiss-knife decoder URL carried over from prepare-time verification. Echoed
   * on the preview response so `renderPreviewVerifyAgentTaskBlock` can splice
   * it directly into the ⚠ DECODE UNAVAILABLE branch of the render template —
   * without this, the agent was "mentioning" the URL lived in the earlier
   * prepare block instead of actually surfacing it in the CHECKS PERFORMED
   * output, forcing the user to scroll up.
   */
  decoderUrl?: string;
  /**
   * True for the three Ledger clear-sign-only tx types: native ETH send
   * (empty calldata), ERC-20 `transfer`, ERC-20 `approve`. The preview
   * handler uses this to render a reduced CHECKS PERFORMED template —
   * no PAIR-CONSISTENCY HASH line, no BLIND-SIGN branch of NEXT ON-DEVICE
   * (both are noise for these tx types; Ledger clear-signs decoded
   * fields and the hash-match path never fires). No security posture
   * change; the server still pins and re-hashes at send time.
   */
  clearSignOnly?: boolean;
}> {
  if (hasTronHandle(args.handle)) {
    throw new Error(
      "preview_send is EVM-only; TRON handles do not use WalletConnect and their on-device " +
        "preview comes from the TRON app's clear-sign screens. Call send_transaction directly " +
        "for TRON handles.",
    );
  }
  const tx = consumeHandle(args.handle);
  const decoderUrl = tx.verification?.decoderUrl;
  const clearSignOnly = isClearSignOnlyTx(tx);
  const existing = getPinnedGas(args.handle);
  if (existing && !args.refresh) {
    return {
      handle: args.handle,
      chain: tx.chain,
      to: tx.to,
      valueWei: tx.value,
      preSignHash: existing.preSignHash,
      pinned: {
        nonce: existing.nonce,
        maxFeePerGas: existing.maxFeePerGas.toString(),
        maxPriorityFeePerGas: existing.maxPriorityFeePerGas.toString(),
        gas: existing.gas.toString(),
      },
      previewToken: existing.previewToken,
      ...(decoderUrl ? { decoderUrl } : {}),
      ...(clearSignOnly ? { clearSignOnly: true } : {}),
    };
  }
  await runEvmPreSignGuards(tx);
  const from =
    tx.from ?? ((await getConnectedAccounts())[0] as `0x${string}` | undefined);
  if (!from) {
    throw new Error(
      "Cannot determine sender address for nonce/fee pin; pair Ledger Live first.",
    );
  }
  const pinned = await pinSendFields(tx.chain, from, tx.to, tx.data, tx.value);
  const preSignHash = eip1559PreSignHash({
    chainId: CHAIN_IDS[tx.chain],
    nonce: pinned.nonce,
    maxFeePerGas: pinned.maxFeePerGas,
    maxPriorityFeePerGas: pinned.maxPriorityFeePerGas,
    gas: pinned.gas,
    to: tx.to,
    value: BigInt(tx.value),
    data: tx.data,
  });
  // Fresh pin → fresh token. If the caller re-pins (refresh: true), any token
  // captured before this call is invalid — prevents replaying an old preview's
  // "I already showed the user" claim against a tx with new fees/nonce/hash.
  const previewToken = randomUUID();
  const pin: StashedPin = {
    nonce: pinned.nonce,
    maxFeePerGas: pinned.maxFeePerGas,
    maxPriorityFeePerGas: pinned.maxPriorityFeePerGas,
    gas: pinned.gas,
    preSignHash,
    pinnedAt: Date.now(),
    previewToken,
  };
  attachPinnedGas(args.handle, pin);
  return {
    handle: args.handle,
    chain: tx.chain,
    to: tx.to,
    valueWei: tx.value,
    preSignHash,
    pinned: {
      nonce: pinned.nonce,
      maxFeePerGas: pinned.maxFeePerGas.toString(),
      maxPriorityFeePerGas: pinned.maxPriorityFeePerGas.toString(),
      gas: pinned.gas.toString(),
    },
    previewToken,
    ...(existing ? { refreshed: true } : {}),
    ...(decoderUrl ? { decoderUrl } : {}),
    ...(clearSignOnly ? { clearSignOnly: true } : {}),
  };
}

/**
 * Forward a prepared tx to the right signer based on which store owns the
 * handle. EVM handles take the WalletConnect path; the caller MUST have
 * called `preview_send` first so the pinned gas tuple + pre-sign hash live
 * on the handle (otherwise the on-device hash would be unpredictable and
 * the whole hash-match UX collapses). TRON handles take the USB HID path
 * and have no preview step.
 *
 * We check TRON first because its path has strictly fewer side effects on
 * failure (no WC relay roundtrip, no eth_call, no chain-id check that would
 * meaninglessly fire before we even know what chain we're on).
 */
export async function sendTransaction(args: SendTransactionArgs): Promise<{
  txHash: `0x${string}` | string;
  chain: SupportedChain | "tron" | "solana" | "bitcoin";
  nextHandle?: string;
  /**
   * EIP-1559 pre-sign RLP hash the user already matched on-device during
   * preview_send. Echoed back so the post-broadcast block can reassure the
   * user that what was signed equals what was previewed. TRON / Solana
   * omit this (they clear-sign on the device; no hash to match in chat).
   */
  preSignHash?: `0x${string}`;
  /** Echoed back so the send handler can render on-device eyeball values without re-reading the handle. */
  to?: `0x${string}`;
  /** Decimal wei string, echoed alongside `preSignHash` for the post-broadcast block. */
  valueWei?: string;
  /**
   * Solana legacy-blockhash txs (currently just `nonce_init`). Surfaced so
   * `get_transaction_status` can distinguish "dropped" (current slot past
   * this) from "not-yet-propagated" when `getSignatureStatuses` returns
   * null.
   */
  lastValidBlockHeight?: number;
  /**
   * Solana durable-nonce txs (native/SPL sends, nonce_close, jupiter_swap,
   * all marginfi_* actions). Surfaced so `get_transaction_status` can
   * authoritatively distinguish "dropped" (on-chain nonce rotated past
   * `nonceValue`) from "not-yet-propagated". Authoritative because Agave
   * itself gates durable-nonce tx validity on the nonce state, not block
   * height.
   */
  durableNonce?: { noncePubkey: string; nonceValue: string };
}> {
  if (hasTronHandle(args.handle)) {
    return sendTronTransaction(args);
  }
  if (hasSolanaHandle(args.handle)) {
    return sendSolanaTransaction(args);
  }
  if (hasBitcoinHandle(args.handle)) {
    return sendBitcoinTransaction(args);
  }
  const stashed = getPinnedGas(args.handle);
  if (!stashed) {
    throw new Error(
      "Missing pinned gas for this handle. Call `preview_send(handle)` first — it pins " +
        "nonce + EIP-1559 fees server-side, computes the EIP-1559 pre-sign RLP hash Ledger " +
        "will display in blind-sign mode, and returns the LEDGER BLIND-SIGN HASH block for " +
        "the user to match BEFORE the Ledger device prompt appears. send_transaction then " +
        "forwards the exact pinned tuple so the on-device hash is deterministic.",
    );
  }
  // Preview-gate enforcement: these two args are what prove the agent went
  // through preview_send and actually surfaced the EXTRA CHECKS menu to the
  // user. A missing/mismatched token means the agent either skipped preview
  // entirely (token never issued) or collapsed preview_send + send_transaction
  // into one step without pausing for the user's 'send' reply. Error text is
  // detailed on purpose — the agent reads it and is expected to self-correct.
  if (!args.previewToken) {
    throw new Error(
      "Missing `previewToken` arg on send_transaction. preview_send returned a `previewToken` " +
        "field in its top-level JSON response — pass it back here verbatim. This is the " +
        "schema-enforced proof that the preview step actually ran and that the EXTRA CHECKS " +
        "YOU CAN RUN BEFORE REPLYING 'SEND' menu was surfaced to the user. If you skipped " +
        "preview_send, call it first.",
    );
  }
  if (args.userDecision !== "send") {
    throw new Error(
      "Missing `userDecision: \"send\"` arg on send_transaction. Set this AFTER presenting the " +
        "EXTRA CHECKS menu from preview_send's agent-task block and receiving the user's " +
        "explicit 'send' reply. The literal is what proves the preview-time gate was shown to " +
        "the user rather than silently bypassed.",
    );
  }
  if (args.previewToken !== stashed.previewToken) {
    throw new Error(
      "SECURITY: `previewToken` does not match the current pin on this handle. The benign " +
        "explanation is that preview_send was re-called with `refresh: true` after the token " +
        "was captured — in that case, the new pin has a new token AND a new preSignHash the " +
        "user MUST re-match on-device. Do NOT retry with the old token: call preview_send " +
        "again, surface the fresh CHECKS PERFORMED block and the new blind-sign hash to the " +
        "user, and pass the new token. If the user did not ask for a refresh and the hash on " +
        "their Ledger screen no longer matches the one they were shown, reject on-device — a " +
        "token drift without a user-initiated refresh is not expected.",
    );
  }
  const tx = consumeHandle(args.handle);
  const pinned = {
    nonce: stashed.nonce,
    maxFeePerGas: stashed.maxFeePerGas,
    maxPriorityFeePerGas: stashed.maxPriorityFeePerGas,
    gas: stashed.gas,
  };
  const hash = await requestSendTransaction(tx, pinned);
  // Only retire the handle after successful submission. If requestSendTransaction
  // throws (device disconnect, user rejection, relay timeout), the handle stays
  // valid and the caller can retry until the 15-minute TTL expires. The pin
  // stays attached so a retry doesn't have to re-preview.
  retireHandle(args.handle);
  return {
    txHash: hash,
    chain: tx.chain,
    ...(tx.next?.handle ? { nextHandle: tx.next.handle } : {}),
    preSignHash: stashed.preSignHash,
    to: tx.to,
    valueWei: tx.value,
  };
}

export async function getTransactionStatus(args: GetTransactionStatusArgs) {
  if (args.chain === "tron") {
    return getTronTransactionStatus(args.txHash);
  }
  if (args.chain === "solana") {
    return getSolanaTransactionStatus({
      signature: args.txHash,
      ...(args.lastValidBlockHeight !== undefined
        ? { lastValidBlockHeight: args.lastValidBlockHeight }
        : {}),
      ...(args.durableNonce ? { durableNonce: args.durableNonce } : {}),
    });
  }
  if (args.chain === "bitcoin") {
    const { getBitcoinIndexer } = await import("../btc/indexer.js");
    const status = await getBitcoinIndexer().getTxStatus(args.txHash);
    if (status === null) {
      return {
        chain: "bitcoin" as const,
        txHash: args.txHash,
        status: "unknown" as const,
        note:
          "Tx not found at the indexer. Either it was dropped before any node saw it " +
          "(low fee, RBF-replaced, or never broadcast) or it hasn't propagated yet — " +
          "wait a minute and re-poll. If a low fee is suspected, the original handle " +
          "is gone after broadcast; rebuild via prepare_btc_send with a higher feeRate.",
      };
    }
    if (!status.confirmed) {
      return {
        chain: "bitcoin" as const,
        txHash: args.txHash,
        status: "pending" as const,
        note: "Tx is in the mempool — waiting for inclusion in a block.",
      };
    }
    return {
      chain: "bitcoin" as const,
      txHash: args.txHash,
      status: "success" as const,
      ...(status.blockHeight !== undefined
        ? { blockNumber: status.blockHeight.toString() }
        : {}),
      ...(status.confirmations !== undefined
        ? { confirmations: status.confirmations }
        : {}),
    };
  }
  const client = getClient(args.chain as SupportedChain);
  try {
    const receipt = await client.getTransactionReceipt({ hash: args.txHash as `0x${string}` });
    return {
      chain: args.chain,
      txHash: args.txHash,
      status: receipt.status === "success" ? "success" : "failed",
      blockNumber: receipt.blockNumber.toString(),
      gasUsed: receipt.gasUsed.toString(),
      from: receipt.from,
      to: receipt.to,
    };
  } catch {
    // No receipt yet — try to find it pending.
    try {
      const tx = await client.getTransaction({ hash: args.txHash as `0x${string}` });
      return {
        chain: args.chain,
        txHash: args.txHash,
        status: "pending",
        from: tx.from,
        to: tx.to,
      };
    } catch {
      return {
        chain: args.chain,
        txHash: args.txHash,
        status: "unknown",
        note: "Transaction not yet visible to this RPC — it may still be propagating.",
      };
    }
  }
}

/**
 * Re-emit the prepared tx + verification block for a known handle. The result
 * shape matches the original prepare_* response, so the existing handler
 * wrapper renders the same VERIFY-BEFORE-SIGNING text content blocks.
 *
 * Why this exists: agents periodically lose the original prepare_* tool result
 * from their context (compaction, long sessions, multi-agent handoffs). The
 * wrong recovery is to read the persisted tool-result JSON file from disk and
 * parse it with a python script — that bypasses the MCP boundary, drags the
 * agent into harness internals, and produces brittle code per call. The right
 * recovery is to ask the server: handles live in-memory for 15 minutes and
 * already carry the verification data, so a tool that takes a handle and
 * returns the same shape costs almost nothing and keeps every agent on the
 * same code path.
 *
 * Routes by handle origin: EVM handles come from tx-store, TRON handles from
 * tron-tx-store. If neither knows the handle, throws with a single clear
 * "expired or unknown" message rather than chaining store-specific errors.
 */
export function getTxVerification(args: GetTxVerificationArgs): UnsignedTx | UnsignedTronTx {
  if (hasHandle(args.handle)) return consumeHandle(args.handle);
  if (hasTronHandle(args.handle)) return consumeTronHandle(args.handle);
  throw new Error(
    `Unknown or expired tx handle '${args.handle}'. Prepared transactions live for ` +
      `15 minutes after issue and are deleted on successful submission. Re-run the ` +
      `prepare_* tool to get a fresh handle.`
  );
}

/**
 * Static prompt appended to every verification artifact. Tells a second LLM
 * how to independently decode the payload without trusting any of the first
 * agent's narrative. Kept in one place so every artifact carries byte-identical
 * instructions — if the text drifts per tx, an attacker gains a channel to
 * inject behavior through the instructions.
 */
const SECOND_AGENT_INSTRUCTIONS = [
  "You are auditing a transaction a user is about to sign on a Ledger hardware wallet.",
  "The payload below is JSON. Do these steps in order:",
  "",
  "  1. Parse the SIGNABLE BYTES yourself — payload.data (EVM), payload.rawDataHex",
  "     (TRON), or payload.messageBase64 (Solana — base64-decode then use",
  "     @solana/web3.js Message.from). Identify the 4-byte selector / TRON contract",
  "     type / Solana instruction programIds, the function or action name, and all",
  "     arguments. DO NOT trust the description / decoded fields in the payload",
  "     for THIS step — the whole point of this cross-check is that you decode the",
  "     bytes from scratch, independently of whatever the first agent claimed.",
  "",
  "  2. Describe in plain English what the transaction will do to the user's wallet:",
  "     what contract, what action, what amounts, what destinations.",
  "",
  "  3. NOW compare your decode to payload.description and payload.decoded (the",
  "     human summary + structured args the first agent showed the user). Three",
  "     possible outcomes:",
  "       - MATCH: your decode and the description say the same thing → the agent",
  "         narrated truthfully; the cross-check passes on the description-vs-bytes",
  "         dimension.",
  "       - MISMATCH: bytes encode something different from what the user was told",
  "         → THIS IS THE THREAT this cross-check exists for. Lead your reply with",
  "         a clear ✗ MISMATCH headline; tell the user to REJECT on-device.",
  "       - PARTIAL: description omits a detail you can see in the bytes (e.g.,",
  "         priority-fee ix, nonce-advance ix, ATA-create ix) → not a mismatch by",
  "         itself; mention the extras and let the user decide.",
  "",
  "  4. Flag red flags: unlimited approvals (uint256.max), unknown destinations,",
  "     nested delegatecalls, transfers to addresses that don't match the stated",
  "     recipient, approvals to spenders that are not well-known protocol routers.",
  "     Specifically: if the calldata embeds a recipient / `to` / unwrap target",
  "     (e.g. unwrapWETH9's recipient, a bridge's destination, a transfer's `to`),",
  "     compare it to payload.from. If they match, it is the signer's own wallet",
  "     — that is the expected case for swaps/unwraps/withdrawals. If they DIFFER,",
  "     the user is sending value to a third party and should confirm that",
  "     destination was intentional.",
  "",
  "  5. SOLANA-SPECIFIC NOTES — these patterns are NOT red flags by themselves;",
  "     do NOT alarm the user about them. This server (vaultpilot-mcp) makes two",
  "     deliberate design choices a generic Solana auditor would otherwise misread:",
  "",
  "     (a) DURABLE-NONCE PROTECTION — every send (native_send / spl_send /",
  "         nonce_close) carries `SystemProgram.AdvanceNonceAccount` as ix[0],",
  "         operating on a per-wallet PDA derived deterministically from the user's",
  "         pubkey + the public seed string `vaultpilot-nonce-v1`. The authority",
  "         on that ix == payload.from. This lets the user take unlimited time on",
  "         Ledger review without the ~60s `recentBlockhash` window expiring (and",
  "         the recentBlockhash field carries the nonce VALUE, not a network",
  "         blockhash, when ix[0] is nonceAdvance — Agave's standard behavior).",
  "         Do NOT describe this as 'signature collection for replay' or 'delayed",
  "         signing attack' — it is the normal flow for every Solana send this",
  "         server builds. Only flag if the nonce account's authority does NOT",
  "         match payload.from (which would mean someone else controls it).",
  "",
  "     (b) SELF-TRANSFER — for SPL TransferChecked, source ATA and destination",
  "         ATA can legitimately be the same when the user is sending to their",
  "         own wallet (used for testing or to advance a nonce as a no-op).",
  "         Check payload.description: if it says 'self', '(self)', 'to yourself',",
  "         or echoes the same address as both from and to, the source==dest",
  "         pattern is INTENTIONAL — say so and stop. Only flag source==dest as",
  "         suspicious if the description claims a non-self recipient but the",
  "         bytes encode a self-transfer (genuine description-vs-bytes mismatch).",
  "",
  "  6. If you cannot decode the selector / instruction (not in your training",
  "     data), say so — do not guess. 'I don't know this selector' is the correct",
  "     answer when true.",
  "",
  "  7. Remind the user that the last check happens on-device, before they tap",
  "     'Approve'. Ledger has two display modes and the check differs between them:",
  "       - BLIND-SIGN (device shows only a hash — the typical case for swaps and",
  "         most DeFi calls, and ALL SPL token transfers on Solana): the hash on-",
  "         device MUST equal payload.preSignHash (EVM), the signed rawData digest",
  "         (TRON), or payload.ledgerMessageHash (Solana — the device label is",
  "         'Message Hash'). Mismatch means the artifact was fabricated by a",
  "         compromised intermediary — REJECT on-device.",
  "       - CLEAR-SIGN (device shows decoded fields — enabled for Aave, Lido, 1inch,",
  "         LiFi, approve, and a few other plugins): hash matching does NOT apply.",
  "         Instead verify that the function name and key fields on-screen (amount,",
  "         recipient, spender, etc.) match what you described above. If the device",
  "         shows a different function or different values — REJECT.",
  "     If you cannot tell which mode the device is in from the user's description,",
  "     explain both cases so the user picks the right check when they see the screen.",
].join("\n");

/**
 * Explicit start/end copy-markers so the user (and the second LLM) can tell
 * where the paste target begins and ends. Without them, the first agent's
 * surrounding commentary bleeds into the paste: live users have pasted the
 * "Reply with what the second agent said..." trailing sentence into the
 * second session, confusing it. The markers eliminate that ambiguity.
 */
const PASTE_START = '===== COPY FROM THIS LINE TO THE "END" MARKER INTO A SEPARATE LLM SESSION =====';
const PASTE_START_2 = "===== (ideally a different LLM provider — the point is no shared context)    =====";
const PASTE_END = '===== END — STOP COPYING HERE =====';

function buildPasteableBlock(payload: Record<string, unknown>): string {
  return [
    PASTE_START,
    PASTE_START_2,
    "",
    SECOND_AGENT_INSTRUCTIONS,
    "",
    "PAYLOAD:",
    JSON.stringify(payload, null, 2),
    "",
    PASTE_END,
  ].join("\n");
}

export interface EvmVerificationArtifact {
  artifactVersion: "v1";
  handle: string;
  chain: SupportedChain;
  chainId: number;
  /**
   * The signer / paired wallet. Surfaced on the artifact (and inside the
   * pasteable payload) so the second agent can auto-check "is the recipient
   * embedded in the calldata the signer's own wallet or a third party?" —
   * the common case that a second agent otherwise has to flag uncertainly.
   * Optional on the type because UnsignedTx.from is optional, but populated
   * in practice for every tx our prepare_* tools produce.
   */
  from?: `0x${string}`;
  to: `0x${string}`;
  value: string;
  data: `0x${string}`;
  payloadHash: `0x${string}`;
  preSignHash?: `0x${string}`;
  /**
   * Self-contained copy-paste string with explicit START/END markers,
   * instructions for the second agent, and the JSON payload embedded inline.
   * The agent should present this field VERBATIM to the user — do not
   * rewrap, don't add commentary inside the markers, don't reformat.
   */
  pasteableBlock: string;
}

export interface TronVerificationArtifact {
  artifactVersion: "v1";
  handle: string;
  chain: "tron";
  from: string;
  txID: string;
  rawDataHex: string;
  payloadHash: `0x${string}`;
  /** See EvmVerificationArtifact.pasteableBlock. */
  pasteableBlock: string;
}

export interface SolanaVerificationArtifact {
  artifactVersion: "v1";
  handle: string;
  chain: "solana";
  action:
    | "native_send"
    | "spl_send"
    | "nonce_init"
    | "nonce_close"
    | "jupiter_swap"
    | "marginfi_init"
    | "marginfi_supply"
    | "marginfi_withdraw"
    | "marginfi_borrow"
    | "marginfi_repay"
    | "marinade_stake"
    | "marinade_unstake_immediate"
    | "native_stake_delegate"
    | "native_stake_deactivate"
    | "native_stake_withdraw"
    | "lifi_solana_swap"
    | "kamino_init_user"
    | "kamino_supply"
    | "kamino_borrow"
    | "kamino_withdraw"
    | "kamino_repay";
  from: string;
  messageBase64: string;
  recentBlockhash: string;
  /** Domain-tagged server-side fingerprint (pair-consistency, NOT shown on-device). */
  payloadHash: `0x${string}`;
  /** base58(sha256(messageBytes)) — the exact 'Message Hash' the Ledger Solana app displays on blind-sign. Present for spl_send; absent for native_send (clear-signs). */
  ledgerMessageHash?: string;
  /** See EvmVerificationArtifact.pasteableBlock. */
  pasteableBlock: string;
}

export type VerificationArtifact =
  | EvmVerificationArtifact
  | TronVerificationArtifact
  | SolanaVerificationArtifact;

/**
 * Produce a sparse verification artifact for the tx named by `handle`. The
 * artifact is designed to be copy-pasted into a second, independent LLM
 * session (different provider ideally) so the user gets an adversarial,
 * from-scratch decode of the calldata — catching the threat class where the
 * first agent truthfully invokes prepare_* with malicious args and then
 * narrates a different action in chat.
 *
 * Deliberately omits the server's humanDecode / swiss-knife URL / 4byte
 * cross-check: the point is adversarial independence, and including any of
 * those fields risks the second agent echoing them instead of decoding.
 *
 * The trust anchor is the Ledger device screen, not a server-side signature.
 * If an adversary fabricates an artifact, the preSignHash it ships will not
 * match what Ledger displays at sign time — the user rejects. No new keypair,
 * no ceremony.
 */
export function getVerificationArtifact(args: GetVerificationArtifactArgs): VerificationArtifact {
  if (hasHandle(args.handle)) {
    const tx = consumeHandle(args.handle);
    // issueHandles stamps verification unconditionally — this should never
    // happen, but the type is optional.
    if (!tx.verification) {
      throw new Error(`Internal: tx for handle '${args.handle}' missing verification metadata.`);
    }
    const pin = getPinnedGas(args.handle);
    // Payload embedded in the paste-block is the SECOND-AGENT-FACING view —
    // just the fields the prompt references (chain, chainId, to, value, data,
    // payloadHash, preSignHash). The artifact's own `handle` / `artifactVersion`
    // are internal plumbing; including them would just invite the second
    // agent to comment on structural fields rather than the tx semantics.
    const pasteablePayload: Record<string, unknown> = {
      chain: tx.chain,
      chainId: CHAIN_IDS[tx.chain],
      to: tx.to,
      value: tx.value,
      data: tx.data,
      payloadHash: tx.verification.payloadHash,
    };
    if (tx.from) pasteablePayload.from = tx.from;
    if (pin) pasteablePayload.preSignHash = pin.preSignHash;
    const artifact: EvmVerificationArtifact = {
      artifactVersion: "v1",
      handle: args.handle,
      chain: tx.chain,
      chainId: CHAIN_IDS[tx.chain],
      to: tx.to,
      value: tx.value,
      data: tx.data,
      payloadHash: tx.verification.payloadHash,
      pasteableBlock: buildPasteableBlock(pasteablePayload),
    };
    if (tx.from) artifact.from = tx.from;
    if (pin) artifact.preSignHash = pin.preSignHash;
    return artifact;
  }
  if (hasTronHandle(args.handle)) {
    const tx = consumeTronHandle(args.handle);
    if (!tx.verification) {
      throw new Error(`Internal: TRON tx for handle '${args.handle}' missing verification metadata.`);
    }
    const pasteablePayload = {
      chain: "tron",
      from: tx.from,
      txID: tx.txID,
      rawDataHex: tx.rawDataHex,
      payloadHash: tx.verification.payloadHash,
    };
    return {
      artifactVersion: "v1",
      handle: args.handle,
      chain: "tron",
      from: tx.from,
      txID: tx.txID,
      rawDataHex: tx.rawDataHex,
      payloadHash: tx.verification.payloadHash,
      pasteableBlock: buildPasteableBlock(pasteablePayload),
    };
  }
  if (hasSolanaHandle(args.handle)) {
    const tx = consumeSolanaHandle(args.handle);
    if (!tx.verification) {
      throw new Error(`Internal: Solana tx for handle '${args.handle}' missing verification metadata.`);
    }
    // Blind-sign actions need the server-computed Ledger Message Hash in the
    // artifact payload so the second LLM can tell the user which value to
    // match against the on-device screen. Clear-sign actions (native_send,
    // nonce_init, nonce_close) omit it — the device shows decoded fields
    // and there is no hash to match.
    const blindSignActions = new Set([
      "spl_send",
      "jupiter_swap",
      "marginfi_init",
      "marginfi_supply",
      "marginfi_withdraw",
      "marginfi_borrow",
      "marginfi_repay",
      "marinade_stake",
      "marinade_unstake_immediate",
      "native_stake_delegate",
      "native_stake_deactivate",
      "native_stake_withdraw",
      "lifi_solana_swap",
      "kamino_init_user",
      "kamino_supply",
      "kamino_borrow",
      "kamino_withdraw",
      "kamino_repay",
    ]);
    const ledgerMessageHash = blindSignActions.has(tx.action)
      ? solanaLedgerMessageHash(tx.messageBase64)
      : undefined;
    // `description` and `decoded` are the human/structured summary the FIRST
    // agent showed the user. The second LLM uses them as a comparison target
    // (step 3 of SECOND_AGENT_INSTRUCTIONS) AFTER it independently decodes
    // the bytes — the genuine threat here is "first agent narrates X, signs
    // Y", which manifests as a mismatch between the byte decode and these
    // fields. Without them, the second LLM has no claim to compare against
    // and falls back to generic "unusual pattern" pattern-matching, which
    // produces false positives on legitimate self-transfers + this server's
    // standard durable-nonce flow (live regression: a 100-USDC self-send
    // got flagged as adversarial because source ATA == dest ATA, with no
    // way for the second LLM to know the user explicitly asked for self).
    const pasteablePayload: Record<string, unknown> = {
      chain: "solana",
      action: tx.action,
      from: tx.from,
      messageBase64: tx.messageBase64,
      recentBlockhash: tx.recentBlockhash,
      payloadHash: tx.verification.payloadHash,
      description: tx.description,
      decoded: tx.decoded,
    };
    if (ledgerMessageHash) pasteablePayload.ledgerMessageHash = ledgerMessageHash;
    const artifact: SolanaVerificationArtifact = {
      artifactVersion: "v1",
      handle: args.handle,
      chain: "solana",
      action: tx.action,
      from: tx.from,
      messageBase64: tx.messageBase64,
      recentBlockhash: tx.recentBlockhash,
      payloadHash: tx.verification.payloadHash,
      pasteableBlock: buildPasteableBlock(pasteablePayload),
    };
    if (ledgerMessageHash) artifact.ledgerMessageHash = ledgerMessageHash;
    return artifact;
  }
  throw new Error(
    `Unknown or expired tx handle '${args.handle}'. Prepared transactions live for ` +
      `15 minutes after issue and are deleted on successful submission. Re-run the ` +
      `prepare_* tool to get a fresh handle.`
  );
}

/**
 * Server-side independent cross-check of a prepared EVM tx's calldata.
 *
 * Pipeline: fetch candidate function signatures for the 4-byte selector from
 * 4byte.directory, decode + re-encode the calldata against each, and report
 * which (if any) round-trips losslessly. Result is a `VerifyDecodeResult`
 * with a human-readable `summary` field — the orchestrator agent is
 * expected to relay that summary to the user verbatim.
 *
 * This exists so the agent does NOT have to script ad-hoc WebFetches to
 * verify arguments, and does NOT have to pretend it read swiss-knife's
 * client-rendered SPA output. One MCP tool = one auditable code path.
 */
export async function verifyTxDecode(args: GetTxVerificationArgs): Promise<VerifyDecodeResult> {
  if (hasTronHandle(args.handle)) {
    const tronTx = consumeTronHandle(args.handle);
    return notApplicableForTron(tronTx);
  }
  if (!hasHandle(args.handle)) {
    throw new Error(
      `Unknown or expired tx handle '${args.handle}'. Prepared transactions live for ` +
        `15 minutes after issue. Re-run the prepare_* tool to get a fresh handle.`
    );
  }
  const tx = consumeHandle(args.handle);
  return verifyEvmCalldata(tx);
}
