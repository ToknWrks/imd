#!/usr/bin/env node
// diag-v42-replicate2.mjs — replicate the user's WORKING swap for OUR wallet
// via pure string surgery on the ascii-hex inputs, then eth_call on drpc.
// Router: 0xfdf6…7fbc7 (v4.2 UR), commands "0x0b00" (WRAP + V4 swap),
// inputs are ASCII-HEX STRINGS.
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
const OLD_SENDER = "217c05f5d1d1e595bbae94534540b803bfc4563b";

const { decodeFunctionData, parseAbi, toHex, encodeFunctionData } = await import("viem");
const { resolveSigner } = await import("../signer.mjs");
const signer = await resolveSigner("base");
const OURS = signer.address.slice(2).toLowerCase();
const VALUE = 10000000000000n; // 0.01 ETH, same as the user's swap

const { args } = decodeFunctionData({ abi: parseAbi(["function execute(bytes,bytes[],uint256) payable"]), data: RAW });
const [commands, inputs] = args;
const cmdAscii = Buffer.from(toHex(commands).slice(2), "hex").toString();          // "0x0b00"
const in0 = Buffer.from(toHex(inputs[0]).slice(2), "hex").toString();              // "0x…(wrap params)"
const in1 = Buffer.from(toHex(inputs[1]).slice(2), "hex").toString();              // "0x…(v4 swap params)"
console.log("commands:", cmdAscii);
console.log("in0:", in0);
console.log("in1 len:", in1.length);
const unixAt = in1.indexOf("756e6978");
console.log("unix hookData position in in1 (hex-char index):", unixAt);

// surgery: recipient w0 (chars 2..66) → our wallet
let in1b = in1.slice(0, 2) + OURS.padStart(64, "0") + in1.slice(66);
console.log("in1 recipient now:", in1b.slice(2, 66).slice(24));
// dry-run 1: keep the original minOut (w2); dry-run 2: minOut → 0 (price may have drifted)
const minOut0 = in1.slice(2 + 2 * 64, 2 + 3 * 64);
console.log("original amountOutMinimum:", BigInt("0x" + minOut0).toString(), "(" + Number(BigInt("0x" + minOut0)) / 1e18, "LAPTOP)");

const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
const asciiBytes = (s) => toHex(Buffer.from(s, "utf8"));
const OUTER_ABI = parseAbi(["function execute(bytes,bytes[],uint256) payable"]);

async function dryCall(tag, in1x) {
  const data = encodeFunctionData({
    abi: OUTER_ABI, functionName: "execute",
    args: [asciiBytes(cmdAscii), [asciiBytes(in0), asciiBytes(in1x)], deadline],
  });
  const res = await fetch("https://base.drpc.org", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call",
      params: [{ from: signer.address, to: UR, data, value: "0x" + VALUE.toString(16) }, "latest"] }),
  });
  const j = await res.json();
  console.log(`${tag}:`, j.error ? "REVERT " + JSON.stringify(j.error).slice(0, 220) : "OK ✅ " + (j.result || "").slice(0, 100));
  return !j.error;
}

const okKeep = await dryCall("replicated, original minOut", in1b);
const in1c = in1.slice(0, 2 + 2 * 64) + "0".repeat(64) + in1.slice(2 + 3 * 64);
if (!okKeep) await dryCall("replicated, minOut=0        ", in1c);
