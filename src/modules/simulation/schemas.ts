import { z } from "zod";
import { SUPPORTED_CHAINS } from "../../types/index.js";

const chainEnum = z.enum(SUPPORTED_CHAINS as unknown as [string, ...string[]]);
const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const dataSchema = z.string().regex(/^0x[a-fA-F0-9]*$/);

export const simulateTransactionInput = z.object({
  chain: chainEnum.default("ethereum"),
  from: addressSchema.optional().describe(
    "msg.sender to simulate from. Omit for a state-independent call; include the " +
      "user's wallet when the target contract's behavior depends on the caller " +
      "(e.g. WETH9.deposit credits msg.sender, ERC-20 transfer debits msg.sender)."
  ),
  to: addressSchema,
  data: dataSchema.optional().describe("Hex-encoded calldata. Omit for a plain value transfer."),
  value: z
    .string()
    .regex(/^\d+$/)
    .optional()
    .describe(
      "Value to send with the call, in wei as a decimal string. Omit for 0. " +
        'Example: "500000000000000000" for 0.5 ETH.'
    ),
});

export type SimulateTransactionArgs = z.infer<typeof simulateTransactionInput>;
