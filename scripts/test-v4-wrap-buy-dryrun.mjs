/**
 * Dry-run the FIXED WETH-quoted-pool buy calldata via eth_estimateGas.
 * No funds move — a broken call reverts in simulation.
 * Usage: node --env-file=.env scripts/test-v4-wrap-buy-dryrun.mjs <token>
 */
import { buildV4BuyCall } from "../dip-swap.mjs";
import { resolveSigner } from "../signer.mjs";
import { createPublicClient, http, parseEther } from "viem";

const token = process.argv[2] ?? "0x39252e514880c1640f7466818a98412cc596b16c"; // OPAI
const signer = await resolveSigner("robinhood");
const key = process.env.ALCHEMY_API_KEY;
const url = key ? `https://robinhood-mainnet.g.alchemy.com/v2/${key}` : "https://rpc.mainnet.chain.robinhood.com";
const c = createPublicClient({ transport: http(url) });

// Rebuild the exact pool OPAI's buy used (WETH/token, fee 100, tick 1, hooked)
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const venue = {
  kind: "v4",
  poolId: null,
  poolKey: {
    currency0: WETH.toLowerCase() < token.toLowerCase() ? WETH : token,
    currency1: WETH.toLowerCase() < token.toLowerCase() ? token : WETH,
    fee: 100,
    tickSpacing: 1,
    hooks: "0x1888f5c80407755b62d549016cacf84277ab0144",
  },
};
// Ensure currency0 < currency1 (V4 sorts)
if (venue.poolKey.currency0.toLowerCase() > venue.poolKey.currency1.toLowerCase()) {
  [venue.poolKey.currency0, venue.poolKey.currency1] = [venue.poolKey.currency1, venue.poolKey.currency0];
}
const tokenIs0 = venue.poolKey.currency0.toLowerCase() === token.toLowerCase();
console.log("pool:", { currency0: venue.poolKey.currency0, currency1: venue.poolKey.currency1, fee: 100, hooks: venue.poolKey.hooks, tokenIs0 });

const amountIn = parseEther("0.005");
const { call, isHooked, quotedOut } = await buildV4BuyCall(venue, token, amountIn, { slippagePct: 3, recipient: signer.address, chainKey: "robinhood" });
console.log("commands:", call.args[0], "| quotedOut:", quotedOut.toString(), "| hooked:", isHooked);

try {
  const gas = await c.estimateContractGas({
    address: call.address, abi: call.abi, functionName: call.functionName,
    args: call.args, value: call.value, account: signer.address,
  });
  console.log("DRY RUN PASS — estimateGas:", gas.toString());
} catch (e) {
  console.log("DRY RUN FAIL:", String(e.message).slice(0, 300));
}
function parseEtherLike(s) { return BigInt(Math.round(Number(s) * 1e18)); }
