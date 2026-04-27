import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Default 5s trips spurious timeouts when several parallel files
    // share CPU with a heavier loader (e.g. the Uniswap V3 SDK loaded
    // by `test/uniswap-v3-mint.test.ts` adds ~7 MB of transitive deps
    // — JSBI + ethersproject — that initialize on every worker). 10s
    // gives enough headroom for unrelated tests under contention.
    testTimeout: 10_000,
  },
});
