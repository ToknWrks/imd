#!/usr/bin/env node
// diag-callback.mjs — decode the failing callback's calldata to see WHO the
// transferFrom pulls from. This identifies the intended payer of the WETH.
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(__dirname, "..", ".env"), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

const { getChain } = await import("../chains.mjs");
const { resolveSigner } = await import("../signer.mjs");
const { encodeFunctionData, parseAbi, decodeFunctionData } = await import("viem");

const TOKEN = "0xB095274743941e953c746F9C228DA9c18Bb6ec29";
const dep = getChain("base");
const signer = await resolveSigner("base");
const VALUE = 1997350161767056n;

// the inner exactInputSingle calldata (selector 0x04e45aaf), 7-field struct
const INNER = "0x04e45aaf"
  + "0000000000000000000000004200000000000000000000000000000000000006" // tokenIn WETH
  + "000000000000000000000000b095274743941e953c746f9c228da9c18bb6ec29" // tokenOut LAPTOP
  + "0000000000000000000000000000000000000000000000000000000000002710" // fee 10000
  + "000000000000000000000000a71fb297aa443adfc22ff74981d8c067ec3475cb" // recipient wallet
  + "0000000000000000000000000000000000000000000000000007189452e25a90" // amountIn
  + "0000000000000000000000000000000000000000000000000000000000000000" // minOut 0
  + "0000000000000000000000000000000000000000000000000000000000000000"; // sqrtLimit 0
const { args } = decodeFunctionData({
  abi: parseAbi(["function x((address,address,uint24,address,uint256,uint256,uint160))"]),
  data: INNER, // placeholder replaced below
});
