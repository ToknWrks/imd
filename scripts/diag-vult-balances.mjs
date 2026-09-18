import { readFileSync } from "fs";
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const { createPublicClient, http, formatEther } = await import("viem");
const { ethereum } = await import("viem/chains");
const c = createPublicClient({ chain: ethereum, transport: http(`https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`) });
const W = "0xa71Fb297aa443aDfc22Ff74981D8C067ec3475Cb";
console.log("ETH:", formatEther(await c.getBalance({ address: W })));
const erc20 = [{name:"balanceOf",type:"function",stateMutability:"view",inputs:[{name:"a",type:"address"}],outputs:[{type:"uint256"}]}];
console.log("USDC raw:", String(await c.readContract({ address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", abi: erc20, functionName: "balanceOf", args: [W] })));
