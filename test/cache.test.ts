import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cache } from "../src/data/cache.js";

describe("TTLCache", () => {
  beforeEach(() => {
    cache.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns undefined for unknown keys", () => {
    expect(cache.get("missing")).toBeUndefined();
  });

  it("returns a cached value until TTL elapses", () => {
    cache.set("k", 42, 1000);
    expect(cache.get<number>("k")).toBe(42);
    vi.advanceTimersByTime(999);
    expect(cache.get<number>("k")).toBe(42);
    vi.advanceTimersByTime(2);
    expect(cache.get<number>("k")).toBeUndefined();
  });

  it("invalidatePrefix drops matching keys only", () => {
    cache.set("aave:ethereum:1", "a", 60_000);
    cache.set("aave:arbitrum:1", "b", 60_000);
    cache.set("uniswap:ethereum:1", "c", 60_000);
    cache.invalidatePrefix("aave:");
    expect(cache.get("aave:ethereum:1")).toBeUndefined();
    expect(cache.get("aave:arbitrum:1")).toBeUndefined();
    expect(cache.get("uniswap:ethereum:1")).toBe("c");
  });

  it("remember computes once while fresh", async () => {
    const fn = vi.fn().mockResolvedValue(7);
    const a = await cache.remember("r", 5000, fn);
    const b = await cache.remember("r", 5000, fn);
    expect(a).toBe(7);
    expect(b).toBe(7);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("remember recomputes after expiry", async () => {
    const fn = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    const a = await cache.remember("r", 1000, fn);
    vi.advanceTimersByTime(1500);
    const b = await cache.remember("r", 1000, fn);
    expect(a).toBe(1);
    expect(b).toBe(2);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
