/**
 * Atomic read/write for `~/.vaultpilot-mcp/readonly-invites.json`. Mirrors
 * the existing `atomicWriteJson` pattern used by `contacts/storage.ts` and
 * `setup/register-clients.ts` — write to `.tmp`, rename. POSIX rename is
 * atomic on the same filesystem; Windows same-volume rename is too. File
 * mode 0o600 (config dir is 0o700).
 *
 * Symlink rejection mirrors `writeContactsFile`: if the target path exists
 * and `lstat` shows a symlink, refuse. Catches the case where a malicious
 * actor swaps `readonly-invites.json` for a symlink to a privileged file.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "../../config/user-config.js";
import {
  ReadonlyInvitesFile,
  emptyInvitesFile,
  type ReadonlyInvitesFile as ReadonlyInvitesFileT,
} from "./schemas.js";

export function invitesPath(): string {
  return join(getConfigDir(), "readonly-invites.json");
}

/**
 * Read the invites file. Returns the empty shape on first-run (file
 * missing) and on parse / schema failure — corruption is treated as
 * "start fresh" rather than "halt the server" (same policy as
 * `readContactsFile`). Lossy-read is acceptable here because the only
 * data lost is the issuer's bookkeeping of who they shared with —
 * recipients still hold their tokens, which is the only consequence
 * that matters in Model A.
 */
export function readInvitesFile(): ReadonlyInvitesFileT {
  const path = invitesPath();
  if (!existsSync(path)) return emptyInvitesFile();
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    return ReadonlyInvitesFile.parse(parsed);
  } catch {
    return emptyInvitesFile();
  }
}

export function writeInvitesFile(file: ReadonlyInvitesFileT): void {
  const path = invitesPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(
      `Refusing to write readonly-invites at ${path}: target is a symlink. ` +
        `Investigate before deleting; this could be benign user setup or a ` +
        `tamper attempt.`,
    );
  }
  ReadonlyInvitesFile.parse(file);
  const tmp = `${path}.vaultpilot.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}
