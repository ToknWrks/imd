// Who is the sniper's signer, and what does it hold? (read-only)
import { resolveSigner } from "../signer.mjs";
import { createPublicClient, http, formatEther } from "viem";

const signer = await resolveSigner("robinhood");
console.log("signer kind:", signer.kind);
console.log("signer address:", signer.address);
console.log("failing tx sender was: 0xa71fb297aa443adfc22ff74981d8c067ec3475cb");
console.log("match:", signer.address.toLowerCase() === "0xa71fb297aa443adfc22ff74981d8c067ec3475cb");

const key = process.env.ALCHEMY_API_KEY;
const url = key ? `https://robinhood-mainnet.g.alchemy.com/v2/${key}` : "https://rpc.mainnet.chain.robinhood.com";
const c = createPublicClient({ transport: http(url) });
const eth = await c.getBalance({ address: signer.address });
console.log("ETH balance:", formatEther(eth));

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const abi = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
];
const usdg = await c.readContract({ address: USDG, abi, functionName: "balanceOf", args: [signer.address] }).catch(() => 0n);
console.log("USDG balance:", Number(usdg) / 1e6);

const tok = "0x39252e514880c1640f7466818a98412cc596b16c";
const sym = await c.readContract({ address: tok, abi, functionName: "symbol" }).catch(() => "?");
console.log("token 0x3925…b16c symbol:", sym);
const tokBal = await c.readContract({ address: tok, abi, functionName: "balanceOf", args: [signer.address] }).catch(() => 0n);
console.log("wallet holds that token:", Number(tokBal) > 0n);
