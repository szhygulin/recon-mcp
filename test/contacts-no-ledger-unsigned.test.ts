/**
 * Issue #428: `add_contact` was hard-gated on Ledger pairing — first-run
 * / accountant-share users in production mode (not demo) saw
 * CONTACTS_LEDGER_NOT_PAIRED and couldn't label addresses without
 * either pairing a Ledger they don't own or entering demo mode (which
 * intercepts broadcasts).
 *
 * These tests pin the smallest fix: when `pickEvmAnchor` /
 * `assertBtcAnchorAvailable` throws CONTACTS_LEDGER_NOT_PAIRED in
 * non-demo mode, fall through to the same in-memory store demo mode
 * uses, return `unsigned: true` + `anchorAddress: "UNSIGNED_NO_LEDGER"`.
 * Listing surfaces the entry with `unsigned: true`. Removing works
 * without a Ledger. The resolver decorates literal addresses + forward-
 * resolves labels from the unsigned store with a "(unsigned)" warning
 * so Invariant #7 keeps working in degraded form.
 *
 * Persistence-across-restart and sign-on-pair upgrade are NOT covered
 * here — those are deferred per
 * `claude-work/plan-contacts-unsigned-state-machine.md`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Force production mode (not demo) so the new fall-through path is the
// one under test. Demo coverage lives in contacts-demo-mode.test.ts.
beforeEach(() => {
  delete process.env.VAULTPILOT_DEMO;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

/**
 * Mock the EVM signer to behave as if no Ledger Live WC session is
 * open — `pickEvmAnchor` throws CONTACTS_LEDGER_NOT_PAIRED, the
 * runtime signal `addContact` falls through on. `signContactsBlobEvm`
 * is also mocked so a misrouted call would surface visibly. The mock
 * MUST be installed before the first import of `contacts/index.js` —
 * call `vi.resetModules()` between this and the imports if the module
 * cache might already hold the real signer.
 */
function mockEvmSignerNoLedger(): void {
  vi.doMock("../src/signers/contacts/evm.js", () => ({
    pickEvmAnchor: vi.fn(async () => {
      throw new Error(
        "CONTACTS_LEDGER_NOT_PAIRED: no active WalletConnect session.",
      );
    }),
    signContactsBlobEvm: vi.fn(async () => {
      throw new Error("signContactsBlobEvm should not be called when unsigned");
    }),
  }));
}

/**
 * Boilerplate every test runs: reset module cache, install the no-
 * Ledger mock, reset the in-memory + anchor state, and re-import the
 * fresh contacts module. Ordering matters — module-cache reset has
 * to come before the import so the mock is consulted.
 */
async function freshContactsModule(): Promise<typeof import("../src/contacts/index.js")> {
  vi.resetModules();
  mockEvmSignerNoLedger();
  const { _resetDemoContactsForTests } = await import(
    "../src/contacts/demo-store.js"
  );
  _resetDemoContactsForTests();
  const mod = await import("../src/contacts/index.js");
  mod._resetContactsAnchorStateForTests();
  return mod;
}

const EVM_ADDR_MOM = "0xabcdef0123456789ABCDEF0123456789aBcDeF01";
const EVM_ADDR_DAD = "0x1234567890123456789012345678901234567890";

describe("addContact — fall-through to in-memory store when no Ledger paired", () => {
  it("returns unsigned: true + UNSIGNED_NO_LEDGER instead of throwing", async () => {
    const { addContact } = await freshContactsModule();
    const r = await addContact({
      chain: "evm",
      label: "Mom",
      address: EVM_ADDR_MOM,
    });
    expect(r.unsigned).toBe(true);
    expect(r.anchorAddress).toBe("UNSIGNED_NO_LEDGER");
    expect(r.version).toBe(0);
    expect(r.label).toBe("Mom");
    expect(r.address).toBe(EVM_ADDR_MOM);
  });

  it("surfaces unsigned entries via listContacts with unsigned: true flag", async () => {
    const { addContact, listContacts } = await freshContactsModule();
    await addContact({ chain: "evm", label: "Mom", address: EVM_ADDR_MOM });
    const r = await listContacts({});
    expect(r.contacts).toHaveLength(1);
    expect(r.contacts[0]).toMatchObject({
      label: "Mom",
      addresses: { evm: EVM_ADDR_MOM },
      unsigned: true,
    });
  });

  it("rejects address-format mismatches the same way the signed path does", async () => {
    const { addContact } = await freshContactsModule();
    await expect(
      addContact({
        chain: "evm",
        label: "Garbage",
        address: "definitely-not-an-evm-address",
      }),
    ).rejects.toThrow(/CONTACTS_ADDRESS_FORMAT_MISMATCH/);
  });
});

describe("removeContact — works on unsigned entries without a Ledger", () => {
  it("removes the unsigned entry and reports unsigned: true on the row", async () => {
    const { addContact, removeContact, listContacts } = await freshContactsModule();
    await addContact({ chain: "evm", label: "Mom", address: EVM_ADDR_MOM });
    const r = await removeContact({ label: "Mom" });
    expect(r.removed).toHaveLength(1);
    expect(r.removed[0]).toMatchObject({
      chain: "evm",
      address: EVM_ADDR_MOM,
      unsigned: true,
    });
    const list = await listContacts({});
    expect(list.contacts).toEqual([]);
  });

  it("throws CONTACTS_LABEL_NOT_FOUND when neither signed nor unsigned has the label", async () => {
    const { removeContact } = await freshContactsModule();
    await expect(removeContact({ label: "Ghost" })).rejects.toThrow(
      /CONTACTS_LABEL_NOT_FOUND/,
    );
  });
});

describe("verifyContacts — surfaces unsignedEntryCount alongside signed counts", () => {
  it("reports `unsigned-only` when only the in-memory store has entries", async () => {
    const { addContact, verifyContacts } = await freshContactsModule();
    await addContact({ chain: "evm", label: "Mom", address: EVM_ADDR_MOM });
    await addContact({ chain: "evm", label: "Dad", address: EVM_ADDR_DAD });
    const r = await verifyContacts({ chain: "evm" });
    expect(r.results).toHaveLength(1);
    expect(r.results[0]).toMatchObject({
      chain: "evm",
      ok: false,
      unsignedEntryCount: 2,
    });
    expect(r.results[0].reason).toMatch(/unsigned-only/);
  });
});

describe("resolveRecipient — degraded reverse-decoration via unsigned store", () => {
  it("decorates a literal address with the unsigned label + warning", async () => {
    const { addContact } = await freshContactsModule();
    const { resolveRecipient } = await import("../src/contacts/resolver.js");
    await addContact({ chain: "evm", label: "Mom", address: EVM_ADDR_MOM });
    const r = await resolveRecipient(EVM_ADDR_MOM, "ethereum");
    expect(r.address).toBe(EVM_ADDR_MOM);
    expect(r.label).toBe("Mom");
    expect(r.warnings.some((w) => /unsigned/i.test(w))).toBe(true);
  });

  it("forward-resolves an unsigned label with a warning", async () => {
    const { addContact } = await freshContactsModule();
    const { resolveRecipient } = await import("../src/contacts/resolver.js");
    await addContact({ chain: "evm", label: "Mom", address: EVM_ADDR_MOM });
    const r = await resolveRecipient("Mom", "ethereum");
    expect(r.source).toBe("contact");
    expect(r.address).toBe(EVM_ADDR_MOM);
    expect(r.label).toBe("Mom");
    expect(r.warnings.some((w) => /unsigned/i.test(w))).toBe(true);
  });
});
