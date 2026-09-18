/**
 * Full rehearsal of the WETH-quoted V4 buy on Robinhood:
 *   1. WETH.deposit 0.001 ETH (real tx — small)
 *   2. Permit2 approvals if needed (real txs)
 *   3. estimateGas the swap (free) — if it passes, the real buy is sound
 * Usage: node --env-file=.env scripts/rehearsal-v4-wrap-buy.mjs
 */
import { buildV4BuyCall, client as getClient } from "../dip-swap.mjs";
import { resolveSigner } from "../signer.mjs";
import { createPublicClient, http, parseEther, parseAbi, formatEther } from "viem";

const TOKEN = process.argv[2] ?? "0x39252e514880c1640f7466818a98412cc596b16c"; // OPAI
const AMOUNT = "0.001";
const signer = await resolveSigner("robinhood");
const c = createPublicClient({ transport: http(process.env.ALCHEMY_API_KEY ? `https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}` : "https://rpc.mainnet.chain.robinhood.com") });
const dep = { weth: "0x0bd7d308f8e1639fab988df18a8011f41eacad73", v4: { universalRouter: "0x8876789976decbfcbbbe364623c63652db8c0904" } };
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const ERC20 = parseAbi(["function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const P2ABI = parseAbi(["function allowance(address,address,address) view returns (uint160, uint48, uint48)", "function approve(address,address,uint160,uint48)"]);

const amountIn = BigInt(Math.round(Number(AMOUNT) * 1e18));
console.log("wallet:", signer.address, "ETH:", formatEther(await c.getBalance({ address: signer.address })));

// 1) pre-wrap
console.log("step 1: WETH.deposit", AMOUNT, "ETH…");
const wrapTx = await signer.callContract({ address: dep.weth, abi: parseAbi(["function deposit() payable"]), functionName: "deposit", value: amountIn });
const wrapReceipt = await c.waitForTransactionReceipt({ hash: wrapTx });
if (wrapReceipt.status !== "success") throw new Error("wrap failed");
console.log("  wrap ok:", wrapTx);

// 2) approvals
const [a1, p2] = await Promise.all([
  c.readContract({ address: dep.weth, abi: ERC20, functionName: "allowance", args: [signer.address, PERMIT2] }),
  c.readContract({ address: PERMIT2, abi: P2ABI, functionName: "allowance", args: [signer.address, dep.weth, dep.v4.universalRouter] }),
]);
if (a1 < amountIn) {
  console.log("step 2a: ERC20 approve PERMIT2…");
  const t = await signer.callContract({ address: dep.weth, abi: ERC20, functionName: "approve", args: [PERMIT2, (1n << 160n) - 1n] });
  if ((await c.waitForTransactionReceipt({ hash: t })).status !== "success") throw new Error("approve failed");
  console.log("  approve ok:", t);
}
const nowSec = BigInt(Math.floor(Date.now() / 1000));
if (p2.amount < amountIn || BigInt(p2.expiration ?? 0) <= nowSec) {
  console.log("step 2b: Permit2 approve router…");
  const t = await signer.callContract({ address: PERMIT2, abi: P2ABI, functionName: "approve", args: [dep.weth, dep.v4.universalRouter, (1n << 160n) - 1n, (1n << 48n) - 1n] });
  if ((await c.waitForTransactionReceipt({ hash: t })).status !== "success") throw new Error("permit2 approve failed");
  console.log("  permit2 ok:", t);
}

// 3) dry-run the actual swap (no funds move)
const { buildV4BuyCall } = await import("../dip-swap.mjs");
const venue = {
  kind: "v4", poolId: "0x1dae1802de9fc690", poolKey: {
    currency0: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
    currency1: TOKEN,
    fee: 100, tickSpacing: 1,
    hooks: "0x1888f5c80407755b62d549016cacf84277ab0144",
  },
};
const { call, quotedOut } = await buildV4BuyCall(venue, TOKEN, amountIn, { slippagePct: 3, recipient: signer.address, chainKey: "robinhood" });
console.log("step 3: estimateGas the swap…");
try {
  const gas = await c.estimateContractGas({ address: call.address, abi: call.abi, functionName: call.functionName, args: call.args, value: call.value, account: signer.address });
  console.log("REHEARSAL PASS — swap estimateGas:", gas.toString());
  console.log("(wallet WETH:", formatEther(await c.readContract({ address: dep.weth, abi: ERC20, functionName: "balanceOf", args: [signer.address] })), "— leave or unwind with WETH.deposit's withdraw if unwanted)");
} catch (e) {
  console.log("REHEARSAL FAIL:", String(e.message).slice(0, 200));
}
