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
    },
    uniswap: {
      positionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
      factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
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
  },
  arbitrum: {
    aave: {
      poolAddressProvider: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
      uiPoolDataProvider: "0x5c5228aC8BC1528482514aF3e27E692495148717",
    },
    uniswap: {
      positionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
      factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
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
    },
    uniswap: {
      positionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
      factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
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
} as const;

export type ChainContracts<C extends SupportedChain> = (typeof CONTRACTS)[C];

/** Native asset symbol per chain. */
export const NATIVE_SYMBOL: Record<SupportedChain, string> = {
  ethereum: "ETH",
  arbitrum: "ETH",
  // Polygon's native token is MATIC (rebranding to POL is in progress — same contract).
  polygon: "MATIC",
};
