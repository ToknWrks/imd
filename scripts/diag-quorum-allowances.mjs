import { createPublicClient, http, formatUnits } from "viem";
const RPC = process.env.ALCHEMY_API_KEY ? `https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}` : "https://rpc.mainnet.chain.robinhood.com";
const c = createPublicClient({ transport: http(RPC) });
const token = "0xa6452fd7134218f62056a304eaf501f8714a26b9";
const wallet = "0xa71Fb297aa443aDfc22Ff74981D8C067ec3475Cb";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const UR = "0x8876789976decbfcbbbe364623c63652db8c0904";
const abi = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{type:"address"}], outputs: [{type:"uint256"}] },
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{type:"address"},{type:"address"}], outputs: [{type:"uint256"}] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{type:"uint8"}] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{type:"string"}] },
];
const [bal, dec, sym, alP2, alURdirect] = await Promise.all([
  c.readContract({ address: token, abi, functionName: "balanceOf", args: [wallet] }),
  c.readContract({ address: token, abi, functionName: "decimals" }).catch(() => 18),
  c.readContract({ address: token, abi, functionName: "symbol" }).catch(() => "?"),
  c.readContract({ address: token, abi, functionName: "allowance", args: [wallet, PERMIT2] }),
  c.readContract({ address: token, abi, functionName: "allowance", args: [wallet, UR] }),
]);
console.log("symbol:", sym, "decimals:", dec);
console.log("wallet balance:", formatUnits(bal, dec));
console.log("ERC20 allowance -> PERMIT2:", formatUnits(alP2, dec));
console.log("ERC20 allowance -> UR direct:", formatUnits(alURdirect, dec));
const p2abi = [{ name: "allowance", type: "function", stateMutability: "view", inputs: [{type:"address"},{type:"address"},{type:"address"}], outputs: [{type:"uint160"},{type:"uint48"},{type:"uint48"}] }];
const p2 = await c.readContract({ address: PERMIT2, abi: p2abi, functionName: "allowance", args: [wallet, token, UR] });
console.log("Permit2 allowance (amount/expiration):", formatUnits(p2[0], dec), "exp:", Number(p2[1]), "now:", Math.floor(Date.now()/1000), p2[1] > 0 && Number(p2[1]) < Math.floor(Date.now()/1000) ? "EXPIRED" : "valid");
