/**
 * Helper: match a TronGrid URL against the two endpoints the bandwidth
 * pre-flight hits and return a success fixture. Callers fall through to
 * their own URL handling on a `null` return.
 *
 * The pre-flight needs two things:
 *   - `/wallet/getaccountresource` for the bandwidth meter (free + staked pools)
 *   - `/wallet/getaccount` for the liquid TRX balance
 *
 * The default fixture returns plenty of bandwidth AND plenty of TRX so the
 * pre-flight passes trivially — tests that want to exercise the
 * insufficient-bandwidth branch should short-circuit with their own mock
 * before falling through to this helper.
 */
export function maybeTronBandwidthResponse(url: string): Response | null {
  if (url === "https://api.trongrid.io/wallet/getaccountresource") {
    return new Response(
      JSON.stringify({
        freeNetUsed: 0,
        freeNetLimit: 5000,
        NetUsed: 0,
        NetLimit: 5000,
        EnergyUsed: 0,
        EnergyLimit: 1_000_000,
        tronPowerUsed: 0,
        tronPowerLimit: 0,
      }),
      { status: 200 }
    );
  }
  if (url === "https://api.trongrid.io/wallet/getaccount") {
    return new Response(JSON.stringify({ balance: 1_000_000_000 }), { status: 200 }); // 1000 TRX
  }
  return null;
}
