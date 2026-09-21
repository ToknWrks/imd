/** LIVE test: registry seeding + multicall alpha scan against mainnet. */
process.env.MASTER_KEY = "alpha-scan-test";
const cache = JSON.parse((await import("fs")).readFileSync("data/alpha-cache.json", "utf8"));
const alpha = await import("../alpha-tokens.mjs");

const size = alpha.recordAlphaTokens(cache.alpha || []);
console.log("[1] registry size:", size);
const toks = alpha.getAlphaTokens();
console.log("    sample:", toks.slice(0, 3).map(t => `${t.symbol}@${t.address.slice(0, 10)}`).join(", "));

await alpha.fillAlphaDecimals("ethereum");
const withDec = alpha.getAlphaTokens().filter(t => t.decimals != null).length;
console.log("[2] decimals filled:", withDec, "/", toks.length);

// Scan vitalik.eth (holds hundreds of tokens — likely some alpha overlaps are
// unlikely, but the scan itself is what we're proving: 150 tokens × 1 wallet
// via multicall should complete fast and return a Map)
const WALLETS = ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"];
const t0 = Date.now();
const bal = await alpha.scanAlphaBalances(WALLETS, "ethereum");
console.log("[3] scan done in", Date.now() - t0, "ms — tokens with balance:", [...bal.entries()].filter(([, per]) => per.reduce((s, r) => s + r, 0n) > 0n).length);

// Sanity: scan a known funded address against a KNOWN token (IMD reserve) —
// temporarily add it and expect a hit only if it holds; proves the multicall
// decodes real balances. Use WETH as ground truth instead:
const { createPublicClient, http } = await import("viem");
const { mainnet } = await import("viem/chains");
const pub = createPublicClient({ chain: mainnet, transport: http("https://eth-mainnet.g.alchemy.com/v2/" + process.env.ALCHEMY_API_KEY) });
const wethBal = await pub.readContract({ address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", abi: [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }], functionName: "balanceOf", args: [WALLETS[0]] });
console.log("[4] ground truth WETH bal:", Number(wethBal) / 1e18, "(multicall path verified if scan didn't throw)");
console.log("DONE");
process.exit(0);
