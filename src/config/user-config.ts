import { readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { UserConfig } from "../types/index.js";

const CONFIG_DIR = join(homedir(), ".recon-crypto-mcp");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

/** Read the user config file; returns null if it doesn't exist. Throws on malformed JSON. */
export function readUserConfig(): UserConfig | null {
  if (!existsSync(CONFIG_PATH)) return null;
  const raw = readFileSync(CONFIG_PATH, "utf8");
  try {
    return JSON.parse(raw) as UserConfig;
  } catch (err) {
    throw new Error(
      `~/.recon-crypto-mcp/config.json is malformed: ${(err as Error).message}. Delete it or re-run \`recon-crypto-mcp-setup\`.`
    );
  }
}

export function writeUserConfig(config: UserConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  // Refuse to follow symlinks or hardlinks when writing the config. A local
  // attacker with write access to ~/.recon-crypto-mcp (or with a race-window before
  // first-run setup creates the dir) could pre-place config.json as a symlink
  // to another file (~/.ssh/authorized_keys, ~/.bashrc, etc.) so the next
  // writeFileSync clobbers it. lstatSync on the path (not following the link)
  // catches this: if the entry exists but isn't a regular file, bail loudly.
  if (existsSync(CONFIG_PATH)) {
    const st = lstatSync(CONFIG_PATH);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink > 1) {
      throw new Error(
        `Refusing to write ${CONFIG_PATH}: path is a symlink, hardlink, or non-regular file. ` +
          `Inspect the file manually and remove it before re-running setup.`
      );
    }
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

/**
 * Hook invoked whenever `patchUserConfig` is about to change the rpc section
 * of the user config. rpc.ts registers a handler that drops cached viem
 * clients + the verified-chain-id memo so subsequent calls re-resolve URLs
 * and re-verify. Avoids a direct import of rpc.ts here (which would cycle).
 */
let rpcChangeHook: (() => void) | null = null;

export function onRpcConfigChange(hook: () => void): void {
  rpcChangeHook = hook;
}

function rpcPatchChangesRpc(base: UserConfig, patch: Partial<UserConfig>): boolean {
  if (!patch.rpc) return false;
  // Any key in patch.rpc that differs from base.rpc counts. JSON.stringify
  // is fine here — both sides are small, schema-controlled objects.
  const baseRpc = JSON.stringify(base.rpc);
  const mergedRpc = JSON.stringify({ ...base.rpc, ...patch.rpc });
  return baseRpc !== mergedRpc;
}

/** Merge a partial update into the existing config (or create a fresh one). */
export function patchUserConfig(patch: Partial<UserConfig>): UserConfig {
  const existing = readUserConfig();
  const base: UserConfig = existing ?? { rpc: { provider: "custom" } };
  const merged: UserConfig = {
    ...base,
    ...patch,
    rpc: { ...base.rpc, ...(patch.rpc ?? {}) },
    walletConnect: { ...base.walletConnect, ...(patch.walletConnect ?? {}) },
  };
  writeUserConfig(merged);
  // If rpc changed, invalidate cached clients + chain-id verification so the
  // next live call re-resolves the URL and re-runs verifyChainId against the
  // new endpoint. Without this, a config rewrite pointing at a hostile RPC
  // would still be bypassed by the in-memory verifiedChains Set.
  if (rpcChangeHook && rpcPatchChangesRpc(base, patch)) rpcChangeHook();
  return merged;
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

/** Pull the Etherscan API key from env (highest priority) or user config. */
export function resolveEtherscanApiKey(userConfig: UserConfig | null): string | undefined {
  return process.env.ETHERSCAN_API_KEY || userConfig?.etherscanApiKey;
}

/** Pull the 1inch Developer Portal API key from env or user config; undefined if none set. */
export function resolveOneInchApiKey(userConfig: UserConfig | null): string | undefined {
  return process.env.ONEINCH_API_KEY || userConfig?.oneInchApiKey;
}

/** Pull the WalletConnect project ID from env or user config; undefined if none set. */
export function resolveWalletConnectProjectId(userConfig: UserConfig | null): string | undefined {
  return process.env.WALLETCONNECT_PROJECT_ID || userConfig?.walletConnect?.projectId;
}
