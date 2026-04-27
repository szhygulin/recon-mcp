import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { createRequire } from "node:module";
import { setConfigDirForTesting } from "../src/config/user-config.js";

/**
 * `prepare_btc_lifi_swap` unit tests. The LiFi quote endpoint is
 * mocked via `fetchBitcoinQuote`; we hand the builder a synthetic PSBT
 * that mirrors the real LiFi-on-NEAR-Intents shape (4 outputs: vault
 * deposit, OP_RETURN memo, change-back-to-source, LiFi fee). The test
 * pins the load-bearing invariants:
 *
 *  - input scripts must equal the source's scriptPubKey (refusal path)
 *  - exactly one OP_RETURN output (multi-OP_RETURN refused)
 *  - vault output address matches `transactionRequest.to`
 *  - `nonWitnessUtxo` is hydrated on every input from the indexer
 *  - the verification block surfaces vault, OP_RETURN hex, expected/min
 *    output, route tool, slippage
 *  - destinations LiFi cannot route to (TRON) are NOT exposed by the
 *    schema enum, so the builder doesn't need a runtime guard for them
 *  - destination address format mismatches are refused up-front (EVM
 *    hex for "solana", base58 for EVM)
 */

const requireCjs = createRequire(import.meta.url);
const bitcoinjsForFixtures = requireCjs("bitcoinjs-lib") as {
  Transaction: new () => {
    version: number;
    addInput(hash: Buffer, index: number, sequence?: number): unknown;
    addOutput(script: Buffer, value: number): unknown;
    toHex(): string;
  };
  Psbt: {
    new (opts?: { network?: unknown }): {
      addInput(input: {
        hash: string | Buffer;
        index: number;
        sequence?: number;
        witnessUtxo?: { script: Buffer; value: number };
      }): unknown;
      addOutput(output: { address?: string; script?: Buffer; value: number }): unknown;
      toHex(): string;
      toBase64(): string;
    };
    fromBase64(b64: string): {
      data: { inputs: Array<{ nonWitnessUtxo?: Buffer }> };
    };
  };
  address: {
    toOutputScript(addr: string, network?: unknown): Buffer;
  };
  payments: {
    embed(opts: { data: Buffer[] }): { output: Buffer };
  };
  networks: { bitcoin: unknown };
};

const NETWORK = bitcoinjsForFixtures.networks.bitcoin;

const SEGWIT_ADDR = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const SEGWIT_PUBKEY =
  "03a34b99f22c790c4e36b2b3c2c35a36db06226e41c692fc82b8b56ac1c540c5bd";
const VAULT_ADDR = "1GhGCZJ65hfkycqxaTTDGyKncouGL2dFox"; // P2PKH; LiFi/NEAR Intents vault
const LIFI_FEE_ADDR = "bc1q539etcvmjsvm3wtltwdkkj6tfd95kj6ttxc3zu"; // LiFi fee output (well-formed P2WPKH)
const FAKE_TXID =
  "1111111111111111111111111111111111111111111111111111111111111111";

/**
 * Build a minimal mainnet prev-tx hex with a single output at `vout`
 * paying `address` `value` sats. Issue #213 — Ledger 2.x requires
 * `nonWitnessUtxo` on every PSBT input, hydrated from this prev-tx.
 */
function buildPrevTxHex(value: number, address: string, vout = 0): string {
  const tx = new bitcoinjsForFixtures.Transaction();
  tx.version = 2;
  tx.addInput(Buffer.alloc(32, 0), 0xffffffff, 0xffffffff);
  for (let i = 0; i <= vout; i++) {
    const script = bitcoinjsForFixtures.address.toOutputScript(address, NETWORK);
    tx.addOutput(script, i === vout ? value : 0);
  }
  return tx.toHex();
}

/**
 * Construct a synthetic LiFi-shaped PSBT: 1 segwit input from `source`,
 * outputs in this order — vault deposit, OP_RETURN memo,
 * change-back-to-source, LiFi-fee. Returns the hex-encoded PSBT (LiFi
 * wire shape is hex; the builder accepts both 0x-prefixed and bare hex).
 */
function buildLifiShapedPsbtHex(opts: {
  source: string;
  inputValue: number;
  inputTxid?: string;
  inputVout?: number;
  vault?: string;
  vaultValue: number;
  memoBytes: Buffer;
  changeValue: number;
  changeAddress?: string; // override to test "change to non-source" case
  feeOutputAddress?: string;
  feeOutputValue?: number;
  extraOpReturnBytes?: Buffer; // for the multi-OP_RETURN refusal test
}): string {
  const psbt = new bitcoinjsForFixtures.Psbt({ network: NETWORK });
  const sourceScript = bitcoinjsForFixtures.address.toOutputScript(
    opts.source,
    NETWORK,
  );
  psbt.addInput({
    hash: opts.inputTxid ?? FAKE_TXID,
    index: opts.inputVout ?? 0,
    sequence: 0xfffffffd,
    witnessUtxo: { script: sourceScript, value: opts.inputValue },
  });
  // Output 0: vault deposit.
  psbt.addOutput({
    address: opts.vault ?? VAULT_ADDR,
    value: opts.vaultValue,
  });
  // Output 1: OP_RETURN memo.
  const memoEmbed = bitcoinjsForFixtures.payments.embed({ data: [opts.memoBytes] });
  psbt.addOutput({ script: memoEmbed.output, value: 0 });
  // Output 2: change.
  psbt.addOutput({
    address: opts.changeAddress ?? opts.source,
    value: opts.changeValue,
  });
  // Output 3 (optional): LiFi fee.
  if (opts.feeOutputAddress && opts.feeOutputValue !== undefined) {
    psbt.addOutput({
      address: opts.feeOutputAddress,
      value: opts.feeOutputValue,
    });
  }
  // Optional second OP_RETURN — used for the multi-memo refusal test.
  if (opts.extraOpReturnBytes) {
    const extra = bitcoinjsForFixtures.payments.embed({
      data: [opts.extraOpReturnBytes],
    });
    psbt.addOutput({ script: extra.output, value: 0 });
  }
  return psbt.toHex();
}

const fetchBitcoinQuoteMock = vi.fn();
vi.mock("../src/modules/swap/lifi.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/modules/swap/lifi.js")>();
  return {
    ...actual,
    fetchBitcoinQuote: (...args: unknown[]) => fetchBitcoinQuoteMock(...args),
  };
});

const getTxHexMock = vi.fn();
vi.mock("../src/modules/btc/indexer.ts", () => ({
  getBitcoinIndexer: () => ({ getTxHex: getTxHexMock }),
  resetBitcoinIndexer: () => {},
}));

let tmpHome: string;

beforeEach(async () => {
  tmpHome = mkdtempSync(pjoin(tmpdir(), "vaultpilot-btc-lifi-"));
  setConfigDirForTesting(tmpHome);
  fetchBitcoinQuoteMock.mockReset();
  getTxHexMock.mockReset();
  getTxHexMock.mockImplementation(async (txid: string) => {
    // Default: return a prev-tx hex paying 100_000 sats to SEGWIT_ADDR
    // at vout=0. Each test that varies inputs sets the value via the
    // synthetic PSBT, so the prev-tx output value just needs to be
    // >= the witnessUtxo value. We size it generously.
    if (txid !== FAKE_TXID) {
      throw new Error(
        `Test setup error: getTxHex(${txid}) called but only FAKE_TXID is registered.`,
      );
    }
    return buildPrevTxHex(1_000_000, SEGWIT_ADDR, 0);
  });
  const { clearPairedBtcAddresses, setPairedBtcAddress } = await import(
    "../src/signing/btc-usb-signer.js"
  );
  const { __clearBitcoinTxStore } = await import(
    "../src/signing/btc-tx-store.js"
  );
  clearPairedBtcAddresses();
  __clearBitcoinTxStore();
  setPairedBtcAddress({
    address: SEGWIT_ADDR,
    publicKey: SEGWIT_PUBKEY,
    path: "84'/0'/0'/0/0",
    appVersion: "2.4.6",
    addressType: "segwit",
    accountIndex: 0,
    chain: 0,
    addressIndex: 0,
  });
});

afterEach(() => {
  setConfigDirForTesting(null);
  rmSync(tmpHome, { recursive: true, force: true });
});

/**
 * Synthesize a LiFi quote object that matches the SDK shape closely enough
 * for the builder. Only the fields the builder actually reads are
 * populated.
 */
function makeLifiQuote(opts: {
  psbtHex: string;
  vault: string;
  fromAmountSats: number;
  toToken: { address: string; symbol: string; decimals: number };
  toAmount: string;
  toAmountMin: string;
  tool?: string;
}): unknown {
  return {
    tool: opts.tool ?? "near",
    transactionRequest: {
      to: opts.vault,
      data: opts.psbtHex,
      value: String(opts.fromAmountSats),
    },
    action: {
      fromToken: { address: "bitcoin", symbol: "BTC", decimals: 8 },
      toToken: opts.toToken,
      fromAmount: String(opts.fromAmountSats),
    },
    estimate: {
      toAmount: opts.toAmount,
      toAmountMin: opts.toAmountMin,
      executionDuration: 1312,
    },
  };
}

describe("buildBitcoinLifiSwap", () => {
  it("decodes vault + OP_RETURN + change, hydrates nonWitnessUtxo, and projects the verification block", async () => {
    const memoBytes = Buffer.from("3d7c6c6966698048cfc093", "hex"); // "=|lifi" + binary
    const psbtHex = buildLifiShapedPsbtHex({
      source: SEGWIT_ADDR,
      inputValue: 887_578,
      vaultValue: 499_262,
      memoBytes,
      changeValue: 386_519,
      feeOutputAddress: LIFI_FEE_ADDR,
      feeOutputValue: 1_250,
    });
    fetchBitcoinQuoteMock.mockResolvedValueOnce(
      makeLifiQuote({
        psbtHex,
        vault: VAULT_ADDR,
        fromAmountSats: 500_000,
        toToken: {
          address: "0x0000000000000000000000000000000000000000",
          symbol: "ETH",
          decimals: 18,
        },
        toAmount: "166995621559815435",
        toAmountMin: "166494634695135988",
      }),
    );

    const { buildBitcoinLifiSwap } = await import(
      "../src/modules/btc/lifi-swap.ts"
    );
    const tx = await buildBitcoinLifiSwap({
      wallet: SEGWIT_ADDR,
      toChain: "ethereum",
      toToken: "native",
      toAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      amount: "0.005",
      slippageBps: 50,
    });

    // Header invariants.
    expect(tx.chain).toBe("bitcoin");
    expect(tx.action).toBe("native_send");
    expect(tx.from).toBe(SEGWIT_ADDR);
    expect(tx.addressFormat).toBe("bech32");
    expect(tx.accountPath).toBe("84'/0'/0'");
    expect(tx.handle).toBeDefined();

    // Verification block — vault, memo hex, route tool, expected/min out.
    expect(tx.decoded.functionName).toBe("bitcoin.lifi_swap");
    expect(tx.decoded.args.vault).toBe(VAULT_ADDR);
    expect(tx.decoded.args.opReturnHex).toBe(memoBytes.toString("hex"));
    expect(tx.decoded.args.opReturnAscii).toBe("=|lifi"); // printable prefix
    expect(tx.decoded.args.route).toBe("near");
    expect(tx.decoded.args.toChain).toBe("ethereum");
    expect(tx.decoded.args.toAddress).toBe(
      "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    );
    expect(tx.decoded.args.expectedOut).toContain("ETH");
    expect(tx.decoded.args.minOut).toContain("ETH");
    expect(tx.decoded.args.slippageBps).toBe("50");

    // Outputs decoded — should be 4 (vault, OP_RETURN, change, LiFi fee).
    expect(tx.decoded.outputs).toHaveLength(4);
    const vaultOut = tx.decoded.outputs.find((o) => o.address === VAULT_ADDR);
    expect(vaultOut).toBeDefined();
    expect(vaultOut?.amountSats).toBe("499262");
    expect(vaultOut?.isChange).toBe(false);

    const opReturnOut = tx.decoded.outputs.find((o) => o.address === "OP_RETURN");
    expect(opReturnOut).toBeDefined();
    expect(opReturnOut?.amountSats).toBe("0");

    const changeOut = tx.decoded.outputs.find(
      (o) => o.address === SEGWIT_ADDR && o.isChange,
    );
    expect(changeOut).toBeDefined();
    expect(changeOut?.amountSats).toBe("386519");
    expect(changeOut?.changePath).toBe("84'/0'/0'/0/0");

    const feeOut = tx.decoded.outputs.find(
      (o) => o.address === LIFI_FEE_ADDR,
    );
    expect(feeOut).toBeDefined();
    expect(feeOut?.amountSats).toBe("1250");
    expect(feeOut?.isChange).toBe(false);

    // Sources — single source, single input.
    expect(tx.sources).toEqual([
      { address: SEGWIT_ADDR, path: "84'/0'/0'/0/0", publicKey: SEGWIT_PUBKEY },
    ]);
    expect(tx.inputSources).toEqual([SEGWIT_ADDR]);
    expect(tx.decoded.sources).toEqual([
      {
        address: SEGWIT_ADDR,
        pulledSats: "887578",
        pulledBtc: "0.00887578",
        inputCount: 1,
      },
    ]);

    // Fee = inputs - outputs = 887578 - (499262 + 0 + 386519 + 1250) = 547.
    expect(tx.decoded.feeSats).toBe("547");
    expect(tx.decoded.rbfEligible).toBe(false);

    // Hydration check — nonWitnessUtxo must now be set on every input.
    expect(getTxHexMock).toHaveBeenCalledOnce();
    const hydrated = bitcoinjsForFixtures.Psbt.fromBase64(tx.psbtBase64);
    expect(hydrated.data.inputs).toHaveLength(1);
    expect(hydrated.data.inputs[0].nonWitnessUtxo).toBeInstanceOf(Buffer);
  });

  it("refuses inputs from a different scriptPubKey than the source address", async () => {
    // Build a PSBT whose input claims a witnessUtxo from a DIFFERENT
    // address (synthetically — we re-encode another address's script).
    // Real-world tampering would manifest the same way: aggregator
    // returns a PSBT with foreign inputs.
    const otherAddr = "bc1q539etcvmjsvm3wtltwdkkj6tfd95kj6ttxc3zu";
    const psbt = new bitcoinjsForFixtures.Psbt({ network: NETWORK });
    psbt.addInput({
      hash: FAKE_TXID,
      index: 0,
      sequence: 0xfffffffd,
      witnessUtxo: {
        script: bitcoinjsForFixtures.address.toOutputScript(otherAddr, NETWORK),
        value: 887_578,
      },
    });
    psbt.addOutput({ address: VAULT_ADDR, value: 499_262 });
    psbt.addOutput({
      script: bitcoinjsForFixtures.payments.embed({
        data: [Buffer.from("memo", "ascii")],
      }).output,
      value: 0,
    });
    psbt.addOutput({ address: SEGWIT_ADDR, value: 386_519 });

    fetchBitcoinQuoteMock.mockResolvedValueOnce(
      makeLifiQuote({
        psbtHex: psbt.toHex(),
        vault: VAULT_ADDR,
        fromAmountSats: 500_000,
        toToken: {
          address: "0x0000000000000000000000000000000000000000",
          symbol: "ETH",
          decimals: 18,
        },
        toAmount: "1",
        toAmountMin: "1",
      }),
    );

    const { buildBitcoinLifiSwap } = await import(
      "../src/modules/btc/lifi-swap.ts"
    );
    await expect(
      buildBitcoinLifiSwap({
        wallet: SEGWIT_ADDR,
        toChain: "ethereum",
        toToken: "native",
        toAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
        amount: "0.005",
      }),
    ).rejects.toThrow(/different scriptPubKey/);
  });

  it("refuses when the PSBT has no OP_RETURN memo output", async () => {
    const psbt = new bitcoinjsForFixtures.Psbt({ network: NETWORK });
    psbt.addInput({
      hash: FAKE_TXID,
      index: 0,
      sequence: 0xfffffffd,
      witnessUtxo: {
        script: bitcoinjsForFixtures.address.toOutputScript(SEGWIT_ADDR, NETWORK),
        value: 887_578,
      },
    });
    // No OP_RETURN — only deposit + change.
    psbt.addOutput({ address: VAULT_ADDR, value: 499_262 });
    psbt.addOutput({ address: SEGWIT_ADDR, value: 386_519 });

    fetchBitcoinQuoteMock.mockResolvedValueOnce(
      makeLifiQuote({
        psbtHex: psbt.toHex(),
        vault: VAULT_ADDR,
        fromAmountSats: 500_000,
        toToken: {
          address: "0x0000000000000000000000000000000000000000",
          symbol: "ETH",
          decimals: 18,
        },
        toAmount: "1",
        toAmountMin: "1",
      }),
    );
    const { buildBitcoinLifiSwap } = await import(
      "../src/modules/btc/lifi-swap.ts"
    );
    await expect(
      buildBitcoinLifiSwap({
        wallet: SEGWIT_ADDR,
        toChain: "ethereum",
        toToken: "native",
        toAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
        amount: "0.005",
      }),
    ).rejects.toThrow(/no OP_RETURN memo/);
  });

  it("refuses when the PSBT has multiple OP_RETURN outputs", async () => {
    const psbtHex = buildLifiShapedPsbtHex({
      source: SEGWIT_ADDR,
      inputValue: 887_578,
      vaultValue: 499_262,
      memoBytes: Buffer.from("memo1", "ascii"),
      changeValue: 386_519,
      extraOpReturnBytes: Buffer.from("memo2", "ascii"),
    });
    fetchBitcoinQuoteMock.mockResolvedValueOnce(
      makeLifiQuote({
        psbtHex,
        vault: VAULT_ADDR,
        fromAmountSats: 500_000,
        toToken: {
          address: "0x0000000000000000000000000000000000000000",
          symbol: "ETH",
          decimals: 18,
        },
        toAmount: "1",
        toAmountMin: "1",
      }),
    );
    const { buildBitcoinLifiSwap } = await import(
      "../src/modules/btc/lifi-swap.ts"
    );
    await expect(
      buildBitcoinLifiSwap({
        wallet: SEGWIT_ADDR,
        toChain: "ethereum",
        toToken: "native",
        toAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
        amount: "0.005",
      }),
    ).rejects.toThrow(/multiple OP_RETURN/);
  });

  it("refuses Solana destinations with an EVM-shaped toAddress", async () => {
    const { buildBitcoinLifiSwap } = await import(
      "../src/modules/btc/lifi-swap.ts"
    );
    await expect(
      buildBitcoinLifiSwap({
        wallet: SEGWIT_ADDR,
        toChain: "solana",
        toToken: "native",
        toAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
        amount: "0.005",
      }),
    ).rejects.toThrow(/not a valid Solana base58 address/);
    expect(fetchBitcoinQuoteMock).not.toHaveBeenCalled();
  });

  it("refuses EVM destinations with a Solana-shaped toAddress", async () => {
    const { buildBitcoinLifiSwap } = await import(
      "../src/modules/btc/lifi-swap.ts"
    );
    await expect(
      buildBitcoinLifiSwap({
        wallet: SEGWIT_ADDR,
        toChain: "ethereum",
        toToken: "native",
        toAddress: "DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1",
        amount: "0.005",
      }),
    ).rejects.toThrow(/not a valid EVM address/);
    expect(fetchBitcoinQuoteMock).not.toHaveBeenCalled();
  });

  it("refuses when the wallet is not paired", async () => {
    const { clearPairedBtcAddresses } = await import(
      "../src/signing/btc-usb-signer.js"
    );
    clearPairedBtcAddresses();
    const { buildBitcoinLifiSwap } = await import(
      "../src/modules/btc/lifi-swap.ts"
    );
    await expect(
      buildBitcoinLifiSwap({
        wallet: SEGWIT_ADDR,
        toChain: "ethereum",
        toToken: "native",
        toAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
        amount: "0.005",
      }),
    ).rejects.toThrow(/not paired/);
    expect(fetchBitcoinQuoteMock).not.toHaveBeenCalled();
  });

  it("refuses high slippage without explicit acknowledgement", async () => {
    const { buildBitcoinLifiSwap } = await import(
      "../src/modules/btc/lifi-swap.ts"
    );
    await expect(
      buildBitcoinLifiSwap({
        wallet: SEGWIT_ADDR,
        toChain: "ethereum",
        toToken: "native",
        toAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
        amount: "0.005",
        slippageBps: 200,
      }),
    ).rejects.toThrow(/slippage/i);
    expect(fetchBitcoinQuoteMock).not.toHaveBeenCalled();
  });
});
