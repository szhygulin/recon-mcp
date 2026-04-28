import { getContractInfo, type ContractInfo } from "../../data/apis/etherscan.js";
import type { SupportedChain } from "../../types/index.js";

export interface GetContractAbiResult extends ContractInfo {
  /**
   * `proxy-implementation` when `followProxy=true`, the target was a proxy,
   * and we successfully resolved the implementation's ABI; the returned
   * `abi` is the implementation's. `proxy-target` when the target was a
   * proxy but we returned the proxy's own ABI (followProxy=false, or the
   * implementation wasn't verified). `direct` when the target was not a
   * proxy. Surfaced so the caller can tell, without re-deriving, whether a
   * follow happened — important for the `prepare_custom_call` use case
   * where the agent needs to know which contract's ABI it's encoding
   * against.
   */
  abiSource: "direct" | "proxy-target" | "proxy-implementation";
  /**
   * When `abiSource === "proxy-target"`, explains why we didn't follow the
   * implementation (followProxy=false vs. implementation unverified). When
   * `abiSource !== "proxy-target"`, omitted.
   */
  proxyFollowSkippedReason?: "follow-proxy-disabled" | "implementation-unverified";
}

/**
 * Read-only ABI fetch via Etherscan V2 (issue #495). Wraps the existing
 * `getContractInfo` + 24h cache + sanitization. Optionally follows the
 * EIP-1967 implementation pointer once when the target is a proxy and
 * `followProxy` is true (default).
 *
 * Why a standalone tool exists: without this, the agent's only MCP path
 * to an ABI is `prepare_custom_call`'s side-effect — which builds a tx
 * the user may not want. Faced with "I just need the ABI", the agent
 * would fall back to `WebFetch` against `etherscan.io`, bypassing the
 * MCP trust boundary (no API key, no size cap, no cache, no
 * sanitization). Closing that hole is the only reason this tool exists.
 */
export async function getContractAbi(
  address: `0x${string}`,
  chain: SupportedChain,
  followProxy: boolean,
): Promise<GetContractAbiResult> {
  const info = await getContractInfo(address, chain);

  if (!info.isProxy || !info.implementation) {
    return { ...info, abiSource: "direct" };
  }

  if (!followProxy) {
    return {
      ...info,
      abiSource: "proxy-target",
      proxyFollowSkippedReason: "follow-proxy-disabled",
    };
  }

  const impl = await getContractInfo(info.implementation, chain);
  if (!impl.isVerified || !impl.abi || impl.abi.length === 0) {
    return {
      ...info,
      abiSource: "proxy-target",
      proxyFollowSkippedReason: "implementation-unverified",
    };
  }

  // Return the implementation's ABI but keep the proxy as the surfaced
  // `address` — the caller asked about that contract; the ABI is the
  // implementation's because that's what the proxy delegates to.
  return {
    address: info.address,
    chain: info.chain,
    isVerified: info.isVerified,
    isProxy: true,
    implementation: info.implementation,
    contractName: impl.contractName ?? info.contractName,
    compilerVersion: impl.compilerVersion ?? info.compilerVersion,
    abi: impl.abi,
    abiSource: "proxy-implementation",
  };
}
