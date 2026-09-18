#!/usr/bin/env node
// diag-v42-decode2.mjs — definitive decode of the user's UR swap:
// inputs[0]/[1] raw hex, try V3 vs V4 param shapes, then replicate.
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(__dirname, "..", ".env"), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}

const RAW = "0x3593564c000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000006aa161bf00000000000000000000000000000000000000000000000000000000000000020b000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000002386f26fc100000000000000000000000000000000000000000000000000000000000000000140000000000000000000000000217c05f5d1d1e595bbae94534540b803bfc4563b000000000000000000000000000000000000000000000000002386f26fc100000000000000000000000000000000000000000000000000003940ba841e27270900000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000120000000000000000000000000000000000000000000000000000000000000002b4200000000000000000000000000000000000006002710b095274743941e953c746f9c228da9c18bb6ec290000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000756e6978000001a0864a5a558000a8e40000000c0100";
const UR = "0xfdf682f51fe81aa4898f0ae2163d8a55c127fbc7";

const { decodeFunctionData, parseAbi, toHex, decodeAbiParameters, parseAbiParameters } = await import("viem");
const { resolveSigner } = await import("../signer.mjs");
const signer = await resolveSigner("base");

const { args } = decodeFunctionData({ abi: parseAbi(["function execute(bytes,bytes[],uint256) payable"]), data: RAW });
const [commands, inputs, deadline] = args;
console.log("commands hex:", toHex(commands), "-> bytes:", toHex(commands).slice(2).match(/.{2}/g).join(" "));
console.log("inputs[]:", inputs.length, "deadline:", deadline.toString());
inputs.forEach((inp, i) => console.log("inputs[" + i + "] len=" + (toHex(inp).length - 2) / 2, "hex:", toHex(inp)));

// inputs[1] should be abi.encode(bytes actions, bytes[] params)
const i1 = toHex(inputs[1]).slice(2);
try {
  const [actions, params] = decodeAbiParameters(parseAbiParameters("bytes,bytes[]"), inputs[1]);
  console.log("\nactions:", toHex(actions), "->", toHex(actions).slice(2).match(/.{2}/g).join(" "));
  console.log("params[]:", params.length);
  params.forEach((p, i) => console.log("  params[" + i + "] len=" + (toHex(p).length - 2) / 2, "hex:", toHex(p)));
} catch (e) {
  console.log("inputs[1] not (bytes,bytes[]):", e.message.slice(0, 150));
}
