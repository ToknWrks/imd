/**
 * LIVE test — /api/wallet total-holdings math against real RPCs.
 * Uses a throwaway wallet address (no registry record) so resolveUserReadWallets
 * falls back to [login EOA]; verifies the handler returns sane totals and that
 * a v2 record with an EMPTY SCW produces the same total as EOA-only.
 */
process.env.MASTER_KEY = "live-wallet-test";
const eoa = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045".toLowerCase(); // vitalik.eth — funded, proves real sums

// Point the handler's json at a capture
const captured = [];
const json = (data) => { captured.push(data); return data; };
const isSignerConfigured = async () => false;

const { walletApiHandler } = await import("../wallet-api.mjs");
await walletApiHandler({ isSignerConfigured, json, userId: eoa });
const r1 = captured[0];
if (!r1 || r1.ok === false) { console.log("handler error:", r1 && r1.error); process.exit(1); }
console.log("[1] no-record fallback: walletSource =", r1.walletSource, "| address =", r1.walletAddress);
console.log("    eth total:", r1.eth.total, "| totalUsd:", r1.totalUsd);
console.log("    chains:", r1.eth.chains.map(c => `${c.name}=${c.balance}`).join(" "));

// Now with a v2 record whose SCW is empty — total must equal the EOA-only case
const { setWalletRecord } = await import("../smart-wallet-registry.mjs");
setWalletRecord(eoa.toLowerCase(), { scwAddress: "0x" + "e".repeat(39) + "3", ownerEoa: eoa.toLowerCase(), salt: 0, grantStatus: "none" });
captured.length = 0;
await walletApiHandler({ isSignerConfigured, json, userId: eoa });
const r2 = captured[0];
console.log("\n[2] with empty SCW record: eth total:", r2.eth.total, "| totalUsd:", r2.totalUsd);
const same = Math.abs(r2.eth.total - r1.eth.total) < 1e-12 && Math.abs(r2.totalUsd - r1.totalUsd) < 1e-9;
console.log("    matches EOA-only total (no double-count, empty SCW adds 0):", same ? "YES ✓" : "NO ✗");
console.log("    tokens rows:", (r2.tokens || []).length, "(summed across both wallets upstream)");
process.exit(same ? 0 : 1);
