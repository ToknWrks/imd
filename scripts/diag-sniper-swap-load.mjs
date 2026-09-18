#!/usr/bin/env node
// diag-sniper-swap-load.mjs — verify sniper-swap.mjs imports cleanly after
// the multicall fix, and build a sample V3 multicall payload for LAPTOP.
import { executeSniperBuy, discoverPools, NETWORKS } from "../sniper-swap.mjs";
import { encodeFunctionData } from "viem";

console.log("✅ sniper-swap.mjs loads");
console.log("exports ok:", typeof executeSniperBuy === "function", typeof discoverPools === "function");
console.log("base v3Router:", NETWORKS.base.v3Router);
process.exit(0);
