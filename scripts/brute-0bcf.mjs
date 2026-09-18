// Brute-force the poolKey for poolId 0x0bcfb8dd…: currency0 must be native
// ETH (address 0) for an ETH/LAPTOP pool. Sweep fee/tickSpacing combos and
// hooks=0; widen if needed.
const { keccak256, toHex, encodeAbiParameters, parseAbiParameters } = await import("viem");
const ETH0 = "0x0000000000000000000000000000000000000000";
const LAPTOP = "0xB095274743941e953c746F9C228DA9c18Bb6ec29";
const TARGET = "0x0bcfb8ddc2af0bc61d72be1daf470c8853f568c4b04f619b0a31f1ced1216c4d";

const derive = (currency0, currency1, fee, ts, hooks) =>
  keccak256(encodeAbiParameters(parseAbiParameters("address, address, uint24, int24, address"), [currency0, currency1, fee, ts, hooks]));

const FEES = [100, 500, 1000, 2980, 3000, 4900, 10000, 20000, 30000, 2500, 400, 1500];
const TSS = [1, 2, 4, 8, 10, 20, 40, 50, 60, 98, 100, 200, 400, 600, 800];
const HOOKS = ["0x0000000000000000000000000000000000000000"];

outer:
for (const hooks of HOOKS) {
  for (const fee of FEES) {
    for (const ts of TSS) {
      const id = keccak256(encodeAbiParameters(parseAbiParameters("address, address, uint24, int24, address"), [ETH0, LAPTOP, fee, ts, hooks]));
      if (id === TARGET) {
        console.log(`MATCH: currency0=ETH0 currency1=LAPTOP fee=${fee} tickSpacing=${ts} hooks=${hooks}`);
        break outer;
      }
    }
  }
}
// also try token-first ordering (token as currency0) just in case
for (const fee of FEES) {
  for (const ts of TSS) {
    const id = keccak256(encodeAbiParameters(parseAbiParameters("address, address, uint24, int24, address"), [LAPTOP, ETH0, fee, ts, "0x0000000000000000000000000000000000000000"]));
    if (id === TARGET) { console.log(`MATCH (token-first): currency0=LAPTOP currency1=ETH0 fee=${fee} tickSpacing=${ts} hooks=0`); break; }
  }
}
console.log("done");
