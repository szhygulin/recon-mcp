import { base58ToHex } from "../../src/modules/tron/address.js";

/**
 * Test-only encoder for TRON Transaction.raw protobuf bytes. Used to give
 * fetch-stubs a realistic `raw_data_hex` so the production verifier runs
 * against well-formed input instead of toy placeholders.
 *
 * NOTE: This mirrors the wire-format assumptions the verifier makes. Keep in
 * sync with src/modules/tron/verify-raw-data.ts — if the verifier adds a new
 * contract type, this helper needs the matching encoder.
 */

const CONTRACT_TYPE = {
  TransferContract: 1,
  VoteWitnessContract: 4,
  WithdrawBalanceContract: 13,
  TriggerSmartContract: 31,
  FreezeBalanceV2Contract: 54,
  UnfreezeBalanceV2Contract: 55,
  WithdrawExpireUnfreezeContract: 56,
} as const;

const RESOURCE_ENUM: Record<"bandwidth" | "energy", number> = {
  bandwidth: 0,
  energy: 1,
};

function writeVarint(n: bigint): number[] {
  const out: number[] = [];
  let v = n;
  if (v < 0n) throw new Error("encoder: negative varint");
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return out;
}

function writeTag(fieldNum: number, wireType: number): number[] {
  return writeVarint(BigInt((fieldNum << 3) | wireType));
}

function writeVarintField(fieldNum: number, value: bigint | number): number[] {
  return [...writeTag(fieldNum, 0), ...writeVarint(BigInt(value))];
}

function writeBytesField(fieldNum: number, value: Uint8Array): number[] {
  return [
    ...writeTag(fieldNum, 2),
    ...writeVarint(BigInt(value.length)),
    ...value,
  ];
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function addrBytes(base58: string): Uint8Array {
  return hexToBytes(base58ToHex(base58));
}

function wrapContract(type: number, innerBytes: Uint8Array, typeUrl: string): Uint8Array {
  // google.protobuf.Any { type_url (1, string), value (2, bytes) }
  const anyBytes = Uint8Array.from([
    ...writeBytesField(1, Buffer.from(typeUrl, "utf8")),
    ...writeBytesField(2, innerBytes),
  ]);
  // Transaction.Contract { type (1, varint), parameter (2, bytes) }
  const contractBytes = Uint8Array.from([
    ...writeVarintField(1, type),
    ...writeBytesField(2, anyBytes),
  ]);
  return contractBytes;
}

function wrapRaw(contractBytes: Uint8Array, feeLimit?: bigint): Uint8Array {
  // Transaction.raw { expiration (8, int64), contract (11, repeated bytes),
  //                   timestamp (14, int64), fee_limit (18, int64) }
  //
  // Issue #280 added a client-side `extendRawDataExpiration` step that
  // requires fields 8 and 14 to be present (it surgically rewrites field 8
  // based on field 14). Real TronGrid responses always include both —
  // this fixture used to omit them because the verifier didn't care, but
  // the extension step does, so we now stamp realistic values: a fixed
  // timestamp (so the fixture is reproducible across test runs) and an
  // initial 60s expiration (matching TronGrid's default and giving the
  // extender a "from" value to bump).
  const FIXTURE_TIMESTAMP_MS = 1_714_128_000_000n;
  const INITIAL_EXPIRATION_MS = FIXTURE_TIMESTAMP_MS + 60_000n;
  const parts: number[] = [];
  parts.push(...writeVarintField(8, INITIAL_EXPIRATION_MS));
  parts.push(...writeBytesField(11, contractBytes));
  parts.push(...writeVarintField(14, FIXTURE_TIMESTAMP_MS));
  if (feeLimit !== undefined) parts.push(...writeVarintField(18, feeLimit));
  return Uint8Array.from(parts);
}

function toHex(u: Uint8Array): string {
  return Buffer.from(u).toString("hex");
}

export function encodeTransferRawData(args: {
  from: string;
  to: string;
  amountSun: bigint;
}): string {
  const inner = Uint8Array.from([
    ...writeBytesField(1, addrBytes(args.from)),
    ...writeBytesField(2, addrBytes(args.to)),
    ...writeVarintField(3, args.amountSun),
  ]);
  return toHex(
    wrapRaw(
      wrapContract(
        CONTRACT_TYPE.TransferContract,
        inner,
        "type.googleapis.com/protocol.TransferContract"
      )
    )
  );
}

export function encodeTriggerSmartContractRawData(args: {
  from: string;
  contract: string;
  dataHex: string;
  callValue?: bigint;
  feeLimitSun?: bigint;
}): string {
  const inner = Uint8Array.from([
    ...writeBytesField(1, addrBytes(args.from)),
    ...writeBytesField(2, addrBytes(args.contract)),
    ...(args.callValue && args.callValue !== 0n
      ? writeVarintField(3, args.callValue)
      : []),
    ...writeBytesField(4, hexToBytes(args.dataHex)),
  ]);
  return toHex(
    wrapRaw(
      wrapContract(
        CONTRACT_TYPE.TriggerSmartContract,
        inner,
        "type.googleapis.com/protocol.TriggerSmartContract"
      ),
      args.feeLimitSun
    )
  );
}

export function encodeVoteWitnessRawData(args: {
  from: string;
  votes: ReadonlyArray<{ address: string; count: number }>;
}): string {
  const voteFields: number[] = [];
  for (const v of args.votes) {
    const voteInner = Uint8Array.from([
      ...writeBytesField(1, addrBytes(v.address)),
      ...writeVarintField(2, v.count),
    ]);
    voteFields.push(...writeBytesField(2, voteInner));
  }
  const inner = Uint8Array.from([
    ...writeBytesField(1, addrBytes(args.from)),
    ...voteFields,
  ]);
  return toHex(
    wrapRaw(
      wrapContract(
        CONTRACT_TYPE.VoteWitnessContract,
        inner,
        "type.googleapis.com/protocol.VoteWitnessContract"
      )
    )
  );
}

export function encodeFreezeV2RawData(args: {
  from: string;
  frozenBalanceSun: bigint;
  resource: "bandwidth" | "energy";
}): string {
  const inner = Uint8Array.from([
    ...writeBytesField(1, addrBytes(args.from)),
    ...writeVarintField(2, args.frozenBalanceSun),
    ...writeVarintField(3, RESOURCE_ENUM[args.resource]),
  ]);
  return toHex(
    wrapRaw(
      wrapContract(
        CONTRACT_TYPE.FreezeBalanceV2Contract,
        inner,
        "type.googleapis.com/protocol.FreezeBalanceV2Contract"
      )
    )
  );
}

export function encodeUnfreezeV2RawData(args: {
  from: string;
  unfreezeBalanceSun: bigint;
  resource: "bandwidth" | "energy";
}): string {
  const inner = Uint8Array.from([
    ...writeBytesField(1, addrBytes(args.from)),
    ...writeVarintField(2, args.unfreezeBalanceSun),
    ...writeVarintField(3, RESOURCE_ENUM[args.resource]),
  ]);
  return toHex(
    wrapRaw(
      wrapContract(
        CONTRACT_TYPE.UnfreezeBalanceV2Contract,
        inner,
        "type.googleapis.com/protocol.UnfreezeBalanceV2Contract"
      )
    )
  );
}

export function encodeOwnerOnlyRawData(args: {
  kind: "withdraw_expire_unfreeze" | "claim_rewards";
  from: string;
}): string {
  const type =
    args.kind === "withdraw_expire_unfreeze"
      ? CONTRACT_TYPE.WithdrawExpireUnfreezeContract
      : CONTRACT_TYPE.WithdrawBalanceContract;
  const typeUrl =
    args.kind === "withdraw_expire_unfreeze"
      ? "type.googleapis.com/protocol.WithdrawExpireUnfreezeContract"
      : "type.googleapis.com/protocol.WithdrawBalanceContract";
  const inner = Uint8Array.from([...writeBytesField(1, addrBytes(args.from))]);
  return toHex(wrapRaw(wrapContract(type, inner, typeUrl)));
}
