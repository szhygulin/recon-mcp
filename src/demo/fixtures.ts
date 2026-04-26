/**
 * Deterministic fixture data for VAULTPILOT_DEMO=true. Same args → same
 * response on every call so demo screenshots / videos / tutorials
 * reproduce identically. Fixtures here mirror the *shape* of the real
 * tool outputs but use values designed to look realistic at a glance to
 * a prospective user — not to pass strict cross-tool consistency checks
 * (the agent narrates each tool independently).
 *
 * Coverage policy:
 *   - The handful of tools the demo-mode plan calls out by name (the
 *     ones a user is most likely to hit in a 30-second walkthrough)
 *     get explicit fixtures.
 *   - Every other tool falls through to `getDemoFixture`'s
 *     `not-implemented` payload, which echoes the tool name + args so
 *     the user can see what's covered and what isn't.
 *
 * Demo-wallet choice: ONE EVM address, ONE TRON address, ONE Solana
 * address, ONE Bitcoin address. A single self-consistent identity makes
 * the demo narrative simpler ("this is your wallet across four chains")
 * and avoids the multi-account UX complexity that would distract from
 * the core read-only walkthrough.
 */

export const DEMO_WALLET = {
  evm: "0xDeFa1212121212121212121212121212121212De" as const,
  tron: "TDemoVAULTpilotxxxxxxxxxxxxxxxxxxxxx" as const,
  solana: "DEMo1111111111111111111111111111111111111111" as const,
  bitcoin: "bc1qdemo7xpyrkfsm7dl5kfjxgvm8azwj9c4yefzx0" as const,
};

/**
 * Known DeFi contract addresses, recognized by `check_contract_security`,
 * `check_permission_risks`, and `get_protocol_risk_score` so the same
 * contract gets a consistent risk verdict across all three tools (and
 * users see "Aave V3 Pool — verified, timelock-governed" rather than
 * generic "established protocol" hand-waving). Real mainnet addresses
 * — keys are lowercase for case-insensitive lookup, since the wire
 * format varies (EIP-55 in user input, lowercase in some indexers).
 */
const KNOWN_DEFI_ADDRESSES: Record<
  string,
  { name: string; protocol: string; kind: string; chain: string; isProxy: boolean }
> = {
  // Aave V3 Pool (mainnet)
  "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2": {
    name: "Aave V3 Pool",
    protocol: "aave-v3",
    kind: "lending-pool",
    chain: "ethereum",
    isProxy: true,
  },
  // Compound V3 USDC Comet (Base)
  "0xb125e6687d4313864e53df431d5425969c15eb2f": {
    name: "Compound V3 USDC (Base)",
    protocol: "compound-v3",
    kind: "comet",
    chain: "base",
    isProxy: true,
  },
  // Lido stETH (mainnet)
  "0xae7ab96520de3a18e5e111b5eaab095312d7fe84": {
    name: "Lido stETH",
    protocol: "lido",
    kind: "liquid-staking-token",
    chain: "ethereum",
    isProxy: true,
  },
  // Uniswap V3 NonfungiblePositionManager (mainnet)
  "0xc36442b4a4522e871399cd717abdd847ab11fe88": {
    name: "Uniswap V3 NonfungiblePositionManager",
    protocol: "uniswap-v3",
    kind: "lp-nft",
    chain: "ethereum",
    isProxy: false,
  },
  // LiFi diamond (multichain)
  "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae": {
    name: "LiFi Diamond",
    protocol: "lifi",
    kind: "swap-bridge-aggregator",
    chain: "ethereum",
    isProxy: false,
  },
};

function lookupKnownDefi(addr: string | undefined) {
  if (!addr || typeof addr !== "string") return undefined;
  return KNOWN_DEFI_ADDRESSES[addr.toLowerCase()];
}

/**
 * The four `0xdemo*` tx hashes from `get_transaction_history`'s v1
 * fixture. `get_transaction_status` recognizes these and reports them
 * as confirmed (so the agent's narrative — "you swapped, supplied,
 * staked, bridged last month" — survives a follow-up "did the swap
 * confirm?" probe). Any other hash returns `pending`.
 */
const KNOWN_TX_HASHES: Set<string> = new Set([
  "0xdemo1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "0xdemo2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "0xdemo3ccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "0xdemo4dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
]);

/**
 * Each fixture function takes the (already-validated by the wrapper at
 * call time) tool args and returns a canned response. Args may be
 * undefined for argless tools (e.g. `get_ledger_status`).
 */
type FixtureFn = (args: unknown) => unknown;

export const DEMO_FIXTURES: Record<string, FixtureFn> = {
  // -------- Identity / pairing -------------------------------------------------
  get_ledger_status: () => ({
    paired: true,
    accounts: [DEMO_WALLET.evm],
    accountDetails: [
      {
        address: DEMO_WALLET.evm,
        chainIds: [1, 42161, 137, 8453],
        chains: ["ethereum", "arbitrum", "polygon", "base"],
      },
    ],
    topic: "demo0000000000000000000000000000000000000000000000000000000000",
    expiresAt: 9_999_999_999_000,
    wallet: "VaultPilot Demo Wallet",
    peerUrl: "https://demo.vaultpilot.example/",
    peerDescription: "Demo session — VAULTPILOT_DEMO=true (no real Ledger paired)",
    tron: [
      {
        address: DEMO_WALLET.tron,
        path: "44'/195'/0'/0/0",
        appVersion: "0.7.4",
        accountIndex: 0,
      },
    ],
    solana: [
      {
        address: DEMO_WALLET.solana,
        path: "44'/501'/0'",
        appVersion: "1.12.1",
        accountIndex: 0,
      },
    ],
    bitcoin: [
      {
        address: DEMO_WALLET.bitcoin,
        path: "84'/0'/0'/0/0",
        appVersion: "2.4.6",
        addressType: "segwit",
        accountIndex: 0,
        chain: 0,
        addressIndex: 0,
      },
    ],
  }),

  get_ledger_device_info: () => ({
    productName: "Nano X (demo)",
    seVersion: "2.2.3",
    mcuVersion: "2.30",
    serialNumber: "DEMO-XXXX-XXXX",
    isOnboarded: true,
    flags: { isInRecoveryMode: false },
  }),

  // -------- Token balances -----------------------------------------------------
  get_token_balance: (args) => {
    const a = (args ?? {}) as { chain?: string; token?: string };
    const chain = a.chain ?? "ethereum";
    const token = (a.token ?? "native").toLowerCase();
    const isNative = token === "native";
    const lookupKey = `${chain}:${isNative ? "native" : token}`;
    const slice = DEMO_TOKEN_BALANCES[lookupKey] ?? DEMO_TOKEN_BALANCES[`${chain}:native`];
    if (!slice) {
      return {
        token: a.token ?? "native",
        symbol: "DEMO",
        decimals: 18,
        amount: "0",
        formatted: "0",
        priceUsd: 0,
        valueUsd: 0,
      };
    }
    return slice;
  },

  // -------- Portfolio summary --------------------------------------------------
  get_portfolio_summary: () => DEMO_PORTFOLIO_SUMMARY,

  // -------- Lending / staking / LP --------------------------------------------
  get_lending_positions: () => DEMO_AAVE_POSITIONS,
  get_compound_positions: () => DEMO_COMPOUND_POSITIONS,
  get_morpho_positions: () => DEMO_MORPHO_POSITIONS,
  get_lp_positions: () => DEMO_UNIV3_POSITIONS,
  get_staking_positions: () => DEMO_LIDO_POSITIONS,
  get_solana_staking_positions: () => DEMO_SOLANA_STAKING,
  get_marginfi_positions: () => DEMO_MARGINFI_POSITIONS,
  get_kamino_positions: () => DEMO_KAMINO_POSITIONS,
  get_tron_staking: () => DEMO_TRON_STAKING,

  // -------- Bitcoin reads ------------------------------------------------------
  get_btc_balance: () => DEMO_BTC_SINGLE_BALANCE,
  get_btc_balances: () => ({
    addresses: [DEMO_BTC_SINGLE_BALANCE],
  }),
  get_btc_account_balance: () => DEMO_BTC_ACCOUNT_BALANCE,
  get_btc_block_tip: () => ({
    height: 946_598,
    hash: "0000000000000000000000000000000000000000000000000000demoabcdef1234",
    timestamp: 1_745_625_600,
    ageSeconds: 240,
  }),
  get_btc_fee_estimates: () => ({
    fastestFee: 18,
    halfHourFee: 9,
    hourFee: 5,
    economyFee: 2,
    minimumFee: 1,
  }),
  get_btc_tx_history: () => ({
    address: DEMO_WALLET.bitcoin,
    txs: [
      {
        txid: "demo1111111111111111111111111111111111111111111111111111111111",
        receivedSats: "7500000",
        sentSats: "0",
        feeSats: "0",
        blockHeight: 946_500,
        blockTime: 1_745_022_400,
        rbfEligible: false,
      },
    ],
  }),

  // -------- Tx history ---------------------------------------------------------
  get_transaction_history: () => DEMO_TX_HISTORY,

  // -------- Read-only helpers (cheap to fixture) -------------------------------
  get_token_metadata: (args) => {
    const a = (args ?? {}) as { token?: string };
    return {
      address: a.token ?? "native",
      symbol: "DEMO-TOKEN",
      decimals: 18,
      name: "Demo Token",
      priceUsd: 1,
    };
  },
  get_token_price: (args) => {
    const a = (args ?? {}) as { token?: string };
    return {
      token: a.token ?? "native",
      priceUsd: 1,
      source: "demo-fixture",
    };
  },
  get_market_incident_status: () => ({
    overallStatus: "operational",
    incidents: [],
    lastChecked: "2026-04-26T00:00:00Z",
  }),
  get_health_alerts: () => ({
    wallet: DEMO_WALLET.evm,
    alerts: [],
    summary: "All lending positions in the demo wallet are well above the liquidation threshold.",
  }),

  // -------- v2: swap & quote ---------------------------------------------------
  get_swap_quote: (args) => {
    const a = (args ?? {}) as {
      fromChain?: string;
      toChain?: string;
      fromToken?: string;
      toToken?: string;
      amount?: string;
      amountSide?: "from" | "to";
    };
    const fromChain = a.fromChain ?? "ethereum";
    const toChain = a.toChain ?? "ethereum";
    const amountIn = parseFloat(a.amount ?? "0") || 0;
    const exactOut = a.amountSide === "to";
    // Stable→stable on mainnet matches the live exact-out shape from
    // the session: SushiSwap routing, ~0.28% effective haircut.
    const isStablePair =
      isStableMint(a.fromToken) && isStableMint(a.toToken) && fromChain === toChain;
    if (isStablePair) {
      const expected = exactOut ? amountIn * 1.001 : amountIn * 0.999;
      const fromAmount = exactOut ? amountIn * 1.0039 : amountIn;
      const toAmount = exactOut ? amountIn : amountIn * 0.9971;
      return {
        fromChain,
        toChain,
        fromToken: { address: a.fromToken, symbol: "USDC", decimals: 6, priceUSD: "1.0" },
        toToken: { address: a.toToken, symbol: "USDT", decimals: 6, priceUSD: "1.0" },
        fromAmount: fromAmount.toFixed(6),
        toAmountMin: toAmount.toFixed(6),
        toAmountExpected: expected.toFixed(6),
        fromAmountUsd: fromAmount,
        toAmountUsd: toAmount,
        tool: "sushiswap",
        executionDurationSeconds: 0,
        feeCostsUsd: amountIn * 0.0025,
        gasCostsUsd: 0.21,
        crossChain: false,
      };
    }
    const isCrossChain = fromChain !== toChain;
    const out = exactOut ? amountIn : amountIn * 0.997;
    return {
      fromChain,
      toChain,
      fromToken: { address: a.fromToken, symbol: "DEMO-IN", decimals: 18 },
      toToken: { address: a.toToken, symbol: "DEMO-OUT", decimals: 18 },
      fromAmount: (exactOut ? amountIn * 1.003 : amountIn).toString(),
      toAmountMin: (out * 0.995).toString(),
      toAmountExpected: out.toString(),
      tool: isCrossChain ? "across" : "1inch",
      executionDurationSeconds: isCrossChain ? 480 : 0,
      feeCostsUsd: isCrossChain ? 4.5 : 0.6,
      gasCostsUsd: 0.18,
      crossChain: isCrossChain,
    };
  },

  get_solana_swap_quote: (args) => {
    const a = (args ?? {}) as { inputMint?: string; outputMint?: string; amount?: string };
    const amount = parseFloat(a.amount ?? "0") || 0;
    return {
      inputMint: a.inputMint ?? "So11111111111111111111111111111111111111112",
      outputMint: a.outputMint ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      inAmount: amount.toString(),
      outAmount: (amount * 0.995).toString(),
      otherAmountThreshold: (amount * 0.99).toString(),
      swapMode: "ExactIn",
      slippageBps: 50,
      priceImpactPct: 0.0012,
      platformFee: null,
      routePlan: [
        {
          swapInfo: {
            ammKey: "DemoOrcaWhirlpoolxxxxxxxxxxxxxxxxxxxxxxxxxxx",
            label: "Orca (Whirlpool)",
            inputMint: a.inputMint ?? "So11111111111111111111111111111111111111112",
            outputMint: a.outputMint ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            inAmount: amount.toString(),
            outAmount: (amount * 0.995).toString(),
            feeAmount: (amount * 0.0025).toString(),
            feeMint: a.inputMint ?? "So11111111111111111111111111111111111111112",
          },
          percent: 100,
        },
      ],
      contextSlot: 287_654_321,
      timeTaken: 0.082,
    };
  },

  simulate_transaction: (args) => {
    const a = (args ?? {}) as { data?: string };
    const data = a.data ?? "0x";
    // A specific marker calldata triggers the synthetic-revert demo so
    // the security narrative ("simulate said REVERT — don't sign") shows
    // up in the demo walkthrough; everything else returns ok.
    if (typeof data === "string" && data.toLowerCase().includes("dead")) {
      return {
        chain: "ethereum",
        ok: false,
        revertReason: "transfer amount exceeds balance",
        revert: {
          errorName: "ERC20InsufficientBalance",
          args: ["sender", "0", "1000000"],
          data: "0xfb8f41b2",
          source: "demo-fixture",
        },
      };
    }
    return { chain: "ethereum", ok: true, returnData: "0x" };
  },

  // -------- v2: status & diagnostics ------------------------------------------
  get_transaction_status: (args) => {
    const a = (args ?? {}) as { txHash?: string; chain?: string };
    const hash = (a.txHash ?? "").toLowerCase();
    if (KNOWN_TX_HASHES.has(hash)) {
      return {
        chain: a.chain ?? "ethereum",
        txHash: a.txHash,
        status: "success",
        confirmations: 142,
        blockHeight: 19_843_002,
        gasUsed: "73214",
      };
    }
    return {
      chain: a.chain ?? "ethereum",
      txHash: a.txHash,
      status: "pending",
      confirmations: 0,
      note: "demo fixture — only the four `0xdemo*` hashes from get_transaction_history are recognized as confirmed",
    };
  },

  get_vaultpilot_config_status: () => ({
    configPath: "~/.vaultpilot-mcp/config.json",
    configExists: true,
    version: "0.8.2",
    rpc: {
      ethereum: { source: "demo-fixture" },
      arbitrum: { source: "demo-fixture" },
      polygon: { source: "demo-fixture" },
      base: { source: "demo-fixture" },
      optimism: { source: "demo-fixture" },
    },
    apiKeys: {
      etherscan: { exists: true, source: "demo-fixture" },
      oneinch: { exists: true, source: "demo-fixture" },
      tronGrid: { exists: true, source: "demo-fixture" },
      walletConnect: { exists: true, source: "demo-fixture" },
    },
    pairedLedger: { solana: 1, tron: 1, bitcoin: 1 },
    wcTopic: "...demo0000",
    demoMode: true,
  }),

  get_marginfi_diagnostics: () => ({
    totalBanks: 188,
    decoded: 188,
    skipped: [],
    note: "demo fixture — all banks hydrated cleanly (no SDK drift in demo mode)",
  }),

  get_solana_setup_status: () => ({
    durableNonce: {
      exists: true,
      address: "DEMo11111111111111111111111111111111nonce0",
      lamports: 1_500_000,
      currentNonce: "DEMo11111111111111111111111111111nonceVal0",
      authority: DEMO_WALLET.solana,
    },
    marginfiAccounts: [
      { accountIndex: 0, address: "DEMo111111111111111111111111111111111mfi0" },
    ],
    note: "demo fixture — both Solana setup steps already complete",
  }),

  rescan_btc_account: (args) => {
    const a = (args ?? {}) as { accountIndex?: number };
    const idx = a.accountIndex ?? 0;
    if (idx !== 0) {
      return {
        accountIndex: idx,
        addressesQueried: 0,
        addressesCached: 0,
        totalConfirmedSats: "0",
        totalConfirmedBtc: "0",
        totalMempoolSats: "0",
        totalSats: "0",
        breakdown: [],
        note: `demo fixture — only accountIndex 0 has data; got ${idx}`,
      };
    }
    return {
      ...DEMO_BTC_ACCOUNT_BALANCE,
      note: "demo fixture — rescanned at 2026-04-26T00:00:00Z (no on-chain delta vs cache)",
    };
  },

  // -------- v2: DeFi protocol reads -------------------------------------------
  get_compound_market_info: (args) => {
    const a = (args ?? {}) as { chain?: string; market?: string };
    return {
      chain: a.chain ?? "base",
      market: a.market ?? "0xb125E6687d4313864e53df431d5425969c15Eb2F",
      baseToken: {
        address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        symbol: "USDC",
        decimals: 6,
      },
      totalSupply: "12450000.00",
      totalBorrow: "8230000.00",
      utilization: 0.661,
      supplyApr: 0.041,
      borrowApr: 0.063,
      pausedActions: [],
      collateralAssets: [
        { symbol: "WETH", liquidationFactor: 0.83, supplyCap: "10000" },
        { symbol: "cbETH", liquidationFactor: 0.83, supplyCap: "5000" },
      ],
    };
  },

  simulate_position_change: (args) => {
    const a = (args ?? {}) as {
      protocol?: string;
      action?: "borrow" | "repay" | "supply" | "withdraw";
      asset?: string;
      amount?: string;
    };
    const proto = a.protocol ?? "aave-v3";
    if (proto !== "aave-v3") {
      return {
        ok: false,
        note: "demo fixture only models the v1 Aave V3 demo position; got protocol=" + proto,
      };
    }
    // v1 demo Aave numbers: 4000 collateral (1.726 WETH), 800 USDC debt.
    // Aave HF formula approximated as collateral × liqThreshold (0.83) / debt.
    const liqThreshold = 0.83;
    const baseCollateralUsd = 4_000;
    const baseDebtUsd = 800;
    const amount = parseFloat(a.amount ?? "0") || 0;
    let collateralUsd = baseCollateralUsd;
    let debtUsd = baseDebtUsd;
    if (a.action === "borrow") debtUsd += amount;
    else if (a.action === "repay") debtUsd = Math.max(0, debtUsd - amount);
    else if (a.action === "supply") collateralUsd += amount;
    else if (a.action === "withdraw") collateralUsd = Math.max(0, collateralUsd - amount);
    const healthFactor = debtUsd > 0 ? (collateralUsd * liqThreshold) / debtUsd : Infinity;
    return {
      protocol: "aave-v3",
      chain: "ethereum",
      action: a.action,
      asset: a.asset,
      amount: a.amount,
      projected: {
        collateralUsd,
        debtUsd,
        healthFactor: isFinite(healthFactor) ? Number(healthFactor.toFixed(2)) : null,
        liquidationThreshold: liqThreshold,
      },
      baseline: {
        collateralUsd: baseCollateralUsd,
        debtUsd: baseDebtUsd,
        healthFactor: 4.15,
      },
    };
  },

  get_staking_rewards: () => ({
    wallet: DEMO_WALLET.evm,
    period: "30d",
    estimated: [
      {
        protocol: "lido",
        asset: "stETH",
        amount: "0.0030",
        valueUsd: 6.94,
        note: "1.2 stETH × ~3.12% APR × 30d",
      },
      {
        protocol: "marginfi",
        asset: "USDC",
        amount: "4.07",
        valueUsd: 4.07,
        note: "800 USDC supply × ~6.2% APY × 30d",
      },
    ],
    totalUsd: 11.01,
    disclaimer: "demo fixture — values are deterministic projections, not realized rewards",
  }),

  estimate_staking_yield: (args) => {
    const a = (args ?? {}) as { protocol?: string; amount?: string };
    const amount = parseFloat(a.amount ?? "1.0") || 1.0;
    const known: Record<string, number> = {
      lido: 0.0312,
      "rocket-pool": 0.0298,
      marinade: 0.072,
      "jito-stake-pool": 0.078,
      eigenlayer: 0.041,
    };
    const apr = known[a.protocol ?? "lido"] ?? 0.05;
    const annualValueUsd = amount * 2316.09 * apr;
    return {
      protocol: a.protocol ?? "lido",
      amount: a.amount ?? "1.0",
      apr,
      estimatedAnnualYield: (amount * apr).toFixed(4),
      valueUsd: Number(annualValueUsd.toFixed(2)),
      note: "demo fixture — APR is a 30-day rolling estimate",
    };
  },

  // -------- v2: security advisory ---------------------------------------------
  check_contract_security: (args) => {
    const a = (args ?? {}) as { address?: string; chain?: string };
    const known = lookupKnownDefi(a.address);
    if (known) {
      return {
        address: a.address,
        chain: a.chain ?? known.chain,
        isVerified: true,
        isProxy: known.isProxy,
        ...(known.isProxy
          ? {
              implementation: "0xDemoImpl000000000000000000000000000000000",
              admin: { type: "TimelockController", delay: 86_400 },
            }
          : {}),
        dangerousFunctions: [],
        notes: [
          `${known.name} — established protocol (${known.protocol}), audited multiple times.`,
          "demo fixture — recognized as a well-known DeFi contract.",
        ],
        proxyPattern: known.isProxy ? "transparent-proxy" : null,
      };
    }
    return {
      address: a.address,
      chain: a.chain ?? "ethereum",
      isVerified: false,
      isProxy: false,
      dangerousFunctions: ["selfdestruct", "delegatecall to unverified target"],
      notes: [
        "Unverified contract — proceed with caution.",
        "demo fixture — any address NOT in the known-DeFi table returns this cautionary verdict so the demo walkthrough shows both safe and risky outcomes.",
      ],
    };
  },

  check_permission_risks: (args) => {
    const a = (args ?? {}) as { address?: string; chain?: string };
    const known = lookupKnownDefi(a.address);
    if (known) {
      return {
        address: a.address,
        chain: a.chain ?? known.chain,
        roles: [
          {
            function: "pause",
            holder: "0xDemoTimelock0000000000000000000000000000",
            holderType: "TimelockController",
            note: "24h timelock — well-protected",
          },
          {
            function: "upgrade",
            holder: "0xDemoTimelock0000000000000000000000000000",
            holderType: "TimelockController",
            note: "Same timelock as pause — single governance path",
          },
        ],
        notes: [
          `${known.name} — governance is on-chain timelock.`,
          "demo fixture — known DeFi contract with mature governance.",
        ],
      };
    }
    return {
      address: a.address,
      chain: a.chain ?? "ethereum",
      roles: [
        {
          function: "owner",
          holder: "0xDemoUnknownEOA000000000000000000000000000",
          holderType: "EOA",
          note: "Single EOA owner — high admin risk; can pause/upgrade unilaterally.",
        },
      ],
      notes: [
        "Unknown contract with EOA admin.",
        "demo fixture — any address NOT in the known-DeFi table returns this high-risk verdict.",
      ],
    };
  },

  get_protocol_risk_score: (args) => {
    const a = (args ?? {}) as { protocol?: string };
    const protocol = (a.protocol ?? "aave-v3").toLowerCase();
    const known: Record<string, { score: number; tvlUsd: number; ageDays: number }> = {
      "aave-v3": { score: 92, tvlUsd: 11_000_000_000, ageDays: 1095 },
      "compound-v3": { score: 88, tvlUsd: 3_200_000_000, ageDays: 870 },
      lido: { score: 90, tvlUsd: 28_000_000_000, ageDays: 1450 },
      "uniswap-v3": { score: 95, tvlUsd: 4_500_000_000, ageDays: 1310 },
      lifi: { score: 80, tvlUsd: 350_000_000, ageDays: 600 },
      "morpho-blue": { score: 84, tvlUsd: 2_100_000_000, ageDays: 540 },
      marginfi: { score: 76, tvlUsd: 420_000_000, ageDays: 730 },
    };
    const k = known[protocol];
    if (k) {
      return {
        protocol: a.protocol,
        score: k.score,
        breakdown: {
          tvl: 18,
          trend30d: 16,
          contractAge: 20,
          audit: 22,
          bugBounty: 16,
        },
        raw: {
          tvlUsd: k.tvlUsd,
          tvlTrend30d: 0.04,
          contractAgeDays: k.ageDays,
          hasBugBounty: true,
        },
      };
    }
    return {
      protocol: a.protocol,
      score: 35,
      breakdown: {
        tvl: 5,
        trend30d: 5,
        contractAge: 5,
        audit: 10,
        bugBounty: 10,
      },
      raw: { hasBugBounty: false },
      notes: [
        "Unknown protocol — low confidence demo fallback.",
        "demo fixture — any protocol NOT in the known-DeFi table scores 35 by default.",
      ],
    };
  },

  // -------- v2: ENS resolution ------------------------------------------------
  resolve_ens_name: (args) => {
    const a = (args ?? {}) as { name?: string };
    const name = (a.name ?? "").toLowerCase();
    if (name === "demo.eth" || name === "vaultpilot.eth") {
      return { name: a.name, address: DEMO_WALLET.evm };
    }
    return {
      name: a.name,
      address: null,
      note: "demo fixture — only resolves `demo.eth` and `vaultpilot.eth`",
    };
  },

  reverse_resolve_ens: (args) => {
    const a = (args ?? {}) as { address?: string };
    if (a.address && a.address.toLowerCase() === DEMO_WALLET.evm.toLowerCase()) {
      return { address: a.address, name: "demo.eth" };
    }
    return { address: a.address, name: null };
  },

  // -------- v2: portfolio diff ------------------------------------------------
  get_portfolio_diff: () => ({
    wallet: DEMO_WALLET.evm,
    startIso: "2026-04-19T00:00:00Z",
    endIso: "2026-04-26T00:00:00Z",
    byChain: {
      ethereum: {
        diffs: {
          ETH: {
            delta: "0",
            deltaUsd: 0,
            price: ["2289.00", "2316.09"],
          },
          stETH: {
            delta: "+0.0030",
            deltaUsd: 6.95,
            price: ["2289.00", "2316.09"],
          },
        },
        totals: {
          netUsd: 12,
          balUsdStart: 12_753,
          balUsdEnd: 12_765,
        },
      },
      arbitrum: {
        diffs: {},
        totals: { netUsd: 0, balUsdStart: 1_732, balUsdEnd: 1_732 },
      },
    },
    notes: [
      "~$12 net change driven by stETH yield + ETH price drift; cross-references the v1 Lido stETH position.",
    ],
  }),

  // -------- v2: TRON witnesses ------------------------------------------------
  list_tron_witnesses: () => ({
    witnesses: Array.from({ length: 27 }, (_, i) => ({
      address: `TVoteDemoSR${(i + 1).toString().padStart(2, "0")}xxxxxxxxxxxxxxxxxxxx`,
      rank: i + 1,
      totalVotes: ((420_000_000 - i * 5_000_000)).toString(),
      isActive: true,
      estVoterApr: Number((0.058 - i * 0.0003).toFixed(4)),
    })),
    userVotes: {},
    totalTronPower: 0,
    totalVotesCast: 0,
    availableVotes: 0,
    note: "demo fixture — user has no votes cast (matches get_tron_staking which has votes: [])",
  }),
};

/**
 * Stable-mint heuristic for `get_swap_quote`'s SushiSwap-routing branch.
 * Recognizes the most common stables across chains (USDC native +
 * bridged, USDT, DAI, USDS, FRAX) by lowercased address; anything else
 * falls through to the generic LiFi / 1inch branch.
 */
function isStableMint(addr: string | undefined): boolean {
  if (!addr || typeof addr !== "string") return false;
  return STABLE_MINTS.has(addr.toLowerCase());
}

const STABLE_MINTS = new Set([
  // USDC variants
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // mainnet USDC
  "0xaf88d065e77c8cc2239327c5edb3a432268e5831", // arb USDC
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // base USDC
  "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", // polygon USDC
  // USDT variants
  "0xdac17f958d2ee523a2206206994597c13d831ec7", // mainnet USDT
  "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", // arb USDT
  // DAI / USDS / FRAX
  "0x6b175474e89094c44da98b954eedeac495271d0f", // mainnet DAI
  "0xdc035d45d973e3ec169d2276ddab16f1e407384f", // mainnet USDS
  "0x853d955acef822db058eb8505911ed77f175b99e", // mainnet FRAX
]);

// ============================================================================
// Demo-data tables
// ============================================================================

const DEMO_TOKEN_BALANCES: Record<string, unknown> = {
  "ethereum:native": {
    token: "0x0000000000000000000000000000000000000000",
    symbol: "ETH",
    decimals: 18,
    amount: "2500000000000000000",
    formatted: "2.5",
    priceUsd: 2316.09,
    valueUsd: 5790.23,
  },
  "ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": {
    token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    symbol: "USDC",
    decimals: 6,
    amount: "0",
    formatted: "0",
    priceUsd: 1,
    valueUsd: 0,
  },
  "arbitrum:native": {
    token: "0x0000000000000000000000000000000000000000",
    symbol: "ETH",
    decimals: 18,
    amount: "100000000000000000",
    formatted: "0.1",
    priceUsd: 2316.09,
    valueUsd: 231.61,
  },
  "arbitrum:0xaf88d065e77c8cc2239327c5edb3a432268e5831": {
    token: "0xaf88d065e77C8CC2239327C5EDb3A432268e5831",
    symbol: "USDC",
    decimals: 6,
    amount: "1500000000",
    formatted: "1500",
    priceUsd: 1,
    valueUsd: 1500,
  },
};

const DEMO_AAVE_POSITIONS = {
  wallet: DEMO_WALLET.evm,
  positions: [
    {
      chain: "ethereum",
      collateralUsd: 4_000,
      debtUsd: 800,
      healthFactor: 4.85,
      ltv: 0.20,
      liquidationThreshold: 0.83,
      collateral: [{ symbol: "WETH", amount: "1.726", valueUsd: 4_000 }],
      debt: [{ symbol: "USDC", amount: "800", valueUsd: 800 }],
    },
  ],
  totals: { collateralUsd: 4_000, debtUsd: 800, netUsd: 3_200 },
};

const DEMO_COMPOUND_POSITIONS = {
  wallet: DEMO_WALLET.evm,
  positions: [],
  totals: { collateralUsd: 0, debtUsd: 0, netUsd: 0 },
};

const DEMO_MORPHO_POSITIONS = {
  wallet: DEMO_WALLET.evm,
  positions: [],
  totals: { collateralUsd: 0, debtUsd: 0, netUsd: 0 },
};

const DEMO_UNIV3_POSITIONS = {
  wallet: DEMO_WALLET.evm,
  positions: [
    {
      chain: "ethereum",
      tokenId: "847291",
      pair: "WETH/USDC",
      feeTier: 0.0005,
      inRange: true,
      token0: { symbol: "WETH", amount: "0.215", valueUsd: 498 },
      token1: { symbol: "USDC", amount: "498", valueUsd: 498 },
      uncollectedFees: { token0: "0.0012", token1: "2.71", valueUsd: 5.49 },
      approxImpermanentLossUsd: -3.2,
      totalValueUsd: 996,
    },
  ],
  totals: { positionValueUsd: 996, uncollectedFeesUsd: 5.49 },
};

const DEMO_LIDO_POSITIONS = {
  wallet: DEMO_WALLET.evm,
  positions: [
    {
      protocol: "lido",
      chain: "ethereum",
      stakedAsset: "stETH",
      amount: "1.2",
      valueUsd: 2_779.31,
      currentApr: 0.0312,
    },
  ],
  totals: { stakedUsd: 2_779.31, weightedApr: 0.0312 },
};

const DEMO_SOLANA_STAKING = {
  wallet: DEMO_WALLET.solana,
  marinade: { positions: [], totalMSolBalance: "0" },
  jito: { positions: [], totalJitoSolBalance: "0" },
  native: [],
  summary: { totalStakedSol: "0", positionCount: 0 },
};

const DEMO_MARGINFI_POSITIONS = {
  wallet: DEMO_WALLET.solana,
  positions: [
    {
      bankAddress: "2s37akKDBoxKcvHm9DwWXGCHA6V3uPGrBiJP6gQAaEpD",
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      symbol: "USDC",
      depositedAmount: "800",
      depositedValueUsd: 800,
      borrowedAmount: "0",
      borrowedValueUsd: 0,
      currentApy: 0.062,
    },
  ],
  totals: { suppliedUsd: 800, borrowedUsd: 0, netUsd: 800 },
};

const DEMO_KAMINO_POSITIONS = {
  wallet: DEMO_WALLET.solana,
  positions: [],
  totals: { suppliedUsd: 0, borrowedUsd: 0, netUsd: 0 },
};

const DEMO_TRON_STAKING = {
  address: DEMO_WALLET.tron,
  trxBalance: "5000",
  frozenForEnergy: { amount: "1000", expiresIn: "in 14 days" },
  frozenForBandwidth: { amount: "0", expiresIn: null },
  votes: [],
  unclaimedRewards: { amount: "12.34", lastClaimedAt: "2026-04-19T10:00:00Z" },
  resources: { energy: { used: 0, total: 152_000 }, bandwidth: { used: 145, total: 1_200 } },
};

const DEMO_BTC_SINGLE_BALANCE = {
  address: DEMO_WALLET.bitcoin,
  confirmedSats: "7500000",
  mempoolSats: "0",
  totalSats: "7500000",
  txCount: 1,
};

const DEMO_BTC_ACCOUNT_BALANCE = {
  accountIndex: 0,
  addressesQueried: 1,
  addressesCached: 1,
  totalConfirmedSats: "7500000",
  totalConfirmedBtc: "0.075",
  totalMempoolSats: "0",
  totalSats: "7500000",
  breakdown: [
    {
      address: DEMO_WALLET.bitcoin,
      addressType: "segwit",
      chain: 0,
      addressIndex: 0,
      confirmedSats: "7500000",
      mempoolSats: "0",
      totalSats: "7500000",
    },
  ],
};

const DEMO_PORTFOLIO_SUMMARY = {
  wallet: DEMO_WALLET.evm,
  totalValueUsd: 14_098,
  byChain: {
    ethereum: {
      nativeValueUsd: 5_790,
      tokenValueUsd: 0,
      defi: { lending: 3_200, staking: 2_779, lpUsd: 996 },
      total: 12_765,
    },
    arbitrum: { nativeValueUsd: 232, tokenValueUsd: 1_500, total: 1_732 },
  },
  nonEvm: {
    bitcoin: [{ address: DEMO_WALLET.bitcoin, totalSats: "7500000", valueUsd: 7_125 }],
    solana: [
      {
        address: DEMO_WALLET.solana,
        nativeSol: "12",
        usdc: "800",
        marginfi: { suppliedUsd: 800 },
        valueUsd: 3_572,
      },
    ],
    tron: [
      {
        address: DEMO_WALLET.tron,
        trx: "5000",
        usdt: "2000",
        valueUsd: 2_675,
      },
    ],
  },
  generatedAt: "2026-04-26T00:00:00Z",
};

const DEMO_TX_HISTORY = {
  wallet: DEMO_WALLET.evm,
  txs: [
    {
      hash: "0xdemo1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      chain: "ethereum",
      timestamp: "2026-04-22T11:42:11Z",
      type: "swap",
      summary: "Swapped 500 USDC → 0.215 WETH on Uniswap V3 (LP top-up)",
      valueUsd: 500,
      gasUsd: 1.21,
    },
    {
      hash: "0xdemo2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      chain: "ethereum",
      timestamp: "2026-04-15T08:17:03Z",
      type: "supply",
      summary: "Supplied 1.726 WETH to Aave V3",
      valueUsd: 4_000,
      gasUsd: 2.04,
    },
    {
      hash: "0xdemo3ccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      chain: "ethereum",
      timestamp: "2026-04-10T20:50:00Z",
      type: "stake",
      summary: "Staked 1.2 ETH → 1.2 stETH via Lido",
      valueUsd: 2_779,
      gasUsd: 1.62,
    },
    {
      hash: "0xdemo4dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      chain: "arbitrum",
      timestamp: "2026-04-02T15:33:21Z",
      type: "bridge",
      summary: "Bridged 1500 USDC from Ethereum → Arbitrum (LiFi)",
      valueUsd: 1_500,
      gasUsd: 0.42,
    },
  ],
  hasMore: false,
};
