/**
 * Persistent per-mint Token-2022 extension snapshots.
 * Issue #252 / #242 v2 (token_extension_change signal).
 *
 * Storage: a JSON file at `~/.vaultpilot-mcp/token2022-snapshots.json`
 * keyed by base58 mint address. Each entry records the extension types
 * observed on the mint at a specific slot/wallclock. The
 * `token_extension_change` signal compares the current observation
 * against the cached snapshot and flags newly-enabled extensions.
 *
 * Atomic writes mirror `src/setup/register-clients.ts`'s
 * `atomicWriteJson` helper — tmp file + `renameSync`. On POSIX rename is
 * atomic by definition; on Windows the same-volume overwrite is atomic.
 *
 * Concurrency: this file is written by a single MCP process per host.
 * If multiple MCP instances ever shared a config dir, the last writer
 * would win on a tight race — acceptable for an advisory snapshot.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "../../config/user-config.js";

export interface MintExtensionSnapshot {
  /** Numeric ExtensionType values from @solana/spl-token. */
  extensions: number[];
  /** ISO timestamp when this snapshot was last written. */
  snappedAt: string;
}

export type MintSnapshotStore = Record<string, MintExtensionSnapshot>;

let pathOverride: string | null = null;

function getSnapshotPath(): string {
  return pathOverride ?? join(getConfigDir(), "token2022-snapshots.json");
}

/** Test-only hook: override the snapshot path so tests don't touch the
 * user's real config dir. Pass `null` to restore the default. */
export function _setSnapshotPathForTests(path: string | null): void {
  pathOverride = path;
}

export function loadSnapshots(): MintSnapshotStore {
  const path = getSnapshotPath();
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf8");
    if (raw.trim() === "") return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      // Malformed file — treat as empty rather than throwing. The next
      // write will overwrite. Logging the warning here would spam tools
      // every call; surfaced via the signal's `firstObservation` instead.
      return {};
    }
    return parsed as MintSnapshotStore;
  } catch {
    return {};
  }
}

export function saveSnapshots(store: MintSnapshotStore): void {
  const path = getSnapshotPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.vaultpilot.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

