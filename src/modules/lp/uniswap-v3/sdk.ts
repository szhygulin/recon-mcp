/**
 * Typed `createRequire` wrapper around `@uniswap/v3-sdk` and
 * `@uniswap/sdk-core`. The SDKs ship as CommonJS but their ESM build
 * uses extension-less directory imports that fail under pure Node ESM
 * (`ERR_UNSUPPORTED_DIR_IMPORT`). This codebase already uses the same
 * pattern for `coinselect` (`src/modules/litecoin/coin-select.ts`) and
 * the BTC USB loader — pick whichever is closest to your IDE for
 * convention.
 *
 * Usage discipline: import only the math + Position helpers from this
 * module. Calldata for the NonfungiblePositionManager is ALWAYS
 * encoded via viem `encodeFunctionData` against
 * `src/abis/uniswap-position-manager.ts` — we don't reach for the
 * SDK's `NonfungiblePositionManager.*CallParameters` because doing so
 * would drag `@ethersproject/abi.Interface` into our calldata path
 * (Option C of the LP scope-probe — see PR description).
 */
import { createRequire } from "node:module";
import type * as V3SDK from "@uniswap/v3-sdk";
import type * as SDKCore from "@uniswap/sdk-core";

const requireCjs = createRequire(import.meta.url);

const v3sdk: typeof V3SDK = requireCjs("@uniswap/v3-sdk");
const sdkCore: typeof SDKCore = requireCjs("@uniswap/sdk-core");

export const Position = v3sdk.Position;
export const Pool = v3sdk.Pool;
export const TickMath = v3sdk.TickMath;
export const FeeAmount = v3sdk.FeeAmount;
export const TICK_SPACINGS = v3sdk.TICK_SPACINGS;
export const nearestUsableTick = v3sdk.nearestUsableTick;

export const Token = sdkCore.Token;
export const Percent = sdkCore.Percent;

export type Position = V3SDK.Position;
export type Pool = V3SDK.Pool;
export type FeeAmount = V3SDK.FeeAmount;
export type Token = SDKCore.Token;
export type Percent = SDKCore.Percent;
