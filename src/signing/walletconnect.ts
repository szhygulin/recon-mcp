import SignClient from "@walletconnect/sign-client";
import type { SessionTypes } from "@walletconnect/types";
import { getSdkError } from "@walletconnect/utils";
import { CHAIN_IDS, type SupportedChain, type UnsignedTx } from "../types/index.js";
import {
  readUserConfig,
  patchUserConfig,
  resolveWalletConnectProjectId,
} from "../config/user-config.js";

/**
 * Default WalletConnect Cloud project ID. Users should provide their own via
 * WALLETCONNECT_PROJECT_ID or `recon-mcp-setup` — the default is a placeholder
 * that will 401 against production relay. We keep a constant here so the code
 * compiles; `getProjectId()` will throw if a real ID is not set.
 */
const DEFAULT_PROJECT_ID = "";

/** EVM namespace requested when proposing a session. Includes both chains we support. */
const REQUIRED_NAMESPACES = {
  eip155: {
    methods: [
      "eth_sendTransaction",
      "eth_signTransaction",
      "personal_sign",
      "eth_signTypedData_v4",
      "eth_chainId",
    ],
    chains: Object.values(CHAIN_IDS).map((id) => `eip155:${id}`),
    events: ["accountsChanged", "chainChanged"],
  },
};

let client: InstanceType<typeof SignClient> | null = null;
let currentSession: SessionTypes.Struct | null = null;

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
  client = await SignClient.init({
    projectId: getProjectId(),
    metadata: {
      name: "Recon MCP",
      description: "MCP server that prepares DeFi transactions for Ledger Live signing.",
      url: "https://github.com/",
      icons: [],
    },
  });

  // Attempt to restore the most recent session.
  const cfg = readUserConfig();
  const topic = cfg?.walletConnect?.sessionTopic;
  if (topic) {
    const all = client.session.getAll();
    const match = all.find((s) => s.topic === topic);
    if (match) currentSession = match;
  }

  return client;
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
