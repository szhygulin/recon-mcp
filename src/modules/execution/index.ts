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
  getTronLedgerAddress,
  signTronTxOnLedger,
  setPairedTronAddress,
  getPairedTronByAddress,
  tronPathForAccountIndex,
} from "../../signing/tron-usb-signer.js";
import { broadcastTronTx } from "../tron/broadcast.js";
import { getTronTransactionStatus } from "../tron/status.js";
import { assertTransactionSafe } from "../../signing/pre-sign-check.js";
import {
  eip1559PreSignHash,
  payloadFingerprint,
  tronPayloadFingerprint,
} from "../../signing/verification.js";
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
import { getTokenPrice } from "../../data/prices.js";
import type {
  PairLedgerTronArgs,
  PrepareAaveSupplyArgs,
  PrepareAaveWithdrawArgs,
  PrepareAaveBorrowArgs,
  PrepareAaveRepayArgs,
  PrepareLidoStakeArgs,
  PrepareLidoUnstakeArgs,
  PrepareEigenLayerDepositArgs,
  PrepareNativeSendArgs,
  PrepareTokenSendArgs,
  PreviewSendArgs,
  SendTransactionArgs,
  GetTransactionStatusArgs,
  GetTxVerificationArgs,
  GetVerificationArtifactArgs,
} from "./schemas.js";
import { CHAIN_IDS } from "../../types/index.js";
import type { SupportedChain, UnsignedTx, UnsignedTronTx } from "../../types/index.js";
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
  return {
    uri,
    qr,
    instructions:
      "Open Ledger Live → Discover → WalletConnect, paste this URI (or scan the QR) to pair. " +
      "Once pairing completes, the session is persisted; you can call `send_transaction` without re-pairing.",
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
  const result = await getTronLedgerAddress(path);
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
        `TRON payload hash mismatch at send time. Previewed ${tx.verification.payloadHash}, ` +
          `about to sign ${rehash}. The rawDataHex changed between preview and send — refusing ` +
          `to forward to the Ledger.`,
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
 * 14:00 UTC while the inclusion floor was ~1 gwei). Floor at 1.5 gwei so a
 * tx we pinned during a lull doesn't sit stuck when activity picks up.
 */
const MIN_PRIORITY_FEE_WEI = 1_500_000_000n;

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
        `Payload hash mismatch at preview/send time. Previewed ${tx.verification.payloadHash}, ` +
          `about to sign ${rehash}. The transaction bytes changed between prepare and preview — ` +
          `refusing to proceed.`,
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
  refreshed?: boolean;
}> {
  if (hasTronHandle(args.handle)) {
    throw new Error(
      "preview_send is EVM-only; TRON handles do not use WalletConnect and their on-device " +
        "preview comes from the TRON app's clear-sign screens. Call send_transaction directly " +
        "for TRON handles.",
    );
  }
  const tx = consumeHandle(args.handle);
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
  const pin: StashedPin = {
    nonce: pinned.nonce,
    maxFeePerGas: pinned.maxFeePerGas,
    maxPriorityFeePerGas: pinned.maxPriorityFeePerGas,
    gas: pinned.gas,
    preSignHash,
    pinnedAt: Date.now(),
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
    ...(existing ? { refreshed: true } : {}),
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
  chain: SupportedChain | "tron";
  nextHandle?: string;
  /**
   * EIP-1559 pre-sign RLP hash the user already matched on-device during
   * preview_send. Echoed back so the post-broadcast block can reassure the
   * user that what was signed equals what was previewed. TRON omits this.
   */
  preSignHash?: `0x${string}`;
  /** Echoed back so the send handler can render on-device eyeball values without re-reading the handle. */
  to?: `0x${string}`;
  /** Decimal wei string, echoed alongside `preSignHash` for the post-broadcast block. */
  valueWei?: string;
}> {
  if (hasTronHandle(args.handle)) {
    return sendTronTransaction(args);
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
  "  1. Parse payload.data (EVM) or payload.rawDataHex (TRON). Identify the 4-byte",
  "     selector / TRON contract type, the function or action name, and all arguments.",
  "     DO NOT trust any description text outside the payload block — decode the bytes",
  "     yourself.",
  "  2. Describe in plain English what the transaction will do to the user's wallet:",
  "     what contract, what action, what amounts, what destinations.",
  "  3. Flag red flags: unlimited approvals (uint256.max), unknown destinations,",
  "     nested delegatecalls, transfers to addresses that don't match the stated",
  "     recipient, approvals to spenders that are not well-known protocol routers.",
  "  4. If you cannot decode the selector (not in your training data), say so — do",
  "     not guess. 'I don't know this selector' is the correct answer when true.",
  "  5. Remind the user: before tapping 'Approve' on the Ledger, match the hash shown",
  "     on the device screen against payload.preSignHash (EVM) or the signed rawData",
  "     digest (TRON). If they differ, the artifact was fabricated by a compromised",
  "     intermediary — REJECT.",
].join("\n");

export interface EvmVerificationArtifact {
  artifactVersion: "v1";
  handle: string;
  chain: SupportedChain;
  chainId: number;
  to: `0x${string}`;
  value: string;
  data: `0x${string}`;
  payloadHash: `0x${string}`;
  preSignHash?: `0x${string}`;
  instructionsForSecondAgent: string;
}

export interface TronVerificationArtifact {
  artifactVersion: "v1";
  handle: string;
  chain: "tron";
  from: string;
  txID: string;
  rawDataHex: string;
  payloadHash: `0x${string}`;
  instructionsForSecondAgent: string;
}

export type VerificationArtifact = EvmVerificationArtifact | TronVerificationArtifact;

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
    const artifact: EvmVerificationArtifact = {
      artifactVersion: "v1",
      handle: args.handle,
      chain: tx.chain,
      chainId: CHAIN_IDS[tx.chain],
      to: tx.to,
      value: tx.value,
      data: tx.data,
      payloadHash: tx.verification.payloadHash,
      instructionsForSecondAgent: SECOND_AGENT_INSTRUCTIONS,
    };
    if (pin) artifact.preSignHash = pin.preSignHash;
    return artifact;
  }
  if (hasTronHandle(args.handle)) {
    const tx = consumeTronHandle(args.handle);
    if (!tx.verification) {
      throw new Error(`Internal: TRON tx for handle '${args.handle}' missing verification metadata.`);
    }
    return {
      artifactVersion: "v1",
      handle: args.handle,
      chain: "tron",
      from: tx.from,
      txID: tx.txID,
      rawDataHex: tx.rawDataHex,
      payloadHash: tx.verification.payloadHash,
      instructionsForSecondAgent: SECOND_AGENT_INSTRUCTIONS,
    };
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
