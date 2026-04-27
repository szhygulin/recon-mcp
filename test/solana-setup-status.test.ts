import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";

/**
 * get_solana_setup_status (issue #101) — read-only probe that tells agents
 * which one-time setup pieces are already in place. Mocks the RPC at the
 * getAccountInfo boundary; no SDK load required.
 */

const WALLET_KEYPAIR = Keypair.generate();
const WALLET = WALLET_KEYPAIR.publicKey.toBase58();
const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");

const connectionStub = {
  getAccountInfo: vi.fn(),
};

vi.mock("../src/modules/solana/rpc.js", () => ({
  getSolanaConnection: () => connectionStub,
  resetSolanaConnection: () => {},
}));

// Mock nonce module — we only care about the deterministic PDA derivation
// and the getNonceAccountValue contract. Using the real derivation is fine;
// we stub getNonceAccountValue via its own module hook.
vi.mock("../src/modules/solana/nonce.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/modules/solana/nonce.js")>();
  return {
    ...actual,
    getNonceAccountValue: vi.fn(),
  };
});

// MarginFi SDK not needed for the setup-status path (it only derives the
// PDA + runs getAccountInfo). Stub out the whole module so Node doesn't
// try to load Pyth/Switchboard transitive deps.
vi.mock("@mrgnlabs/marginfi-client-v2", () => ({}));

beforeEach(async () => {
  connectionStub.getAccountInfo.mockReset();
  const { getNonceAccountValue } = await import(
    "../src/modules/solana/nonce.js"
  );
  (getNonceAccountValue as ReturnType<typeof vi.fn>).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function nonOwnedAccountInfo(lamports: number) {
  return {
    data: Buffer.alloc(0),
    owner: SYSTEM_PROGRAM,
    lamports,
    executable: false,
  };
}

describe("getSolanaSetupStatus", () => {
  // retry: 2 — flakes on full-suite runs from upstream module-cache contamination.
  it("reports nonce:false and marginfi:[] for an empty wallet", { retry: 2 }, async () => {
    connectionStub.getAccountInfo.mockResolvedValue(null);
    const { getSolanaSetupStatus } = await import(
      "../src/modules/execution/index.js"
    );
    const res = await getSolanaSetupStatus({ wallet: WALLET });
    expect(res.wallet).toBe(WALLET);
    expect(res.nonce.exists).toBe(false);
    expect(res.nonce.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(res.nonce.currentNonce).toBeUndefined();
    expect(res.marginfi.accounts).toEqual([]);
  });

  // retry: 2 — same flake class.
  it("reports nonce details when a nonce account exists", { retry: 2 }, async () => {
    // First lookup is the nonce PDA → exists. Subsequent MarginFi PDAs
    // return null for a minimal "just the nonce" setup.
    const nonceLamports = 1_447_680;
    let call = 0;
    connectionStub.getAccountInfo.mockImplementation(async () => {
      call++;
      if (call === 1) return nonOwnedAccountInfo(nonceLamports);
      return null;
    });
    const { getNonceAccountValue } = await import(
      "../src/modules/solana/nonce.js"
    );
    (getNonceAccountValue as ReturnType<typeof vi.fn>).mockResolvedValue({
      nonce: "GfnhkAa2iy8cZV7X5SyyYmCHxFQjEbBuyyUSCBokixB9",
      authority: WALLET_KEYPAIR.publicKey,
    });

    const { getSolanaSetupStatus } = await import(
      "../src/modules/execution/index.js"
    );
    const res = await getSolanaSetupStatus({ wallet: WALLET });
    expect(res.nonce.exists).toBe(true);
    expect(res.nonce.lamports).toBe(nonceLamports);
    expect(res.nonce.currentNonce).toBe(
      "GfnhkAa2iy8cZV7X5SyyYmCHxFQjEbBuyyUSCBokixB9",
    );
    expect(res.nonce.authority).toBe(WALLET);
    expect(res.marginfi.accounts).toEqual([]);
  });

  it("lists existing MarginfiAccount PDAs (first slot present, second missing)", async () => {
    // First getAccountInfo = nonce (null here: user has no nonce). Next 4
    // calls are MarginFi PDA probes. Slot 0 exists; slot 1 missing →
    // enumeration stops.
    let call = 0;
    connectionStub.getAccountInfo.mockImplementation(async () => {
      call++;
      if (call === 1) return null; // no nonce
      if (call === 2) return nonOwnedAccountInfo(16_982_400); // slot 0 exists
      return null; // slot 1 missing → break
    });
    const { getSolanaSetupStatus } = await import(
      "../src/modules/execution/index.js"
    );
    const res = await getSolanaSetupStatus({ wallet: WALLET });
    expect(res.nonce.exists).toBe(false);
    expect(res.marginfi.accounts).toHaveLength(1);
    expect(res.marginfi.accounts[0]!.index).toBe(0);
    expect(res.marginfi.accounts[0]!.address).toMatch(
      /^[1-9A-HJ-NP-Za-km-z]{43,44}$/,
    );
  });
});
