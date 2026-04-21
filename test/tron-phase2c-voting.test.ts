import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { listTronWitnesses } from "../src/modules/tron/witnesses.js";
import { buildTronVote } from "../src/modules/tron/actions.js";
import { hasTronHandle } from "../src/signing/tron-tx-store.js";
import { encodeVoteWitnessRawData } from "./helpers/tron-raw-data-encode.js";
import { maybeTronBandwidthResponse } from "./helpers/tron-bandwidth-mock.js";

/**
 * Phase-2c (TRON voting) tests. Covers:
 *   - SR ranking + active/candidate split + APR math against a fixed synthetic set
 *   - Per-wallet augmentation (userVotes, totalTronPower, availableVotes)
 *   - VoteWitness builder body shape, dedupe, positive-integer-count guards,
 *     TronGrid error surfacing, and clear-all-votes (empty array) semantics
 */

const OWNER = "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7";
const SR1 = "TMuA6YqfCeX8EhbfYEg5y7S4DqzSJireY9";
const SR2 = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const SR3 = "TWGEPPwSxGNwQBefExdbVybgrsNuF47yYJ";

/**
 * Build a synthetic /wallet/listwitnesses response with 30 SRs of decreasing
 * vote weight, so the 27-active threshold actually gets tested. Addresses
 * don't need to be unique to the point of chain reality — base58 regex is
 * all the reader validates.
 */
function fakeWitnessList(): { witnesses: Array<{ address: string; voteCount: number; url?: string; totalProduced?: number; totalMissed?: number }> } {
  // Use our three known-valid base58 addresses as the top 3, then fill the
  // remaining 27 with deterministic variants. All 30 still need to be valid
  // TRON addresses (base58check) — easiest is to just reuse SR1 for the tail
  // since listTronWitnesses only checks each is a string and doesn't enforce
  // uniqueness (TronGrid wouldn't serve dupes on real mainnet).
  const top = [
    { address: SR1, voteCount: 5_000_000_000, url: "https://sr1.example", totalProduced: 1000, totalMissed: 1 },
    { address: SR2, voteCount: 3_000_000_000, url: "https://sr2.example", totalProduced: 800 },
    { address: SR3, voteCount: 1_000_000_000 },
  ];
  const tail = Array.from({ length: 27 }, (_, i) => ({
    address: SR1,
    voteCount: 1_000_000 - i, // strictly decreasing, well below the top 3
  }));
  return { witnesses: [...top, ...tail] };
}

describe("listTronWitnesses (network stubbed)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "https://api.trongrid.io/wallet/listwitnesses?visible=true") {
          return new Response(JSON.stringify(fakeWitnessList()), { status: 200 });
        }
        if (url.startsWith("https://api.trongrid.io/v1/accounts/")) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  address: OWNER,
                  votes: [
                    { vote_address: SR1, vote_count: 100 },
                    { vote_address: SR2, vote_count: 50 },
                  ],
                  frozenV2: [
                    { amount: 200_000_000, type: "BANDWIDTH" }, // 200 TRX
                    { amount: 50_000_000, type: "ENERGY" }, // 50 TRX
                  ],
                },
              ],
            }),
            { status: 200 }
          );
        }
        throw new Error(`Unexpected fetch: ${url}`);
      })
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns only the top 27 active SRs by default, ranked by voteCount DESC", async () => {
    const list = await listTronWitnesses();
    expect(list.witnesses).toHaveLength(27);
    // All active.
    expect(list.witnesses.every((w) => w.isActive)).toBe(true);
    // Top-ranked entry is SR1 (highest voteCount).
    expect(list.witnesses[0].address).toBe(SR1);
    expect(list.witnesses[0].rank).toBe(1);
    // userVotes-related fields absent when no address passed.
    expect(list.userVotes).toBeUndefined();
    expect(list.totalTronPower).toBeUndefined();
  });

  it("includes candidates when includeCandidates=true, and top-127 candidates share the same APR as active SRs", async () => {
    const list = await listTronWitnesses(undefined, true);
    expect(list.witnesses.length).toBeGreaterThan(27);
    const candidate = list.witnesses.find((w) => !w.isActive);
    expect(candidate).toBeDefined();
    expect(candidate!.rank).toBeGreaterThan(27);
    // All 30 witnesses in the fake list fall inside top-127 so they all get
    // the same (non-zero) APR — the split is "top 127 earn pool, rest get 0",
    // not "active earn, candidates don't".
    expect(candidate!.estVoterApr).toBeGreaterThan(0);
    expect(candidate!.estVoterApr).toBe(list.witnesses[0].estVoterApr);
  });

  it("computes voter APR as 160 TRX/block pool ÷ total top-127 vote weight", async () => {
    const list = await listTronWitnesses();
    const top = list.witnesses[0];
    // Fake set total top-127 votes = top3 (9e9) + 27 tail entries summing
    // to Σ_{i=0..26}(1_000_000 - i) = 27 * 1_000_000 - (0+1+...+26)
    // = 27_000_000 - 351 = 26_999_649.
    const totalTop127 = 5_000_000_000 + 3_000_000_000 + 1_000_000_000 + 26_999_649;
    const expected = (160 * 28800 * 365) / totalTop127;
    expect(top.estVoterApr).toBeCloseTo(expected, 10);
    // The APR is uniform across all active SRs under this model.
    for (const w of list.witnesses) {
      expect(w.estVoterApr).toBeCloseTo(expected, 10);
    }
  });

  it("augments the response with userVotes / totalTronPower / availableVotes when address is passed", async () => {
    const list = await listTronWitnesses(OWNER);
    expect(list.userVotes).toEqual([
      { address: SR1, count: 100 },
      { address: SR2, count: 50 },
    ]);
    // 200 + 50 = 250 TRX frozen → 250 vote units.
    expect(list.totalTronPower).toBe(250);
    expect(list.totalVotesCast).toBe(150);
    expect(list.availableVotes).toBe(100);
  });

  it("clamps availableVotes to 0 when cast > power (edge case; shouldn't happen on-chain but be defensive)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("https://api.trongrid.io/wallet/listwitnesses")) {
          return new Response(JSON.stringify(fakeWitnessList()), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            data: [
              {
                votes: [{ vote_address: SR1, vote_count: 999 }],
                frozenV2: [{ amount: 100_000_000, type: "BANDWIDTH" }], // 100 TRX
              },
            ],
          }),
          { status: 200 }
        );
      })
    );
    const list = await listTronWitnesses(OWNER);
    expect(list.availableVotes).toBe(0);
  });

  it("rejects a malformed address", async () => {
    await expect(listTronWitnesses("0xdeadbeef")).rejects.toThrow(/TRON mainnet/);
  });
});

describe("buildTronVote (network stubbed)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const preflight = maybeTronBandwidthResponse(url);
      if (preflight) return preflight;
      expect(url).toBe("https://api.trongrid.io/wallet/votewitnessaccount");
      const body = JSON.parse(init!.body as string);
      expect(body.owner_address).toBe(OWNER);
      expect(body.visible).toBe(true);
      expect(Array.isArray(body.votes)).toBe(true);
      return new Response(
        JSON.stringify({
          txID: "cc".repeat(32),
          raw_data: { expiration: 0 },
          raw_data_hex: encodeVoteWitnessRawData({
            from: OWNER,
            votes: (body.votes as Array<{ vote_address: string; vote_count: number }>).map(
              (v) => ({ address: v.vote_address, count: v.vote_count })
            ),
          }),
          visible: true,
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("builds a multi-SR vote tx with the right body shape + handle", async () => {
    const tx = await buildTronVote({
      from: OWNER,
      votes: [
        { address: SR1, count: 100 },
        { address: SR2, count: 50 },
      ],
    });
    expect(tx.action).toBe("vote");
    expect(tx.decoded.functionName).toBe("VoteWitnessContract");
    expect(tx.description).toBe(
      "Cast 150 TRON Power across 2 SRs (replaces any prior votes)"
    );
    expect(tx.decoded.args.totalVotes).toBe("150");
    expect(hasTronHandle(tx.handle!)).toBe(true);

    // TronGrid body uses vote_address / vote_count, not our external shape.
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.votes).toEqual([
      { vote_address: SR1, vote_count: 100 },
      { vote_address: SR2, vote_count: 50 },
    ]);
  });

  it("emits a clear-votes description when votes=[]", async () => {
    const tx = await buildTronVote({ from: OWNER, votes: [] });
    expect(tx.description).toBe(`Clear all SR votes for ${OWNER}`);
    expect(tx.decoded.args.totalVotes).toBe("0");
  });

  it("rejects duplicate SR addresses in the allocation", async () => {
    await expect(
      buildTronVote({
        from: OWNER,
        votes: [
          { address: SR1, count: 100 },
          { address: SR1, count: 50 },
        ],
      })
    ).rejects.toThrow(/Duplicate vote target/);
  });

  it("rejects non-integer or non-positive counts", async () => {
    await expect(
      buildTronVote({ from: OWNER, votes: [{ address: SR1, count: 0 }] })
    ).rejects.toThrow(/positive integer/);
    await expect(
      buildTronVote({ from: OWNER, votes: [{ address: SR1, count: 1.5 }] })
    ).rejects.toThrow(/positive integer/);
  });

  it("rejects non-TRON vote targets", async () => {
    await expect(
      buildTronVote({ from: OWNER, votes: [{ address: "0xbad", count: 1 }] })
    ).rejects.toThrow(/not a valid TRON/);
  });

  it("surfaces TronGrid 'Not enough tron power' verbatim", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const preflight = maybeTronBandwidthResponse(url);
      if (preflight) return preflight;
      return new Response(
        JSON.stringify({ Error: "contract validate error : Not enough tron power" }),
        { status: 200 }
      );
    });
    await expect(
      buildTronVote({ from: OWNER, votes: [{ address: SR1, count: 999_999 }] })
    ).rejects.toThrow(/Not enough tron power/);
  });
});
