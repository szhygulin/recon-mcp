import { readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync, cpSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { UserConfig } from "../types/index.js";

// Pre-rename path. We still read from here if the new dir doesn't exist, and
// copy the legacy dir on first write so existing users keep their WC pairing
// state (walletconnect.db) across the rename.
const LEGACY_CONFIG_DIR = join(homedir(), ".recon-crypto-mcp");
const LEGACY_CONFIG_PATH = join(LEGACY_CONFIG_DIR, "config.json");

/**
 * TEST-ONLY HOOK — redirect the config file to `dir`. Pass `null` to
 * restore the homedir default. Production code MUST NOT call this; it
 * only exists so test suites that mutate config (pair tests, persistence
 * tests, setup tests) don't pollute the real `~/.vaultpilot-mcp`.
 *
 * Implementation: sets `VAULTPILOT_CONFIG_DIR` (read by `getConfigDir`
 * below). Env-var indirection is deliberate — a mutable module-scoped
 * variable would not survive vitest's `vi.resetModules()` + dynamic
 * `await import()` cycles, which would silently restore the homedir
 * default and let the test write to the developer's real config (live
 * regression — happened twice during the pairing-persistence rollout).
 */
export function setConfigDirForTesting(dir: string | null): void {
  if (dir === null) delete process.env.VAULTPILOT_CONFIG_DIR;
  else process.env.VAULTPILOT_CONFIG_DIR = dir;
}

/** Read the user config file; returns null if it doesn't exist. Throws on malformed JSON. */
export function readUserConfig(): UserConfig | null {
  const configPath = getConfigPath();
  const path = existsSync(configPath)
    ? configPath
    : existsSync(LEGACY_CONFIG_PATH)
      ? LEGACY_CONFIG_PATH
      : null;
  if (!path) return null;
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw) as UserConfig;
  } catch (err) {
    throw new Error(
      `~/.vaultpilot-mcp/config.json is malformed: ${(err as Error).message}. Delete it or re-run \`vaultpilot-mcp-setup\`.`,
      { cause: err },
    );
  }
}

export function writeUserConfig(config: UserConfig): void {
  const configDir = getConfigDir();
  const configPath = getConfigPath();
  // Migrate the legacy `.recon-crypto-mcp` dir to the new `.vaultpilot-mcp`
  // location on first write after upgrade. We `cp -r` rather than rename so the
  // user can roll back if something goes sideways. The legacy dir stays put;
  // a future release can drop it.
  if (!existsSync(configDir) && existsSync(LEGACY_CONFIG_DIR)) {
    cpSync(LEGACY_CONFIG_DIR, configDir, { recursive: true, preserveTimestamps: true });
  }
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }
  // Refuse to follow symlinks or hardlinks when writing the config. A local
  // attacker with write access to ~/.vaultpilot-mcp (or with a race-window before
  // first-run setup creates the dir) could pre-place config.json as a symlink
  // to another file (~/.ssh/authorized_keys, ~/.bashrc, etc.) so the next
  // writeFileSync clobbers it. lstatSync on the path (not following the link)
  // catches this: if the entry exists but isn't a regular file, bail loudly.
  if (existsSync(configPath)) {
    const st = lstatSync(configPath);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink > 1) {
      throw new Error(
        `Refusing to write ${configPath}: path is a symlink, hardlink, or non-regular file. ` +
          `Inspect the file manually and remove it before re-running setup.`
      );
    }
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
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
    // Per-chain merge for pairings: a patch that touches `solana` only must
    // preserve `tron` (and vice versa). Without this, the Solana signer's
    // persistPairedSolana() call would wipe TRON pairings on every pair_solana.
    ...((patch.pairings || base.pairings)
      ? {
          pairings: {
            ...(base.pairings ?? {}),
            ...(patch.pairings ?? {}),
          },
        }
      : {}),
  };
  writeUserConfig(merged);
  // If rpc changed, invalidate cached clients + chain-id verification so the
  // next live call re-resolves the URL and re-runs verifyChainId against the
  // new endpoint. Without this, a config rewrite pointing at a hostile RPC
  // would still be bypassed by the in-memory verifiedChains Set.
  if (rpcChangeHook && rpcPatchChangesRpc(base, patch)) rpcChangeHook();
  return merged;
}

/**
 * Resolved on every call (rather than cached at module-load time) so the
 * `setConfigDirForTesting` env-var override is picked up even after
 * `vi.resetModules()` reloads this module fresh.
 */
export function getConfigDir(): string {
  return process.env.VAULTPILOT_CONFIG_DIR ?? join(homedir(), ".vaultpilot-mcp");
}

export function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

/** Pull the Etherscan API key from env (highest priority) or user config. */
export function resolveEtherscanApiKey(userConfig: UserConfig | null): string | undefined {
  return process.env.ETHERSCAN_API_KEY || userConfig?.etherscanApiKey;
}

/** Pull the 1inch Developer Portal API key from env or user config; undefined if none set. */
export function resolveOneInchApiKey(userConfig: UserConfig | null): string | undefined {
  return process.env.ONEINCH_API_KEY || userConfig?.oneInchApiKey;
}

/**
 * Pull the Reservoir API key (NFT data) from env or user config; undefined
 * if none set. An undefined key falls back to Reservoir's anonymous tier,
 * which the NFT handlers' multi-chain fan-out can hit the rate limit on —
 * the rate-limit error is surfaced with a "set RESERVOIR_API_KEY" hint so
 * the user has a clear remediation path.
 */
export function resolveReservoirApiKey(userConfig: UserConfig | null): string | undefined {
  return process.env.RESERVOIR_API_KEY || userConfig?.reservoirApiKey;
}

/**
 * Pull the TronGrid API key from env or user config; undefined if none set.
 * An undefined key means TRON reads are either disabled or fall back to
 * anonymous TronGrid (rate-limited — the reader flags that in its errored
 * coverage status rather than silently degrading).
 */
export function resolveTronApiKey(userConfig: UserConfig | null): string | undefined {
  return process.env.TRON_API_KEY || userConfig?.tronApiKey;
}

/** Pull the WalletConnect project ID from env or user config; undefined if none set. */
export function resolveWalletConnectProjectId(userConfig: UserConfig | null): string | undefined {
  return process.env.WALLETCONNECT_PROJECT_ID || userConfig?.walletConnect?.projectId;
}
