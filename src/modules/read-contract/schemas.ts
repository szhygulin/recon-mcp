import { z } from "zod";
import { SUPPORTED_CHAINS } from "../../types/index.js";
import { EVM_ADDRESS } from "../../shared/address-patterns.js";

const chainEnum = z.enum(SUPPORTED_CHAINS as unknown as [string, ...string[]]);
const addressSchema = z.string().regex(EVM_ADDRESS);

export const readContractInput = z.object({
  chain: chainEnum.default("ethereum"),
  contract: addressSchema.describe(
    "Target contract address. Must be Etherscan-verified OR the `abi` arg must be passed inline.",
  ),
  fn: z
    .string()
    .min(1)
    .max(200)
    .describe(
      'Function name to call (e.g. "getRoleMember"). Pass the FULL signature ' +
        '("getRoleMember(bytes32,uint256)") to disambiguate when the ABI has overloads ' +
        "for the same name.",
    ),
  args: z
    .array(z.unknown())
    .default([])
    .describe(
      "Array of args matching the function's inputs in order. Decimal strings for " +
        'uint256 (e.g. "0"), 0x-prefixed hex for bytes32/bytes (e.g. an OZ role hash ' +
        'like keccak256("EXECUTOR_ROLE")), lowercase 0x-prefixed addresses, plain ' +
        "numbers/booleans for primitives, nested arrays/objects for structs and tuples.",
    ),
  abi: z
    .array(z.unknown())
    .optional()
    .describe(
      "Inline ABI array. When omitted, the tool fetches it via Etherscan V2. Pass it to " +
        "override the Etherscan ABI, to call a contract whose source isn't yet verified, " +
        "or to call through a proxy whose implementation can't be auto-followed.",
    ),
});

export type ReadContractArgs = z.infer<typeof readContractInput>;
