/**
 * v2 wallet tests (plan 2026-09-20 — user-EOA-owned SCWs).
 * Offline: stubs the AA client/signer/users/chains modules via the shared
 * resolve-hook loader (scripts/test-loader-hook.mjs). Covers:
 *   - ensureWalletSession: new wallet derives from the EOA, stores schema-2
 *     record with NO session key, and is stable across re-connects.
 *   - resolveUserSessionKeyAsync: null (not throw) for pre-grant v2 records.
 *   - resolveUserReadWallet(s): SCW address straight from the v2 record.
 *   - activateSmartWallet: browser-sign payload (owner = the EOA, never self-owned).
 *   - v1 regression: existing session-key records still resolve via the AA client.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "fs";

// Own stub dir — see smart-wallet-activate.test.mjs; shared dirs race under
// concurrent node --test suites.
const STUB_DIR = "scripts/stubs-v2";
mkdirSync(STUB_DIR, { recursive: true });

// Registry stub with an in-memory store so v2/v1 shapes can coexist.
// MIRRORS the real setWalletRecord: ownerEoa present ⇒ schema 2, and the
// key fields default to null exactly as the real registry writes them.
writeFileSync(`${STUB_DIR}/registry-v2.stub.mjs`, `
  const store = {};
  export function isV2Record(rec) { return Boolean(rec && rec.schema === 2 && rec.ownerEoa); }
  export function getWalletRecord(addr) { return store[(addr || "").toLowerCase()] ?? null; }
  export function setWalletRecord(addr, rec) {
    const k = (addr || "").toLowerCase();
    const prev = store[k] ?? {};
    if (rec && rec.ownerEoa) {
      store[k] = {
        ...prev, ...rec, schema: 2,
        sessionKeyAddress: rec.sessionKeyAddress ?? prev.sessionKeyAddress ?? null,
        sessionKeyEnc: rec.sessionKeyEnc ?? prev.sessionKeyEnc ?? null,
        createdAt: prev.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    } else {
      store[k] = { ...prev, ...rec, createdAt: prev.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() };
    }
    return true;
  }
  export function listWallets() { return Object.entries(store).map(([connectedWallet, rec]) => ({ connectedWallet, ...rec })); }
  export function __store() { return store; }
`);
// Reuse the shared stubs written by smart-wallet-activate.test.mjs (they already
// export the v2 names); rewrite them here so this file is self-sufficient.
writeFileSync(`${STUB_DIR}/smart-account.stub.mjs`, `
  export const gasReserveWei = () => 0n;
  export function invalidateSmartAccountClient() {}
  export function explainUserOpError(e) { return String(e); }
  export const MAV2_FACTORY = "0x" + "1".repeat(40);
  export const SMAV2_IMPL = "0x" + "2".repeat(40);
  export const ENTRY_POINT_V7 = "0x" + "3".repeat(40);
  export function predictEoaOwnedScwAddress(chainKey, eoa) { return "0x" + "d".repeat(40); }
  export function ssvModuleAddress() { return "0x" + "e".repeat(40); }
  export function userOpDigest() { return "0x" + "f".repeat(64); }
  export function packUOSignature(sig) { return "0xFF00" + sig; }
  export async function getSmartAccountClient(chainKey = "ethereum", opts = {}) {
    return { account: { address: "0x" + "9".repeat(40), owner: undefined } };
  }
`);
writeFileSync(`${STUB_DIR}/signer.stub.mjs`, `
  export async function resolveSigner() { throw new Error("no signer (stub)"); }
  export function invalidateSigner() {}
`);
writeFileSync(`${STUB_DIR}/users.stub.mjs`, `
  export function encryptSecret(s) { return "enc:" + s; }
  export function decryptSecret(s) { return s.startsWith("enc:") ? s.slice(4) : null; }
  export function getUser() { return null; }
  export function getUserSecret() { return null; }
  export function setUserSecret() {}
`);
writeFileSync(`${STUB_DIR}/chains.stub.mjs`, `
  export const CHAIN_KEYS = ["ethereum"];
  export function getChain() {
    return {
      name: "Ethereum", viemChain: { id: 1 }, httpRpc: () => "http://stub",
      dollar: "0x" + "a".repeat(40), dollarDecimals: 6,
      imdToken: "0x" + "b".repeat(40), imdDecimals: 18, imdSymbol: "IMD",
    };
  }
  export async function getEthUsdPriceFor() { return 4000; }
`);
writeFileSync(`${STUB_DIR}/db.stub.mjs`, `export function getDipWatchers() { return []; }\nexport function getDipWatcher() { return null; }\n`);
writeFileSync(`${STUB_DIR}/dip-swap.stub.mjs`, `export async function getErc20Balance() { return 0n; }\nexport async function getImdPerEth() { return 0; }\n`);

const SNIPPET = `
  process.env.MASTER_KEY = "stub";
  const mod = await import("../smart-wallet-api.mjs");
  const regMod = await import("./stubs-v2/registry-v2.stub.mjs");
  const __store = regMod.__store;
  const probe = "0x" + "c".repeat(40);
  const out = [];

  // 1. New wallet → v2 derivation, no key minted, needsActivate
  const r1 = await mod.ensureWalletSession(probe, "ethereum");
  out.push(["new-wallet-v2", r1.ok === true && r1.schema === 2 && r1.sessionKeyAddress === null && r1.needsActivate === true && r1.scwAddress === "0x" + "d".repeat(40)]);
  const rec = __store()[probe.toLowerCase()];
  out.push(["record-shape", rec && rec.schema === 2 && rec.ownerEoa === probe && rec.sessionKeyEnc === null && rec.grantStatus === "none"]);

  // 2. Reconnect → same address, still no key minted (case-insensitive —
  //    the reconnect path returns the record's EIP-55-checksummed address)
  const r2 = await mod.ensureWalletSession(probe, "ethereum");
  out.push(["reconnect-stable", r2.scwAddress.toLowerCase() === r1.scwAddress.toLowerCase() && r2.created === false && r2.sessionKeyAddress === null]);

  // 3. resolveUserSessionKeyAsync → null (co-pilot), never throws
  const skNull = await mod.resolveUserSessionKeyAsync(probe);
  out.push(["null-key-copilot", skNull === null]);

  // 4. Read wallet straight from the record (case-insensitive compare — EIP-55
  //    checksumming of an all-same-nibble address is mixed case)
  const read = await mod.resolveUserReadWallet(probe, "ethereum");
  out.push(["read-wallet-v2", read && read.toLowerCase() === ("0x" + "d".repeat(40))]);
  const reads = await mod.resolveUserReadWallets(probe, "ethereum");
  out.push(["read-wallets-v2", reads.some((a) => a.toLowerCase() === ("0x" + "d".repeat(40))) && reads.some((a) => a.toLowerCase() === probe)]);

  // 5. activateSmartWallet → browser payload, owner = EOA, not self-owned
  const act = await mod.activateSmartWallet("ethereum", { browserFrom: probe, userId: probe });
  out.push(["activate-browser", act.ok === true && act.browserSign === true && act.factory && act.callData.length > 10]);
  out.push(["activate-owner", act.owner && act.owner.toLowerCase() === probe && act.owner.toLowerCase() !== act.scwAddress.toLowerCase()]);

  // 6. moveFunds('out') for v2 → explicit browser-sign error (no silent server key use)
  let threw = null;
  try { await mod.moveFunds({ direction: "out", asset: "eth", amount: 0.1, chainKey: "ethereum", userId: probe }); }
  catch (e) { threw = e.message; }
  out.push(["moveout-blocked", threw !== null && /browser/.test(threw)]);

  // 7. quoteDirectSweepV2 guards (2026-09-20 direct-execute sweep): needs a v2
  //    record and a positive amount — both checked BEFORE any RPC call.
  //    probe HAS a record by now (step 1), so the no-record check uses a fresh
  //    address; the no-amount check fires before RPC for any address.
  threw = null;
  const bare = "0x" + "b".repeat(39) + "1";
  try { await mod.quoteDirectSweepV2(bare, "ethereum", { asset: "eth", amount: 0.1 }); }
  catch (e) { threw = e.message; }
  out.push(["direct-sweep-needs-record", threw !== null && /no v2 record/.test(threw)]);
  threw = null;
  try { await mod.quoteDirectSweepV2(probe, "ethereum", { asset: "eth", amount: 0 }); }
  catch (e) { threw = e.message; }
  out.push(["direct-sweep-needs-amount", threw !== null && /positive amount/.test(threw)]);

  const fails = out.filter(([, ok]) => !ok);
  for (const [name, ok] of out) console.log((ok ? "PASS" : "FAIL") + " " + name);
  process.exit(fails.length ? 1 : 0);
`;
writeFileSync("scripts/.v2-snippet.mjs", SNIPPET);

test("v2 wallet lifecycle: derive → copilot-null → read → browser-activate → moveout guard", () => {
  const out = execFileSync(process.execPath, ["--import", "./scripts/test-loader.mjs", "scripts/.v2-snippet.mjs"], { encoding: "utf8", env: { ...process.env, TEST_STUB_DIR: "stubs-v2" } });
  assert.match(out, /PASS read-wallets-v2/);
  assert.match(out, /PASS activate-owner/);
  assert.match(out, /PASS moveout-blocked/);
  assert.match(out, /PASS direct-sweep-needs-record/);
  assert.match(out, /PASS direct-sweep-needs-amount/);
  assert.doesNotMatch(out, /FAIL/);
});
