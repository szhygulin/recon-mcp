import { encodeFunctionData, formatUnits } from "viem";
import qrcodeTerminal from "qrcode-terminal";
import {
  initiatePairing,
  requestSendTransaction,
} from "../../signing/walletconnect.js";
import { getSessionStatus } from "../../signing/session.js";
import { getClient } from "../../data/rpc.js";
import { erc20Abi } from "../../abis/erc20.js";
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
  PrepareAaveSupplyArgs,
  PrepareAaveWithdrawArgs,
  PrepareAaveBorrowArgs,
  PrepareAaveRepayArgs,
  PrepareLidoStakeArgs,
  PrepareLidoUnstakeArgs,
  PrepareEigenLayerDepositArgs,
  SendTransactionArgs,
  GetTransactionStatusArgs,
} from "./schemas.js";
import type { SupportedChain, UnsignedTx } from "../../types/index.js";
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

/** Attach gas estimate + USD cost + eth_call simulation result. */
async function enrichTx(tx: UnsignedTx): Promise<UnsignedTx> {
  const client = getClient(tx.chain);
  const from = tx.from;
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
    // Simulation fails for many legitimate reasons (insufficient allowance, etc.) — we surface the tx anyway.
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
      interestRateMode: args.interestRateMode,
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
      interestRateMode: args.interestRateMode,
    })
  );
}

// ----- Staking preparation handlers -----

export async function prepareLidoStake(args: PrepareLidoStakeArgs): Promise<UnsignedTx> {
  return enrichTx(buildLidoStake({ wallet: args.wallet as `0x${string}`, amountEth: args.amountEth }));
}

export async function prepareLidoUnstake(args: PrepareLidoUnstakeArgs): Promise<UnsignedTx> {
  return enrichTx(
    await buildLidoUnstake({ wallet: args.wallet as `0x${string}`, amountStETH: args.amountStETH })
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
    })
  );
}

// ----- Send + status -----

export async function sendTransaction(args: SendTransactionArgs): Promise<{ txHash: `0x${string}`; chain: SupportedChain }> {
  const tx: UnsignedTx = {
    chain: args.chain as SupportedChain,
    to: args.to as `0x${string}`,
    data: args.data as `0x${string}`,
    value: args.value,
    from: args.from as `0x${string}` | undefined,
    description: `Send transaction on ${args.chain}`,
  };
  const hash = await requestSendTransaction(tx);
  return { txHash: hash, chain: args.chain as SupportedChain };
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
