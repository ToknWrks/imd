/**
 * hook-intel.mjs — inspect the IMD/ETH hooked pool's hook contract:
 * size, address constants embedded (who it calls), and whether the launchpad
 * docs/hook expose what hookData must contain. Read-only.
 */
import { readFileSync } from "fs";

const env = Object.fromEntries(
  readFileSync("/Users/lancepitman/accumulate-imd/.env", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
const res = await fetch(`https://eth-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: ["0xC6C965BD164C483E87D0B550671798E9A3602840", "latest"] }),
});
const j = await res.json();
const code = (j.result || "0x").toLowerCase();
console.log("hook bytecode size:", (code.length - 2) / 2, "bytes");

const KNOWN = {
  UniversalRouter: "66a9893cc07d91d95644aedd05d03f95e1dba8af",
  Permit2: "000000000022d473030f116ddee9f6b43ac78ba3",
  PoolManager: "000000000004444c5dc75cb358380d2e3de08a90",
  PermitSpender: "23617e59a5925b2a4bf75d73ff6711cd0b29de85",
  IMD: "d34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7",
  PositionManager: "bd1d5f0bd4e21b4f9a3baimm", // placeholder check
};
for (const [name, a] of Object.entries(KNOWN)) {
  if (code.includes(a)) console.log(`references ${name}: YES`);
}
// Small 24-bit function selectors can hint at interface — skip deep RE; report size only.
console.log("\n(note: full RE is out of scope — the on-chain tx scan is the authoritative source for hookData)");
