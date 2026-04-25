/**
 * Shared `getNonceAccountValue` mock helpers. The `vi.mock(...)` body has to
 * stay inline in each consumer (vitest hoists it above imports); only the
 * helpers below are shared.
 *
 * Usage:
 *
 *   import { setNoncePresent, setNonceMissing } from "./fixtures/solana-nonce-mock.js";
 *
 *   vi.mock("../src/modules/solana/nonce.js", async (importOriginal) => {
 *     const actual = await importOriginal<typeof import("../src/modules/solana/nonce.js")>();
 *     return { ...actual, getNonceAccountValue: vi.fn() };
 *   });
 *
 *   beforeEach(async () => { await setNoncePresent(WALLET_PUBKEY); });
 */
import { vi } from "vitest";
import type { PublicKey } from "@solana/web3.js";

export const DEFAULT_TEST_NONCE_VALUE =
  "GfnhkAa2iy8cZV7X5SyyYmCHxFQjEbBuyyUSCBokixB9";

export async function setNoncePresent(
  authority: PublicKey,
  nonceValue: string = DEFAULT_TEST_NONCE_VALUE,
): Promise<void> {
  const { getNonceAccountValue } = await import(
    "../../src/modules/solana/nonce.js"
  );
  (getNonceAccountValue as ReturnType<typeof vi.fn>).mockResolvedValue({
    nonce: nonceValue,
    authority,
  });
}

export async function setNonceMissing(): Promise<void> {
  const { getNonceAccountValue } = await import(
    "../../src/modules/solana/nonce.js"
  );
  (getNonceAccountValue as ReturnType<typeof vi.fn>).mockResolvedValue(null);
}

export async function resetNonceMock(): Promise<void> {
  const { getNonceAccountValue } = await import(
    "../../src/modules/solana/nonce.js"
  );
  (getNonceAccountValue as ReturnType<typeof vi.fn>).mockReset();
}
