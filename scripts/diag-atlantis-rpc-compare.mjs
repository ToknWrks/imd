/**
 * diag-atlantis-rpc-compare.mjs — run the IDENTICAL leg-1 calldata estimate
 * against both Robinhood RPCs (public vs Alchemy). If Alchemy reverts where
 * the public RPC passes, the failure is RPC-specific state (e.g. Alchemy's
 * node is behind on liquidity/fee state, or sees a different pending view).
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

for (const line of readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.env"), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

const { createPublicClient, http, parseAbi, encodeAbiParameters, parseAbiParameters, encodeFunctionData } = await import("viem");
const { getChain } = await import("../chains.mjs");
const dep = getChain("robinhood");

const WALLET = "0xa71Fb297aa443aDfc22Ff74981D8C067ec3475Cb";
const ATL = "0x26915c10e8ce9fb86b836fe8b129a1c5c3771e18";
const STOCK = "0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD";
const HOOK = "0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544";
const amountIn = 97053059907225739329536n;
const spot = 2.0438412913959115e-8;
const stockMin = BigInt(Math.floor(Number(amountIn) * spot * 0.97));

const wn = (x) => BigInt(x).toString(16).padStart(64, "0");
const ad = (a) => a.slice(2).toLowerCase().padStart(64, "0");
const swapParams = "0x" + wn(0x20) + [
  ad(ATL), wn(5 * 32), wn(13 * 32), wn(amountIn), wn(stockMin),
  wn(1), wn(0x20), ad(STOCK), wn(8388608), wn(8), ad(HOOK), wn(0xa0), wn(0), wn(0),
].join("");
const settleParams = encodeAbiParameters(parseAbiParameters("address currency, uint256 amount, bool payerIsUser"), [ATL, 0n, true]);
const takeParams = encodeAbiParameters(parseAbiParameters("address currency, address recipient, uint256 amount"), [STOCK, WALLET, 0n]);
const payload = encodeAbiParameters(parseAbiParameters("bytes, bytes[]"), ["0x070b0e", [swapParams, settleParams, takeParams]]);
const data = encodeFunctionData({
  abi: parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]),
  functionName: "execute",
  args: ["0x10", [payload], BigInt(Math.floor(Date.now() / 1000) + 300)],
});

const alchemyKey = process.env.ALCHEMY_API_KEY?.trim();
const rpcs = {
  public: dep.httpRpc(),
  alchemy: `https://robinhood-mainnet.g.alchemy.com/v2/${alchemyKey}`,
};

for (const [name, url] of Object.entries(rpcs)) {
  const r = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "eth_estimateGas",
      params: [{ from: WALLET, to: dep.v4.universalRouter, data, value: "0x0" }, "latest"],
    }),
  });
  const j = await r.json();
  if (j.error) console.log(`${name}: ❌ ${JSON.stringify(j.error).slice(0, 250)}`);
  else console.log(`${name}: ✅ gas ${BigInt(j.result).toString()}`);
}

// Also compare block numbers / state roots to see if they even agree on state
for (const [name, url] of Object.entries(rpcs)) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber" }) });
  const j = await r.json();
  console.log(`${name} block:`, BigInt(j.result).toString());
}
