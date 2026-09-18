#!/usr/bin/env node
// diag-router-code.mjs — is Base's "SwapRouter02" actually SwapRouter02?
// Compare runtime bytecode hashes and disassembly hints across chains,
// and probe which top-level functions the Base contract exposes.
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(__dirname, "..", ".env"), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

const { getChain } = await import("../chains.mjs");
const { createPublicClient, http, keccak256, toHex } = await import("viem");

const mainnet = createPublicClient({ transport: http("https://eth-mainnet.g.alchemy.com/v2/" + (process.env.ALCHEMY_API_KEY || "").trim()) });
const base = createPublicClient({ transport: http("https://mainnet.base.org") });

const MAINNET_ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const BASE_ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481";

const mcode = await mainnet.getBytecode({ address: MAINNET_ROUTER });
const bcode = await base.getBytecode({ address: BASE_ROUTER });
console.log("mainnet router code hash:", keccak256(mcode));
console.log("base    router code hash:", keccak256(bcode));
console.log("identical code:", keccak256(mcode) === keccak256(bcode));

// probe function selectors present in bytecode
const sel = (sig) => keccak256(toHex(sig)).slice(0, 10);
for (const [name, sig] of [
  ["multicall(bytes[])", "multicall(bytes[])"],
  ["multicall(uint256,bytes[])", "multicall(uint256,bytes[])"],
  ["multicall(uint256,bytes[],bool)", "multicall(uint256,bytes[],bool)"],
  ["exactInputSingle(8-field)", "exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))"],
  ["exactInputSingle(7-field)", "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))"],
  ["wrapETH", "wrapETH(uint256)"],
  ["refundETH", "refundETH()"],
  ["uniswapV3SwapCallback", "uniswapV3SwapCallback(int256,uint256,bytes)"],
]) {
  const s = sel(sig);
  const inM = mcode?.toLowerCase().includes(s.slice(2).toLowerCase());
  const inB = bcode?.toLowerCase().includes(s.slice(2).toLowerCase());
  console.log(`${name.padEnd(28)} selector ${s}  mainnet:${inM ? "Y" : "n"}  base:${inB ? "Y" : "n"}`);
}
