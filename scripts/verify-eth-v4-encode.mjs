// Verify buildV4BuyCall encodes cleanly for a NORMAL ETH/V4 pool (IMD on
// Ethereum) — the shape that broke after the USDG changes (trades 114-116,
// "Cannot read properties of undefined (reading 'length')").
// Read-only: one RPC quote + local encode. No wallet, no tx, no .env needed.
const { buildV4BuyCall } = await import("../dip-swap.mjs");
const { encodeFunctionData } = await import("viem");

// IMD V4 pool on Ethereum: currency0 = native ETH, unhooked, fee 10000/ts 200
const venue = {
  kind: "v4",
  poolId: "0xb07d640fd9e2eb9dc81b953c8e4fd006bdfeaf276010fb5418eb763ca15abfb3",
  poolKey: {
    currency0: "0x0000000000000000000000000000000000000000",
    currency1: "0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7",
    fee: 10000, tickSpacing: 200,
    hooks: "0x0000000000000000000000000000000000000000",
  },
  fee: 10000, tickSpacing: 200,
  hooks: "0x0000000000000000000000000000000000000000",
};
const TOKEN = venue.poolKey.currency1;
const WALLET = "0xa71Fb297aa443aDfc22Ff74981D8C067ec3475Cb"; // recipient only

try {
  const { call, quotedOut } = await buildV4BuyCall(venue, TOKEN, 1_000_000_000_000_000n, {
    slippagePct: 3, recipient: WALLET, chainKey: "ethereum",
  });
  console.log("quote OK:", Number(quotedOut) / 1e18, "IMD per 0.001 ETH");
  console.log("commands arg:", call.args[0]);
  const data = encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args });
  console.log("✅ encode OK — calldata", data.length, "chars (was crashing here with 'reading length')");
} catch (e) {
  console.log("❌ FAILED:", e.message.slice(0, 300));
}
