/**
 * LiFi Diamond (https://github.com/lifinance/contracts) swap-facet ABI +
 * shared bridge-data layout. The swap-facet entries cover the generic-swap
 * entry points; the BridgeData tuple is the universal first argument of
 * every `startBridgeTokensVia*` facet (across/amarok/stargate/wormhole/
 * mayan/debridge/allbridge/...) and is decoded separately by
 * `decodeLifiBridgeData` below.
 *
 * Source of truth:
 *
 *   - src/Facets/GenericSwapFacet.sol          (legacy `swapTokensGeneric`)
 *   - src/Facets/GenericSwapFacetV3.sol        (V3 single-* and multiple-* variants)
 *   - src/Libraries/LibSwap.sol                (SwapData struct)
 *   - src/Interfaces/ILiFi.sol                 (BridgeData struct — universal)
 *   - src/Helpers/LiFiData.sol                 (NON_EVM_RECEIVER sentinel)
 *
 * All on `lifinance/contracts` master, verified 2026-04-25.
 *
 * Swap selector reference (computed locally):
 *   0x4630a0d8  swapTokensGeneric                      (legacy, SwapData[])
 *   0x4666fc80  swapTokensSingleV3ERC20ToERC20         (single, SwapData)
 *   0x733214a3  swapTokensSingleV3ERC20ToNative        (single, SwapData)
 *   0xaf7060fd  swapTokensSingleV3NativeToERC20        (single, SwapData)
 *   0x5fd9ae2e  swapTokensMultipleV3ERC20ToERC20       (multi, SwapData[])
 *   0x2c57e884  swapTokensMultipleV3ERC20ToNative      (multi, SwapData[])
 *   0x736eac0b  swapTokensMultipleV3NativeToERC20      (multi, SwapData[])
 *
 * Bridge selectors are NOT enumerated — there are dozens (one per facet)
 * and they share an encoding pattern: BridgeData tuple as first arg,
 * facet-specific tuple (or bytes blob) as second arg. We decode just
 * BridgeData (which gives us bridge name, sendingAssetId, receiver,
 * minAmount, destinationChainId, etc.) and let the facet-specific data
 * fall through. For non-EVM destinations (Solana), `receiver` is the
 * sentinel `NON_EVM_RECEIVER_SENTINEL` below and the real destination
 * address is encoded inside the bridge-specific data — surfaced as a
 * clear "not decoded" flag rather than a misleading sentinel address.
 */

const swapDataTuple = {
  type: "tuple",
  name: "_swapData",
  components: [
    { name: "callTo", type: "address" },
    { name: "approveTo", type: "address" },
    { name: "sendingAssetId", type: "address" },
    { name: "receivingAssetId", type: "address" },
    { name: "fromAmount", type: "uint256" },
    { name: "callData", type: "bytes" },
    { name: "requiresDeposit", type: "bool" },
  ],
} as const;

const swapDataArray = {
  type: "tuple[]",
  name: "_swapData",
  components: swapDataTuple.components,
} as const;

const commonInputs = [
  { name: "_transactionId", type: "bytes32" },
  { name: "_integrator", type: "string" },
  { name: "_referrer", type: "string" },
  { name: "_receiver", type: "address" },
] as const;

function swapSingle(name: string, minAmountName: "_minAmountOut" | "_minAmount") {
  return {
    type: "function" as const,
    name,
    stateMutability: "payable" as const,
    inputs: [
      ...commonInputs,
      { name: minAmountName, type: "uint256" },
      swapDataTuple,
    ],
    outputs: [],
  };
}

function swapMulti(name: string, minAmountName: "_minAmountOut" | "_minAmount") {
  return {
    type: "function" as const,
    name,
    stateMutability: "payable" as const,
    inputs: [
      ...commonInputs,
      { name: minAmountName, type: "uint256" },
      swapDataArray,
    ],
    outputs: [],
  };
}

export const lifiDiamondAbi = [
  swapMulti("swapTokensGeneric", "_minAmount"),
  swapSingle("swapTokensSingleV3ERC20ToERC20", "_minAmountOut"),
  swapSingle("swapTokensSingleV3ERC20ToNative", "_minAmountOut"),
  swapSingle("swapTokensSingleV3NativeToERC20", "_minAmountOut"),
  swapMulti("swapTokensMultipleV3ERC20ToERC20", "_minAmountOut"),
  swapMulti("swapTokensMultipleV3ERC20ToNative", "_minAmountOut"),
  swapMulti("swapTokensMultipleV3NativeToERC20", "_minAmountOut"),
] as const;

/**
 * Universal first argument of every `startBridgeTokensVia*` /
 * `swapAndStartBridgeTokensVia*` facet on the LiFi Diamond. Used by
 * `decodeLifiBridgeData` to extract the bridge intent from any bridge
 * facet's calldata without enumerating every selector.
 *
 * Field ordering matches `ILiFi.BridgeData` exactly — do not reorder or
 * insert fields. ABI decoding is positional.
 */
export const LIFI_BRIDGE_DATA_TUPLE = {
  type: "tuple",
  name: "_bridgeData",
  components: [
    { name: "transactionId", type: "bytes32" },
    { name: "bridge", type: "string" },
    { name: "integrator", type: "string" },
    { name: "referrer", type: "address" },
    { name: "sendingAssetId", type: "address" },
    { name: "receiver", type: "address" },
    { name: "minAmount", type: "uint256" },
    { name: "destinationChainId", type: "uint256" },
    { name: "hasSourceSwaps", type: "bool" },
    { name: "hasDestinationCall", type: "bool" },
  ],
} as const;

/**
 * The sentinel address LiFi places in `BridgeData.receiver` when the
 * destination is non-EVM (Solana, Bitcoin, Sui, etc.). The real
 * receiver is encoded inside the bridge-specific second argument
 * (Wormhole-style `bytes32`, Mayan-style, etc.).
 *
 * Constant verified against `lifinance/contracts/src/Helpers/LiFiData.sol`
 * 2026-04-25. Lowercased for case-insensitive comparison.
 */
export const NON_EVM_RECEIVER_SENTINEL =
  "0x11f111f111f111f111f111f111f111f111f111f1";
