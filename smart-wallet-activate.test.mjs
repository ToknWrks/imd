/**
 * Offline smoke tests for the smart-wallet activate path.
 * Stubs smart-account.mjs (AA client) + signer.mjs via a resolve hook so no
 * network / no Alchemy / no env keys are needed. Fails LOUDLY on ReferenceError
 * — the bug class that broke /api/smart-wallet/status on 2026-09-19.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "fs";

// Own stub dir — the v2 test writes the same filenames into scripts/stubs and
// node --test runs suites concurrently, so a shared dir races (flaky fails).
const STUB_DIR = "scripts/stubs-activate";

const STUBS = {
  "smart-account.stub.mjs": `
    export const gasReserveWei = () => 0n;
    export function invalidateSmartAccountClient() {}
    export function explainUserOpError(e) { return String(e); }
    export const MAV2_FACTORY = "0x" + "1".repeat(40);
    export const SMAV2_IMPL = "0x" + "2".repeat(40);
    export const ENTRY_POINT_V7 = "0x" + "3".repeat(40);
    export function predictEoaOwnedScwAddress(chainKey, eoa) { return "0x" + "d".repeat(40); }
    export function ssvModuleAddress() { return "0x" + "e".repeat(40); }
    export function userOpDigest(chainKey, userOp) { return "0x" + "f".repeat(64); }
    export function packUOSignature(sig) { return "0xFF00" + sig; }
    // PRODUCTION SHAPE: the Alchemy client does NOT expose account.owner
    // (verified live 2026-09-19 — the guard fired on the first activation).
    // The owner must come from the registry session key instead.
    export async function getSmartAccountClient(chainKey = "ethereum", opts = {}) {
      return {
        account: {
          address: "0x" + "9".repeat(40),
          owner: undefined,
        },
        buildUserOperation: async () => ({ preVerificationGas: 0n, verificationGasLimit: 0n, maxFeePerGas: 0n, callGasLimit: 0n }),
        sendUserOperation: async () => ({ hash: "0x" + "f".repeat(64) }),
        waitForUserOperationTransaction: async () => "0x" + "f".repeat(64),
      };
    }
  `,
  "signer.stub.mjs": `
    // resolveSigner throws like the real one does on hosted (no env signer).
    export async function resolveSigner() {
      const e = new Error("No signer configured — set AGENT_PRIVATE_KEY or VAULT_ACTIVE=true in .env");
      throw e;
    }
    export function invalidateSigner() {}
    export async function resolveSignerUser() { throw new Error("stub: not used in this test"); }
  `,
  "users.stub.mjs": `
    export function encryptSecret(s) { return "enc:" + s; }
    export function decryptSecret(s) { return s.startsWith("enc:") ? s.slice(4) : null; }
    export function getUser() { return { wallet_address: "0x" + "2".repeat(40), signer_mode: "copilot" }; }
    export function getUserSecret() { return null; }
    export function setUserSecret() {}
  `,
  "smart-wallet-registry.stub.mjs": `
    import { privateKeyToAccount } from "viem/accounts";
    // A deterministic session key; the test expects its EOA as owner.
    const SK = "0x" + "1".repeat(64);
    export function isV2Record() { return false; }
    export function getWalletRecord() {
      return {
        scwAddress: "0x" + "9".repeat(40),
        sessionKeyAddress: privateKeyToAccount(SK).address,
        sessionKeyEnc: "enc:" + SK,
      };
    }
    export function setWalletRecord() {}
  `,
};

// The loader hook maps smart-wallet-registry.mjs → registry-v2.stub.mjs (shared
// with the v2 test, which also writes that file). Use the SAME in-memory-store
// shape as the v2 test so both suites coexist regardless of run order; preload
// this test's v1 record for the probe user.
const SK_CONST = 'const SK = "0x" + "1".repeat(64);';
STUBS["registry-v2.stub.mjs"] = `
    import { privateKeyToAccount } from "viem/accounts";
    ${SK_CONST}
    // v2 record preloaded for the activate test's probe user (v1 removed).
    const store = {
      ${JSON.stringify("0x" + "2".repeat(40))}: {
        schema: 2,
        scwAddress: ${JSON.stringify("0x" + "d".repeat(40))},
        ownerEoa: ${JSON.stringify("0x" + "a".repeat(40))},
        salt: 0, sessionKeyEnc: null, sessionKeyAddress: null, grantStatus: "none",
      },
    };
    export function isV2Record(rec) { return Boolean(rec && rec.schema === 2 && rec.ownerEoa); }
    export function getWalletRecord(addr) { return store[(addr || "").toLowerCase()] ?? null; }
    export function setWalletRecord(addr, rec) {
      const k = (addr || "").toLowerCase();
      const prev = store[k] ?? {};
      if (rec && rec.ownerEoa) {
        store[k] = { ...prev, ...rec, schema: 2, sessionKeyAddress: rec.sessionKeyAddress ?? prev.sessionKeyAddress ?? null, sessionKeyEnc: rec.sessionKeyEnc ?? prev.sessionKeyEnc ?? null, createdAt: prev.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() };
      } else {
        store[k] = { ...prev, ...rec, createdAt: prev.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() };
      }
      return true;
    }
    export function listWallets() { return Object.entries(store).map(([connectedWallet, rec]) => ({ connectedWallet, ...rec })); }
    export function __store() { return store; }
  `;

// The loader writes a register()-based entrypoint that points at the hook file
// (already maintained by hand at scripts/test-loader-hook.mjs). Node 22 needs
// module.register(); a bare resolve export in the --import module is inert.
const LOADER = `import { register } from "node:module";
import { pathToFileURL } from "url";
register(pathToFileURL("./scripts/test-loader-hook.mjs"));
`;

const CHILD_SNIPPET = `
  const mod = await import("../smart-wallet-api.mjs");
  const from = "0x" + "a".repeat(40);
  const userId = "0x" + "2".repeat(40);
  let r;
  try {
    // owner= undefined on the SDK client (production reality) — the registry
    // key path must supply the owner/gas-payer. Stub key EOA: 0x19E7…ff2A,
    // whose balance is 0 in the stub, so the EXPECTED result is needsGas.
    r = await mod.activateSmartWallet("ethereum", { browserFrom: from, userId });
  } catch (e) {
    // The one failure mode this test exists to catch: a scope/reference bug.
    if (e instanceof ReferenceError || /is not defined/.test(String(e))) { console.error("REFERENCE_ERROR:" + e.message); process.exit(2); }
    console.error("OTHER_ERROR:" + e.message); process.exit(3);
  }
  if (!r.ok || r.browserSign !== true || r.schema !== 2) { console.error("BAD_PAYLOAD:" + JSON.stringify(r).slice(0, 200)); process.exit(4); }
  if (!/^0x[0-9a-fA-F]{40}$/.test(r.factory) || !/^0x[0-9a-fA-F]{40}$/.test(r.owner)) { console.error("BAD_ADDR:" + JSON.stringify(r).slice(0, 200)); process.exit(5); }
  // Owner MUST be the user's EOA from the v2 record — never the SCW itself.
  if (r.owner.toLowerCase() !== from.toLowerCase()) { console.error("WRONG_OWNER:" + r.owner); process.exit(7); }
  if (r.owner.toLowerCase() === r.scwAddress.toLowerCase()) { console.error("SELF_OWNED"); process.exit(8); }
  if (!/^0x[a-f0-9]+$/i.test(r.callData) || r.callData.length < 10) { console.error("BAD_CALLDATA"); process.exit(6); }
  console.log("ACTIVATE_BROWSER_PATH_OK");
`;

mkdirSync(STUB_DIR, { recursive: true });
for (const [name, content] of Object.entries(STUBS)) {
  writeFileSync(`${STUB_DIR}/${name}`, content);
}
writeFileSync(`${STUB_DIR}/db.stub.mjs`, `export function getDipWatchers() { return []; }\nexport function getDipWatcher() { return null; }\n`);
writeFileSync(`${STUB_DIR}/dip-swap.stub.mjs`, `export async function getErc20Balance() { return 1000000n; }\nexport async function getImdPerEth() { return 25000; }\n`);
writeFileSync(`${STUB_DIR}/chains.stub.mjs`, `
  export const CHAIN_KEYS = ["ethereum"];
  export function getChain() {
    return {
      name: "Ethereum", viemChain: {}, httpRpc: () => "http://stub",
      dollar: "0x" + "a".repeat(40), dollarDecimals: 6,
      imdToken: "0x" + "b".repeat(40), imdDecimals: 18, imdSymbol: "IMD",
    };
  }
  export async function getEthUsdPriceFor() { return 4000; }
`);
writeFileSync("scripts/test-loader.mjs", LOADER);

// Run the child snippet from a FILE, not `-e`: Node's eval mode doesn't apply
// --import loader hooks the same way; a real module entrypoint does.
const SNIPPET_PATH = "scripts/.activate-snippet.mjs";
writeFileSync(SNIPPET_PATH, CHILD_SNIPPET);

test("activateSmartWallet browser path returns a signable payload (no ReferenceError)", () => {
  const out = execFileSync(process.execPath, [
    "--import", "./scripts/test-loader.mjs",
    SNIPPET_PATH,
  ], { encoding: "utf8", env: { ...process.env, TEST_STUB_DIR: "stubs-activate" } });
  assert.match(out, /ACTIVATE_BROWSER_PATH_OK/);
});
