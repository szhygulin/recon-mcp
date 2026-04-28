import { describe, it, expect } from "vitest";
import { parseEther, toFunctionSelector, zeroAddress } from "viem";
import {
  buildLidoStake,
  buildLidoUnwrap,
} from "../src/modules/staking/actions.js";
import { CONTRACTS } from "../src/config/contracts.js";

describe("buildLidoStake", () => {
  const wallet = "0x1111111111111111111111111111111111111111" as `0x${string}`;

  it("produces a tx to the stETH contract on Ethereum", () => {
    const tx = buildLidoStake({ wallet, amountEth: "1.5" });
    expect(tx.chain).toBe("ethereum");
    expect(tx.to.toLowerCase()).toBe(CONTRACTS.ethereum.lido.stETH.toLowerCase());
    expect(tx.from).toBe(wallet);
  });

  it("value equals amount in wei", () => {
    const tx = buildLidoStake({ wallet, amountEth: "0.5" });
    expect(tx.value).toBe(parseEther("0.5").toString());
  });

  it("calldata starts with the submit(address) selector and includes zero referral", () => {
    const tx = buildLidoStake({ wallet, amountEth: "1" });
    const selector = toFunctionSelector("submit(address)");
    expect(tx.data.toLowerCase().startsWith(selector.toLowerCase())).toBe(true);
    // 4-byte selector + 32-byte address arg = 36 bytes = 72 hex chars + 0x.
    expect(tx.data.length).toBe(2 + 8 + 64);
    // Referral is zeroAddress — last 40 hex chars of the encoded address slot.
    const argHex = tx.data.slice(2 + 8);
    expect(argHex.slice(-40)).toBe(zeroAddress.slice(2).toLowerCase());
  });

  it("decoded metadata preserves user-facing amount", () => {
    const tx = buildLidoStake({ wallet, amountEth: "2.25" });
    expect(tx.decoded?.functionName).toBe("submit");
    expect(tx.decoded?.args.value).toBe("2.25 ETH");
    expect(tx.description).toContain("2.25 ETH");
  });
});

describe("buildLidoUnwrap", () => {
  const wallet = "0x2222222222222222222222222222222222222222" as `0x${string}`;

  it("returns a single tx to the wstETH contract with no approve step", () => {
    const tx = buildLidoUnwrap({ wallet, amountWstETH: "1.5" });
    expect(tx.chain).toBe("ethereum");
    expect(tx.to.toLowerCase()).toBe(CONTRACTS.ethereum.lido.wstETH.toLowerCase());
    expect(tx.from).toBe(wallet);
    expect(tx.value).toBe("0");
    expect(tx.next).toBeUndefined();
  });

  it("calldata starts with the unwrap(uint256) selector and encodes amount in wei", () => {
    const tx = buildLidoUnwrap({ wallet, amountWstETH: "0.25" });
    const selector = toFunctionSelector("unwrap(uint256)");
    expect(tx.data.toLowerCase().startsWith(selector.toLowerCase())).toBe(true);
    expect(tx.data.length).toBe(2 + 8 + 64);
    const argHex = tx.data.slice(2 + 8);
    expect(BigInt("0x" + argHex)).toBe(parseEther("0.25"));
  });

  it("decoded metadata preserves user-facing amount", () => {
    const tx = buildLidoUnwrap({ wallet, amountWstETH: "2" });
    expect(tx.decoded?.functionName).toBe("unwrap");
    expect(tx.decoded?.args.amount).toBe("2 wstETH");
    expect(tx.description).toContain("2 wstETH");
  });
});
