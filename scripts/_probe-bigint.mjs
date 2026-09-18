import { createPublicClient, http, defineChain, keccak256, toHex } from "viem";
const robinhood = defineChain({ id: 4663, name: "Robinhood", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } } });
const c = createPublicClient({ chain: robinhood, transport: http("https://rpc.mainnet.chain.robinhood.com") });
const TOPIC = keccak256(toHex("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"));
const latest = await c.getBlockNumber();
console.log("latest:", latest, typeof latest);
// SIRIUS poolId
const poolId = "0x3206ce1c4d3f9fa25cfab95de7e743f61912fcb03efa6b3bff02cc577dcda22b";
const from = BigInt(latest - 100);
console.log("from type:", typeof from, from.toString());
const logs = await c.getLogs({ address: "0x8366a39CC670B4001A1121B8F6A443A643e40951", topics: [TOPIC, poolId], fromBlock: from, toBlock: BigInt(latest) });
console.log("logs found:", logs.length);
if (logs.length) console.log("sample data:", logs[0].data.slice(0, 140));
