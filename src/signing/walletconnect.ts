import { SignClient } from "@walletconnect/sign-client";
import type { SessionTypes } from "@walletconnect/types";
import { getSdkError } from "@walletconnect/utils";
import { join } from "node:path";
import { CHAIN_IDS, type SupportedChain, type UnsignedTx } from "../types/index.js";
import {
  readUserConfig,
  patchUserConfig,
  resolveWalletConnectProjectId,
  getConfigDir,
} from "../config/user-config.js";

/**
 * Default WalletConnect Cloud project ID. Users should provide their own via
 * WALLETCONNECT_PROJECT_ID or `recon-mcp-setup` — the default is a placeholder
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
      "No WalletConnect project ID configured. Set WALLETCONNECT_PROJECT_ID in your env or re-run `recon-mcp-setup`. " +
        "Create a free project at https://cloud.walletconnect.com."
    );
  }
  return id;
}

export async function getSignClient(): Promise<InstanceType<typeof SignClient>> {
  if (client) return client;
  // Persist WC symkey/pairing/session state under ~/.recon-mcp so it survives process exit.
  // Without this, the SignClient defaults to an unstorage path in cwd — which Claude Code
  // kills on exit, leaving the saved session topic useless (no keys to decrypt the relay).
  const storageDbPath = join(getConfigDir(), "walletconnect.db");
  client = await SignClient.init({
    projectId: getProjectId(),
    metadata: {
      name: "Recon MCP",
      description: "MCP server that prepares DeFi transactions for Ledger Live signing.",
      url: "https://github.com/",
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

/** Return the list of EVM accounts exposed by the connected wallet (across all namespaces). */
export async function getConnectedAccounts(): Promise<`0x${string}`[]> {
  if (!currentSession) await getSignClient(); // ensure restoration attempted
  if (!currentSession) return [];
  const accounts: `0x${string}`[] = [];
  const ns = currentSession.namespaces.eip155;
  if (!ns) return [];
  for (const entry of ns.accounts) {
    // format: "eip155:1:0xabc..."
    const parts = entry.split(":");
    if (parts.length === 3 && /^0x[a-fA-F0-9]{40}$/.test(parts[2])) {
      accounts.push(parts[2] as `0x${string}`);
    }
  }
  return accounts;
}

/** Send an `eth_sendTransaction` request. Ledger Live shows it, user signs on device, we get tx hash back. */
export async function requestSendTransaction(tx: UnsignedTx): Promise<`0x${string}`> {
  const c = await getSignClient();
  if (!currentSession) {
    throw new Error(
      "No active WalletConnect session. Pair Ledger Live first via `pair_ledger_live` or `recon-mcp-setup`."
    );
  }
  const chainId = CHAIN_IDS[tx.chain];
  const from = tx.from ?? (await getConnectedAccounts())[0];
  if (!from) throw new Error("Cannot determine sender address from WalletConnect session.");

  const request = {
    topic: currentSession.topic,
    chainId: `eip155:${chainId}`,
    request: {
      method: "eth_sendTransaction",
      params: [
        {
          from,
          to: tx.to,
          data: tx.data,
          value: tx.value === "0" ? "0x0" : `0x${BigInt(tx.value).toString(16)}`,
          ...(tx.gasEstimate ? { gas: `0x${BigInt(tx.gasEstimate).toString(16)}` } : {}),
        },
      ],
    },
  };

  const hash = (await c.request(request)) as `0x${string}`;
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
