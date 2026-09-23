/**
 * diag-all-scws.mjs — check every SCW in the registry for USDC/IMD/ETH balances.
 * The user sees "6.06 in the SCW wallet" — find which address actually holds it.
 * Read-only.
 */
import { readFileSync } from "fs";

const env = Object.fromEntries(
  readFileSync("/Users/lancepitman/accumulate-imd/.env", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
const url = `https://eth-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`;
const IMD = "d34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7";
const USDC = "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const txt = await res.text();
      if (!txt) { await sleep(500); continue; }
      return JSON.parse(txt);
    } catch { await sleep(800); }
  }
  return {};
}

const balOf = async (token, owner) => {
  const j = await rpc("eth_call", [{ to: "0x" + token, data: "0x70a08231000000000000000000000000" + owner }, "latest"]);
  return j.result ? BigInt(j.result) : 0n;
};

const reg = JSON.parse(readFileSync("/Users/lancepitman/accumulate-imd/data/connected-wallets.json", "utf8"));
const scws = new Set(Object.values(reg).map((r) => r.scwAddress.toLowerCase()).filter((a) => a && !a.startsWith("eeee")));
// also check the v1 EOA-owned wallets themselves
for (const [addr, rec] of Object.entries(reg)) {
  console.log(`wallet ${addr.slice(0, 10)}… → SCW ${rec.scwAddress}`);
}
console.log("");

for (const scw of scws) {
  const eth = await rpc("eth_getBalance", ["0x" + scw, "latest"]);
  const imd = await balOf(IMD, scw);
  const usdc = await balOf(USDC, scw);
  const ethN = eth.result ? Number(BigInt(eth.result)) / 1e18 : 0;
  const imdN = Number(imd) / 1e18;
  const usdcN = Number(usdc) / 1e6;
  if (ethN > 0.0001 || imdN > 0.001 || usdcN > 0.01) {
    console.log(`★ 0x${scw}: ETH=${ethN} IMD=${imdN} USDC=${usdcN}`);
  } else {
    console.log(`  0x${scw}: (empty)`);
  }
}
