import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { UserConfig } from "../types/index.js";

const CONFIG_DIR = join(homedir(), ".recon-mcp");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

/** Read the user config file; returns null if it doesn't exist. Throws on malformed JSON. */
export function readUserConfig(): UserConfig | null {
  if (!existsSync(CONFIG_PATH)) return null;
  const raw = readFileSync(CONFIG_PATH, "utf8");
  try {
    return JSON.parse(raw) as UserConfig;
  } catch (err) {
    throw new Error(
      `~/.recon-mcp/config.json is malformed: ${(err as Error).message}. Delete it or re-run \`recon-mcp-setup\`.`
    );
  }
}

export function writeUserConfig(config: UserConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
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
