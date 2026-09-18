// Identify the 0xe5e7… token contract (the "Swap"-looking event emitter in the
// exit tx) — is the sale paying out in a stock token instead of USDG/ETH?
import { createPublicClient, http, defineChain } from "viem";
const robinhood = defineChain({ id: 4663, name: "Robinhood", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } } });
const c = createPublicClient({ chain: robinhood, transport: http("https://rpc.mainnet.chain.robinhood.com") });
const MYSTERY = "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044";
const W = "0xa71Fb297aa443aDfc22Ff74981D8C067ec3475Cb";
const code = await c.getBytecode({ address: MYSTERY });
console.log("mystery has code:", code !== undefined && code !== "0x", "size bytes:", Math.max(0, (code?.length ?? 0) / 2 - 2));
const ERC20 = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }, { type: "function", name: "symbol", stateMutability: "view", outputs: [{ type: "string" }] }];
const bal = await c.readContract({ address: MYSTERY, abi: ERC20, functionName: "balanceOf", args: [W] }).catch((e) => "read fail: " + e.message.slice(0, 60));
const sym = await c.readContract({ address: MYSTERY, abi: ERC20, functionName: "symbol", args: [] }).catch((e) => "?" + e.message.slice(0, 40));
console.log("wallet balance of mystery token:", bal?.toString?.() ?? bal, "symbol:", sym);
process.exit(0);
