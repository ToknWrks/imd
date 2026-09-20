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

const STUB_DIR = "scripts/stubs";

const STUBS = {
  "smart-account.stub.mjs": `
    export const gasReserveWei = () => 0n;
    export function invalidateSmartAccountClient() {}
    export function explainUserOpError(e) { return String(e); }
    // The SCW client the status/activate paths use. owner = a deterministic EOA.
    export async function getSmartAccountClient(chainKey = "ethereum", opts = {}) {
      return {
        account: {
          address: "0x" + "9".repeat(40),
          owner: { address: "0x" + "e".repeat(40) },
        },
        buildUserOperation: async () => ({ preVerificationGas: 0n, verificationGasLimit: 0n, maxFeePerGas: 0n, callGasLimit: 0n }),
        sendUserOperation: async () => ({ hash: "0x" + "f".repeat(64) }),
        waitForUserOperationTransaction: async () => "0x" + "f".repeat(64),
        buildUserOperationWithPaymasterAndData: undefined,
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
    export function getWalletRecord() { return null; }
    export function setWalletRecord() {}
  `,
};

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
  let r;
  try {
    r = await mod.activateSmartWallet("ethereum", { browserFrom: from });
  } catch (e) {
    // The one failure mode this test exists to catch: a scope/reference bug.
    if (e instanceof ReferenceError || /is not defined/.test(String(e))) { console.error("REFERENCE_ERROR:" + e.message); process.exit(2); }
    console.error("OTHER_ERROR:" + e.message); process.exit(3);
  }
  if (!r.ok || r.browserSign !== true) { console.error("BAD_PAYLOAD:" + JSON.stringify(r).slice(0, 200)); process.exit(4); }
  if (!/^0x[0-9a-fA-F]{40}$/.test(r.factory) || !/^0x[0-9a-fA-F]{40}$/.test(r.owner)) { console.error("BAD_ADDR:" + JSON.stringify(r).slice(0, 200)); process.exit(5); }
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
  ], { encoding: "utf8" });
  assert.match(out, /ACTIVATE_BROWSER_PATH_OK/);
});
