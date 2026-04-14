import {
  getConnectedAccountsDetailed,
  getCurrentSession,
  getSignClient,
  isPeerUnreachable,
} from "./walletconnect.js";
import { getPairedTronAddress } from "./tron-usb-signer.js";
import type { SupportedChain } from "../types/index.js";

export interface SessionAccount {
  address: `0x${string}`;
  /** Supported chains this address is exposed on (mapped from chainIds). */
  chains: SupportedChain[];
  /** Every eip155 chainId advertised for this address, including ones the server does not support. */
  chainIds: number[];
}

export interface SessionStatus {
  paired: boolean;
  /**
   * Deduplicated list of addresses. An address that appears on multiple chains
   * shows up once here; use `accountDetails` for the per-chain breakdown.
   */
  accounts: `0x${string}`[];
  /** Per-address chain exposure — addresses paired with the networks they're advertised on. */
  accountDetails: SessionAccount[];
  topic?: string;
  expiresAt?: number;
  /** Peer-advertised app name (e.g. "Ledger Live"). Self-reported — NOT a trusted identity. */
  wallet?: string;
  /** Peer-advertised URL. Self-reported — NOT a trusted identity. */
  peerUrl?: string;
  /** Peer-advertised description. Self-reported — NOT a trusted identity. */
  peerDescription?: string;
  /**
   * Guidance for the agent: WalletConnect peer metadata is self-reported and any
   * app can claim to be "Ledger Live". Surface `wallet`/`peerUrl` to the user
   * before sending a tx they can't physically verify on the Ledger device.
   */
  peerTrustWarning: string;
  /**
   * Set when a local session record exists but the peer did not respond to the
   * liveness ping on restore. The session may still be valid (peer just
   * offline) or dead (relay didn't deliver a rejection in time) — callers
   * should treat it as unverified and avoid submitting transactions until the
   * peer comes back online or the user re-pairs.
   */
  peerUnreachable?: boolean;
  /**
   * Present when the user has run `pair_ledger_tron`. TRON doesn't share
   * WalletConnect with EVM — signing goes over USB HID — so this section is
   * independent of the `paired`/`accounts` fields above (which describe the
   * WC session for EVM chains only). Unset means the agent should ask the
   * user to run `pair_ledger_tron` before preparing a TRON tx.
   */
  tron?: {
    address: string;
    path: string;
    appVersion: string;
  };
}

export const PEER_TRUST_WARNING =
  "WalletConnect peer metadata is self-reported — any app can claim to be 'Ledger Live'. " +
  "If the paired wallet/URL above is unexpected (e.g. not 'Ledger Live' / ledger.com), ask the user " +
  "to confirm before calling send_transaction. The ultimate check is that the tx shows up on the " +
  "user's physical Ledger device for on-screen approval.";

export async function getSessionStatus(): Promise<SessionStatus> {
  await getSignClient(); // triggers restore + liveness check
  const session = getCurrentSession();
  const tronPaired = getPairedTronAddress();
  const tronSection = tronPaired
    ? {
        tron: {
          address: tronPaired.address,
          path: tronPaired.path,
          appVersion: tronPaired.appVersion,
        },
      }
    : {};
  if (!session)
    return {
      paired: false,
      accounts: [],
      accountDetails: [],
      peerTrustWarning: PEER_TRUST_WARNING,
      ...tronSection,
    };
  const accountDetails = await getConnectedAccountsDetailed();
  const accounts = accountDetails.map((a) => a.address);
  const meta = session.peer?.metadata;
  const unreachable = isPeerUnreachable();
  return {
    paired: true,
    accounts,
    accountDetails,
    topic: session.topic,
    expiresAt: session.expiry * 1000,
    ...(meta?.name ? { wallet: meta.name } : {}),
    ...(meta?.url ? { peerUrl: meta.url } : {}),
    ...(meta?.description ? { peerDescription: meta.description } : {}),
    peerTrustWarning: PEER_TRUST_WARNING,
    ...(unreachable ? { peerUnreachable: true } : {}),
    ...tronSection,
  };
}
