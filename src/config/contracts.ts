import type { SupportedChain } from "../types/index.js";

/**
 * Canonical contract addresses per chain.
 * Source: Aave V3 deployments, Uniswap V3 deployments, Lido docs, EigenLayer repo.
 */
export const CONTRACTS = {
  ethereum: {
    aave: {
      poolAddressProvider: "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e",
      uiPoolDataProvider: "0x3F78BBD206e4D3c504Eb854232EdA7e47E9Fd8FC",
      // Pinned Pool address used by the pre-sign safety check. Derived from
      // PoolAddressesProvider.getPool() at deploy time and stable since Aave
      // V3 launch on this chain. Used in place of a live getPool() read so a
      // compromised RPC cannot forge a malicious pool into our allowlist.
      pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
    },
    uniswap: {
      positionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
      factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
      swapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
      quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    },
    lido: {
      stETH: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
      wstETH: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
      withdrawalQueue: "0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1",
    },
    eigenlayer: {
      strategyManager: "0x858646372CC42E1A627fcE94aa7A7033e7CF075A",
      // EIP-55 checksum: second `f` is lowercase in the canonical form. viem's readContract
      // re-validates address checksums and will throw InvalidAddressError otherwise.
      delegationManager: "0x39053D51B77DC0d36036Fc1fCc8Cb819df8Ef37A",
    },
    /**
     * Rocket Pool — rETH liquid-staking. Mainnet only; the rETH bridged
     * representations on L2s (Arbitrum/Optimism/Base/Polygon) are not
     * deposit-and-mint capable, so stake/unstake live exclusively on L1.
     * Source: official Rocket Pool docs repo
     * `docs/en/protocol/contracts-integrations.md`. RocketDepositPool was
     * upgraded once (v1.0 → v1.1 → v1.2 Atlas); the address below is the
     * current Atlas deployment. rETH itself has been at the same address
     * since launch — its upgrade path is via RocketStorage proxy lookup, so
     * the on-chain address is effectively stable.
     */
    rocketpool: {
      depositPool: "0xDD3f50F8A6CafbE9b31a427582963f465E745AF8",
      rETH: "0xae78736Cd615f374D3085123A210448E74Fc6393",
      storage: "0x1d8f8f00cfa6758d7bE78336684788Fb0ee0Fa46",
    },
    // Common ERC-20 tokens used for portfolio summary.
    tokens: {
      USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      WBTC: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
      LINK: "0x514910771AF9Ca656af840dff83E8264EcF986CA",
      UNI: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
      AAVE: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9",
      LDO: "0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32",
    },
    compound: {
      cUSDCv3: "0xc3d688B66703497DAA19211EEdff47f25384cdc3",
      cUSDTv3: "0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840",
      cWETHv3: "0xA17581A9E3356d9A858b789D68B4d866e593aE94",
      cwstETHv3: "0x3D0bb1ccaB520A66e607822fC55BC921738fAFE3",
    },
    morpho: {
      /** Morpho Blue singleton on Ethereum. */
      blue: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
    },
    /**
     * Curve Finance — v0.1 surface (Ethereum stable_ng plain pools only).
     * All addresses verified against `@curvefi/api` v2.69.0
     * `lib/constants/network_constants.js` `ALIASES_ETHEREUM` block; also
     * cross-checked against `github.com/curvefi/metaregistry/main/scripts/utils/constants.py`.
     * Per `claude-work/plan-curve-v1.md`'s rnd-verified gates table.
     *
     * Future PRs add: stable_factory (legacy), crypto_factory,
     * twocrypto_factory, tricrypto_factory, plus per-chain entries on
     * Arbitrum/Polygon. Base deferred until the SDK author's TODO
     * comments on Base CRV/gauge_controller addresses resolve.
     */
    curve: {
      /** StableNG factory — newest stable-pool generation. */
      stableNgFactory: "0x6A8cbed756804B16E05E741eDaBd5cB544AE21bf",
      /** CRV reward token. */
      crv: "0xD533a949740bb3306d119CC777fa900bA034cd52",
      /** GaugeController — emissions distribution; metadata only on L2s. */
      gaugeController: "0x2F50D538606Fa9EDD2B11E2446BEb18C9D5846bB",
      /** Universal AddressProvider (CREATE2-deterministic across chains). */
      addressProvider: "0x0000000022D53366457F9d5E68Ec105046FC4383",
    },
  },
  arbitrum: {
    aave: {
      poolAddressProvider: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
      uiPoolDataProvider: "0x5c5228aC8BC1528482514aF3e27E692495148717",
      pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    },
    uniswap: {
      positionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
      factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
      swapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
      quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    },
    lido: {
      wstETH: "0x5979D7b546E38E414F7E9822514be443A4800529",
    },
    tokens: {
      USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      "USDC.e": "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8",
      USDT: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
      DAI: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
      WETH: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
      WBTC: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
      LINK: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4",
      ARB: "0x912CE59144191C1204E64559FE8253a0e49E6548",
    },
    compound: {
      cUSDCv3: "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf",
      "cUSDC.ev3": "0xA5EDBDD9646f8dFF606d7448e414884C7d905dCA",
      cUSDTv3: "0xd98Be00b5D27fc98112BdE293e487f8D4cA57d07",
      cWETHv3: "0x6f7D514bbD4aFf3BcD1140B7344b32f063dEe486",
    },
  },
  polygon: {
    aave: {
      // Aave V3 uses the same PoolAddressesProvider address across most L2s
      // (deterministic deploy); UiPoolDataProviderV3 is chain-specific.
      poolAddressProvider: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
      uiPoolDataProvider: "0xC69728f11E9E6127733751c8410432913123acf1",
      pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    },
    uniswap: {
      positionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
      factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
      swapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
      quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    },
    // Lido has no native deployment on Polygon (stMATIC is a separate protocol
    // from a different team); we intentionally omit the `lido` entry so the
    // staking reader short-circuits for this chain.
    tokens: {
      USDC: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
      "USDC.e": "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
      USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
      DAI: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
      WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
      WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
      WBTC: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",
      LINK: "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39",
      AAVE: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B",
    },
    compound: {
      cUSDCv3: "0xF25212E676D1F7F89Cd72fFEe66158f541246445",
      "cUSDT.ev3": "0xaeB318360f27748Acb200CE616E389A6C9409a07",
    },
  },
  base: {
    aave: {
      // Aave V3 Base deployment. PoolAddressesProvider is chain-specific on
      // Base (not the deterministic cross-L2 address), per the Aave docs.
      poolAddressProvider: "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D",
      uiPoolDataProvider: "0x174446a6741c0bdA9cEe4D8FF4419Fb0ca1c7883",
      pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    },
    uniswap: {
      // Canonical Uniswap V3 deployment on Base. Note: SwapRouter02 and
      // QuoterV2 addresses differ from the standard cross-chain values
      // used on Ethereum/Arbitrum/Polygon (Base was deployed later with
      // fresh addresses) — do not assume uniformity.
      positionManager: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
      factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
      swapRouter02: "0x2626664c2603336E57B271c5C0b26F421741e481",
      quoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    },
    // Lido and EigenLayer are L1-only — no `lido`/`eigenlayer` keys means the
    // staking reader short-circuits for Base, matching how Polygon is handled.
    tokens: {
      // Native USDC on Base (Circle-issued). USDbC is the bridged legacy
      // Coinbase-wrapped USDC — kept because Compound still has a market for
      // it and some older positions are denominated in it.
      USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      USDbC: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
      DAI: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
      WETH: "0x4200000000000000000000000000000000000006",
      cbETH: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22",
    },
    compound: {
      cUSDCv3: "0xb125E6687d4313864e53df431d5425969c15Eb2F",
      cUSDbCv3: "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf",
      cWETHv3: "0x46e6b214b524310239732D51387075E0e70970bf",
    },
    // Morpho Blue is deployed on Base (same bytecode/address as mainnet)
    // but we deliberately omit the `morpho` key here because the discovery
    // scan in src/modules/morpho/discover.ts needs a known deployment block
    // to start the `eth_getLogs` walk from — and that block hasn't been
    // verified for Base yet. Add the address + block together in a future
    // PR rather than guess and risk missing positions.
  },
  optimism: {
    aave: {
      // Aave V3 on Optimism. PoolAddressesProvider matches the deterministic
      // cross-L2 address (same on Arbitrum/Polygon); UiPoolDataProvider is
      // chain-specific. Sourced from bgd-labs/aave-address-book AaveV3Optimism.
      poolAddressProvider: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
      uiPoolDataProvider: "0xa6741111f4CcB5162Ec6A825465354Ed8c6F7095",
      pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    },
    uniswap: {
      // Optimism uses the canonical cross-chain Uniswap V3 addresses (same as
      // Ethereum/Arbitrum/Polygon — only Base diverged). Verified against
      // Uniswap/docs Optimism-Deployments.md.
      positionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
      factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
      swapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
      quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    },
    // Lido / EigenLayer are L1-only; Morpho Blue is deployed on Optimism but
    // we omit it for the same reason as Base — the discovery scan needs a
    // verified deployment block. Add later as a follow-up.
    tokens: {
      // USDC is the Circle-native (post-2023); USDC.e is the bridged legacy
      // version that some positions are still denominated in.
      USDC: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
      "USDC.e": "0x7F5c764cBc14f9669B88837ca1490cCa17c31607",
      USDT: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
      DAI: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
      WETH: "0x4200000000000000000000000000000000000006",
      WBTC: "0x68f180fcCe6836688e9084f035309E29Bf0A2095",
      // OP-stack predeploy addresses (0x4200... range). The OP token is the
      // governance token for the Optimism Collective.
      OP: "0x4200000000000000000000000000000000000042",
    },
    compound: {
      // Compound V3 markets on Optimism, sourced from compound-finance/comet
      // deployments/optimism/{usdc,weth,usdt}/roots.json.
      cUSDCv3: "0x2e44e174f7D53F0212823acC11C01A11d58c5bCB",
      cWETHv3: "0xE36A30D249f7761327fd973001A32010b521b6Fd",
      cUSDTv3: "0x995E394b8B2437aC8Ce61Ee0bC610D617962B214",
    },
  },
} as const;

export type ChainContracts<C extends SupportedChain> = (typeof CONTRACTS)[C];

/** Native asset symbol per chain. */
export const NATIVE_SYMBOL: Record<SupportedChain, string> = {
  ethereum: "ETH",
  arbitrum: "ETH",
  // Polygon's native token is MATIC (rebranding to POL is in progress — same contract).
  polygon: "MATIC",
  base: "ETH",
  optimism: "ETH",
};

/**
 * Token decimals by symbol for the tokens enumerated above. Used by the
 * calldata decoder to render `valueHuman` on ERC-20 `amount` args ("1.0 USDC"
 * instead of the raw uint256). Any token missing here falls through to the
 * raw bigint string in the preview — unknown tokens never render a decimal.
 *
 * Lowercase symbol keys so address→symbol lookups in `TOKEN_META` compose
 * cleanly. Values sourced from each token's on-chain `decimals()` — the
 * canonical set on Ethereum mainnet, identical on every L2 for the same
 * asset (USDC.e / USDbC inherit the native USDC's 6 decimals).
 */
const DECIMALS_BY_SYMBOL: Record<string, number> = {
  usdc: 6,
  "usdc.e": 6,
  usdbc: 6,
  usdt: 6,
  "usdt.e": 6,
  dai: 18,
  weth: 18,
  wbtc: 8,
  link: 18,
  uni: 18,
  aave: 18,
  ldo: 18,
  arb: 18,
  wmatic: 18,
  cbeth: 18,
  op: 18,
};

export interface TokenInfo {
  symbol: string;
  decimals: number;
}

function buildTokenMeta(): Record<SupportedChain, Record<string, TokenInfo>> {
  const out = {} as Record<SupportedChain, Record<string, TokenInfo>>;
  for (const chain of Object.keys(CONTRACTS) as SupportedChain[]) {
    const chainTokens = (CONTRACTS[chain] as { tokens?: Record<string, string> }).tokens;
    const entry: Record<string, TokenInfo> = {};
    if (chainTokens) {
      for (const [symbol, addr] of Object.entries(chainTokens)) {
        const decimals = DECIMALS_BY_SYMBOL[symbol.toLowerCase()];
        if (decimals === undefined) continue;
        entry[addr.toLowerCase()] = { symbol, decimals };
      }
    }
    out[chain] = entry;
  }
  return out;
}

/**
 * Lower-cased-address → `{ symbol, decimals }` map, indexed per chain.
 * `TOKEN_META.ethereum["0xa0b8...eb48"]` → `{ symbol: "USDC", decimals: 6 }`.
 */
export const TOKEN_META: Record<SupportedChain, Record<string, TokenInfo>> = buildTokenMeta();
