// The exit tx swapped QUORUM → some token of the 0xe5e7… contract (log 2),
// NOT USDG directly. Identify that second token and its amount.
import { createPublicClient, http, defineChain, parseAbi } from "viem";
const robinhood = defineChain({ id: 4663, name: "Robinhood", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } } });
const c = createPublicClient({ chain: robinhood, transport: http("https://rpc.mainnet.chain.robinhood.com") });
const META = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const addr = "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044";
const [sym, dec] = await Promise.all([
  c.readContract({ address: addr, abi: META, functionName: "symbol" }).catch(() => "?"),
  c.readContract({ address: addr, abi: META, functionName: "decimals" }).catch(() => 18),
]);
// log2 data: word1 = amount0? event unknown; but the data had 0x1aca31f1483700000000 ≈ ?
const raw = 0x1aca31f1483700000000n;
console.log("mystery token:", sym, "decimals:", dec);
console.log("amount (its decimals):", Number(raw) / 10 ** Number(dec));
process.exit(0);
