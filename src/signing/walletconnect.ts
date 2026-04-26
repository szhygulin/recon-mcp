import { SignClient } from "@walletconnect/sign-client";
import type { SessionTypes } from "@walletconnect/types";
import { getSdkError } from "@walletconnect/utils";
import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PublicClient } from "viem";
import { CHAIN_IDS, CHAIN_ID_TO_NAME, type SupportedChain, type UnsignedTx } from "../types/index.js";
import { EVM_ADDRESS } from "../shared/address-patterns.js";
import {
  readUserConfig,
  patchUserConfig,
  resolveWalletConnectProjectId,
  getConfigDir,
} from "../config/user-config.js";
import { getClient } from "../data/rpc.js";
import { eip1559PreSignHash } from "./verification.js";

/**
 * Recursively tighten permissions on the WalletConnect storage tree so the
 * session symkey (held in `wc@2/core/.../keychain`) is readable only by the
 * process owner. The `SignClient` storage backend writes files under the
 * process umask (typically 022 → 0644); on a shared host any local user could
 * read those files and decrypt relay traffic for the active session.
 *
 * We enforce 0700 on directories and 0600 on files. Applied idempotently on
 * every `getSignClient()` call — cheap, and catches the case where the user's
 * config dir was created by an older release that didn't set `mode: 0o700`.
 * Swallows ENOENT / EACCES silently (another user-owned file in the same
 * path, or a race during concurrent init) — the signing flow's on-device
 * hash match remains the authoritative defense even if file perms are wrong.
 */
function tightenWcStoragePerms(root: string): void {
  if (!existsSync(root)) return;
  try {
    const stack: string[] = [root];
    while (stack.length > 0) {
      const p = stack.pop()!;
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      try {
        chmodSync(p, st.isDirectory() ? 0o700 : 0o600);
      } catch {
        // Best-effort; if chmod fails (e.g. not our file), skip and keep going.
      }
      if (st.isDirectory()) {
        let entries: string[] = [];
        try {
          entries = readdirSync(p);
        } catch {
          continue;
        }
        for (const entry of entries) stack.push(join(p, entry));
      }
    }
  } catch {
    // Defensive top-level swallow; perm-tightening failure must never break
    // the signing pipeline (device checks are the real boundary).
  }
}

/**
 * Default WalletConnect Cloud project ID. Users should provide their own via
 * WALLETCONNECT_PROJECT_ID or `vaultpilot-mcp-setup` — the default is a placeholder
 * that will 401 against production relay. We keep a constant here so the code
 * compiles; `getProjectId()` will throw if a real ID is not set.
 */
const DEFAULT_PROJECT_ID = "";

/**
 * EVM namespace requested when proposing a session. We deliberately omit
 * `personal_sign` and `eth_signTypedData_v4` — no tool in this server produces
 * either, so requesting them would be an over-broad capability grant. Blind
 * typed-data signing is the canonical Permit2 / off-chain-order phishing
 * surface; scoping the session away from it means a compromised process can't
 * issue those requests against a live pairing without reconnecting (which the
 * user would see prompted on their device).
 */
export const REQUIRED_NAMESPACES = {
  eip155: {
    methods: [
      "eth_sendTransaction",
      "eth_signTransaction",
      "eth_chainId",
    ],
    chains: Object.values(CHAIN_IDS).map((id) => `eip155:${id}`),
    events: ["accountsChanged", "chainChanged"],
  },
};

let client: InstanceType<typeof SignClient> | null = null;
let currentSession: SessionTypes.Struct | null = null;
/**
 * Set when the last liveness signal (startup probe, pre-send probe, or
 * keepalive ping) showed the peer as not currently reachable. The local
 * session record is RETAINED — see issue #241: closing the WalletConnect
 * subapp inside Ledger Live should be transient, and reopening it must
 * resume the same session without a re-pair. Probe failure is liveness
 * UX, not a session-end signal; only the SDK's `session_delete` /
 * `session_expire` events authoritatively clear local state.
 */
let peerUnreachable = false;

/**
 * Background keepalive timer. While a session exists we ping the peer over
 * the relay every `KEEPALIVE_INTERVAL_MS` so the relay keeps the topic
 * subscription warm and we get a continuous reachability signal (used to
 * flip `peerUnreachable` between true/false without ever destroying the
 * persisted session). Cleared on `session_delete` / `session_expire` /
 * `disconnect()` / fresh restore. `null` when no session is being tracked.
 */
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Keepalive cadence. 30s is short enough that a transient peer disappearance
 * (LL-WC subapp closed, network blip) flips `peerUnreachable` quickly when
 * resolved, and long enough that the per-session bandwidth cost is trivial
 * (~120 pings/hour). Intentionally well below the WC v2 default session TTL
 * (7 days) and below typical relay-side topic-idle reap windows.
 */
const KEEPALIVE_INTERVAL_MS = 30_000;

export function isPeerUnreachable(): boolean {
  return peerUnreachable;
}

function getProjectId(): string {
  const id = resolveWalletConnectProjectId(readUserConfig()) || DEFAULT_PROJECT_ID;
  if (!id) {
    throw new Error(
      "No WalletConnect project ID configured. Set WALLETCONNECT_PROJECT_ID in your env or re-run `vaultpilot-mcp-setup`. " +
        "Create a free project at https://cloud.walletconnect.com."
    );
  }
  return id;
}

export async function getSignClient(): Promise<InstanceType<typeof SignClient>> {
  if (client) return client;
  // Persist WC symkey/pairing/session state under ~/.vaultpilot-mcp so it survives process exit.
  // Without this, the SignClient defaults to an unstorage path in cwd — which Claude Code
  // kills on exit, leaving the saved session topic useless (no keys to decrypt the relay).
  const storageDbPath = join(getConfigDir(), "walletconnect.db");
  // Defensive re-tighten before SignClient touches the tree (catches the
  // post-restart state where older releases created the dir world-readable).
  tightenWcStoragePerms(getConfigDir());
  client = await SignClient.init({
    projectId: getProjectId(),
    metadata: {
      name: "VaultPilot MCP",
      description: "MCP server that prepares DeFi transactions for Ledger Live signing.",
      url: "https://github.com/szhygulin/vaultpilot-mcp",
      icons: [],
    },
    storageOptions: { database: storageDbPath },
  });
  // Re-tighten after SignClient.init — it may have created new files under
  // the process umask (default 022). Idempotent; cheap.
  tightenWcStoragePerms(getConfigDir());

  // Attempt to restore the most recent session. Prefer the explicit topic from user config,
  // but fall back to the most recent active session if the topic is missing or stale (can
  // happen if the user manually edited config or the session expired and was renewed).
  const cfg = readUserConfig();
  const topic = cfg?.walletConnect?.sessionTopic;
  const all = client.session.getAll();
  if (topic) {
    const match = all.find((s) => s.topic === topic);
    if (match) currentSession = match;
  }
  if (!currentSession && all.length > 0) {
    currentSession = all[all.length - 1];
    patchUserConfig({
      walletConnect: {
        sessionTopic: currentSession.topic,
        pairingTopic: currentSession.pairingTopic,
      },
    });
  }

  // Wire SDK lifecycle events. These are the ONLY paths that clear the
  // local session record (issue #241): probe outcomes are liveness UX,
  // not lifecycle authority. `session_delete` fires when the peer or relay
  // explicitly ends the session; `session_expire` fires when the WC v2 TTL
  // is hit. Anything else — including a failed probe — leaves the persisted
  // session intact so closing/reopening the WalletConnect subapp inside
  // Ledger Live resumes without a re-pair.
  client.on("session_delete", ({ topic }) => {
    if (currentSession?.topic !== topic) return;
    handleSessionEndedByPeer();
  });
  client.on("session_expire", ({ topic }) => {
    if (currentSession?.topic !== topic) return;
    handleSessionEndedByPeer();
  });

  // Verify the restored session is currently reachable. Two outcomes,
  // BOTH non-destructive (issue #241):
  //   - alive: peer ack'd, clear the unreachable flag.
  //   - dead/unknown: peer not responding right now (LL-WC subapp closed,
  //     device asleep, network blip). Flag `peerUnreachable` so callers
  //     surface the unreachable hint, but KEEP the session so reopening
  //     LL-WC resumes via the next successful keepalive without a re-pair.
  if (currentSession) {
    const liveness = await verifySessionAlive(client, currentSession.topic);
    peerUnreachable = liveness !== "alive";
    startKeepalive(client, currentSession.topic);
  }

  return client;
}

/**
 * Drop the local session record + persisted topic. ONLY call this from an
 * authoritative end signal — `session_delete` / `session_expire` events
 * from the SDK, or the explicit user-driven `disconnect()`. Probe failure
 * does NOT qualify (issue #241): we want LL-WC close/reopen to resume.
 */
function handleSessionEndedByPeer(): void {
  stopKeepalive();
  currentSession = null;
  peerUnreachable = false;
  patchUserConfig({
    walletConnect: { sessionTopic: undefined, pairingTopic: undefined },
  });
}

function startKeepalive(c: InstanceType<typeof SignClient>, topic: string): void {
  stopKeepalive();
  keepaliveTimer = setInterval(() => {
    void (async () => {
      // Use the same probe as the pre-send check so classification stays
      // consistent. Failure leaves the session record intact and just
      // updates the reachability flag — LL-WC close/reopen flips this
      // false→true→false without any re-pair.
      const liveness = await probeSessionLiveness(c, topic);
      peerUnreachable = liveness !== "alive";
    })();
  }, KEEPALIVE_INTERVAL_MS);
  // Don't keep the Node event loop alive solely on the keepalive — if the
  // MCP process has nothing else to do, it should exit cleanly. The MCP
  // server's stdio loop normally holds the process open; this is just
  // belt-and-suspenders for tests and one-shot invocations.
  if (typeof keepaliveTimer.unref === "function") keepaliveTimer.unref();
}

function stopKeepalive(): void {
  if (keepaliveTimer !== null) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

/** Test-only hook: stop the keepalive timer between tests. */
export function _stopKeepaliveForTests(): void {
  stopKeepalive();
}

/**
 * Error thrown from `requestSendTransaction` when the WC session can't be
 * confirmed live before publishing the signing request. Issue #75: the old
 * code called `c.request(...)` unconditionally, which hangs forever if the
 * peer is gone (Ledger Live quit, session disconnected, device asleep long
 * enough for the relay to drop the subscription). Now we probe first and
 * fail fast with this structured error so the agent can ask the user to
 * re-pair instead of blocking the chat indefinitely.
 */
export class WalletConnectSessionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletConnectSessionUnavailableError";
  }
}

/**
 * Error thrown when the WC request itself exceeds the hard wall-clock
 * timeout. Complements the pre-publish probe: even if the session is alive
 * at probe time, the peer can go away between probe and `c.request`
 * resolving, or Ledger Live can accept the request but sit on it without
 * presenting it to the user. The hard timeout caps the worst case so a
 * send_transaction eventually returns control to the agent.
 */
export class WalletConnectRequestTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletConnectRequestTimeoutError";
  }
}

/**
 * Ping the peer over the relay with a short timeout. WC's ping resolves when
 * the peer acknowledges; it rejects promptly if the peer has no matching
 * session (explicit "dead"); and it hangs if the peer is offline (we surface
 * that as "unknown" via the timeout branch, so callers can distinguish it
 * from a confirmed rejection).
 */
async function verifySessionAlive(
  c: InstanceType<typeof SignClient>,
  topic: string
): Promise<"alive" | "dead" | "unknown"> {
  return probeSessionLiveness(c, topic);
}

/**
 * Session-liveness ping timeout. 5s matches what `getSignClient` uses at
 * restore time, so both paths classify a slow peer the same way. Module-
 * level so it lives with `WC_SEND_REQUEST_TIMEOUT_MS` (the other timeout
 * knob in this file) and can be tuned without digging into a function body.
 */
const PING_TIMEOUT_MS = 5_000;

/**
 * Exported variant of the probe for use by `requestSendTransaction` and
 * test code. Same contract as the internal `verifySessionAlive`.
 */
export async function probeSessionLiveness(
  c: InstanceType<typeof SignClient>,
  topic: string
): Promise<"alive" | "dead" | "unknown"> {
  let timedOut = false;
  try {
    await Promise.race([
      c.ping({ topic }),
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          timedOut = true;
          reject(new Error("ping timeout"));
        }, PING_TIMEOUT_MS)
      ),
    ]);
    return "alive";
  } catch {
    return timedOut ? "unknown" : "dead";
  }
}

export interface PairResult {
  uri: string;
  approval: Promise<SessionTypes.Struct>;
}

/** Create a new pairing + session proposal. The returned URI is what the user scans in Ledger Live. */
export async function initiatePairing(): Promise<PairResult> {
  const c = await getSignClient();
  const { uri, approval } = await c.connect({ requiredNamespaces: REQUIRED_NAMESPACES });
  if (!uri) throw new Error("WalletConnect did not return a pairing URI.");
  return {
    uri,
    approval: (async () => {
      const session = await approval();
      currentSession = session;
      peerUnreachable = false;
      patchUserConfig({
        walletConnect: {
          sessionTopic: session.topic,
          pairingTopic: session.pairingTopic,
        },
      });
      startKeepalive(c, session.topic);
      return session;
    })(),
  };
}

export function getCurrentSession(): SessionTypes.Struct | null {
  return currentSession;
}

/**
 * Return the deduplicated list of EVM addresses exposed by the connected
 * wallet across all chain namespaces. WalletConnect advertises accounts as
 * `eip155:<chainId>:<address>` — the same address typically appears once per
 * chain the wallet has exposed, so a flat list of raw entries looks like
 * duplicates from the agent's perspective. Callers that care which chains an
 * address is exposed on should use `getConnectedAccountsDetailed`.
 */
export async function getConnectedAccounts(): Promise<`0x${string}`[]> {
  const detailed = await getConnectedAccountsDetailed();
  return detailed.map((a) => a.address);
}

/**
 * Return per-address chain exposure. Addresses are deduplicated; `chainIds`
 * lists every eip155 chainId the address was advertised for, and `chains`
 * maps those to the server's SupportedChain names where recognized.
 */
export async function getConnectedAccountsDetailed(): Promise<
  { address: `0x${string}`; chainIds: number[]; chains: SupportedChain[] }[]
> {
  if (!currentSession) await getSignClient(); // ensure restoration attempted
  if (!currentSession) return [];
  const ns = currentSession.namespaces.eip155;
  if (!ns) return [];

  // Preserve the first-seen order of addresses so the list is deterministic
  // across calls — a Map iterates in insertion order.
  const byAddress = new Map<`0x${string}`, Set<number>>();
  for (const entry of ns.accounts) {
    const parts = entry.split(":");
    if (parts.length !== 3) continue;
    const chainId = Number(parts[1]);
    const addr = parts[2];
    if (!Number.isFinite(chainId) || !EVM_ADDRESS.test(addr)) continue;
    const address = addr as `0x${string}`;
    const existing = byAddress.get(address);
    if (existing) existing.add(chainId);
    else byAddress.set(address, new Set([chainId]));
  }

  return Array.from(byAddress.entries()).map(([address, chainIdSet]) => {
    const chainIds = Array.from(chainIdSet).sort((a, b) => a - b);
    const chains = chainIds
      .map((id) => CHAIN_ID_TO_NAME[id])
      .filter((c): c is SupportedChain => c !== undefined);
    return { address, chainIds, chains };
  });
}

/**
 * Nonce + EIP-1559 fee fields pinned server-side at send time. Including all
 * four in the WalletConnect `eth_sendTransaction` params is what makes the
 * pre-sign RLP hash on Ledger's blind-sign screen predictable — Ledger Live
 * is supposed to honor dApp-supplied values (WalletConnect spec), but if the
 * user taps "Edit gas / fees" in Ledger Live, the hash will diverge and the
 * user should reject on-device. See `eip1559PreSignHash` in
 * src/signing/verification.ts.
 */
export interface PinnedGasFields {
  nonce: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gas: bigint;
}

/**
 * Hard wall-clock cap on a WC `eth_sendTransaction` request. 120s is long
 * enough that a user signing on-device (review the tx on the Ledger screen,
 * press both buttons) has comfortable margin, but short enough that a dead
 * peer doesn't stall the chat indefinitely. Complements the pre-publish
 * liveness probe: the probe catches obviously-dead sessions in 5s, this
 * catches the "peer accepted but never responded" tail.
 */
const WC_SEND_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Compose the peer-unreachable error message used by `requestSendTransaction`
 * when the pre-send liveness probe fails. Issue #241: the prior wording
 * said "the local session record has been cleared, run `pair_ledger_live`"
 * because the dead-branch USED to destroy the persisted session on probe
 * failure. That broke the resumption invariant — closing the WalletConnect
 * subapp inside Ledger Live and reopening it should resume the same session
 * without a re-pair. The persisted session is now retained on probe
 * failure; only the SDK's `session_delete` / `session_expire` events
 * authoritatively clear it. So lead with "open WalletConnect in Ledger
 * Live and retry the same handle"; only suggest `pair_ledger_live` as a
 * last resort when reopening doesn't help.
 *
 * Name kept (not renamed to `peerUnreachableMessage`) to avoid churning
 * downstream importers; the wording is the contract.
 *
 * Exported for test-side inspection so we don't have to source-scrape.
 */
export function deadSessionMessage(): string {
  return (
    "WalletConnect peer is not currently reachable (the relay-side ping did " +
    "not get a response from Ledger Live). The local session record has " +
    "been RETAINED — closing the WalletConnect subapp inside Ledger Live is " +
    "transient, and reopening it resumes the same session. " +
    "Open WalletConnect in Ledger Live (Discover → WalletConnect, or " +
    "Settings → Connected Apps → WalletConnect depending on Ledger Live " +
    "version) and re-call `send_transaction` on the SAME handle within its " +
    "15-minute TTL — no re-pair needed. " +
    "If reopening doesn't restore reachability after a few seconds, the " +
    "session may have been ended on Ledger Live's side; only then run " +
    "`pair_ledger_live` to start a fresh one. Issue #241."
  );
}

/**
 * Compose the timeout error message. Issue #218: the prior wording said
 * "the handle is still valid for retry" without qualification, which
 * invited blind retries that risk a double-broadcast (Ledger Live may
 * still complete signing + broadcast asynchronously after our 120s
 * timer fires — our timer aborts only THIS server's wait, not the
 * device-side request). Surface the pinned (from, nonce, chainId) so the
 * agent can suggest concrete on-chain checks before retrying.
 *
 * Exported for test-side inspection so we don't have to source-scrape.
 */
export function timeoutMessage(args: {
  timeoutSeconds: number;
  from: `0x${string}` | string;
  nonce: number | "<unpinned — check pending nonce on chain>";
  chainId: number | string;
}): string {
  return (
    `WalletConnect signing request did not complete within ${args.timeoutSeconds}s on this server's clock — ` +
    `the user may simply still be reviewing the tx on the Ledger device. ` +
    `CRITICAL: this timeout aborts only THIS server's wait; it does NOT cancel the request on Ledger Live's side. ` +
    `If the user signs after this point, Ledger Live may still broadcast the tx asynchronously without us seeing the response. ` +
    `DO NOT retry blindly — that risks a double-broadcast attempt against the chain (saved here only by the chain's duplicate-nonce protection, which is incidental, not by design). ` +
    `Before any retry, verify the original request did NOT land on chain: ` +
    `query \`get_transaction_status\` against the chain's mempool / latest block, ` +
    `or check a block explorer for txs from \`${args.from}\` with nonce \`${args.nonce}\` on chain id \`${args.chainId}\`. ` +
    `Only retry send_transaction (same handle, 15-min TTL from prepare) if RPC confirms the pinned nonce is still UNCONSUMED on the pending state. ` +
    `Issue #218.`
  );
}

/**
 * Compose the message thrown when the WC timer fires AND the pending
 * nonce on chain has advanced past the pinned nonce, but no tx in the
 * recent block window matched our pre-sign hash. Issue #232. This is
 * an "ambiguous" outcome: someone consumed the slot, but we can't
 * confirm it was our broadcast.
 *
 * Exported for test-side inspection.
 */
export function consumedUnmatchedMessage(args: {
  from: `0x${string}` | string;
  pinnedNonce: number;
  pendingNonce: number;
  chainId: number | string;
  probeWindowBlocks: number;
}): string {
  return (
    `WalletConnect signing request timed out AND the on-chain pending nonce for \`${args.from}\` ` +
    `has advanced past the pinned nonce (pending=${args.pendingNonce}, pinned=${args.pinnedNonce}) ` +
    `on chain id \`${args.chainId}\` — the slot was consumed by SOMETHING, but the last ${args.probeWindowBlocks} blocks ` +
    `do NOT contain a tx whose pre-sign hash matches what we pinned. ` +
    `Possible causes: (a) our tx mined further back than the probe window, ` +
    `(b) a different tx with the same nonce got there first (rare unless the user has another tool driving the same wallet), ` +
    `(c) RBF/cancel from another tooling path replaced our tx. ` +
    `DO NOT retry — the nonce is consumed and a retry would either fail with "nonce too low" or land a duplicate at a higher nonce. ` +
    `Direct the user to a block explorer for txs from \`${args.from}\` around the recent window to identify what landed. Issue #232.`
  );
}

/**
 * Compose the message thrown when the WC timer fires but the late-
 * broadcast probe confirmed the pending nonce is still equal to the
 * pinned nonce — i.e. NOTHING broadcast. Issue #232. Strict improvement
 * over the legacy generic timeout: the agent (and user) now know with
 * certainty that retrying the same handle is safe.
 *
 * Exported for test-side inspection.
 */
export function noBroadcastConfirmedMessage(args: {
  from: `0x${string}` | string;
  pinnedNonce: number;
  chainId: number | string;
  timeoutSeconds: number;
}): string {
  return (
    `WalletConnect signing request did not complete within ${args.timeoutSeconds}s — and an automatic ` +
    `on-chain probe confirmed that the pending nonce for \`${args.from}\` on chain id \`${args.chainId}\` ` +
    `is still \`${args.pinnedNonce}\` (pinned), so no late broadcast is in flight. ` +
    `Safe to retry: call \`send_transaction\` on the SAME handle within its 15-min TTL. ` +
    `The user is most likely still reviewing the tx on the Ledger device — closing the WalletConnect ` +
    `subapp on Ledger Live and reopening it before the retry can help if the device prompt got stale. Issue #232.`
  );
}

/**
 * How many recent blocks the late-broadcast probe walks back through to
 * find a tx matching the pinned (from, nonce). Bounded so a probe on a
 * fast-block chain (Arbitrum, Optimism, Base) doesn't fan out to dozens
 * of `eth_getBlockByNumber` calls. The 120s WC timeout fires after the
 * tx (if broadcast) has had time to mine — for Ethereum (~12s blocks)
 * 16 blocks is ~3 min of headroom; for L2s with sub-second blocks the
 * window is shorter in wall time but still covers the typical late-
 * broadcast tail. Beyond this we surface a "consumed but not located"
 * error and let the agent fall back to the existing on-chain check.
 */
const LATE_BROADCAST_PROBE_BLOCKS = 16;

/**
 * Outcome of `probeForLateBroadcast`. Three branches:
 *   - `matched` → found an on-chain tx whose pre-sign hash equals the
 *     server's pinned hash; the WC timeout was a false alarm and we can
 *     return the tx hash to the caller.
 *   - `no_broadcast` → the pending nonce on chain is still ≤ the pinned
 *     nonce; the tx never left Ledger Live's side. Safe to retry.
 *   - `consumed_unmatched` → the pinned nonce was consumed but no tx in
 *     the recent block window had a matching pre-sign hash. Could be a
 *     different tx (RBF replacement, parallel tooling) using the same
 *     slot, or our tx mined further back than the probe window. Don't
 *     retry; surface the pending nonce so the agent can guide the user
 *     to a block explorer.
 */
export type LateBroadcastProbeResult =
  | { status: "matched"; txHash: `0x${string}` }
  | { status: "no_broadcast"; pendingNonce: number }
  | { status: "consumed_unmatched"; pendingNonce: number };

/**
 * After a WC `eth_sendTransaction` times out, find out whether the tx
 * actually broadcast (Ledger Live finished signing + relayed
 * asynchronously after our 120s timer fired) before throwing. Issue
 * #232.
 *
 * Strategy:
 *   1. Read the pending nonce on chain. If it equals the pinned nonce,
 *      nothing happened — return `no_broadcast`.
 *   2. Otherwise (pending > pinned), the slot was consumed. Walk the
 *      most-recent `LATE_BROADCAST_PROBE_BLOCKS` blocks, pull every tx
 *      with `from === pinnedFrom && nonce === pinnedNonce`, and
 *      recompute its EIP-1559 pre-sign hash. If it equals
 *      `expectedPreSignHash`, that IS our tx; return `matched`.
 *   3. If walked the full window without a hash match, return
 *      `consumed_unmatched`.
 *
 * Errors during the probe (RPC failure, viem decoding failure) bubble
 * up to the caller, which falls back to the existing timeout error
 * rather than blocking. This is read-only — no chain mutations.
 */
export async function probeForLateBroadcast(args: {
  client: Pick<
    PublicClient,
    "getTransactionCount" | "getBlockNumber" | "getBlock"
  >;
  from: `0x${string}`;
  pinnedNonce: number;
  expectedPreSignHash: `0x${string}`;
  chainId: number;
  /** Override the default block window (for tests). */
  blockWindow?: number;
}): Promise<LateBroadcastProbeResult> {
  const pendingNonce = await args.client.getTransactionCount({
    address: args.from,
    blockTag: "pending",
  });
  if (pendingNonce <= args.pinnedNonce) {
    return { status: "no_broadcast", pendingNonce };
  }
  const head = await args.client.getBlockNumber();
  const window = args.blockWindow ?? LATE_BROADCAST_PROBE_BLOCKS;
  const fromLower = args.from.toLowerCase();
  for (let n = 0; n < window; n++) {
    if (head < BigInt(n)) break;
    const blockNumber = head - BigInt(n);
    let block;
    try {
      block = await args.client.getBlock({
        blockNumber,
        includeTransactions: true,
      });
    } catch {
      continue;
    }
    for (const tx of block.transactions) {
      // includeTransactions:true → full objects; the `string` branch is
      // never taken at runtime but viem's union type forces a guard.
      if (typeof tx === "string") continue;
      if (!tx.from || tx.from.toLowerCase() !== fromLower) continue;
      if (tx.nonce !== args.pinnedNonce) continue;
      // Pre-sign hash recomputation requires EIP-1559 fields. The pin
      // path always emits eip1559 txs; legacy/2930 wouldn't match by
      // construction. viem types these as a discriminated union via
      // `tx.type`.
      if (tx.type !== "eip1559") continue;
      if (
        tx.maxFeePerGas === undefined ||
        tx.maxFeePerGas === null ||
        tx.maxPriorityFeePerGas === undefined ||
        tx.maxPriorityFeePerGas === null ||
        tx.to === null
      ) {
        continue;
      }
      let computed: `0x${string}`;
      try {
        computed = eip1559PreSignHash({
          chainId: args.chainId,
          nonce: tx.nonce,
          maxFeePerGas: tx.maxFeePerGas,
          maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
          gas: tx.gas,
          to: tx.to as `0x${string}`,
          value: tx.value,
          data: tx.input,
        });
      } catch {
        continue;
      }
      if (computed.toLowerCase() === args.expectedPreSignHash.toLowerCase()) {
        return { status: "matched", txHash: tx.hash };
      }
    }
  }
  return { status: "consumed_unmatched", pendingNonce };
}

/** Send an `eth_sendTransaction` request. Ledger Live shows it, user signs on device, we get tx hash back. */
export async function requestSendTransaction(
  tx: UnsignedTx,
  pinned?: PinnedGasFields,
  /**
   * EIP-1559 pre-sign hash the server pinned at preview time. When set,
   * a WC timeout triggers a late-broadcast probe (issue #232): if the
   * pinned tx mined while we were waiting, return its on-chain hash
   * instead of throwing. Required to be present on the production send
   * path; only test/legacy callers omit it.
   */
  expectedPreSignHash?: `0x${string}`,
): Promise<`0x${string}`> {
  const c = await getSignClient();
  if (!currentSession) {
    throw new WalletConnectSessionUnavailableError(
      "No active WalletConnect session. Pair Ledger Live first via `pair_ledger_live` or `vaultpilot-mcp-setup`.",
    );
  }

  // Issue #75: probe session liveness BEFORE publishing. If the peer is
  // not currently reachable (Ledger Live's WalletConnect subapp closed,
  // device asleep, network blip), `c.request(...)` below would hang
  // indefinitely and the agent would have no signal to surface. A 5s
  // ping-probe catches the unreachable case in bounded time and raises an
  // actionable structured error instead.
  //
  // Issue #241: BOTH `dead` and `unknown` outcomes are now treated as
  // "peer not currently reachable" and are NON-DESTRUCTIVE — the local
  // session is retained so reopening the WalletConnect subapp inside
  // Ledger Live resumes the same session without a re-pair. Persisted
  // session state is only cleared via `session_delete` / `session_expire`
  // events from the SDK (wired in `getSignClient`).
  const liveness = await probeSessionLiveness(c, currentSession.topic);
  if (liveness !== "alive") {
    peerUnreachable = true;
    throw new WalletConnectSessionUnavailableError(deadSessionMessage());
  }
  // Successful pre-send probe is a fresh reachability signal — clear the
  // stale flag so `getSessionStatus()` stops emitting peer-unreachable
  // guidance until the next failed probe.
  peerUnreachable = false;

  const chainId = CHAIN_IDS[tx.chain];
  const from = tx.from ?? (await getConnectedAccounts())[0];
  if (!from) throw new Error("Cannot determine sender address from WalletConnect session.");

  // When `pinned` is present, forward all four fields so Ledger's pre-sign RLP
  // hash is deterministic. Fall back to the historical behavior (forward only
  // the optional gas hint) for callers that haven't been updated — today that's
  // only test code; the production `sendTransaction` path always pins.
  const txParams: Record<string, string> = {
    from,
    to: tx.to,
    data: tx.data,
    value: tx.value === "0" ? "0x0" : `0x${BigInt(tx.value).toString(16)}`,
  };
  if (pinned) {
    txParams.nonce = `0x${pinned.nonce.toString(16)}`;
    txParams.maxFeePerGas = `0x${pinned.maxFeePerGas.toString(16)}`;
    txParams.maxPriorityFeePerGas = `0x${pinned.maxPriorityFeePerGas.toString(16)}`;
    txParams.gas = `0x${pinned.gas.toString(16)}`;
  } else if (tx.gasEstimate) {
    txParams.gas = `0x${BigInt(tx.gasEstimate).toString(16)}`;
  }

  const request = {
    topic: currentSession.topic,
    chainId: `eip155:${chainId}`,
    request: {
      method: "eth_sendTransaction",
      params: [txParams],
    },
  };

  // Hard wall-clock cap so even if the peer accepts the request but never
  // responds (common failure mode when Ledger Live is backgrounded mid-sign),
  // the tool eventually surfaces control back to the agent. Issue #75.
  //
  // CRITICAL framing — Issue #218: the timeout aborts THIS server's wait,
  // it does NOT cancel the request on Ledger Live's side. If the user is
  // mid-review on the Ledger when the timer fires, signing may still
  // complete and Ledger Live may still broadcast asynchronously after the
  // error returns. The error message must NOT advise a blind retry — that
  // risks a double-broadcast. Surface the pinned (from, nonce, chainId)
  // so the agent can suggest checking on-chain state before re-sending.
  let timedOut = false;
  const hash = await Promise.race([
    c.request(request) as Promise<`0x${string}`>,
    new Promise<never>((_, reject) =>
      setTimeout(() => {
        timedOut = true;
        reject(
          new WalletConnectRequestTimeoutError(
            timeoutMessage({
              timeoutSeconds: WC_SEND_REQUEST_TIMEOUT_MS / 1000,
              from,
              nonce: pinned ? pinned.nonce : "<unpinned — check pending nonce on chain>",
              chainId,
            }),
          ),
        );
      }, WC_SEND_REQUEST_TIMEOUT_MS),
    ),
  ]).catch(async (e: unknown) => {
    if (!timedOut) {
      // Any other `c.request` rejection surfaces as-is.
      throw e;
    }
    // Issue #232: WC timeout doesn't necessarily mean nothing happened —
    // Ledger Live can finish signing + broadcast asynchronously after
    // our 120s timer aborts. Probe the chain before surfacing a scary
    // error to the user. Only run when we have everything the probe
    // needs (pinned nonce + expected pre-sign hash); otherwise fall
    // through to the existing timeout error.
    if (!pinned || !expectedPreSignHash) {
      throw e;
    }
    let probe: LateBroadcastProbeResult;
    try {
      probe = await probeForLateBroadcast({
        client: getClient(tx.chain),
        from: from as `0x${string}`,
        pinnedNonce: pinned.nonce,
        expectedPreSignHash,
        chainId,
      });
    } catch {
      // Probe-internal failure (RPC down, decoder threw) → fall back
      // to the existing timeout error. Better the conservative "DO NOT
      // retry blindly" guidance than a silent partial result.
      throw e;
    }
    if (probe.status === "matched") {
      // The tx landed while we were waiting — return the on-chain
      // hash and treat the timeout as a false alarm. The caller's
      // happy-path post-broadcast block fires unchanged.
      return probe.txHash;
    }
    if (probe.status === "consumed_unmatched") {
      throw new WalletConnectRequestTimeoutError(
        consumedUnmatchedMessage({
          from,
          pinnedNonce: pinned.nonce,
          pendingNonce: probe.pendingNonce,
          chainId,
          probeWindowBlocks: LATE_BROADCAST_PROBE_BLOCKS,
        }),
      );
    }
    // probe.status === "no_broadcast" → safe to retry, surface the
    // confirmed-no-broadcast variant so the agent doesn't fall back to
    // the conservative original message.
    throw new WalletConnectRequestTimeoutError(
      noBroadcastConfirmedMessage({
        from,
        pinnedNonce: pinned.nonce,
        chainId,
        timeoutSeconds: WC_SEND_REQUEST_TIMEOUT_MS / 1000,
      }),
    );
  });
  return hash;
}

export async function disconnect(): Promise<void> {
  const c = await getSignClient();
  if (!currentSession) return;
  await c.disconnect({
    topic: currentSession.topic,
    reason: getSdkError("USER_DISCONNECTED"),
  });
  stopKeepalive();
  currentSession = null;
  peerUnreachable = false;
  patchUserConfig({ walletConnect: { sessionTopic: undefined, pairingTopic: undefined } });
}
