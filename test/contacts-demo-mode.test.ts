import { describe, it, expect, beforeEach, afterEach } from "vitest";

/**
 * Demo-mode address book — `add_contact` / `remove_contact` /
 * `list_contacts` / `verify_contacts` route to an in-memory demo
 * store when `VAULTPILOT_DEMO=true`. Unsigned by design (no Ledger
 * available in demo mode). Lost on process restart.
 *
 * Pinned invariants:
 *   - addContact in demo writes to the in-memory store, no signing,
 *     no disk write
 *   - all four chains (btc/evm/solana/tron) addressable from day one
 *     in demo (vs. production v1's btc+evm-only)
 *   - addContact rejects malformed addresses up-front
 *   - addContact rejects duplicate-address-different-label
 *   - removeContact removes from one chain or all (matches production)
 *   - listContacts joins by label across chains (matches production
 *     shape)
 *   - verifyContacts in demo returns a count + the DEMO_ANCHOR
 *     sentinel so callers can distinguish from a signed verify
 *   - resolveRecipient label-lookup hits the demo store
 *   - resolveRecipient reverse-lookup decorates literal addresses with
 *     the demo label
 *   - exiting demo mode (unsetting the env var) makes the production
 *     path fire again (demo store is invisible from real mode)
 */

beforeEach(async () => {
  // Re-import a fresh copy of the contacts module + demo store for
  // every test so the in-memory `store` is clean.
  const { _resetDemoContactsForTests } = await import(
    "../src/contacts/demo-store.js"
  );
  _resetDemoContactsForTests();
  process.env.VAULTPILOT_DEMO = "true";
});

afterEach(() => {
  delete process.env.VAULTPILOT_DEMO;
});

describe("demo-mode address book — addContact", () => {
  it("writes to the in-memory store with no signing required", async () => {
    const { addContact, listContacts } = await import("../src/contacts/index.js");
    const result = await addContact({
      chain: "evm",
      label: "Mom",
      address: "0xabcdef0123456789ABCDEF0123456789aBcDeF01",
    });
    expect(result.label).toBe("Mom");
    expect(result.address).toBe("0xabcdef0123456789ABCDEF0123456789aBcDeF01");
    expect(result.anchorAddress).toBe("DEMO_ANCHOR");
    expect(result.version).toBe(0);

    const list = await listContacts({});
    expect(list.contacts).toHaveLength(1);
    expect(list.contacts[0].label).toBe("Mom");
    expect(list.contacts[0].addresses.evm).toBe(
      "0xabcdef0123456789ABCDEF0123456789aBcDeF01",
    );
  });

  it("supports all four chains in demo (btc/evm/solana/tron)", async () => {
    const { addContact, listContacts } = await import("../src/contacts/index.js");
    await addContact({
      chain: "btc",
      label: "Alice",
      address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
    });
    await addContact({
      chain: "evm",
      label: "Alice",
      address: "0xabcdef0123456789ABCDEF0123456789aBcDeF01",
    });
    await addContact({
      chain: "solana",
      label: "Alice",
      address: "DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1",
    });
    await addContact({
      chain: "tron",
      label: "Alice",
      address: "TLPpXqMWoyLgQqGv1J7jVmzAMQVYQ8XQVy",
    });
    const list = await listContacts({ label: "Alice" });
    expect(list.contacts).toHaveLength(1);
    const alice = list.contacts[0];
    expect(alice.addresses.btc).toBeDefined();
    expect(alice.addresses.evm).toBeDefined();
    expect(alice.addresses.solana).toBeDefined();
    expect(alice.addresses.tron).toBeDefined();
  });

  it("rejects malformed addresses up-front", async () => {
    const { addContact } = await import("../src/contacts/index.js");
    await expect(
      addContact({
        chain: "evm",
        label: "Bob",
        address: "definitely-not-an-address",
      }),
    ).rejects.toThrow(/CONTACTS_ADDRESS_FORMAT_MISMATCH/);
  });

  it("rejects a different label mapping to an already-saved address (duplicate-address)", async () => {
    const { addContact } = await import("../src/contacts/index.js");
    await addContact({
      chain: "evm",
      label: "Mom",
      address: "0xabcdef0123456789ABCDEF0123456789aBcDeF01",
    });
    await expect(
      addContact({
        chain: "evm",
        label: "Dad",
        address: "0xabcdef0123456789ABCDEF0123456789aBcDeF01",
      }),
    ).rejects.toThrow(/CONTACTS_DUPLICATE_ADDRESS/);
  });

  it("replaces (not duplicates) when the same label is added twice on the same chain", async () => {
    const { addContact, listContacts } = await import("../src/contacts/index.js");
    await addContact({
      chain: "evm",
      label: "Mom",
      address: "0x1111111111111111111111111111111111111111",
    });
    await addContact({
      chain: "evm",
      label: "Mom",
      address: "0x2222222222222222222222222222222222222222",
    });
    const list = await listContacts({});
    expect(list.contacts).toHaveLength(1);
    expect(list.contacts[0].addresses.evm).toBe(
      "0x2222222222222222222222222222222222222222",
    );
  });
});

describe("demo-mode address book — removeContact", () => {
  it("removes a label from one chain when chain is specified", async () => {
    const { addContact, removeContact, listContacts } = await import(
      "../src/contacts/index.js"
    );
    await addContact({
      chain: "evm",
      label: "Mom",
      address: "0xabcdef0123456789ABCDEF0123456789aBcDeF01",
    });
    await addContact({
      chain: "btc",
      label: "Mom",
      address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
    });
    const result = await removeContact({ label: "Mom", chain: "evm" });
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0].chain).toBe("evm");

    const list = await listContacts({});
    expect(list.contacts[0].addresses.evm).toBeUndefined();
    expect(list.contacts[0].addresses.btc).toBeDefined();
  });

  it("removes a label from every chain when chain is omitted", async () => {
    const { addContact, removeContact, listContacts } = await import(
      "../src/contacts/index.js"
    );
    await addContact({
      chain: "evm",
      label: "Mom",
      address: "0xabcdef0123456789ABCDEF0123456789aBcDeF01",
    });
    await addContact({
      chain: "btc",
      label: "Mom",
      address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
    });
    const result = await removeContact({ label: "Mom" });
    expect(result.removed.length).toBeGreaterThanOrEqual(2);
    const list = await listContacts({});
    expect(list.contacts).toHaveLength(0);
  });

  it("throws CONTACTS_LABEL_NOT_FOUND when no chain has the label", async () => {
    const { removeContact } = await import("../src/contacts/index.js");
    await expect(
      removeContact({ label: "Nobody" }),
    ).rejects.toThrow(/CONTACTS_LABEL_NOT_FOUND/);
  });
});

describe("demo-mode address book — verifyContacts", () => {
  it("returns the DEMO_ANCHOR sentinel + a count per populated chain", async () => {
    const { addContact, verifyContacts } = await import(
      "../src/contacts/index.js"
    );
    await addContact({
      chain: "evm",
      label: "Mom",
      address: "0xabcdef0123456789ABCDEF0123456789aBcDeF01",
    });
    const v = await verifyContacts({});
    const evmRow = v.results.find((r) => r.chain === "evm");
    expect(evmRow?.ok).toBe(true);
    expect(evmRow?.anchorAddress).toBe("DEMO_ANCHOR");
    expect(evmRow?.entryCount).toBe(1);
    // Empty chains report ok=false with the human reason.
    const btcRow = v.results.find((r) => r.chain === "btc");
    expect(btcRow?.ok).toBe(false);
    expect(btcRow?.reason).toMatch(/no entries/);
  });
});

describe("demo-mode address book — resolveRecipient", () => {
  it("resolves a demo label to the stored address (forward lookup)", async () => {
    const { addContact } = await import("../src/contacts/index.js");
    const { resolveRecipient } = await import(
      "../src/contacts/resolver.js"
    );
    await addContact({
      chain: "evm",
      label: "Mom",
      address: "0xabcdef0123456789ABCDEF0123456789aBcDeF01",
    });
    const r = await resolveRecipient("Mom", "ethereum");
    expect(r.address).toBe("0xabcdef0123456789ABCDEF0123456789aBcDeF01");
    expect(r.source).toBe("contact");
    expect(r.label).toBe("Mom");
  });

  it("decorates a literal address with the matching demo label (reverse lookup)", async () => {
    const { addContact } = await import("../src/contacts/index.js");
    const { resolveRecipient } = await import(
      "../src/contacts/resolver.js"
    );
    await addContact({
      chain: "evm",
      label: "Mom",
      address: "0xabcdef0123456789ABCDEF0123456789aBcDeF01",
    });
    const r = await resolveRecipient(
      "0xABCDEF0123456789ABCDEF0123456789ABCDEF01", // upper-case input
      "ethereum",
    );
    expect(r.address).toBe("0xABCDEF0123456789ABCDEF0123456789ABCDEF01");
    expect(r.source).toBe("literal");
    expect(r.label).toBe("Mom");
  });

  it("supports Solana label resolution in demo (production v1 doesn't)", async () => {
    const { addContact } = await import("../src/contacts/index.js");
    const { resolveRecipient } = await import(
      "../src/contacts/resolver.js"
    );
    await addContact({
      chain: "solana",
      label: "Alice",
      address: "DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1",
    });
    const r = await resolveRecipient("Alice", "solana");
    expect(r.address).toBe("DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1");
    expect(r.source).toBe("contact");
  });

  it("returns source=unknown when the label has no match", async () => {
    const { resolveRecipient } = await import(
      "../src/contacts/resolver.js"
    );
    const r = await resolveRecipient("Nobody", "ethereum");
    expect(r.source).toBe("unknown");
  });
});

describe("demo store isolation from production", () => {
  it("does NOT touch disk — demo entries don't appear in the production-mode list", async () => {
    const { addContact } = await import("../src/contacts/index.js");
    await addContact({
      chain: "evm",
      label: "DemoMom",
      address: "0xabcdef0123456789ABCDEF0123456789aBcDeF01",
    });
    // Switch out of demo mode and try the production reader. The
    // production path reads from disk via `readContactsStrict`; the
    // demo-only entry was never written there, so it should be absent.
    delete process.env.VAULTPILOT_DEMO;
    const { listContacts } = await import("../src/contacts/index.js");
    // Production path will throw on no-file or return an empty list
    // depending on storage state. Either way, "DemoMom" must NOT be
    // present.
    try {
      const list = await listContacts({});
      const labels = list.contacts.map((c) => c.label);
      expect(labels).not.toContain("DemoMom");
    } catch (err) {
      // Production-mode read may throw because no contacts file exists
      // in the test environment — that's also a valid "demo entry not
      // leaked" outcome.
      expect((err as Error).message).not.toContain("DemoMom");
    }
  });
});
