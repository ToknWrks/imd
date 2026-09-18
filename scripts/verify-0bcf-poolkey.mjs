// Decode the Initialize log from Blockscout raw output and derive the poolId.
import { keccak256, encodeAbiParameters, parseAbiParameters } from "viem";
const TARGET = "0x0bcfb8ddc2af0bc61d72be1daf470c8853f568c4b04f619b0a31f1ced1216c4d";

const data = "0x000000000000000000000000000000000000000000000000000000000000c35000000000000000000000000000000000000000000000000000000000000001f4000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000b668280bc3ae1d2691b7cf777a00000000000000000000000000000000000000000000000000000000000196c2";
const body = data.slice(2);
const words = [];
for (let i = 0; i < body.length; i += 64) words.push(body.slice(i, i + 64));
console.log("word count:", words.length);
words.forEach((w, i) => console.log(`  word${i}: 0x${w} = ${BigInt("0x" + w)}`));

const ETH0 = "0x0000000000000000000000000000000000000000";
const LAPTOP = "0xB095274743941e953c746F9C228DA9c18Bb6ec29";
const fee = Number(BigInt("0x" + words[0]));
const tickSpacing = Number(BigInt("0x" + words[1]));
const hooks = "0x" + words[2].slice(24);

const id = keccak256(encodeAbiParameters(
  parseAbiParameters("address, address, uint24, int24, address"),
  [ETH0, LAPTOP, fee, tickSpacing, hooks],
));
console.log("\nderived:", id);
console.log("target: ", TARGET);
console.log(id === TARGET ? "✓ EXACT MATCH" : "✗ mismatch");
console.log(`\npoolKey: currency0=ETH currency1=LAPTOP fee=${fee} tickSpacing=${tickSpacing} hooks=${hooks}`);
