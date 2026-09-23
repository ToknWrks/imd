/**
 * find-ui-sell-tx.mjs — find the user's ACTUAL successful V4 IMD sell on-chain.
 * The pasted UI calldata has a nibble-shift corruption (manual copy error), so we
 * fetch ground truth from the chain: recent IMD transfers FROM the user's EOA,
 * then pick the tx sent to the Universal Router.
 * Read-only.
 */
import { createPublicClient, http, getAddress } from "viem";
import { mainnet } from "viem/chains";
import { readFileSync } from "fs";

process.chdir("/Users/lancepitman/accumulate-imd");
const env = Object.fromEntries(
  readFileSync(".env", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
const key = env.ALCHEMY_API_KEY;
const EOA = "0xa71fb297aa443adfc22ff74981d8c067ec3475cb";
const IMD = "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7";
const UR = "0x66a9893cc07d91d95644aedd05d03f95e1dba8af";

// Alchemy asset-transfers API (not via viem — raw JSON-RPC)
const rpc = async (method, params) => {
  const res = await fetch(`https://eth-mainnet.g.alchemy.com/v2/${key}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await res.json()).result;
};

const transfers = await rpc("alchemy_getTokenTransfers", [{
  fromAddress: EOA,
  contractAddresses: [IMD],
  category: ["erc20"],
  maxCount: "0x64",
  withMetadata: true,
  order: "desc",
}]);
if (!transfers?.transfers) {
  console.error("alchemy_getTokenTransfers failed:", JSON.stringify(transfers ?? "undefined response").slice(0, 400));
  process.exit(1);
}

console.log(`found ${transfers.transfers.length} IMD transfers from the EOA`);
const UR_LO = UR.toLowerCase();
for (const t of transfers.transfers.slice(0, 15)) {
  const tx = await rpc("eth_getTransactionByHash", [t.hash]);
  const to = tx?.to?.toLowerCase();
  const tag = to === UR_LO ? " ← UNIVERSAL ROUTER (the V4 sell!)"
    : to === "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45" ? " (V3 Router02)"
    : to === "0x3fc91a3afd70395cd496c6477e7a4cf80c76e2ca" ? " (Uniswap UniversalRouter 1.2)"
    : "";
  console.log(
    `block ${t.blockNum} | ${t.value} IMD | to=${to}${tag}`
  );
  if (tag.includes("UNIVERSAL ROUTER")) {
    console.log("\n=== CANDIDATE: exact input (first 300 chars) ===");
    console.log(tx.input.slice(0, 300));
  }
}
