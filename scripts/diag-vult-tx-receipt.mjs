import { readFileSync } from "fs";
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const { createPublicClient, http, formatEther, formatUnits } = await import("viem");
const { ethereum } = await import("viem/chains");
const c = createPublicClient({ chain: ethereum, transport: http(`https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`) });
const tx = process.argv[2] || "0xc023fd5f0c5a6db71096cccb4e5a531d2a75fab0689aa072ede5b941da32ec56";
const r = await c.getTransactionReceipt({ hash: tx });
console.log("status:", r.status === "success" ? "✅ success" : "❌ " + r.status, "| block:", r.blockNumber, "| gas:", r.gasUsed.toString());
const VULT = "0xb788144DF611029C60b859DF47e79B7726C4DEBa";
const transfer = r.logs.filter((l) => l.address.toLowerCase() === VULT.toLowerCase() && l.topics[0] === "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" && l.topics[1].toLowerCase() !== "0x0000000000000000000000000000000000000000000000000000000000000000");
for (const l of transfer) console.log("VULT received:", formatUnits(BigInt(l.data), 18));
const bal = await c.readContract({ address: VULT, abi: [{name:"balanceOf",type:"function",stateMutability:"view",inputs:[{name:"a",type:"address"}],outputs:[{type:"uint256"}]}], functionName: "balanceOf", args: ["0xa71Fb297aa443aDfc22Ff74981D8C067ec3475Cb"] });
console.log("wallet VULT balance now:", formatUnits(bal, 18));
