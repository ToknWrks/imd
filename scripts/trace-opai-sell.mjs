/** Where did the OPAI sell proceeds go? Decode the sell tx receipt + balances. (read-only) */
import { createPublicClient, http, parseAbi, formatEther, formatUnits } from "viem";
const key = process.env.ALCHEMY_API_KEY;
const c = createPublicClient({ transport: http(key ? `https://robinhood-mainnet.g.alchemy.com/v2/${key}` : "https://rpc.mainnet.chain.robinhood.com") });
const wallet = "0xa71Fb297aa443aDfc22Ff74981D8C067ec3475Cb";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const OPAI = "0x39252e514880c1640f7466818a98412cc596b16c";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"]);
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const TX = "0x74b20ce3c000f22b5c999a97006fdce7730c8d52d6ff1419a20b26e70a7fc427";
const r = await c.getTransactionReceipt({ hash: TX });
console.log("sell tx status:", r.status, "| logs:", r.logs.length, "| gasUsed:", r.gasUsed.toString());
for (const log of r.logs) {
  if (log.topics[0] === TRANSFER) {
    const from = "0x" + log.topics[1].slice(26), to = "0x" + log.topics[2].slice(26);
    const dec = await c.readContract({ address: log.address, abi: ERC20, functionName: "decimals" }).catch(() => 18);
    const val = formatUnits(log.data, dec);
    const sym = log.address.toLowerCase() === WETH ? "WETH" : log.address.toLowerCase() === OPAI ? "OPAI" : log.address.toLowerCase() === USDG ? "USDG" : log.address.slice(0, 10);
    console.log(`  Transfer ${sym}: ${val}  ${from.slice(0, 10)}… → ${to.slice(0, 10)}…`);
  }
}
// hook address activity
const HOOK = "0x1888f5c80407755b62d549016cacf84277ab0144";
const hookLogs = r.logs.filter(l => l.address.toLowerCase() === HOOK);
console.log("logs from hook contract:", hookLogs.length);

console.log("\ncurrent wallet balances:");
console.log("  ETH:", formatEther(await c.getBalance({ address: wallet })));
for (const [sym, addr] of [["WETH", WETH], ["OPAI", OPAI], ["USDG", USDG]]) {
  const [bal, dec] = await Promise.all([
    c.readContract({ address: addr, abi: ERC20, functionName: "balanceOf", args: [wallet] }),
    c.readContract({ address: addr, abi: ERC20, functionName: "decimals" }),
  ]);
  console.log(`  ${sym}:`, formatUnits(bal, dec), `(decimals ${dec})`);
}
