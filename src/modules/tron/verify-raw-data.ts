import { base58ToHex } from "./address.js";

/**
 * Local verification of the `raw_data_hex` that TronGrid returns and that the
 * Ledger will ultimately sign. TronGrid is a trusted service in practice, but
 * we don't want to rely on that trust alone: a compromised or MITM'd TronGrid
 * could return a `raw_data_hex` that doesn't match the request we made (e.g.
 * swap `to_address` for an attacker's wallet) while returning a benign
 * `raw_data` JSON structure alongside. The Ledger screen would catch it, but
 * the agent-visible preview would lie.
 *
 * This module decodes the protobuf wire form ourselves and asserts every
 * field the builder specified is present verbatim. Scope: exactly the
 * contract types we build in actions.ts / staking.ts / witnesses.ts.
 */

// --- Wire-format primitives (just what we need for Transaction.raw) --------

interface DecodedField {
  // wire type 0 | 1 | 5 carry a numeric payload; we keep it as bigint for
  // int64 safety.
  varint?: bigint;
  // wire type 2 carries length-delimited bytes.
  bytes?: Uint8Array;
}

type FieldMap = Map<number, DecodedField[]>;

function readVarint(buf: Uint8Array, offset: number): { value: bigint; next: number } {
  let result = 0n;
  let shift = 0n;
  let next = offset;
  for (;;) {
    if (next >= buf.length) throw new Error("TRON rawData verify: truncated varint");
    const b = buf[next++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
    if (shift > 70n) throw new Error("TRON rawData verify: varint overflow");
  }
  return { value: result, next };
}

function parseProtobuf(buf: Uint8Array): FieldMap {
  const map: FieldMap = new Map();
  let offset = 0;
  while (offset < buf.length) {
    const { value: tag, next } = readVarint(buf, offset);
    offset = next;
    const fieldNum = Number(tag >> 3n);
    const wireType = Number(tag & 0x7n);
    let decoded: DecodedField;
    if (wireType === 0) {
      const v = readVarint(buf, offset);
      offset = v.next;
      decoded = { varint: v.value };
    } else if (wireType === 2) {
      const l = readVarint(buf, offset);
      offset = l.next;
      const len = Number(l.value);
      if (offset + len > buf.length) {
        throw new Error("TRON rawData verify: length-delimited field overruns buffer");
      }
      decoded = { bytes: buf.subarray(offset, offset + len) };
      offset += len;
    } else if (wireType === 1) {
      if (offset + 8 > buf.length) throw new Error("TRON rawData verify: truncated fixed64");
      let v = 0n;
      for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(buf[offset + i]);
      offset += 8;
      decoded = { varint: v };
    } else if (wireType === 5) {
      if (offset + 4 > buf.length) throw new Error("TRON rawData verify: truncated fixed32");
      let v = 0n;
      for (let i = 3; i >= 0; i--) v = (v << 8n) | BigInt(buf[offset + i]);
      offset += 4;
      decoded = { varint: v };
    } else {
      throw new Error(`TRON rawData verify: unsupported wire type ${wireType}`);
    }
    const arr = map.get(fieldNum) ?? [];
    arr.push(decoded);
    map.set(fieldNum, arr);
  }
  return map;
}

function requireBytes(fields: FieldMap, tag: number, label: string): Uint8Array {
  const arr = fields.get(tag);
  if (!arr || arr.length === 0 || !arr[0].bytes) {
    throw new Error(`TRON rawData verify: missing ${label} (tag ${tag})`);
  }
  return arr[0].bytes;
}

function optionalBytes(fields: FieldMap, tag: number): Uint8Array | undefined {
  const arr = fields.get(tag);
  if (!arr || arr.length === 0) return undefined;
  return arr[0].bytes;
}

function optionalVarint(fields: FieldMap, tag: number): bigint {
  const arr = fields.get(tag);
  if (!arr || arr.length === 0 || arr[0].varint === undefined) return 0n;
  return arr[0].varint;
}

function toHex(u: Uint8Array): string {
  return Buffer.from(u).toString("hex");
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error("TRON rawData verify: raw_data_hex is not valid hex");
  }
  return Uint8Array.from(Buffer.from(clean, "hex"));
}

// --- Contract-type constants (Transaction.Contract.ContractType enum) ------

const CONTRACT_TYPE = {
  TransferContract: 1,
  VoteWitnessContract: 4,
  WithdrawBalanceContract: 13,
  TriggerSmartContract: 31,
  FreezeBalanceV2Contract: 54,
  UnfreezeBalanceV2Contract: 55,
  WithdrawExpireUnfreezeContract: 56,
} as const;

// TRON's ResourceCode enum: 0 = BANDWIDTH, 1 = ENERGY, 2 = TRON_POWER.
// We only expose bandwidth/energy at the builder surface.
const RESOURCE_ENUM: Record<"bandwidth" | "energy", bigint> = {
  bandwidth: 0n,
  energy: 1n,
};

// --- Public expectation shapes ---------------------------------------------

export type TronRawDataExpectation =
  | { kind: "native_send"; from: string; to: string; amountSun: bigint }
  | {
      kind: "trc20_send";
      from: string;
      contract: string;
      parameterHex: string;
      feeLimitSun?: bigint;
      callValue?: bigint;
    }
  | {
      kind: "trc20_approve";
      from: string;
      contract: string;
      parameterHex: string;
      feeLimitSun?: bigint;
      callValue?: bigint;
    }
  | {
      kind: "vote";
      from: string;
      votes: ReadonlyArray<{ address: string; count: number }>;
    }
  | {
      kind: "freeze";
      from: string;
      frozenBalanceSun: bigint;
      resource: "bandwidth" | "energy";
    }
  | {
      kind: "unfreeze";
      from: string;
      unfreezeBalanceSun: bigint;
      resource: "bandwidth" | "energy";
    }
  | { kind: "withdraw_expire_unfreeze"; from: string }
  | { kind: "claim_rewards"; from: string };

// --- Main entry point ------------------------------------------------------

/**
 * Throws if `rawDataHex` doesn't encode exactly the transaction the builder
 * asked TronGrid to create. Call once per builder immediately before
 * `issueTronHandle`.
 */
export function assertTronRawDataMatches(
  rawDataHex: string,
  expected: TronRawDataExpectation
): void {
  const buf = hexToBytes(rawDataHex);
  const raw = parseProtobuf(buf);

  // Transaction.raw.contract (repeated, tag 11). We only ever build single-
  // contract transactions; multi-contract raw_data is suspicious.
  const contracts = raw.get(11) ?? [];
  if (contracts.length !== 1) {
    throw new Error(
      `TRON rawData verify: expected exactly 1 contract, got ${contracts.length}. ` +
        `Refusing to sign a multi-contract transaction built by prepare_tron_*.`
    );
  }
  const contractBytes = contracts[0].bytes;
  if (!contractBytes) throw new Error("TRON rawData verify: contract[0] not length-delimited");

  // Transaction.Contract { type (1, enum), parameter (2, Any) }
  const contract = parseProtobuf(contractBytes);
  const typeField = contract.get(1)?.[0];
  if (!typeField || typeField.varint === undefined) {
    throw new Error("TRON rawData verify: contract.type missing");
  }
  const type = Number(typeField.varint);
  const parameterBytes = requireBytes(contract, 2, "contract.parameter");

  // google.protobuf.Any { type_url (1, string), value (2, bytes) }
  const anyFields = parseProtobuf(parameterBytes);
  const innerBytes = requireBytes(anyFields, 2, "Any.value");
  const inner = parseProtobuf(innerBytes);

  // Fee limit (tag 18 on Transaction.raw) — only meaningful for
  // TriggerSmartContract; other builders don't set it.
  const feeLimit = optionalVarint(raw, 18);

  switch (expected.kind) {
    case "native_send":
      return verifyTransfer(type, inner, expected);
    case "trc20_send":
      return verifyTriggerSmartContract(
        type,
        inner,
        expected,
        feeLimit,
        "a9059cbb",
        "transfer(address,uint256)",
      );
    case "trc20_approve":
      return verifyTriggerSmartContract(
        type,
        inner,
        expected,
        feeLimit,
        "095ea7b3",
        "approve(address,uint256)",
      );
    case "vote":
      return verifyVote(type, inner, expected);
    case "freeze":
      return verifyFreezeV2(type, inner, expected);
    case "unfreeze":
      return verifyUnfreezeV2(type, inner, expected);
    case "withdraw_expire_unfreeze":
      return verifyOwnerOnly(
        type,
        CONTRACT_TYPE.WithdrawExpireUnfreezeContract,
        inner,
        expected.from,
        "WithdrawExpireUnfreezeContract"
      );
    case "claim_rewards":
      return verifyOwnerOnly(
        type,
        CONTRACT_TYPE.WithdrawBalanceContract,
        inner,
        expected.from,
        "WithdrawBalanceContract"
      );
  }
}

// --- Per-contract verifiers ------------------------------------------------

function expectAddress(actual: Uint8Array, expectedBase58: string, label: string): void {
  const expectedHex = base58ToHex(expectedBase58);
  const actualHex = toHex(actual);
  if (actualHex.toLowerCase() !== expectedHex.toLowerCase()) {
    throw new Error(
      `TRON rawData verify: ${label} mismatch — TronGrid returned 0x${actualHex} ` +
        `but we asked for ${expectedBase58} (0x${expectedHex}). Refusing to sign.`
    );
  }
}

function expectType(actual: number, want: number, label: string): void {
  if (actual !== want) {
    throw new Error(
      `TRON rawData verify: contract type mismatch — expected ${label} (${want}), got ${actual}. ` +
        `TronGrid returned a different contract type than requested.`
    );
  }
}

function verifyTransfer(
  type: number,
  inner: FieldMap,
  e: Extract<TronRawDataExpectation, { kind: "native_send" }>
): void {
  expectType(type, CONTRACT_TYPE.TransferContract, "TransferContract");
  expectAddress(requireBytes(inner, 1, "TransferContract.owner_address"), e.from, "owner_address");
  expectAddress(requireBytes(inner, 2, "TransferContract.to_address"), e.to, "to_address");
  const amount = optionalVarint(inner, 3);
  if (amount !== e.amountSun) {
    throw new Error(
      `TRON rawData verify: amount mismatch — raw_data_hex has ${amount} sun, ` +
        `we asked for ${e.amountSun} sun. Refusing to sign.`
    );
  }
}

function verifyTriggerSmartContract(
  type: number,
  inner: FieldMap,
  e: Extract<TronRawDataExpectation, { kind: "trc20_send" | "trc20_approve" }>,
  actualFeeLimit: bigint,
  expectedSelector: string,
  selectorLabel: string,
): void {
  expectType(type, CONTRACT_TYPE.TriggerSmartContract, "TriggerSmartContract");
  expectAddress(
    requireBytes(inner, 1, "TriggerSmartContract.owner_address"),
    e.from,
    "owner_address"
  );
  expectAddress(
    requireBytes(inner, 2, "TriggerSmartContract.contract_address"),
    e.contract,
    "contract_address"
  );
  // call_value — default 0 if absent.
  const callValue = optionalVarint(inner, 3);
  if (callValue !== (e.callValue ?? 0n)) {
    throw new Error(
      `TRON rawData verify: call_value mismatch — raw_data_hex has ${callValue}, ` +
        `we asked for ${e.callValue ?? 0n}.`
    );
  }
  // data — function selector + ABI-encoded params.
  const dataBytes = optionalBytes(inner, 4) ?? new Uint8Array();
  const dataHex = toHex(dataBytes).toLowerCase();
  // Builder's `parameterHex` is the ABI param payload WITHOUT the 4-byte
  // selector. TronGrid prepends the function selector to produce the full
  // calldata. Compare on selector + suffix to catch BOTH selector swap
  // (transfer ↔ approve) and parameter tampering.
  const expectedParam = e.parameterHex.toLowerCase();
  const expectedFullData = expectedSelector + expectedParam;
  if (dataHex !== expectedFullData) {
    throw new Error(
      `TRON rawData verify: TriggerSmartContract.data mismatch (expected ${selectorLabel}) — ` +
        `got 0x${dataHex}, expected 0x${expectedFullData}. Refusing to sign.`
    );
  }
  if (e.feeLimitSun !== undefined && actualFeeLimit !== e.feeLimitSun) {
    throw new Error(
      `TRON rawData verify: fee_limit mismatch — raw_data_hex has ${actualFeeLimit} sun, ` +
        `we asked for ${e.feeLimitSun} sun.`
    );
  }
}

function verifyVote(
  type: number,
  inner: FieldMap,
  e: Extract<TronRawDataExpectation, { kind: "vote" }>
): void {
  expectType(type, CONTRACT_TYPE.VoteWitnessContract, "VoteWitnessContract");
  expectAddress(requireBytes(inner, 1, "VoteWitnessContract.owner_address"), e.from, "owner_address");
  const voteFields = inner.get(2) ?? [];
  if (voteFields.length !== e.votes.length) {
    throw new Error(
      `TRON rawData verify: vote count mismatch — raw_data_hex has ${voteFields.length} ` +
        `entries, we asked for ${e.votes.length}.`
    );
  }
  // Vote order must match what we sent — TronGrid preserves it.
  for (let i = 0; i < e.votes.length; i++) {
    const voteBytes = voteFields[i].bytes;
    if (!voteBytes) throw new Error(`TRON rawData verify: vote[${i}] not length-delimited`);
    const v = parseProtobuf(voteBytes);
    expectAddress(requireBytes(v, 1, `vote[${i}].vote_address`), e.votes[i].address, `vote[${i}].address`);
    const count = optionalVarint(v, 2);
    if (count !== BigInt(e.votes[i].count)) {
      throw new Error(
        `TRON rawData verify: vote[${i}].vote_count mismatch — raw_data_hex has ${count}, ` +
          `we asked for ${e.votes[i].count}.`
      );
    }
  }
}

function verifyFreezeV2(
  type: number,
  inner: FieldMap,
  e: Extract<TronRawDataExpectation, { kind: "freeze" }>
): void {
  expectType(type, CONTRACT_TYPE.FreezeBalanceV2Contract, "FreezeBalanceV2Contract");
  expectAddress(requireBytes(inner, 1, "FreezeBalanceV2Contract.owner_address"), e.from, "owner_address");
  const frozen = optionalVarint(inner, 2);
  if (frozen !== e.frozenBalanceSun) {
    throw new Error(
      `TRON rawData verify: frozen_balance mismatch — raw_data_hex has ${frozen} sun, ` +
        `we asked for ${e.frozenBalanceSun} sun.`
    );
  }
  const resource = optionalVarint(inner, 3);
  if (resource !== RESOURCE_ENUM[e.resource]) {
    throw new Error(
      `TRON rawData verify: resource mismatch — raw_data_hex has enum ${resource}, ` +
        `we asked for "${e.resource}" (${RESOURCE_ENUM[e.resource]}).`
    );
  }
}

function verifyUnfreezeV2(
  type: number,
  inner: FieldMap,
  e: Extract<TronRawDataExpectation, { kind: "unfreeze" }>
): void {
  expectType(type, CONTRACT_TYPE.UnfreezeBalanceV2Contract, "UnfreezeBalanceV2Contract");
  expectAddress(
    requireBytes(inner, 1, "UnfreezeBalanceV2Contract.owner_address"),
    e.from,
    "owner_address"
  );
  const unfreeze = optionalVarint(inner, 2);
  if (unfreeze !== e.unfreezeBalanceSun) {
    throw new Error(
      `TRON rawData verify: unfreeze_balance mismatch — raw_data_hex has ${unfreeze} sun, ` +
        `we asked for ${e.unfreezeBalanceSun} sun.`
    );
  }
  const resource = optionalVarint(inner, 3);
  if (resource !== RESOURCE_ENUM[e.resource]) {
    throw new Error(
      `TRON rawData verify: resource mismatch — raw_data_hex has enum ${resource}, ` +
        `we asked for "${e.resource}" (${RESOURCE_ENUM[e.resource]}).`
    );
  }
}

function verifyOwnerOnly(
  type: number,
  expectedType: number,
  inner: FieldMap,
  from: string,
  label: string
): void {
  expectType(type, expectedType, label);
  expectAddress(requireBytes(inner, 1, `${label}.owner_address`), from, "owner_address");
}

// --- LiFi-specific extractor ----------------------------------------------

/**
 * Decode just enough of a TRON `raw_data_hex` to expose the
 * `TriggerSmartContract` envelope. Used by the LiFi-on-TRON flow to
 * cross-check that LiFi's response targets the LiFi Diamond contract on
 * TRON and to extract the inner ABI calldata for the universal
 * `BridgeData` decoder. Mirrors the structural assertions in
 * `assertTronRawDataMatches` for `kind: "trc20_send"` but returns the
 * raw fields to the caller rather than asserting against a fixed
 * expectation.
 *
 * Throws if the contract type isn't TriggerSmartContract or the protobuf
 * is malformed.
 */
export interface DecodedTronTriggerSmartContract {
  /** Hex string (no 0x prefix) of the owner_address — 21 bytes including `41` TRON prefix. */
  ownerAddressHex: string;
  /** Hex string (no 0x prefix) of the contract_address — 21 bytes. */
  contractAddressHex: string;
  /** ABI calldata (selector + args) the call invokes on the contract. */
  dataHex: `0x${string}`;
  /** Native TRX value passed with the call (typically 0 for TRC-20 swaps; non-zero for TRX-source). */
  callValueSun: bigint;
  /** Fee limit in SUN — bound on the energy burn for this call. */
  feeLimitSun: bigint;
}

export function decodeTronTriggerSmartContract(
  rawDataHex: string,
): DecodedTronTriggerSmartContract {
  const buf = hexToBytes(rawDataHex);
  const raw = parseProtobuf(buf);
  const contracts = raw.get(11) ?? [];
  if (contracts.length !== 1) {
    throw new Error(
      `TRON raw_data_hex must have exactly 1 contract, got ${contracts.length}. ` +
        `LiFi-routed TRON txs are single-contract by design.`,
    );
  }
  const contractBytes = contracts[0].bytes;
  if (!contractBytes) {
    throw new Error("TRON raw_data_hex: contract[0] not length-delimited");
  }
  const contract = parseProtobuf(contractBytes);
  const typeField = contract.get(1)?.[0];
  if (!typeField || typeField.varint === undefined) {
    throw new Error("TRON raw_data_hex: contract.type missing");
  }
  const type = Number(typeField.varint);
  if (type !== CONTRACT_TYPE.TriggerSmartContract) {
    throw new Error(
      `TRON raw_data_hex: expected TriggerSmartContract (${CONTRACT_TYPE.TriggerSmartContract}), got contract type ${type}. ` +
        `LiFi-routed TRON txs are always smart-contract calls; refusing.`,
    );
  }
  const parameterBytes = requireBytes(contract, 2, "contract.parameter");
  const anyFields = parseProtobuf(parameterBytes);
  const innerBytes = requireBytes(anyFields, 2, "Any.value");
  const inner = parseProtobuf(innerBytes);

  const ownerAddress = requireBytes(inner, 1, "TriggerSmartContract.owner_address");
  const contractAddress = requireBytes(inner, 2, "TriggerSmartContract.contract_address");
  const callValueSun = optionalVarint(inner, 3);
  const dataBytes = optionalBytes(inner, 4) ?? new Uint8Array();
  const feeLimitSun = optionalVarint(raw, 18);

  return {
    ownerAddressHex: toHex(ownerAddress),
    contractAddressHex: toHex(contractAddress),
    dataHex: ("0x" + toHex(dataBytes)) as `0x${string}`,
    callValueSun,
    feeLimitSun,
  };
}
