import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";

/**
 * Jupiter swap tests — mock the lite-api.jup.ag HTTP API via global fetch,
 * plus the Solana RPC connection (ALT fetch, nonce-account presence). Every
 * path-level concern is covered: quote formatting, instruction composition
 * with nonceAdvance prepended, ALT resolution, error paths.
 */

// Canonical mainnet mints (from src/config/solana.ts SOLANA_TOKENS).
const WSOL = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const WALLET_KEYPAIR = Keypair.generate();
const WALLET = WALLET_KEYPAIR.publicKey.toBase58();

const connectionStub = {
  getAccountInfo: vi.fn(),
};

vi.mock("../src/modules/solana/rpc.js", () => ({
  getSolanaConnection: () => connectionStub,
  resetSolanaConnection: () => {},
}));

// Mock the ALT resolver — we don't care about the Connection-level fetch
// in these tests; we just want to verify `buildJupiterSwap` hands the
// addressLookupTableAddresses through to the resolver and stashes the
// resolved accounts on the draft.
const resolveAltMock = vi.fn();
vi.mock("../src/modules/solana/alt.js", () => ({
  resolveAddressLookupTables: (...args: unknown[]) => resolveAltMock(...args),
  clearAltCache: () => {},
  invalidateAlt: () => {},
}));

// Mock the nonce-account lookup — Jupiter builder calls this in its preflight.
vi.mock("../src/modules/solana/nonce.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/modules/solana/nonce.js")>();
  return {
    ...actual,
    getNonceAccountValue: vi.fn(),
  };
});

let fetchMock: ReturnType<typeof vi.fn>;

async function setNoncePresent(): Promise<void> {
  const { getNonceAccountValue } = await import(
    "../src/modules/solana/nonce.js"
  );
  (getNonceAccountValue as ReturnType<typeof vi.fn>).mockResolvedValue({
    nonce: "GfnhkAa2iy8cZV7X5SyyYmCHxFQjEbBuyyUSCBokixB9",
    authority: new PublicKey(WALLET),
  });
}

async function setNonceMissing(): Promise<void> {
  const { getNonceAccountValue } = await import(
    "../src/modules/solana/nonce.js"
  );
  (getNonceAccountValue as ReturnType<typeof vi.fn>).mockResolvedValue(null);
}

beforeEach(async () => {
  connectionStub.getAccountInfo.mockReset();
  resolveAltMock.mockReset();
  resolveAltMock.mockResolvedValue([]); // default: no ALTs resolved
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  const { getNonceAccountValue } = await import(
    "../src/modules/solana/nonce.js"
  );
  (getNonceAccountValue as ReturnType<typeof vi.fn>).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Minimal well-formed Jupiter /quote response (per their OpenAPI spec). */
const SAMPLE_QUOTE = {
  inputMint: WSOL,
  inAmount: "1000000000", // 1 SOL (9 decimals)
  outputMint: USDC_MINT,
  outAmount: "170000000", // 170 USDC (6 decimals)
  otherAmountThreshold: "169150000", // ~0.5% slippage
  swapMode: "ExactIn",
  slippageBps: 50,
  priceImpactPct: "0.0001",
  routePlan: [
    {
      swapInfo: {
        ammKey: "HXpGFJGCEEFdV31tDmjDBaJMEB1fKLiAoKoWr3Fnonid",
        label: "Meteora DLMM",
        inputMint: WSOL,
        outputMint: USDC_MINT,
        inAmount: "1000000000",
        outAmount: "170000000",
      },
      percent: 100,
    },
  ],
  contextSlot: 324307186,
  timeTaken: 0.012,
};

describe("getJupiterQuote", () => {
  it("hits lite-api.jup.ag/swap/v1/quote with the right params and surfaces human fields for known mints", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => SAMPLE_QUOTE,
    });
    const { getJupiterQuote } = await import(
      "../src/modules/solana/jupiter.js"
    );
    const { quote, human } = await getJupiterQuote({
      inputMint: WSOL,
      outputMint: USDC_MINT,
      amount: "1000000000",
      slippageBps: 50,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("https://lite-api.jup.ag/swap/v1/quote?");
    expect(url).toContain(`inputMint=${WSOL}`);
    expect(url).toContain(`outputMint=${USDC_MINT}`);
    expect(url).toContain("amount=1000000000");
    expect(url).toContain("slippageBps=50");
    expect(url).toContain("swapMode=ExactIn");
    // maxAccounts cap keeps v0 txs under the 1232-byte packet ceiling.
    expect(url).toContain("maxAccounts=40");

    // Raw quote passed through verbatim (we need to pass it back to /swap).
    expect(quote.inputMint).toBe(WSOL);
    expect(quote.outputMint).toBe(USDC_MINT);
    expect(quote.routePlan).toHaveLength(1);

    // Human fields: canonical mint → symbol + decimals.
    expect(human.inputSymbol).toBe("SOL");
    expect(human.outputSymbol).toBe("USDC");
    expect(human.inputAmountHuman).toBe("1"); // 1_000_000_000 lamports = 1 SOL
    expect(human.outputAmountHuman).toBe("170"); // 170_000_000 micro-USDC = 170 USDC
    expect(human.minOutputHuman).toBe("169.15");
    expect(human.routeLabels).toEqual(["Meteora DLMM"]);
    expect(human.priceImpactPct).toBe("0.0001");
  });

  it("surfaces the Jupiter error body on HTTP failure", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => '{"error":"Invalid mint"}',
    });
    const { getJupiterQuote } = await import(
      "../src/modules/solana/jupiter.js"
    );
    await expect(
      getJupiterQuote({
        inputMint: WSOL,
        outputMint: USDC_MINT,
        amount: "1000000000",
        slippageBps: 50,
      }),
    ).rejects.toThrow(/Jupiter \/quote failed \(HTTP 400\):.*Invalid mint/);
  });
});

describe("buildJupiterSwap", () => {
  it("refuses with the shared 'nonce init required' error when the wallet has no nonce account", async () => {
    await setNonceMissing();
    const { buildJupiterSwap } = await import(
      "../src/modules/solana/jupiter.js"
    );
    await expect(
      buildJupiterSwap({ wallet: WALLET, quote: SAMPLE_QUOTE as never }),
    ).rejects.toThrow(/durable-nonce account not initialized/);
  });

  it("composes the v0 ix list with nonceAdvance first + resolves ALTs + stashes everything on a v0 draft", async () => {
    await setNoncePresent();
    // Jupiter /swap-instructions response — one compute-budget ix, one
    // setup (ATA create), one swap, one cleanup (unwrap WSOL), plus one
    // ALT address.
    const jupResponse = {
      computeBudgetInstructions: [
        {
          programId: "ComputeBudget111111111111111111111111111111",
          accounts: [],
          data: Buffer.from([0x02, 0x10, 0x27, 0x00, 0x00]).toString("base64"),
        },
      ],
      setupInstructions: [
        {
          programId: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
          accounts: [
            { pubkey: WALLET, isSigner: true, isWritable: true },
          ],
          data: "",
        },
      ],
      swapInstruction: {
        programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
        accounts: [
          { pubkey: WALLET, isSigner: true, isWritable: true },
        ],
        data: Buffer.from([0xe5, 0x17]).toString("base64"),
      },
      cleanupInstruction: {
        programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        accounts: [
          { pubkey: WALLET, isSigner: true, isWritable: true },
        ],
        data: Buffer.from([0x09]).toString("base64"),
      },
      otherInstructions: [],
      addressLookupTableAddresses: [
        "GxS6FiQ9RbErBB48mE34U4Jv13MdEJov4R1e5KgFzRFY",
      ],
    };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => jupResponse,
    });
    resolveAltMock.mockResolvedValueOnce([
      // Opaque AddressLookupTableAccount stand-in; Milestone A's v0 pin
      // is what actually consumes it, and that path is covered in
      // test/solana-v0-alt.test.ts.
      { key: new PublicKey("GxS6FiQ9RbErBB48mE34U4Jv13MdEJov4R1e5KgFzRFY") },
    ]);

    const { buildJupiterSwap } = await import(
      "../src/modules/solana/jupiter.js"
    );
    const prepared = await buildJupiterSwap({
      wallet: WALLET,
      quote: SAMPLE_QUOTE as never,
    });

    // Confirm /swap-instructions was called with useSharedAccounts + wrap +
    // dynamicComputeUnitLimit (the three defaults that matter for this path).
    const [url, req] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://lite-api.jup.ag/swap/v1/swap-instructions");
    expect(req.method).toBe("POST");
    const body = JSON.parse(req.body as string);
    expect(body.userPublicKey).toBe(WALLET);
    expect(body.useSharedAccounts).toBe(true);
    expect(body.wrapAndUnwrapSol).toBe(true);
    expect(body.dynamicComputeUnitLimit).toBe(true);
    // The quote object is echoed verbatim so Jupiter can verify its own
    // signature over it.
    expect(body.quoteResponse).toEqual(SAMPLE_QUOTE);

    // ALT resolver was called with the one ALT Jupiter returned.
    expect(resolveAltMock).toHaveBeenCalledTimes(1);
    const altArg = resolveAltMock.mock.calls[0][1] as PublicKey[];
    expect(altArg).toHaveLength(1);
    expect(altArg[0].toBase58()).toBe(
      "GxS6FiQ9RbErBB48mE34U4Jv13MdEJov4R1e5KgFzRFY",
    );

    // Prepared shape — action, description, decoded.args, nonceAccount.
    expect(prepared.action).toBe("jupiter_swap");
    expect(prepared.chain).toBe("solana");
    expect(prepared.from).toBe(WALLET);
    expect(prepared.description).toContain("via Jupiter");
    expect(prepared.description).toContain("Meteora DLMM");
    expect(prepared.description).toContain("50 bps");
    expect(prepared.decoded.functionName).toBe("solana.jupiter.swap");
    expect(prepared.decoded.args.inputSymbol).toBe("SOL");
    expect(prepared.decoded.args.outputSymbol).toBe("USDC");
    expect(prepared.decoded.args.slippageBps).toBe("50");
    expect(prepared.decoded.args.route).toBe("Meteora DLMM");
    expect(prepared.decoded.args.addressLookupTables).toBe("1");
    expect(prepared.nonceAccount).toBeDefined();

    // Confirm the draft in the tx-store is a v0 variant with nonceAdvance
    // first and Jupiter's ix list appended in order.
    const { getSolanaDraft } = await import(
      "../src/signing/solana-tx-store.js"
    );
    const draft = getSolanaDraft(prepared.handle);
    expect(draft.kind).toBe("v0");
    if (draft.kind !== "v0") throw new Error("unreachable");
    // ix[0] = nonceAdvance (System Program, tag 04000000).
    expect(draft.instructions[0].programId.toBase58()).toBe(
      "11111111111111111111111111111111",
    );
    expect(draft.instructions[0].data.toString("hex")).toBe("04000000");
    // ix[1] = Jupiter's compute-budget ix (we passed it as ComputeBudget111).
    expect(draft.instructions[1].programId.toBase58()).toBe(
      "ComputeBudget111111111111111111111111111111",
    );
    // ix[2] = setup ATA (ATokenGP...knL).
    expect(draft.instructions[2].programId.toBase58()).toBe(
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    );
    // ix[3] = Jupiter swap ix (JUP6Lk...V4).
    expect(draft.instructions[3].programId.toBase58()).toBe(
      "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    );
    // ix[4] = cleanup (SPL Token — unwrap WSOL or similar).
    expect(draft.instructions[4].programId.toBase58()).toBe(
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    );
    // ALTs stashed on the draft for the v0 pin to consume.
    expect(draft.addressLookupTableAccounts).toHaveLength(1);
    // Nonce meta survives for pinSolanaHandle's consistency guard.
    expect(draft.meta.nonce?.account).toBe(prepared.nonceAccount);
    expect(draft.meta.nonce?.authority).toBe(WALLET);
  });

  it("surfaces the Jupiter error body on /swap-instructions HTTP failure", async () => {
    await setNoncePresent();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "upstream router error",
    });
    const { buildJupiterSwap } = await import(
      "../src/modules/solana/jupiter.js"
    );
    await expect(
      buildJupiterSwap({ wallet: WALLET, quote: SAMPLE_QUOTE as never }),
    ).rejects.toThrow(
      /Jupiter \/swap-instructions failed \(HTTP 500\):.*upstream router error/,
    );
  });
});

describe("renderSolanaAgentTaskBlock — jupiter_swap handling", () => {
  it("treats Jupiter as a blind-sign action (Message Hash on-device, CHECK 2 runs)", async () => {
    const { renderSolanaAgentTaskBlock } = await import(
      "../src/signing/render-verification.js"
    );
    const { solanaLedgerMessageHash } = await import(
      "../src/signing/verification.js"
    );
    const tx = {
      chain: "solana" as const,
      action: "jupiter_swap" as const,
      from: WALLET,
      messageBase64: "AQAEBzA/m98Yce1Jt/hp+eAbCM3GPwfIAUQr0DAXVer+HYYg",
      recentBlockhash: "GfnhkAa2iy8cZV7X5SyyYmCHxFQjEbBuyyUSCBokixB9",
      description: "Swap 1 SOL → 170 USDC via Jupiter (Meteora DLMM)",
      decoded: {
        functionName: "solana.jupiter.swap",
        args: { inputSymbol: "SOL", outputSymbol: "USDC" },
      },
      nonce: {
        account: "NonceAcct1",
        authority: WALLET,
        value: "Gfnhk",
      },
    };
    const expectedHash = solanaLedgerMessageHash(tx.messageBase64);
    const block = renderSolanaAgentTaskBlock(tx);
    // Blind-sign branch on on-device line.
    expect(block).toContain("BLIND-SIGN");
    // v1.6 Phase 2: "Jupiter routing" subtype label was dropped from the
    // on-device line (uniform blind-sign message for all blind-sign
    // actions) — the summary's "via Jupiter" headline bullet still
    // identifies it as a swap.
    expect(block).toContain("via Jupiter");
    // Hash spliced into the on-device line as a bare base58 value. The
    // Markdown emphasis wrappers (`**\`…\`**`) were dropped because they
    // leak through as literal characters in Claude Code's preformatted
    // CHECKS PERFORMED rendering; blank-line isolation around the indented
    // hash is what carries the visual emphasis. Guard the regression.
    expect(block).toContain(expectedHash);
    expect(block).not.toMatch(/\*\*`[1-9A-HJ-NP-Za-km-z]{43,44}`\*\*/);
    expect(block).toContain("Allow blind signing");
    // CHECK 2 (pair-consistency hash) runs for blind-sign.
    expect(block).toContain("PAIR-CONSISTENCY LEDGER HASH");
    // Summary shape mentions Jupiter + route.
    expect(block).toContain("via Jupiter");
    // v1.6 Phase 2: DURABLE-NONCE MODE explainer compressed to an inline
    // sentence — Jupiter uses nonceAdvance like the other blind-sign sends.
    expect(block).toContain("durable-nonce-protected");
    expect(block).toContain("Nonce:");
  });
});
