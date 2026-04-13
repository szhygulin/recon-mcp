import {
  getConnectedAccounts,
  getCurrentSession,
  getSignClient,
  isPeerUnreachable,
} from "./walletconnect.js";

export interface SessionStatus {
  paired: boolean;
  accounts: `0x${string}`[];
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
}

const PEER_TRUST_WARNING =
  "WalletConnect peer metadata is self-reported — any app can claim to be 'Ledger Live'. " +
  "If the paired wallet/URL above is unexpected (e.g. not 'Ledger Live' / ledger.com), ask the user " +
  "to confirm before calling send_transaction. The ultimate check is that the tx shows up on the " +
  "user's physical Ledger device for on-screen approval.";

export async function getSessionStatus(): Promise<SessionStatus> {
  await getSignClient(); // triggers restore + liveness check
  const session = getCurrentSession();
  if (!session)
    return { paired: false, accounts: [], peerTrustWarning: PEER_TRUST_WARNING };
  const accounts = await getConnectedAccounts();
  const meta = session.peer?.metadata;
  const unreachable = isPeerUnreachable();
  return {
    paired: true,
    accounts,
    topic: session.topic,
    expiresAt: session.expiry * 1000,
    ...(meta?.name ? { wallet: meta.name } : {}),
    ...(meta?.url ? { peerUrl: meta.url } : {}),
    ...(meta?.description ? { peerDescription: meta.description } : {}),
    peerTrustWarning: PEER_TRUST_WARNING,
    ...(unreachable ? { peerUnreachable: true } : {}),
  };
}
