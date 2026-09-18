/**
 * diag-atlantis-transfer2.mjs — pin down the exact failing transferFrom:
 * varies (from, to, amount) across eth_calls to find which combination
 * reverts. Read-only.
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
const POOL_MANAGER = dep.v4.poolManager;

const ERC20 = parseAbi(["function transferFrom(address,address,uint256) returns (bool)"]);
const FULL = 97053059907225739329536n; // exact amountIn from the reverted tx
const TINY = 1000000n;

const callIt = async (from, to, args, label) => {
  const data = encodeFunctionData({ abi: ERC20, functionName: "transferFrom", args });
  const r = await fetch(dep.httpRpc(), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ from, to, data }, "latest"] }),
  });
  const j = await r.json();
  console.log(`${label}:`, j.result ? "OK" : "REVERT " + (j.error?.data ?? JSON.stringify(j.error).slice(0, 100)));
};

// The real flow: Permit2 executes token.transferFrom(owner=wallet, to=PoolManager)
await callIt(PERMIT2, ATL, [WALLET, POOL_MANAGER, TINY], "from=Permit2 to=PoolManager tiny");
await callIt(PERMIT2, ATL, [WALLET, POOL_MANAGER, FULL], "from=Permit2 to=PoolManager FULL amount");
await callIt(PERMIT2, ATL, [WALLET, UR, TINY], "from=Permit2 to=UR tiny");
await callIt(PERMIT2, ATL, [WALLET, PERMIT2, TINY], "from=Permit2 to=Permit2 tiny");
await callIt(PERMIT2, ATL, [WALLET, WALLET, TINY], "from=Permit2 to=wallet tiny");
console.log("PoolManager:", POOL_MANAGER);
console.log("UR:", UR);
