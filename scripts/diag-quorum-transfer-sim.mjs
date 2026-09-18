// Simulate the exact pull the Universal Router/Permit2 does, without sending a tx.
import { createPublicClient, http, formatUnits, decodeErrorResult } from "viem";
const RPC = process.env.ALCHEMY_API_KEY ? `https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}` : "https://rpc.mainnet.chain.robinhood.com";
const c = createPublicClient({ transport: http(RPC) });
const token = "0xa6452fd7134218f62056a304eaf501f8714a26b9";
const wallet = "0xa71Fb297aa443aDfc22Ff74981D8C067ec3475Cb";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const UR = "0x8876789976decbfcbbbe364623c63652db8c0904";
const abi = [
  { name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{type:"address"},{type:"uint256"}], outputs: [{type:"bool"}] },
  { name: "transferFrom", type: "function", stateMutability: "nonpayable", inputs: [{type:"address"},{type:"address"},{type:"uint256"}], outputs: [{type:"bool"}] },
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{type:"address"}], outputs: [{type:"uint256"}] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{type:"uint8"}] },
  { name: "owner", type: "function", stateMutability: "view", inputs: [], outputs: [{type:"address"}] },
  { name: "tradingOpen", type: "function", stateMutability: "view", inputs: [], outputs: [{type:"bool"}] },
  { name: "tradingEnabled", type: "function", stateMutability: "view", inputs: [], outputs: [{type:"bool"}] },
];
const bal = await c.readContract({ address: token, abi, functionName: "balanceOf", args: [wallet] });
const amount = (bal * 1n) / 100n; // 1%

// 1) plain transfer FROM the wallet (simulated as if the wallet sent it)
try {
  const { result } = await c.simulateContract({ address: token, abi, functionName: "transfer", args: [UR, amount], account: wallet });
  console.log("SIM transfer(wallet→UR, 1%): OK");
} catch (e) {
  console.log("SIM transfer(wallet→UR, 1%): REVERT —", String(e.message).slice(0, 200));
}
// 2) transferFrom exactly as Permit2 does (from=PERMIT2, wallet→UR)
try {
  const { result } = await c.simulateContract({ address: token, abi, functionName: "transferFrom", args: [wallet, UR, amount], account: PERMIT2 });
  console.log("SIM transferFrom(PERMIT2: wallet→UR, 1%): OK");
} catch (e) {
  console.log("SIM transferFrom(PERMIT2: wallet→UR, 1%): REVERT —", String(e.message).slice(0, 200));
}
// 3) common restriction getters
for (const fn of ["owner", "tradingOpen", "tradingEnabled"]) {
  try { console.log(fn + ":", await c.readContract({ address: token, abi, functionName: fn })); }
  catch (e) { console.log(fn + ": (not present)"); }
}
