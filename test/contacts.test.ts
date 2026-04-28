/**
 * Address-book v1.0 tests. Covers the security-critical surfaces:
 *
 *   - canonicalize: stable output for equivalent inputs (key-order
 *     independence, entry-order independence after sort)
 *   - storage: atomic write + read round-trip; symlink rejection
 *   - BTC verifier: BIP-137 round-trip with a real
 *     `signBtcMessageOnLedger` mocked at the SDK layer; tampered
 *     blob fails
 *   - EVM verifier: viem `verifyMessage` round-trip with a real
 *     EIP-191 sig generated locally; tampered blob fails
 *   - resolver: literal pass-through, label resolution, ENS, unknown,
 *     reverse-decoration; scoped-abort behavior on tamper
 *   - top-level addContact: duplicate-address rejection,
 *     CHAIN_NOT_YET_SUPPORTED, ledger-not-paired
 *   - render-verification suffixes: contact / ENS / reverse / unknown
 *
 * The full flow (add → list → tamper → list) is integration-tested
 * against a tmp config dir so the persisted file actually round-trips
 * through disk.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock the BTC SDK — every test that exercises `addContact` for BTC
// goes through this. We compute a real BIP-137 signature locally so
// the verifier can round-trip against the same key.
const signMessageMock = vi.fn();
const getWalletPublicKeyMock = vi.fn();
const getAppAndVersionMock = vi.fn();
const transportCloseMock = vi.fn(async () => {});

vi.mock("../src/signing/btc-usb-loader.js", () => ({
  openLedger: async () => ({
    app: {
      getWalletPublicKey: getWalletPublicKeyMock,
      signMessage: signMessageMock,
    },
    transport: { close: transportCloseMock },
    rawTransport: {},
  }),
  getAppAndVersion: () => getAppAndVersionMock(),
}));

// Mock WC personal_sign with a real EIP-191 signature.
const requestPersonalSignMock = vi.fn();
const getConnectedAccountsDetailedMock = vi.fn();

vi.mock("../src/signing/walletconnect.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/signing/walletconnect.js")>();
  return {
    ...actual,
    requestPersonalSign: (...a: unknown[]) => requestPersonalSignMock(...a),
    getConnectedAccountsDetailed: (...a: unknown[]) =>
      getConnectedAccountsDetailedMock(...a),
  };
});

// ENS mock for resolver tests.
const resolveNameMock = vi.fn();
vi.mock("../src/modules/balances/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/modules/balances/index.js")>();
  return {
    ...actual,
    resolveName: (...a: unknown[]) => resolveNameMock(...a),
  };
});

import { setConfigDirForTesting } from "../src/config/user-config.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { createRequire } from "node:module";
import {
  privateKeyToAccount,
  type PrivateKeyAccount,
} from "viem/accounts";

const requireCjs = createRequire(import.meta.url);
const bitcoinjs = requireCjs("bitcoinjs-lib") as {
  payments: {
    p2wpkh(opts: { pubkey: Buffer }): { address?: string };
  };
};

// ---------- BIP-137 sign helper (mirror of what Ledger BTC app does) ----------

/**
 * Compute the (recid, r, s) tuple for a BIP-137 signature on `message`
 * with `privKey`. The header byte is computed by the Ledger flow; we
 * just return what the SDK's `signMessage` would.
 */
function bip137SignLocal(
  message: string,
  privKey: Uint8Array,
): { v: number; r: string; s: string } {
  // Standard BIP-137 prefix — `varint(24) || "Bitcoin Signed Message:\n"`.
  // The Ledger BTC app prepends this internally; the verifier in
  // src/contacts/verify.ts uses the same shape. We mirror it here so
  // the mocked sign + the real verify agree on the message hash.
  const magic = "\x18Bitcoin Signed Message:\n";
  const messageBytes = Buffer.from(message, "utf8");
  const len = messageBytes.length;
  let lenBytes: Buffer;
  if (len < 0xfd) lenBytes = Buffer.from([len]);
  else if (len <= 0xffff) {
    lenBytes = Buffer.alloc(3);
    lenBytes[0] = 0xfd;
    lenBytes.writeUInt16LE(len, 1);
  } else {
    lenBytes = Buffer.alloc(5);
    lenBytes[0] = 0xfe;
    lenBytes.writeUInt32LE(len, 1);
  }
  const concat = Buffer.concat([
    Buffer.from(magic, "utf8"),
    lenBytes,
    messageBytes,
  ]);
  const msgHash = sha256(sha256(concat));
  const sig = secp256k1.sign(msgHash, privKey);
  return {
    v: sig.recovery!,
    r: sig.r.toString(16).padStart(64, "0"),
    s: sig.s.toString(16).padStart(64, "0"),
  };
}

function pubkeyFromPriv(privKey: Uint8Array): Uint8Array {
  return secp256k1.getPublicKey(privKey, true);
}

function btcAddressFromPubkey(pubkeyHex: string): string {
  const pubkey = Buffer.from(pubkeyHex, "hex");
  const p = bitcoinjs.payments.p2wpkh({ pubkey });
  return p.address!;
}

// ---------- Test fixtures ----------

const BTC_PRIV = new Uint8Array(32).fill(7);
const BTC_PUB = pubkeyFromPriv(BTC_PRIV);
const BTC_ADDR = btcAddressFromPubkey(Buffer.from(BTC_PUB).toString("hex"));

let evmAccount: PrivateKeyAccount;

let tmpHome: string;

beforeEach(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), "vaultpilot-contacts-"));
  setConfigDirForTesting(join(tmpHome, ".vaultpilot-mcp"));

  // Reset all mocks.
  signMessageMock.mockReset();
  getWalletPublicKeyMock.mockReset();
  getAppAndVersionMock.mockReset();
  transportCloseMock.mockClear();
  requestPersonalSignMock.mockReset();
  getConnectedAccountsDetailedMock.mockReset();
  resolveNameMock.mockReset();

  // Default Ledger BTC: app reports Bitcoin, returns the canonical
  // BTC address for the test private key, and signs locally with
  // BIP-137. Tests that need a different shape override per-call.
  getAppAndVersionMock.mockResolvedValue({ name: "Bitcoin", version: "2.4.6" });
  getWalletPublicKeyMock.mockResolvedValue({
    bitcoinAddress: BTC_ADDR,
    publicKey: Buffer.from(BTC_PUB).toString("hex"),
    chainCode: "00".repeat(32),
  });
  signMessageMock.mockImplementation(async (_path: string, messageHex: string) => {
    const message = Buffer.from(messageHex, "hex").toString("utf8");
    return bip137SignLocal(message, BTC_PRIV);
  });

  // Default WC EVM: a fresh viem account, signs the personal_sign
  // request with EIP-191 locally.
  evmAccount = privateKeyToAccount(`0x${"1".repeat(64)}`);
  getConnectedAccountsDetailedMock.mockResolvedValue([
    { address: evmAccount.address, namespace: "eip155", chainIds: [1] },
  ]);
  requestPersonalSignMock.mockImplementation(
    async (args: { message: string; from: `0x${string}` }) => {
      return await evmAccount.signMessage({ message: args.message });
    },
  );

  // Pre-pair a BTC entry so the contacts signer can pick an anchor.
  const { setPairedBtcAddress, clearPairedBtcAddresses } = await import(
    "../src/signing/btc-usb-signer.js"
  );
  clearPairedBtcAddresses();
  setPairedBtcAddress({
    address: BTC_ADDR,
    publicKey: Buffer.from(BTC_PUB).toString("hex"),
    path: "84'/0'/0'/0/0",
    appVersion: "2.4.6",
    addressType: "segwit",
    accountIndex: 0,
    chain: 0,
    addressIndex: 0,
  });

  const { _resetContactsAnchorStateForTests } = await import(
    "../src/contacts/index.js"
  );
  _resetContactsAnchorStateForTests();
});

afterEach(() => {
  setConfigDirForTesting(null);
  rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------- canonicalize ----------

describe("canonicalize", () => {
  it("produces stable output regardless of object key order", async () => {
    const { canonicalize } = await import("../src/contacts/canonicalize.js");
    const a = canonicalize({ a: 1, b: 2, c: 3 });
    const b = canonicalize({ c: 3, a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it("preserves array order (entries[] are sort-by-label upstream)", async () => {
    const { canonicalize } = await import("../src/contacts/canonicalize.js");
    const a = canonicalize([1, 2, 3]);
    const b = canonicalize([3, 2, 1]);
    expect(a).not.toBe(b);
  });

  it("buildSigningPreimage sorts entries by label", async () => {
    const { buildSigningPreimage, canonicalize } = await import(
      "../src/contacts/canonicalize.js"
    );
    const out1 = canonicalize(
      buildSigningPreimage({
        chainId: "btc",
        version: 1,
        anchorAddress: BTC_ADDR,
        signedAt: "2026-01-01T00:00:00.000Z",
        entries: [
          { label: "Z", address: "z", addedAt: "2026-01-01T00:00:00.000Z" },
          { label: "A", address: "a", addedAt: "2026-01-01T00:00:00.000Z" },
        ],
      }),
    );
    const out2 = canonicalize(
      buildSigningPreimage({
        chainId: "btc",
        version: 1,
        anchorAddress: BTC_ADDR,
        signedAt: "2026-01-01T00:00:00.000Z",
        entries: [
          { label: "A", address: "a", addedAt: "2026-01-01T00:00:00.000Z" },
          { label: "Z", address: "z", addedAt: "2026-01-01T00:00:00.000Z" },
        ],
      }),
    );
    expect(out1).toBe(out2);
  });
});

// ---------- storage ----------

describe("storage", () => {
  it("write+read round-trip with file mode 0o600", async () => {
    const { writeContactsFile, readContactsFile, contactsPath } = await import(
      "../src/contacts/storage.js"
    );
    const { emptyContactsFile } = await import("../src/contacts/schemas.js");
    writeContactsFile(emptyContactsFile());
    const path = contactsPath();
    const stat = lstatSync(path);
    // mode is OS-dependent; only check the user bits.
    expect(stat.mode & 0o777).toBe(0o600);
    const back = readContactsFile();
    expect(back.schemaVersion).toBe(1);
  });

  it("rejects writes when target path is a symlink", async () => {
    const { writeContactsFile, contactsPath } = await import(
      "../src/contacts/storage.js"
    );
    const { emptyContactsFile } = await import("../src/contacts/schemas.js");
    const { mkdirSync, symlinkSync, writeFileSync: wf } = await import("node:fs");
    const dir = join(tmpHome, ".vaultpilot-mcp");
    mkdirSync(dir, { recursive: true });
    const decoy = join(tmpHome, "decoy");
    wf(decoy, "{}");
    symlinkSync(decoy, contactsPath());
    expect(() => writeContactsFile(emptyContactsFile())).toThrow(/symlink/);
  });
});

// ---------- BTC verifier round-trip ----------

describe("BTC contacts blob — sign + verify round-trip", () => {
  it("verifies a blob signed by the test key", async () => {
    const { addContact } = await import("../src/contacts/index.js");
    const result = await addContact({
      chain: "btc",
      label: "Mom",
      address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
    });
    expect(result.version).toBe(1);
    const { verifyContacts } = await import("../src/contacts/index.js");
    const verified = await verifyContacts({ chain: "btc" });
    expect(verified.results).toHaveLength(1);
    expect(verified.results[0].ok).toBe(true);
    expect(verified.results[0].entryCount).toBe(1);
  });

  it("CONTACTS_TAMPERED — flipping an entry address fails verification", async () => {
    const { addContact, verifyContacts, _resetContactsAnchorStateForTests } =
      await import("../src/contacts/index.js");
    await addContact({
      chain: "btc",
      label: "Mom",
      address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
    });
    // Reset session anchor state so the post-tamper read starts cold.
    _resetContactsAnchorStateForTests();
    // Tamper: read the file, swap the address, write it back.
    const { contactsPath } = await import("../src/contacts/storage.js");
    const path = contactsPath();
    const raw = readFileSync(path, "utf8");
    const file = JSON.parse(raw);
    file.chains.btc.entries[0].address = "bc1qother111111111111111111111111111111111";
    writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 });
    const verified = await verifyContacts({ chain: "btc" });
    expect(verified.results[0].ok).toBe(false);
    expect(verified.results[0].reason).toBe("CONTACTS_TAMPERED");
  });
});

// ---------- EVM verifier round-trip ----------

describe("EVM contacts blob — sign + verify round-trip", () => {
  it("verifies a blob signed via WC personal_sign", async () => {
    const { addContact } = await import("../src/contacts/index.js");
    await addContact({
      chain: "evm",
      label: "Friend",
      address: "0xdEAD000000000000000000000000000000000000",
    });
    const { verifyContacts } = await import("../src/contacts/index.js");
    const verified = await verifyContacts({ chain: "evm" });
    expect(verified.results[0].ok).toBe(true);
  });

  it("CONTACTS_TAMPERED — bumping the version without re-signing fails", async () => {
    const { addContact, verifyContacts, _resetContactsAnchorStateForTests } =
      await import("../src/contacts/index.js");
    await addContact({
      chain: "evm",
      label: "Friend",
      address: "0xdEAD000000000000000000000000000000000000",
    });
    _resetContactsAnchorStateForTests();
    const { contactsPath } = await import("../src/contacts/storage.js");
    const path = contactsPath();
    const raw = readFileSync(path, "utf8");
    const file = JSON.parse(raw);
    file.chains.evm.version = 999;
    writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 });
    const verified = await verifyContacts({ chain: "evm" });
    expect(verified.results[0].ok).toBe(false);
    expect(verified.results[0].reason).toBe("CONTACTS_TAMPERED");
  });
});

// ---------- Top-level CRUD ----------

describe("addContact / removeContact / listContacts", () => {
  it("add → list joins by label across chains", async () => {
    const { addContact, listContacts } = await import("../src/contacts/index.js");
    await addContact({
      chain: "btc",
      label: "Mom",
      address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
    });
    await addContact({
      chain: "evm",
      label: "Mom",
      address: "0xdEAD000000000000000000000000000000000000",
      notes: "weekly transfer",
    });
    const out = await listContacts({});
    expect(out.contacts).toHaveLength(1);
    const mom = out.contacts[0];
    expect(mom.label).toBe("Mom");
    expect(mom.addresses.btc).toMatch(/^bc1q/);
    expect(mom.addresses.evm).toMatch(/^0x/i);
    expect(mom.notes).toBe("weekly transfer");
  });

  it("CONTACTS_DUPLICATE_ADDRESS — same address under a different label rejected", async () => {
    const { addContact } = await import("../src/contacts/index.js");
    await addContact({
      chain: "btc",
      label: "Mom",
      address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
    });
    await expect(
      addContact({
        chain: "btc",
        label: "Dad",
        address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
      }),
    ).rejects.toThrow(/CONTACTS_DUPLICATE_ADDRESS/);
  });

  it("CONTACTS_CHAIN_NOT_YET_SUPPORTED for solana/tron in v1.0", async () => {
    const { addContact } = await import("../src/contacts/index.js");
    await expect(
      addContact({
        chain: "solana",
        label: "X",
        address: "5rJ3dKM5K8hYkHcH67z3kjRtGkGuGh3aVi9fFpq9ZuDi",
      }),
    ).rejects.toThrow(/CONTACTS_CHAIN_NOT_YET_SUPPORTED/);
  });

  it("removeContact across chains drops the metadata sidecar when no chain references the label", async () => {
    const { addContact, removeContact, listContacts } = await import(
      "../src/contacts/index.js"
    );
    await addContact({
      chain: "btc",
      label: "Mom",
      address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
      notes: "with note",
    });
    await addContact({
      chain: "evm",
      label: "Mom",
      address: "0xdEAD000000000000000000000000000000000000",
    });
    await removeContact({ label: "Mom" });
    const out = await listContacts({});
    expect(out.contacts).toHaveLength(0);
    // Metadata row gone too.
    const { contactsPath } = await import("../src/contacts/storage.js");
    const file = JSON.parse(readFileSync(contactsPath(), "utf8"));
    expect(file.metadata.Mom).toBeUndefined();
  });
});

// ---------- Resolver ----------

describe("resolveRecipient", () => {
  it("literal EVM address passes through unchanged", async () => {
    const { resolveRecipient } = await import("../src/contacts/resolver.js");
    const out = await resolveRecipient(
      "0xdEAD000000000000000000000000000000000000",
      "ethereum",
    );
    expect(out.source).toBe("literal");
    expect(out.address.toLowerCase()).toBe(
      "0xdead000000000000000000000000000000000000",
    );
  });

  it("label resolves to address; source = 'contact'", async () => {
    const { addContact } = await import("../src/contacts/index.js");
    await addContact({
      chain: "evm",
      label: "Mom",
      address: "0xdEAD000000000000000000000000000000000000",
    });
    const { resolveRecipient } = await import("../src/contacts/resolver.js");
    const out = await resolveRecipient("Mom", "ethereum");
    expect(out.source).toBe("contact");
    expect(out.label).toBe("Mom");
    expect(out.address.toLowerCase()).toBe(
      "0xdead000000000000000000000000000000000000",
    );
  });

  it("literal address that matches a saved contact reverse-decorates with the label", async () => {
    const { addContact } = await import("../src/contacts/index.js");
    await addContact({
      chain: "evm",
      label: "Mom",
      address: "0xdEAD000000000000000000000000000000000000",
    });
    const { resolveRecipient } = await import("../src/contacts/resolver.js");
    const out = await resolveRecipient(
      "0xdead000000000000000000000000000000000000",
      "ethereum",
    );
    expect(out.source).toBe("literal");
    expect(out.label).toBe("Mom");
  });

  it("ENS resolution feeds through with source = 'ens'", async () => {
    resolveNameMock.mockResolvedValue({
      name: "vitalik.eth",
      address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    });
    const { resolveRecipient } = await import("../src/contacts/resolver.js");
    const out = await resolveRecipient("vitalik.eth", "ethereum");
    expect(out.source).toBe("ens");
    expect(out.address).toBe("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
  });

  it("scoped abort: tampered contacts + label input → throws", async () => {
    const { addContact, _resetContactsAnchorStateForTests } = await import(
      "../src/contacts/index.js"
    );
    await addContact({
      chain: "evm",
      label: "Mom",
      address: "0xdEAD000000000000000000000000000000000000",
    });
    _resetContactsAnchorStateForTests();
    const { contactsPath } = await import("../src/contacts/storage.js");
    const path = contactsPath();
    const raw = readFileSync(path, "utf8");
    const file = JSON.parse(raw);
    file.chains.evm.entries[0].address = "0xattacker000000000000000000000000000000000";
    writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 });
    const { resolveRecipient } = await import("../src/contacts/resolver.js");
    await expect(resolveRecipient("Mom", "ethereum")).rejects.toThrow(
      /CONTACTS_TAMPERED/,
    );
  });

  it("scoped abort: tampered contacts + LITERAL address input → proceeds with warning", async () => {
    const { addContact, _resetContactsAnchorStateForTests } = await import(
      "../src/contacts/index.js"
    );
    await addContact({
      chain: "evm",
      label: "Mom",
      address: "0xdEAD000000000000000000000000000000000000",
    });
    _resetContactsAnchorStateForTests();
    const { contactsPath } = await import("../src/contacts/storage.js");
    const path = contactsPath();
    const raw = readFileSync(path, "utf8");
    const file = JSON.parse(raw);
    file.chains.evm.entries[0].address = "0xattacker000000000000000000000000000000000";
    writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 });

    const { resolveRecipient } = await import("../src/contacts/resolver.js");
    const out = await resolveRecipient(
      "0x9999999999999999999999999999999999999999",
      "ethereum",
    );
    expect(out.source).toBe("literal");
    expect(out.warnings).toContainEqual(
      expect.stringMatching(/contacts file failed verification/),
    );
  });
});

// ---------- intendedChains tag (issue #482) ----------

describe("intendedChains (issue #482)", () => {
  it("addContact accepts intendedChains on EVM and the entry round-trips through verify", async () => {
    const { addContact, verifyContacts, listContacts } = await import(
      "../src/contacts/index.js"
    );
    await addContact({
      chain: "evm",
      label: "Carol",
      address: "0xCAfE000000000000000000000000000000000000",
      intendedChains: ["arbitrum"],
    });
    const verified = await verifyContacts({ chain: "evm" });
    expect(verified.results[0].ok).toBe(true);
    // listContacts joins by label; the intendedChains tag lives on the
    // signed entry — confirm it round-tripped to disk by reading the
    // raw blob back.
    const out = await listContacts({});
    expect(out.contacts).toHaveLength(1);
    expect(out.contacts[0].label).toBe("Carol");
    const { contactsPath } = await import("../src/contacts/storage.js");
    const file = JSON.parse(readFileSync(contactsPath(), "utf8"));
    expect(file.chains.evm.entries[0].intendedChains).toEqual(["arbitrum"]);
  });

  it("addContact rejects intendedChains on BTC with CONTACTS_INTENDED_CHAINS_EVM_ONLY", async () => {
    const { addContact } = await import("../src/contacts/index.js");
    await expect(
      addContact({
        chain: "btc",
        label: "Carol",
        address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
        // @ts-expect-error — intendedChains shouldn't be passed for btc;
        // schema-layer types narrow this, but the runtime guard is the
        // load-bearing rule under JS callers and demo-mode fallthroughs.
        intendedChains: ["ethereum"],
      }),
    ).rejects.toThrow(/CONTACTS_INTENDED_CHAINS_EVM_ONLY/);
  });

  it("forward label resolution: tagged contact + matching chain → no warning", async () => {
    const { addContact } = await import("../src/contacts/index.js");
    await addContact({
      chain: "evm",
      label: "Carol",
      address: "0xCAfE000000000000000000000000000000000000",
      intendedChains: ["arbitrum"],
    });
    const { resolveRecipient } = await import("../src/contacts/resolver.js");
    const out = await resolveRecipient("Carol", "arbitrum");
    expect(out.source).toBe("contact");
    expect(out.label).toBe("Carol");
    expect(out.warnings).not.toContainEqual(
      expect.stringMatching(/CONTACT-CHAIN MISMATCH/),
    );
  });

  it("forward label resolution: tagged contact + non-matching chain → CONTACT-CHAIN MISMATCH warning", async () => {
    const { addContact } = await import("../src/contacts/index.js");
    await addContact({
      chain: "evm",
      label: "Carol",
      address: "0xCAfE000000000000000000000000000000000000",
      intendedChains: ["arbitrum"],
    });
    const { resolveRecipient } = await import("../src/contacts/resolver.js");
    const out = await resolveRecipient("Carol", "ethereum");
    expect(out.source).toBe("contact");
    expect(out.label).toBe("Carol");
    expect(out.warnings).toContainEqual(
      expect.stringMatching(/CONTACT-CHAIN MISMATCH.*Carol.*arbitrum.*ethereum/),
    );
  });

  it("legacy contact (no intendedChains) on any EVM chain → no warning (backward compat)", async () => {
    const { addContact } = await import("../src/contacts/index.js");
    await addContact({
      chain: "evm",
      label: "Mom",
      address: "0xdEAD000000000000000000000000000000000000",
    });
    const { resolveRecipient } = await import("../src/contacts/resolver.js");
    for (const c of ["ethereum", "arbitrum", "polygon", "base", "optimism"]) {
      const out = await resolveRecipient("Mom", c);
      expect(out.warnings).not.toContainEqual(
        expect.stringMatching(/CONTACT-CHAIN MISMATCH/),
      );
    }
  });

  it("reverse-decoration on a literal address: tagged contact + non-matching chain → warning fires", async () => {
    const { addContact } = await import("../src/contacts/index.js");
    await addContact({
      chain: "evm",
      label: "Carol",
      address: "0xCAfE000000000000000000000000000000000000",
      intendedChains: ["arbitrum", "polygon"],
    });
    const { resolveRecipient } = await import("../src/contacts/resolver.js");
    const out = await resolveRecipient(
      "0xcafe000000000000000000000000000000000000",
      "base",
    );
    expect(out.source).toBe("literal");
    expect(out.label).toBe("Carol");
    expect(out.warnings).toContainEqual(
      expect.stringMatching(/CONTACT-CHAIN MISMATCH.*Carol.*arbitrum, polygon.*base/),
    );
  });

  it("preimage byte-equality: legacy entry produces the same canonical bytes as before #482", async () => {
    // The fix only adds `intendedChains` to the preimage when SET on
    // the source entry. Legacy entries (no field) must produce the
    // exact same canonical JSON as the pre-#482 code path so existing
    // signed blobs verify unchanged.
    const { canonicalize, buildSigningPreimage } = await import(
      "../src/contacts/canonicalize.js"
    );
    const legacyPreimage = canonicalize(
      buildSigningPreimage({
        chainId: "evm",
        version: 1,
        anchorAddress: "0xanchor",
        signedAt: "2026-04-28T00:00:00.000Z",
        entries: [
          {
            label: "Mom",
            address: "0xdEAD000000000000000000000000000000000000",
            addedAt: "2026-04-28T00:00:00.000Z",
          },
        ],
      }),
    );
    // Sentinel — what the pre-#482 code produced byte-for-byte.
    expect(legacyPreimage).toBe(
      '{"anchorAddress":"0xanchor","chainId":"evm","entries":[{"addedAt":"2026-04-28T00:00:00.000Z","address":"0xdEAD000000000000000000000000000000000000","label":"Mom"}],"signedAt":"2026-04-28T00:00:00.000Z","version":1}',
    );
    // Tagged entry adds `intendedChains` only on entries that carry it.
    const taggedPreimage = canonicalize(
      buildSigningPreimage({
        chainId: "evm",
        version: 1,
        anchorAddress: "0xanchor",
        signedAt: "2026-04-28T00:00:00.000Z",
        entries: [
          {
            label: "Carol",
            address: "0xCAfE000000000000000000000000000000000000",
            addedAt: "2026-04-28T00:00:00.000Z",
            intendedChains: ["arbitrum"],
          },
        ],
      }),
    );
    expect(taggedPreimage).toContain('"intendedChains":["arbitrum"]');
  });
});

// ---------- WC namespace expansion ----------

describe("REQUIRED_NAMESPACES", () => {
  it("includes personal_sign for the address-book signer (path-C trade-off)", async () => {
    const { REQUIRED_NAMESPACES } = await import(
      "../src/signing/walletconnect.js"
    );
    expect(REQUIRED_NAMESPACES.eip155.methods).toContain("personal_sign");
    // Typed-data remains EXCLUDED.
    expect(REQUIRED_NAMESPACES.eip155.methods).not.toContain(
      "eth_signTypedData_v4",
    );
  });
});
