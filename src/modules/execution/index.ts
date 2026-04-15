import { encodeFunctionData, formatUnits, parseEther, parseUnits } from "viem";
import qrcodeTerminal from "qrcode-terminal";
import {
  initiatePairing,
  requestSendTransaction,
  getConnectedAccounts,
} from "../../signing/walletconnect.js";
import { getSessionStatus } from "../../signing/session.js";
import { consumeHandle, retireHandle } from "../../signing/tx-store.js";
import { consumeTronHandle, retireTronHandle } from "../../signing/tron-tx-store.js";
import {
  getTronLedgerAddress,
  signTronTxOnLedger,
  setPairedTronAddress,
  getPairedTronByAddress,
  tronPathForAccountIndex,
} from "../../signing/tron-usb-signer.js";
import { broadcastTronTx } from "../tron/broadcast.js";
import { assertTransactionSafe } from "../../signing/pre-sign-check.js";
import { payloadFingerprint, tronPayloadFingerprint } from "../../signing/verification.js";
import { getClient, verifyChainId } from "../../data/rpc.js";
import { erc20Abi } from "../../abis/erc20.js";
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
  SendTransactionArgs,
  GetTransactionStatusArgs,
} from "./schemas.js";
import type { SupportedChain, UnsignedTx, UnsignedTronTx } from "../../types/index.js";
import { hasTronHandle } from "../../signing/tron-tx-store.js";
import { round } from "../../data/format.js";

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

export async function getLedgerStatus() {
  return getSessionStatus();
}

async function resolveAssetMeta(
  chain: SupportedChain,
  asset: `0x${string}`
): Promise<{ decimals: number; symbol: string }> {
  const client = getClient(chain);
  const [decimals, symbol] = await client.multicall({
    contracts: [
      { address: asset, abi: erc20Abi, functionName: "decimals" },
      { address: asset, abi: erc20Abi, functionName: "symbol" },
    ],
    allowFailure: false,
  });
  return { decimals: Number(decimals), symbol: symbol as string };
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
  const meta = await resolveAssetMeta(args.chain as SupportedChain, args.asset as `0x${string}`);
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
  const meta = await resolveAssetMeta(args.chain as SupportedChain, args.asset as `0x${string}`);
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
  const meta = await resolveAssetMeta(args.chain as SupportedChain, args.asset as `0x${string}`);
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
  const meta = await resolveAssetMeta(args.chain as SupportedChain, args.asset as `0x${string}`);
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
  const meta = await resolveAssetMeta("ethereum", args.token as `0x${string}`);
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

export async function prepareNativeSend(args: PrepareNativeSendArgs): Promise<UnsignedTx> {
  const wallet = args.wallet as `0x${string}`;
  const chain = args.chain as SupportedChain;
  const to = args.to as `0x${string}`;
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
  const to = args.to as `0x${string}`;
  const meta = await resolveAssetMeta(chain, token);

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
 * Forward a prepared tx to the right signer based on which store owns the
 * handle. EVM handles take the WalletConnect path (unchanged). TRON handles
 * take the USB HID path: `consume → sign on Ledger → broadcast via TronGrid`.
 *
 * The two stores share no keys (`randomUUID` collision is ~0), and we check
 * TRON first because its path has strictly fewer side effects on failure
 * (no WC relay roundtrip, no eth_call, no chain-id check that would
 * meaninglessly fire before we even know what chain we're on).
 */
export async function sendTransaction(args: SendTransactionArgs): Promise<{
  txHash: `0x${string}` | string;
  chain: SupportedChain | "tron";
  nextHandle?: string;
}> {
  if (hasTronHandle(args.handle)) {
    return sendTronTransaction(args);
  }
  const tx = consumeHandle(args.handle);
  // Last-line check: refuse to sign against an RPC that's pointing at the
  // wrong chain. See verifyChainId() for the threat model.
  await verifyChainId(tx.chain);
  // Independent of the prepare_* pipeline: validate destination + selector +
  // (for approve) spender allowlist. A compromised agent can't slip an
  // "approve(attacker, MAX)" past this, even if the handle system were bypassed.
  await assertTransactionSafe(tx);
  // Re-simulate against current chain state before asking the user to sign.
  // At prepare time, step 2 of an approve→action pair legitimately reverts
  // because the approve isn't mined yet. By send time, the approve is on-chain
  // and the simulation should pass. A revert here means signing would waste gas
  // on a guaranteed failure — refuse rather than forward.
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
        `and wait for confirmation before retrying. Use simulate_transaction to debug.`
    );
  }
  // Assert that tx.from is actually an account the paired wallet holds keys
  // for. Without this check, a prepare_* call with a user-supplied `wallet`
  // arg referencing an address the wallet doesn't control would be forwarded
  // to Ledger Live and rejected deep in the sign flow with a confusing error.
  // Worse: a prompt-injected agent could get us to request signing for an
  // address the user didn't intend to use in this session.
  if (tx.from) {
    const accounts = (await getConnectedAccounts()).map((a) => a.toLowerCase());
    const from = tx.from.toLowerCase();
    if (accounts.length > 0 && !accounts.includes(from)) {
      throw new Error(
        `Pre-sign check: tx.from (${tx.from}) is not one of the accounts exposed by the paired ` +
          `WalletConnect session (${accounts.join(", ")}). Refusing to submit. If this is a ` +
          `different Ledger account, re-pair with that account unlocked.`
      );
    }
  }
  // Proof-of-identity guard: recompute the domain-tagged hash of the exact
  // `{chainId, to, value, data}` that are about to be forwarded to WalletConnect
  // (`requestSendTransaction` consumes these four fields, see
  // src/signing/walletconnect.ts). Equality with `tx.verification.payloadHash`
  // is the "what-you-preview == what-you-sign" proof. If they diverge, the
  // request is refused — a mismatch would only be possible if tx state was
  // mutated in-process between handle issuance and the send call.
  if (tx.verification) {
    const rehash = payloadFingerprint({ chain: tx.chain, to: tx.to, value: tx.value, data: tx.data });
    if (rehash !== tx.verification.payloadHash) {
      throw new Error(
        `Payload hash mismatch at send time. Previewed ${tx.verification.payloadHash}, ` +
          `about to send ${rehash}. The transaction bytes changed between preview and send — ` +
          `refusing to forward to WalletConnect.`,
      );
    }
  }
  const hash = await requestSendTransaction(tx);
  // Only retire the handle after successful submission. If requestSendTransaction
  // throws (device disconnect, user rejection, relay timeout), the handle stays
  // valid and the caller can retry until the 15-minute TTL expires.
  retireHandle(args.handle);
  return {
    txHash: hash,
    chain: tx.chain,
    ...(tx.next?.handle ? { nextHandle: tx.next.handle } : {}),
  };
}

export async function getTransactionStatus(args: GetTransactionStatusArgs) {
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
