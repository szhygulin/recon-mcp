/**
 * Process-local active-wallet state for VAULTPILOT_DEMO live mode.
 *
 * Default demo mode (`VAULTPILOT_DEMO=true` with no live wallet set) is
 * read-real-RPC + signing-refused: a prospective user can browse any
 * address they pass without committing to a Ledger, but every signing /
 * broadcast tool refuses with a structured error.
 *
 * Live mode is opted into at runtime via the `set_demo_wallet` tool. Once
 * set, the wallet stays active for the rest of the process lifetime (or
 * until cleared via `set_demo_wallet({})`). In live mode, the broadcast
 * step (`send_transaction`) is intercepted and returns a simulation
 * envelope instead of refusing — letting the user walk the full
 * prepare → simulate → preview → "broadcast" flow against a real on-chain
 * persona without a Ledger.
 *
 * State is module-local (not file-backed): a restart resets to default
 * demo mode. This is deliberate — demo state is ephemeral by design, and
 * persisting it to disk would risk leaking the "this is a demo session"
 * signal into a real-mode boot.
 */

import {
  PERSONAS,
  isPersonaId,
  type Persona,
  type PersonaId,
} from "./personas.js";

/**
 * Active live-mode wallet selection. `null` means default demo mode
 * (read-real-RPC + signing-refused, no broadcast simulation). Mutated
 * exclusively via `setLiveWallet` / `clearLiveWallet`.
 */
export interface LiveWalletState {
  /** Persona that the active wallet belongs to (`null` for custom address). */
  personaId: PersonaId | null;
  /** Resolved address bundle. For personas, copied from PERSONAS[id]. */
  addresses: {
    evm: string[];
    solana: string[];
    tron: string[];
    bitcoin: string[] | null;
  };
}

let activeWallet: LiveWalletState | null = null;

/** Returns a deep-frozen copy of the current state, or `null` if not in live mode. */
export function getLiveWallet(): LiveWalletState | null {
  if (activeWallet === null) return null;
  return {
    personaId: activeWallet.personaId,
    addresses: {
      evm: [...activeWallet.addresses.evm],
      solana: [...activeWallet.addresses.solana],
      tron: [...activeWallet.addresses.tron],
      bitcoin:
        activeWallet.addresses.bitcoin === null
          ? null
          : [...activeWallet.addresses.bitcoin],
    },
  };
}

/** True when a live wallet has been set (i.e., we're in live mode, not default). */
export function isLiveMode(): boolean {
  return activeWallet !== null;
}

/**
 * Activate a persona by ID. Throws on unknown ID rather than falling back
 * silently — the agent should know if the user typo'd a persona name.
 */
export function setLivePersona(personaId: string): Persona {
  if (!isPersonaId(personaId)) {
    throw new Error(
      `[VAULTPILOT_DEMO] Unknown persona '${personaId}'. ` +
        `Valid IDs: ${Object.keys(PERSONAS).join(", ")}.`,
    );
  }
  const persona = PERSONAS[personaId];
  activeWallet = {
    personaId,
    addresses: {
      evm: [...persona.addresses.evm],
      solana: [...persona.addresses.solana],
      tron: [...persona.addresses.tron],
      bitcoin:
        persona.addresses.bitcoin === null
          ? null
          : [...persona.addresses.bitcoin],
    },
  };
  return persona;
}

/**
 * Activate a custom address bundle (no persona). At least one chain
 * field must be non-empty, otherwise we'd be in a "live mode with no
 * addresses" state which is meaningless. Throws on empty input.
 */
export function setLiveCustomAddresses(custom: {
  evm?: string[];
  solana?: string[];
  tron?: string[];
  bitcoin?: string[];
}): void {
  const evm = custom.evm ?? [];
  const solana = custom.solana ?? [];
  const tron = custom.tron ?? [];
  const bitcoin = custom.bitcoin ?? [];
  if (
    evm.length === 0 &&
    solana.length === 0 &&
    tron.length === 0 &&
    bitcoin.length === 0
  ) {
    throw new Error(
      "[VAULTPILOT_DEMO] set_demo_wallet(custom={...}) requires at least one chain " +
        "address. Pass a persona ID instead, or include evm/solana/tron/bitcoin entries.",
    );
  }
  activeWallet = {
    personaId: null,
    addresses: {
      evm,
      solana,
      tron,
      bitcoin: bitcoin.length === 0 ? null : bitcoin,
    },
  };
}

/** Clear live-mode state, returning to default demo mode. */
export function clearLiveWallet(): void {
  activeWallet = null;
}

/** Test-only: hard reset between tests. Equivalent to `clearLiveWallet`. */
export function _resetLiveWalletForTests(): void {
  activeWallet = null;
}
