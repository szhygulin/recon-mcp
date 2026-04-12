import { getAddress, zeroAddress } from "viem";
import { getClient } from "../../data/rpc.js";
import { getContractInfo } from "../../data/apis/etherscan.js";
import type { SecurityReport, SupportedChain } from "../../types/index.js";

// EIP-1967 storage slots.
const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

/** Read a 32-byte storage slot and return it as a 20-byte address (last 20 bytes). */
async function readAddressFromSlot(
  chain: SupportedChain,
  address: `0x${string}`,
  slot: `0x${string}`
): Promise<`0x${string}` | undefined> {
  const client = getClient(chain);
  try {
    const raw = await client.getStorageAt({ address, slot });
    if (!raw || raw === "0x" || raw.length < 66) return undefined;
    const addr = `0x${raw.slice(26)}` as `0x${string}`;
    if (addr === zeroAddress) return undefined;
    return getAddress(addr) as `0x${string}`;
  } catch {
    return undefined;
  }
}

const DANGEROUS_FUNCTION_NAMES = new Set([
  "mint",
  "pause",
  "unpause",
  "upgradeTo",
  "upgradeToAndCall",
  "setAdmin",
  "transferOwnership",
  "setImplementation",
  "changeAdmin",
  "setPause",
]);

/** Scan an ABI for dangerous function signatures. */
export function scanAbiForDangerousFunctions(abi: unknown[] | undefined): string[] {
  if (!abi) return [];
  const found: string[] = [];
  for (const item of abi) {
    if (typeof item !== "object" || !item) continue;
    const it = item as { type?: string; name?: string };
    if (it.type === "function" && it.name && DANGEROUS_FUNCTION_NAMES.has(it.name)) {
      found.push(it.name);
    }
  }
  return found;
}

export async function checkContractSecurity(
  address: `0x${string}`,
  chain: SupportedChain
): Promise<SecurityReport> {
  const [info, eipImpl, eipAdmin] = await Promise.all([
    getContractInfo(address, chain),
    readAddressFromSlot(chain, address, EIP1967_IMPL_SLOT),
    readAddressFromSlot(chain, address, EIP1967_ADMIN_SLOT),
  ]);

  const isProxy = info.isProxy || eipImpl !== undefined;
  const implementation = info.implementation ?? eipImpl;

  // If proxy, also check the implementation's ABI for dangerous functions.
  let dangerousFns = scanAbiForDangerousFunctions(info.abi);
  if (isProxy && implementation) {
    try {
      const implInfo = await getContractInfo(implementation, chain);
      dangerousFns = [
        ...new Set([...dangerousFns, ...scanAbiForDangerousFunctions(implInfo.abi)]),
      ];
    } catch {
      // ignore
    }
  }

  return {
    address: getAddress(address) as `0x${string}`,
    chain,
    isVerified: info.isVerified,
    isProxy,
    implementation,
    admin: eipAdmin,
    dangerousFunctions: dangerousFns,
    privilegedRoles: [], // populated by permissions module when requested
  };
}
