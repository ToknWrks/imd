import { keccak256 } from "viem";
const ETH  = "0".repeat(64);
const HASH = "0".repeat(24) + "ca75082b85bb7bec8325d513f615b16bda260020";
const HOOK = "0".repeat(24) + "ca757986e932bc55776492cca0b413e9b3d02acc";
const ZERO = "0".repeat(64);
const TARGET = "0x42b009f327076bc462dc1725c29221938f8f96307f356121a8445b889d036ea7";
const fees = [0, 1, 5, 10, 30, 60, 100, 500, 1000, 2500, 3000, 5000, 10000, 50000, 8388608, 0x800000, 0x1000000, 0x80000000, 0x40000000, 0xfffff];
const tss  = [1, 2, 4, 5, 8, 10, 20, 50, 60, 100, 200, 500, 600, 1000, 2000, 8, 16, 64, 1000];
let found = false;
for (const f of fees) {
  for (const t of tss) {
    const fee = BigInt(f).toString(16).padStart(64, "0");
    const ts = BigInt(t).toString(16).padStart(64, "0");
    if (keccak256("0x"+ETH+HASH+fee+ts+HOOK) === TARGET) { console.log("MATCH fee="+f+" ts="+t); found = true; }
  }
}
if (!found) console.log("no fee/ts combo matches with hooks=ca757986 and c0=0x0");
