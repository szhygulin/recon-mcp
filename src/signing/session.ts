import {
  getConnectedAccountsDetailed,
  getCurrentSession,
  getSignClient,
  isPeerUnreachable,
} from "./walletconnect.js";
import { getPairedTronAddresses } from "./tron-usb-signer.js";
import { getPairedSolanaAddresses } from "./solana-usb-signer.js";
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
   * Only set when the paired peer's URL host is NOT on the Ledger-first-party
   * allowlist (see `isKnownLedgerPeer`). The common case — pairing with Ledger
   * Live, which advertises a `ledger.com` host — produces no warning, so the
   * agent has nothing to surface. An unknown host flips this on and the agent
   * is expected to ask the user to confirm the peer before sending.
   *
   * NOT emitted on unpaired sessions either: there's no peer to warn about.
   */
  peerTrustWarning?: string;
  /**
   * Set when a local session record exists but the peer did not respond to the
   * liveness ping on restore. The session may still be valid (peer just
   * offline) or dead (relay didn't deliver a rejection in time) — callers
   * should treat it as unverified and avoid submitting transactions until the
   * peer comes back online or the user re-pairs.
   */
  peerUnreachable?: boolean;
  /**
   * Actionable guidance for the agent, populated only when `peerUnreachable`
   * is true. The cached `accounts` / `accountDetails` are still usable for
   * address resolution (e.g. "my first wallet" → 0x…) but any signing
   * attempt will hang on the unresponsive relay, so the agent should
   * proactively prompt the user to re-pair before proceeding to a
   * prepare_* / send flow. Kept as a string rather than a boolean so the
   * exact call-to-action lives alongside the flag and the agent can splice
   * it verbatim into its reply.
   */
  peerUnreachableGuidance?: string;
  /**
   * Present when the user has run `pair_ledger_tron` at least once. TRON
   * doesn't share WalletConnect with EVM — signing goes over USB HID — so
   * this section is independent of the `paired`/`accounts` fields above
   * (which describe the WC session for EVM chains only). An array because
   * users can pair multiple account slots (index 0, 1, …) in the same
   * session; entries are ordered by `accountIndex`. Absent/empty means the
   * agent should ask the user to run `pair_ledger_tron` before preparing a
   * TRON tx.
   */
  tron?: Array<{
    address: string;
    path: string;
    appVersion: string;
    /** Null when the path is not in the standard `44'/195'/<n>'/0/0` layout. */
    accountIndex: number | null;
  }>;
  /**
   * Solana pairings — parallel to the TRON section above. Populated once
   * the user has run `pair_ledger_solana` (USB HID — Ledger Live does NOT
   * expose Solana accounts over WalletConnect). Ordered by `accountIndex`.
   * Absent/empty → agent should call `pair_ledger_solana` before preparing
   * any `prepare_solana_*` tx.
   */
  solana?: Array<{
    address: string;
    path: string;
    appVersion: string;
    /** Null when the path is not in the standard `44'/501'/<n>'` layout. */
    accountIndex: number | null;
  }>;
}

export const PEER_TRUST_WARNING =
  "WalletConnect peer metadata is self-reported — any app can claim to be 'Ledger Live'. " +
  "The paired wallet/URL above is NOT on the Ledger-first-party allowlist; ask the user " +
  "to confirm before calling send_transaction. The ultimate check is that the tx shows up on the " +
  "user's physical Ledger device for on-screen approval.";

export const PEER_UNREACHABLE_GUIDANCE =
  "WalletConnect session is cached locally but the relay couldn't confirm Ledger Live is currently connected. " +
  "Cached addresses below are fine for referring to the user's wallet(s) — keep using them for balance/history/portfolio queries — " +
  "but any signing flow (prepare_* → send_transaction) will hang on the unresponsive peer. " +
  "Before the next signing operation, ASK the user: 'WalletConnect looks disconnected. Want me to re-pair Ledger Live now via pair_ledger_live?' " +
  "Only call pair_ledger_live on explicit confirmation. Do NOT auto-re-pair on read-only requests.";

/**
 * Hosts the server treats as first-party Ledger WC peers. Exact match or any
 * subdomain of `ledger.com` (so `wc.apps.ledger.com`, `ledger.com`, etc. all
 * pass). Everything else trips `peerTrustWarning`.
 */
export function isKnownLedgerPeer(peerUrl: string | undefined): boolean {
  if (!peerUrl) return false;
  try {
    const host = new URL(peerUrl).hostname.toLowerCase();
    return host === "ledger.com" || host.endsWith(".ledger.com");
  } catch {
    return false;
  }
}

export async function getSessionStatus(): Promise<SessionStatus> {
  await getSignClient(); // triggers restore + liveness check
  const session = getCurrentSession();
  const tronPaired = getPairedTronAddresses();
  const tronSection =
    tronPaired.length > 0
      ? {
          tron: tronPaired.map((e) => ({
            address: e.address,
            path: e.path,
            appVersion: e.appVersion,
            accountIndex: e.accountIndex,
          })),
        }
      : {};
  const solanaPaired = getPairedSolanaAddresses();
  const solanaSection =
    solanaPaired.length > 0
      ? {
          solana: solanaPaired.map((e) => ({
            address: e.address,
            path: e.path,
            appVersion: e.appVersion,
            accountIndex: e.accountIndex,
          })),
        }
      : {};
  if (!session)
    return {
      paired: false,
      accounts: [],
      accountDetails: [],
      ...tronSection,
      ...solanaSection,
    };
  const accountDetails = await getConnectedAccountsDetailed();
  const accounts = accountDetails.map((a) => a.address);
  const meta = session.peer?.metadata;
  const unreachable = isPeerUnreachable();
  const warnPeer = !isKnownLedgerPeer(meta?.url);
  return {
    paired: true,
    accounts,
    accountDetails,
    topic: session.topic,
    expiresAt: session.expiry * 1000,
    ...(meta?.name ? { wallet: meta.name } : {}),
    ...(meta?.url ? { peerUrl: meta.url } : {}),
    ...(meta?.description ? { peerDescription: meta.description } : {}),
    ...(warnPeer ? { peerTrustWarning: PEER_TRUST_WARNING } : {}),
    ...(unreachable
      ? { peerUnreachable: true, peerUnreachableGuidance: PEER_UNREACHABLE_GUIDANCE }
      : {}),
    ...tronSection,
    ...solanaSection,
  };
}
