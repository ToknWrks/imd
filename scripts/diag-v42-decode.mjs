#!/usr/bin/env node
// diag-v42-decode.mjs — fully manual decode of the user's V4.2-router swap
// (no viem ABI assumptions), then replicate for our wallet via eth_call.
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
const SENDER = "0x217c05f5d1d1e595bbae94534540b803bfc4563b";

const hex = RAW.slice(10); // strip 0x + selector(4B)
const word = (i) => hex.slice(i * 64, i * 64 + 64);
// selector occupies word -1; word 0 = offset commands(0x60), word1 = offset inputs(0xa0), word2 = deadline
const deadline = parseInt(hex.slice(2 * 64 + 0, 2 * 64 + 64).slice(24), 16);
console.log("deadline:", deadline);

// commands: dynamic bytes at offset 0x60 = word 3
const cmdLen = parseInt(hex.slice(3 * 64, 3 * 64 + 64).slice(24), 16) / 2;
const cmdHex = hex.slice(4 * 64, 4 * 64 + cmdLen * 2);
console.log("commands bytes:", cmdHex, "(ascii:", Buffer.from(cmdHex, "hex").toString(), ")");

// inputs: dynamic array at offset 0xa0 = word 5 → len at word5, elements follow
const inLen = parseInt(hex.slice(5 * 64, 6 * 64).slice(24), 16);
console.log("inputs[]:", inLen);
// inputs array data starts word 6: element0 offset (0x40=64B → 2 words ahead), element1 offset
const e0off = parseInt(hex.slice(6 * 64, 7 * 64).slice(24), 16);
const e1off = parseInt(hex.slice(7 * 64, 8 * 64).slice(24), 16);
const readDyn = (wordIdx) => {
  const len = parseInt(hex.slice(wordIdx * 64, wordIdx * 64 + 64).slice(24), 16);
  const bytes = hex.slice(wordIdx * 64 + 64, wordIdx * 64 + 64 + len * 2);
  return { len, bytes };
};
// inputs[0] at word 6 + e0off/32 = 8 → wrap params
const i0 = readDyn(8);
console.log("inputs[0] (wrap? amount):", "len=" + i0.len, i0.bytes.slice(0, 64), "→", BigInt("0x" + i0.bytes.slice(0, 64).slice(24)).toString());
// inputs[1] at word 8 + 2 + 1... e1off from array start (word 6): wordIdx = 6 + e1off/32
const i1Start = 6 + e1off / 32;
const i1 = readDyn(i1Start);
console.log("inputs[1] (v4swap payload): len=" + i1.len);

// v4 payload = abi.encode(bytes actions, bytes[] params)
const p1 = i1.bytes;
const actionsLen = parseInt(p1.slice(0, 64).slice(24), 16);
const actions = p1.slice(64, 64 + actionsLen * 2);
const arrOff = parseInt(p1.slice(64 + actionsLen * 2, 64 + actionsLen * 2 + 64).slice(24), 16) / 32;
const arrLen = parseInt(p1.slice(arrOff * 64, arrOff * 64 + 64).slice(24), 16);
console.log("actions:", actions, "· inner params[]:", arrLen);
// first inner param: offset from arrOff+1
const pOff = arrOff + 1 + parseInt(p1.slice((arrOff + 1) * 64, (arrOff + 1) * 64 + 64).slice(24), 16) / 32;
const pLen = parseInt(p1.slice(pOff * 64, pOff * 64 + 64).slice(24), 16);
const pBytes = p1.slice(pOff * 64 + 64, pOff * 64 + 64 + pLen * 2);
console.log("inner param[0]:", pBytes.slice(0, 240));
// SWAP_EXACT_IN params = (bytes path, uint128 amountIn, uint128 amountOutMinimum)? or 5-field
// Try: path bytes + amountIn + minOut + hookData
const pathLen = parseInt(pBytes.slice(0, 64).slice(24), 16);
const pathBytes = pBytes.slice(64, 64 + pathLen * 2);
const after = 64 + pathLen * 2 + ((32 - (pathLen * 2) % 64) % 64);
const f1 = BigInt("0x" + pBytes.slice(after, after + 64));
const f2 = BigInt("0x" + pBytes.slice(after + 64, after + 128));
const f3 = BigInt("0x" + pBytes.slice(after + 128, after + 192));
console.log("path len:", pathLen, "· path:", pathBytes);
console.log("field1:", f1.toString(), "field2:", f2.toString(), "field3:", f3.toString());
const rest = pBytes.slice(after + 192);
console.log("remaining bytes (hookData?):", rest);
console.log("hookData ascii attempt:", Buffer.from(rest, "hex").toString().replace(/[^\x20-\x7e]/g, "."));

// path parse: currency(20B) fee(3B) currency(20B)
const ph = pathBytes;
console.log("path: cur0=0x" + ph.slice(0, 40), "fee=" + parseInt(ph.slice(40, 46), 16), "cur1=0x" + ph.slice(46, 86));

console.log("\nVALUE attached to tx:", BigInt("0x2386f26fc10000").toString(), "= 0.01 ETH");
