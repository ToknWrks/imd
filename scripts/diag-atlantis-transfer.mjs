/**
 * diag-atlantis-transfer.mjs — is ATLANTIS transferable at all?
 * eth_call variants: Permit2 as caller, wallet as caller (direct transfer),
 * and a plain transfer (no allowance path) to isolate hook restrictions.
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

for (const line of readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.env"), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

const { createPublicClient, http, parseAbi, encodeFunctionData } = await import("viem");
const { getChain } = await import("../chains.mjs");
const dep = getChain("robinhood");
const c = createPublicClient({ transport: http(dep.httpRpc()) });

const WALLET = "0xa71Fb297aa443aDfc22Ff74981D8C067ec3475Cb";
const ATL = "0x26915c10e8ce9fb86b836fe8b129a1c5c3771e18";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const UR = dep.v4.universalRouter;

const ERC20 = parseAbi([
  "function transferFrom(address,address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

const meta = { symbol: "?", decimals: 18 };
try { meta.symbol = await c.readContract({ address: ATL, abi: ERC20, functionName: "symbol" }); } catch {}
try { meta.decimals = await c.readContract({ address: ATL, abi: ERC20, functionName: "decimals" }); } catch {}
console.log("token:", meta.symbol, "decimals:", meta.decimals);

const bal = await c.readContract({ address: ATL, abi: ERC20, functionName: "balanceOf", args: [WALLET] });
console.log("wallet balance:", bal.toString());

// A) wallet → wallet self-transfer (no allowance needed — tests transferability only)
try {
  await c.simulateContract({ address: ATL, abi: ERC20, functionName: "transfer", args: [WALLET, 1000n] });
  console.log("A) wallet self-transfer sim: OK");
} catch (e) { console.log("A) wallet self-transfer sim FAILED:", e.message.slice(0, 250)); }

// B) eth_call as PERMIT2 executing transferFrom(wallet → PERMIT2)
const tf = encodeFunctionData({ abi: ERC20, functionName: "transferFrom", args: [WALLET, PERMIT2, 1000000n] });
const callIt = async (from, to, data, label) => {
  const r = await fetch(dep.httpRpc(), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ from, to, data }, "latest"] }),
  });
  const j = await r.json();
  console.log(`${label}:`, j.result ? "OK " + j.result : "REVERT " + JSON.stringify(j.error).slice(0, 180));
};
await callIt(PERMIT2, ATL, tf, "B) eth_call from=PERMIT2 token.transferFrom(wallet→PERMIT2)");
await callIt(WALLET, ATL, tf, "C) eth_call from=wallet  token.transferFrom(wallet→PERMIT2)");

// D) wallet → wallet direct transfer via eth_call
const tr = encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [WALLET, 1000n] });
await callIt(WALLET, ATL, tr, "D) eth_call from=wallet  token.transfer(wallet→wallet)");
