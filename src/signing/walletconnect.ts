import { SignClient } from "@walletconnect/sign-client";
import type { SessionTypes } from "@walletconnect/types";
import { getSdkError } from "@walletconnect/utils";
import { join } from "node:path";
import { CHAIN_IDS, CHAIN_ID_TO_NAME, type SupportedChain, type UnsignedTx } from "../types/index.js";
import {
  readUserConfig,
  patchUserConfig,
  resolveWalletConnectProjectId,
  getConfigDir,
} from "../config/user-config.js";

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
 * Set when the last liveness check timed out (peer didn't respond within the
 * window) rather than returning an explicit "session not found". We keep the
 * local session record in that case — the peer may just be offline — but
 * surface the ambiguity via `getSessionStatus()` so callers don't treat the
 * session as confirmed-alive.
 */
let peerUnreachable = false;

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

  // Verify the restored session is still live on the relay. Three outcomes:
  //   - alive: peer ack'd, keep using it.
  //   - dead:  peer rejected (session was ended on their side), drop it locally.
  //   - unknown: ping timed out — peer is offline or the relay is slow. Keep
  //              the record so a future launch (when peer is back online) can
  //              resume without re-pairing, but flag `peerUnreachable` so
  //              callers don't assume the session is usable.
  if (currentSession) {
    const liveness = await verifySessionAlive(client, currentSession.topic);
    if (liveness === "dead") {
      try {
        await client.session.delete(currentSession.topic, getSdkError("USER_DISCONNECTED"));
      } catch {
        // Session record may already be gone; ignore.
      }
      currentSession = null;
      peerUnreachable = false;
      patchUserConfig({
        walletConnect: { sessionTopic: undefined, pairingTopic: undefined },
      });
    } else {
      peerUnreachable = liveness === "unknown";
    }
  }

  return client;
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
 * Exported variant of the probe for use by `requestSendTransaction` and
 * test code. Same contract as the internal `verifySessionAlive`. 5s timeout
 * matches what `getSignClient` uses at restore time, so both paths classify
 * a slow peer the same way.
 */
export async function probeSessionLiveness(
  c: InstanceType<typeof SignClient>,
  topic: string
): Promise<"alive" | "dead" | "unknown"> {
  const PING_TIMEOUT_MS = 5_000;
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
      patchUserConfig({
        walletConnect: {
          sessionTopic: session.topic,
          pairingTopic: session.pairingTopic,
        },
      });
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
    if (!Number.isFinite(chainId) || !/^0x[a-fA-F0-9]{40}$/.test(addr)) continue;
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

/** Send an `eth_sendTransaction` request. Ledger Live shows it, user signs on device, we get tx hash back. */
export async function requestSendTransaction(
  tx: UnsignedTx,
  pinned?: PinnedGasFields,
): Promise<`0x${string}`> {
  const c = await getSignClient();
  if (!currentSession) {
    throw new WalletConnectSessionUnavailableError(
      "No active WalletConnect session. Pair Ledger Live first via `pair_ledger_live` or `vaultpilot-mcp-setup`.",
    );
  }

  // Issue #75: probe session liveness BEFORE publishing. If the peer is
  // gone (Ledger Live closed, session disconnected, device asleep long
  // enough to drop the relay subscription), `c.request(...)` below would
  // hang indefinitely and the agent would have no signal to surface. A
  // 5s ping-probe catches the dead-session case in bounded time and
  // raises an actionable structured error instead.
  const liveness = await probeSessionLiveness(c, currentSession.topic);
  if (liveness === "dead") {
    throw new WalletConnectSessionUnavailableError(
      "WalletConnect session has been ended by the peer (Ledger Live disconnected it, " +
        "or the relay rejected the topic). Open Ledger Live → Settings → Connected " +
        "Apps → VaultPilot and reconnect, or run `pair_ledger_live` to start a fresh " +
        "session. The handle is still valid for the next 15 minutes, so you can retry " +
        "send_transaction with the same handle once WC is reconnected.",
    );
  }
  if (liveness === "unknown") {
    throw new WalletConnectSessionUnavailableError(
      "WalletConnect peer is not responding (Ledger Live may be closed, backgrounded, " +
        "or on a device that's asleep). Open Ledger Live and make sure the VaultPilot " +
        "WC session is active, then retry send_transaction with the same handle. If " +
        "the session was dropped entirely, run `pair_ledger_live` to re-pair.",
    );
  }

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
  let timedOut = false;
  const hash = await Promise.race([
    c.request(request) as Promise<`0x${string}`>,
    new Promise<never>((_, reject) =>
      setTimeout(() => {
        timedOut = true;
        reject(
          new WalletConnectRequestTimeoutError(
            `WalletConnect signing request did not complete within ${WC_SEND_REQUEST_TIMEOUT_MS / 1000}s. ` +
              "The peer may be unresponsive or the user may have walked away from the Ledger. " +
              "The handle is still valid for retry (15-minute TTL from prepare time).",
          ),
        );
      }, WC_SEND_REQUEST_TIMEOUT_MS),
    ),
  ]).catch((e: unknown) => {
    if (timedOut) throw e;
    // Any other `c.request` rejection surfaces as-is.
    throw e;
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
  currentSession = null;
  patchUserConfig({ walletConnect: { sessionTopic: undefined, pairingTopic: undefined } });
}
