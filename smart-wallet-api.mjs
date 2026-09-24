/**
 * smart-wallet-api.mjs — per-user smart wallet (v2 ONLY; v1 removed 2026-09-24).
 *
 * Every user's smart wallet is an Alchemy Semi-Modular Account v2 OWNED BY
 * THEIR EOA (deterministic: factory.createSemiModularAccount(ownerEoa, salt)).
 * The server holds NOTHING until the user enables automation; then a session
 * key is installed on-chain as the ENTITY-1 operator and stored encrypted in
 * the registry (data/connected-wallets.json, on the VPS).
 *
 * Moves: funding (EOA → SCW) and sweeps (SCW → EOA) are signed IN THE BROWSER
 * by the owner EOA (direct execute(), no EntryPoint). USDC sweep-usd runs on
 * the session signer (autonomy). There is no server-signed owner path.
 */
import { getChain, getEthUsdPriceFor } from "./chains.mjs";
import { getErc20Balance, getImdPerEth } from "./dip-swap.mjs";
import { getSmartAccountClient, invalidateSmartAccountClient, gasReserveWei, explainUserOpError, predictEoaOwnedScwAddress, ssvModuleAddress, MAV2_FACTORY, userOpDigest, packUOSignature, ENTRY_POINT_V7 } from "./smart-account.mjs";
import { createPublicClient, http, getAddress, encodeFunctionData, encodeAbiParameters, parseAbi, formatEther, formatUnits, parseUnits, concat, padHex, toHex, getContract } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getWalletRecord, setWalletRecord, isV2Record } from "./smart-wallet-registry.mjs";

const ERC20_ABI = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);

/**
 * Called on every sign-in (auth.mjs). Guarantees the connected EOA has a v2
 * registry record pointing at its deterministic EOA-owned SCW. Existing v2
 * records are returned untouched (never re-derived, never re-keyed).
 */
export async function ensureWalletSession(connectedAddress, chainKey = "ethereum") {
  if (!connectedAddress || !/^0x[0-9a-fA-F]{40}$/.test(connectedAddress)) {
    throw new Error("invalid connected wallet address");
  }
  const rec = getWalletRecord(connectedAddress);
  if (rec && isV2Record(rec)) {
    if (rec.sessionKeyEnc && !decryptSessionKey(rec.sessionKeyEnc)) {
      console.error(`[wallet-session] ${connectedAddress.slice(0, 6)}…${connectedAddress.slice(-4)}: session key UNREADABLE — check MASTER_KEY (funds-safety guard; record left untouched).`);
      throw new Error("Stored session key unreadable — check MASTER_KEY / data/connected-wallets.json. The record was NOT modified.");
    }
    return { ok: true, created: false, scwAddress: getAddress(rec.scwAddress), sessionKeyAddress: rec.sessionKeyAddress ?? null, schema: 2, needsActivate: !rec.sessionKeyEnc };
  }
  if (rec) {
    // A non-v2 (legacy v1) record: v1 is no longer supported. Never overwrite
    // it silently — its SCW may hold funds. Surface it for manual migration.
    console.error(`[wallet-session] ${connectedAddress.slice(0, 6)}…${connectedAddress.slice(-4)}: legacy v1 registry record (SCW ${rec.scwAddress}) — v1 is removed; migrate this record to v2 manually.`);
    throw new Error(`Legacy v1 smart wallet ${rec.scwAddress} found for this account — v1 is no longer supported. Ask the operator to migrate it to v2 (funds are untouched).`);
  }
  const scwAddress = predictEoaOwnedScwAddress(chainKey, connectedAddress);
  setWalletRecord(connectedAddress, { scwAddress, ownerEoa: connectedAddress, salt: 0, grantStatus: "none" });
  console.log(`[wallet-session] ${connectedAddress.slice(0, 6)}…${connectedAddress.slice(-4)}: v2 SCW derived ${scwAddress} (owner = user EOA)`);
  return { ok: true, created: true, scwAddress, sessionKeyAddress: null, schema: 2, needsActivate: true };
}

// ── session-key encryption at rest (AES-256-GCM via users.mjs MASTER_KEY) ───
import { encryptSecret, decryptSecret } from "./users.mjs";

/** Encrypt a session key for the registry. Throws if MASTER_KEY is not set —
 *  silently storing plaintext was the 2026-09-18 bug. */
function encryptSessionKey(plain) {
  if (!process.env.MASTER_KEY?.trim()) {
    throw new Error("MASTER_KEY not set — refusing to store a session key unencrypted. Set MASTER_KEY in .env and restart.");
  }
  return encryptSecret(plain);
}

/** Decrypt a registry session key; transparently upgrades legacy plaintext
 *  (0x-prefixed raw keys written before encrypt-at-rest existed). */
function decryptSessionKey(stored) {
  if (!stored) return null;
  if (/^0x[0-9a-fA-F]{64}$/.test(stored)) return stored; // legacy plaintext
  return decryptSecret(stored); // null on wrong key / corruption
}

/**
 * The wallet whose balances a user sees: their v2 SCW from the registry;
 * otherwise their login EOA. Reads never depend on any signer or env key.
 */
export async function resolveUserReadWallet(userId, chainKey = "ethereum") {
  if (!userId || !/^0x[0-9a-fA-F]{40}$/.test(userId)) throw new Error("resolveUserReadWallet: a user address is required");
  const rec = getWalletRecord(userId);
  if (rec && isV2Record(rec)) return getAddress(rec.scwAddress);
  return getAddress(userId);
}

/**
 * BOTH of the user's read wallets, deduped: the v2 SCW (app-signed trades)
 * + the login/browser EOA (launchpad & curve buys land here).
 */
export async function resolveUserReadWallets(userId, chainKey = "ethereum") {
  if (!userId || !/^0x[0-9a-fA-F]{40}$/.test(userId)) throw new Error("resolveUserReadWallets: a user address is required");
  const out = [];
  const push = (a) => { if (a && /^0x[0-9a-fA-F]{40}$/.test(a) && !out.some((x) => x.toLowerCase() === a.toLowerCase())) out.push(getAddress(a)); };
  const rec = getWalletRecord(userId);
  if (rec && isV2Record(rec)) push(rec.scwAddress);
  push(userId);
  return out;
}

function dollarSymbol(chainKey) {
  const dep = getChain(chainKey);
  return dep.dollarDecimals === 6 ? "USDC" : "USD";
}

async function publicClientFor(chainKey) {
  const dep = getChain(chainKey);
  return createPublicClient({ chain: dep.viemChain, transport: http(dep.httpRpc()) });
}

/**
 * GET /api/smart-wallet/status (query: chain=ethereum|base|robinhood)
 * Returns both sides' balances + deploy state for the two-card UI.
 */
export async function smartWalletStatus(chainKey = "ethereum", { sessionAddress: sessionAddrFn = null, req = null } = {}) {
  // Per-user SCW (2026-09-19): the smart-wallet card must show the SESSION
  // USER's wallet, never the global env AA_SESSION_KEY (which on hosted
  // resolves to a legacy burner 0xF4a6… that belongs to nobody — the old code
  // happily offered a Fund UI into it). Resolve the user's key the same way
  // trading does; if they have none, report hasSessionKey=false and skip the
  // SCW read entirely so the UI can show a "generate a session key" prompt.
  // Same `uid` also drives the owner card below — one source of truth
  // (the signed session), not a client-submitted address.
  const uid = sessionAddrFn && req ? sessionAddrFn(req) : null;

  // ── v2 records (user-EOA-owned): the SCW address lives in the registry; no
  // session key is needed to read balances. Emit the fields the v2 UI branch
  // consumes (schema, grantStatus, custodyLabel) and read the SCW directly.
  // The owner card shows the USER'S OWN EOA balances — the login address IS
  // the owner, so read it as a plain address (no signer resolution needed).
  const rec = uid ? getWalletRecord(uid) : null;
  if (rec && isV2Record(rec)) {
    const scwAddress = getAddress(rec.scwAddress);
    const ownerEoa = getAddress(rec.ownerEoa);
    const pub = await publicClientFor(chainKey);
    const dep = getChain(chainKey);
    // Destructuring must match the promise order: [scw-eth, scw-code, scd-usd, scw-imd, owner-eth, owner-usd, owner-imd, price]
    const [scwEthWei, code, dollarRaw, imdRaw, ownerEthWei, ownerUsdRaw, ownerImdRaw, ethUsdPrice] = await Promise.all([
      pub.getBalance({ address: scwAddress }).catch(() => 0n),
      pub.getCode({ address: scwAddress }).catch(() => "0x"),
      getErc20Balance(dep.dollar, scwAddress, chainKey).catch(() => null),
      dep.imdToken ? getErc20Balance(dep.imdToken, scwAddress, chainKey).catch(() => null) : Promise.resolve(null),
      pub.getBalance({ address: ownerEoa }).catch(() => 0n),
      getErc20Balance(dep.dollar, ownerEoa, chainKey).catch(() => null),
      dep.imdToken ? getErc20Balance(dep.imdToken, ownerEoa, chainKey).catch(() => null) : Promise.resolve(null),
      getEthUsdPriceFor(chainKey).catch(() => 0),
    ]);
    // USD spot for the IMD display hints (ETH/IMD pool × ETH/USD).
    const imdPerEth2 = dep.imdToken ? await getImdPerEth(chainKey).catch(() => 0) : 0;
    const imdUsd2 = imdPerEth2 > 0 ? ethUsdPrice / imdPerEth2 : 0;
    return {
      ok: true,
      chain: chainKey,
      schema: 2,
      custodyLabel: "your EOA owns it",
      ethUsd: ethUsdPrice,
      imdPerEth: imdPerEth2,
      imdSymbol: getChain(chainKey).imdSymbol || "IMD",
      grantStatus: rec.grantStatus || "none",
      ownerEoa,
      hasSessionKey: Boolean(rec.sessionKeyEnc),
      owner: {
        address: ownerEoa,
        eth: Number(ownerEthWei) / 1e18,
        usd: ownerUsdRaw != null ? Number(ownerUsdRaw) / 10 ** (dep.dollarDecimals ?? 6) : null,
        dollarDecimals: dep.dollarDecimals ?? 6,
        imd: imdRaw != null || ownerImdRaw != null ? Number(ownerImdRaw ?? 0n) / 1e18 : null,
      },
      scw: {
        address: scwAddress,
        eth: Number(scwEthWei) / 1e18,
        activated: Boolean(code && code !== "0x"),
        usd: dollarRaw != null ? Number(dollarRaw) / 10 ** (dep.dollarDecimals ?? 6) : null,
        imd: imdRaw != null ? Number(imdRaw) / 1e18 : null,
      },
      gasReserveEth: Number(gasReserveWei(chainKey)) / 1e18,
      dollarSymbol: dollarSymbol(chainKey),
      dollarToken: dep.dollar,
      imdToken: dep.imdToken || null,
    };
  }

  // No v2 record (anonymous or pre-sign-in): nothing to show.
  return { ok: false, error: uid ? "no smart wallet registered for this account — sign in again to create it" : "authentication required" };
}

/** POST /api/smart-wallet/activate.
 *
 *  v2 wallets (user-EOA-owned, plan 2026-09-20): returns an UNSIGNED factory
 *  payload for the BROWSER to sign (eth_sendTransaction) — the owner IS the
 *  browser EOA, so msg.sender == owner by construction and the deploy is one
 *  owner-paid click (fork-verified 2026-09-20: 97,772 gas, code lands at the
 *  predicted address). No gas-key funding dance.
 *
 *  (v1 server-signed activation removed 2026-09-24.) */
export async function activateSmartWallet(chainKey = "ethereum", { browserFrom = null, userId = null, checkOnly = false } = {}) {
  const dep = getChain(chainKey);
  const pub = await publicClientFor(chainKey);

  // ── v2 branch: derive from the registry record (owner = the connected EOA).
  const rec = userId ? getWalletRecord(userId) : null;
  if (rec && isV2Record(rec)) {
    const address = getAddress(rec.scwAddress);
    const ownerEoa = getAddress(rec.ownerEoa);
    const code = await pub.getCode({ address }).catch(() => "0x");
    if (code && code !== "0x") return { ok: true, alreadyDeployed: true, address, schema: 2 };
    if (browserFrom && getAddress(browserFrom).toLowerCase() !== ownerEoa.toLowerCase()) {
      throw new Error(`activation must be signed by the wallet's owner ${ownerEoa} (got ${getAddress(browserFrom)})`);
    }
    const factoryAbi = parseAbi(["function createSemiModularAccount(address owner, uint256 salt) returns (address)"]);
    const callData = encodeFunctionData({
      abi: factoryAbi,
      functionName: "createSemiModularAccount",
      args: [ownerEoa, BigInt(rec.salt ?? 0)],
    });
    // Browser signs; server only prepares + verifies. checkOnly is honored for
    // API compat (pollers) — it just reports readiness, never deploys.
    if (checkOnly) {
      return { ok: true, checkOnly: true, browserSign: true, schema: 2, factory: MAV2_FACTORY, owner: ownerEoa, scwAddress: address, callData, chainId: dep.viemChain.id ?? 1 };
    }
    return {
      ok: true,
      browserSign: true,
      schema: 2,
      factory: MAV2_FACTORY,
      owner: ownerEoa,
      scwAddress: address,
      callData,
      chainId: dep.viemChain.id ?? 1,
      gasEstimate: 200000,
      message: "Sign the deploy in your browser wallet — your EOA is the owner, so this single tx activates the wallet.",
    };
  }

  throw new Error("no v2 smart wallet registered for this account — sign in again to create it");
}

/**
 * v2 AUTONOMY GRANT (2026-09-21 rewrite — was a UserOp/EntryPoint flow, now a
 * DIRECT owner-execute, same proven pattern as quoteDirectSweepV2).
 *
 * ROOT CAUSE of every grant failing on-chain (found live 2026-09-21, traced
 * from a production AA23 on an autonomy trade all the way back to this): the
 * OLD flow wrapped installValidation in a UserOperation whose nonce used
 * ENTITY 1's key (256) — but entity 1 doesn't exist until THIS call installs
 * it. The EntryPoint routes a UserOp's validation to whatever validator is
 * registered for its nonce key; with no entity-1 validator installed yet,
 * the account's own validateUserOp had nothing to check against and threw —
 * "AA23 reverted" on the GRANT tx itself, every single time, for every
 * wallet. The registry still got marked "granted" regardless (a SEPARATE
 * bug fixed the same day in confirmGrant — see its own comment) because
 * nothing ever checked the grant tx's receipt. Circular by construction: no
 * amount of nonce/signature-format tweaking fixes a UserOp that authorizes
 * itself via an entity that doesn't exist until it lands.
 *
 * Fix: skip the EntryPoint for the grant entirely. The owner already has
 * native authority to call `execute()` directly on their own SMA (this is
 * exactly how quoteDirectSweepV2 moves funds pre-grant, fork-verified
 * 2026-09-20) — no UserOp, no nonce key, no signature-packing scheme needed.
 * installValidation is just another call routed through that same
 * owner-authorized execute(), sent as a single plain `eth_sendTransaction`.
 */
export async function grantSessionKeyForOwner(userId, chainKey = "ethereum", { browserFrom = null } = {}) {
  if (!userId || !/^0x[0-9a-fA-F]{40}$/.test(userId)) throw new Error("userId required");
  const rec = getWalletRecord(userId);
  if (!rec || !isV2Record(rec)) throw new Error("no v2 smart wallet registered for this user — connect the wallet first");
  const ownerEoa = getAddress(rec.ownerEoa);
  if (browserFrom && getAddress(browserFrom).toLowerCase() !== ownerEoa.toLowerCase()) {
    throw new Error(`the grant must be signed by the wallet owner ${ownerEoa}`);
  }
  const scwAddress = getAddress(rec.scwAddress);
  const pub = await publicClientFor(chainKey);
  const code = await pub.getCode({ address: scwAddress }).catch(() => "0x");
  if (!code || code === "0x") throw new Error("smart wallet is not deployed yet — activate it first");

  // Reuse an already-generated key (idempotent re-quotes); mint only if absent.
  let sessionKey = rec.sessionKeyEnc ? decryptSessionKey(rec.sessionKeyEnc) : null;
  if (!sessionKey) {
    const { generatePrivateKey } = await import("viem/accounts");
    sessionKey = generatePrivateKey();
  }
  const sessionKeyAddress = getAddress(privateKeyToAccount(sessionKey).address);

  // Persist the key NOW (encrypted at rest) + record grantStatus "pending".
  // A crash between quote and submit must not orphan the key.
  setWalletRecord(userId, {
    scwAddress: rec.scwAddress,
    ownerEoa,
    salt: rec.salt,
    sessionKeyAddress,
    sessionKeyEnc: encryptSessionKey(sessionKey),
    grantStatus: "pending",
  });

  // installValidation (entity 1, selectors execute + executeBatch, signer =
  // session-key EOA). Sent DIRECTLY, unwrapped — the Alchemy SDK's own
  // encodeCallData (modularAccountV2Base.js) explicitly skips the execute()
  // wrapper for a self-targeting call ("target === accountAddress ? data :
  // execute(target, value, data)"). Wrapping it anyway (the old bug) sent a
  // call shape the account's dispatch doesn't recognize as authorized —
  // confirmed by a free eth_call simulation reverting with it wrapped and
  // succeeding once unwrapped (2026-09-21).
  const ssv = ssvModuleAddress(chainKey);
  const validationConfig = concat([ssv, toHex(1, { size: 4 }), toHex(0x01, { size: 1 })]); // isUserOpValidation only
  const data = encodeFunctionData({
    abi: parseAbi(["function installValidation(bytes25 validationConfig, bytes4[] selectors, bytes installData, bytes[] hooks)"]),
    functionName: "installValidation",
    args: [
      validationConfig,
      ["0xb61d27f6", "0x34fcd5be"], // execute, executeBatch
      encodeAbiParameters([{ type: "uint32" }, { type: "address" }], [1, sessionKeyAddress]),
      [],
    ],
  });

  return {
    ok: true,
    browserSign: true,
    schema: 2,
    directExecute: true,   // UI: plain eth_sendTransaction, NOT handleOps
    to: scwAddress,
    data,
    sessionKeyAddress,
    gasEstimateEth: 0.0002,
    message: "Sign the grant in your browser wallet — this adds the app's session key as an operator that can trade from your smart wallet.",
  };
}

/**
 * Submit the browser-signed grant UO: verify the signature recovers the OWNER
 * (defense against a malicious/compromised client quoting someone else's
 * signature), pack it in SMA format, relay handleOps from the server's bundler
 * key, and wait for the receipt. The bundler key (AGENT_PRIVATE_KEY) pays gas;
 * the UO itself is paid by the SCW's prefund.
 */
export async function submitGrant(userId, chainKey = "ethereum", { signature = null, quotedUserOp = null } = {}) {
  if (!signature || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error("missing or malformed browser signature");
  const rec = getWalletRecord(userId);
  if (!rec || !isV2Record(rec)) throw new Error("no v2 record");
  const ownerEoa = getAddress(rec.ownerEoa);
  const scwAddress = getAddress(rec.scwAddress);
  const pub = await publicClientFor(chainKey);
  const code = await pub.getCode({ address: scwAddress }).catch(() => "0x");
  if (!code || code === "0x") throw new Error("smart wallet not deployed — activate it first");

  // Rebuild the exact quote server-side (never trust a client-supplied userOp).
  const quote = await grantSessionKeyForOwner(userId, chainKey);
  const userOp = { ...quote.userOp, signature: packUOSignature(signature) };

  // Signature check: recover the signer of the digest.
  const digest = userOpDigest(chainKey, quote.userOp);
  const recovered = await (await import("viem")).verifyMessage({ address: ownerEoa, message: { raw: digest } }, signature);
  if (!recovered) throw new Error("grant signature does not recover the wallet owner — refusing to relay");

  return relayUserOp(chainKey, userOp, { label: "grant" });
}

/**
 * Relay a fully-signed UserOperation through EntryPoint 0.7 handleOps from the
 * server's bundler key. Resolves to the inner tx hash once mined; throws with
 * the decoded FailedOp reason on revert. Same plumbing the fork dry run proved.
 */
async function relayUserOp(chainKey, userOp, { label = "uo" } = {}) {
  const dep = getChain(chainKey);
  const pub = await publicClientFor(chainKey);
  const bundlerPk = process.env.AGENT_PRIVATE_KEY?.trim();
  if (!bundlerPk) throw new Error("no bundler key configured (AGENT_PRIVATE_KEY) — cannot relay user operations");
  const { createWalletClient } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const bundler = createWalletClient({ account: privateKeyToAccount(bundlerPk.startsWith("0x") ? bundlerPk : "0x" + bundlerPk), chain: dep.viemChain, transport: http(dep.httpRpc()) });
  const beneficiary = getAddress(bundler.account.address); // gas refund to the relayer
  const tx = await bundler.sendTransaction({
    to: ENTRY_POINT_V7,
    data: encodeFunctionData({ abi: parseAbi(["function handleOps((address,uint256,bytes,bytes,bytes32,bytes,bytes)[] ops, address beneficiary)"]), functionName: "handleOps", args: [[{
      sender: userOp.sender,
      nonce: userOp.nonce,
      initCode: userOp.initCode,
      callData: userOp.callData,
      accountGasLimits: concat([padHex(userOp.verificationGasLimit, { size: 16 }), padHex(userOp.callGasLimit, { size: 16 })]),
      preVerificationGas: userOp.preVerificationGas,
      gasFees: concat([padHex(userOp.maxPriorityFeePerGas, { size: 16 }), padHex(userOp.maxFeePerGas, { size: 16 })]),
      paymasterAndData: userOp.paymasterAndData ?? "0x",
      signature: userOp.signature,
    }], beneficiary] }),
    gas: 3000000n,
  });
  const rcpt = await pub.waitForTransactionReceipt({ hash: tx });
  if (rcpt.status !== "success") throw new Error(label + " relay tx reverted");
  // Extract the inner tx from UserOperationEvent (topics[1] = userOpHash → not a tx hash;
  // the inner tx hash is not directly exposed for handleOps relays — surface the relay tx).
  return { ok: true, txHash: tx, relayTxHash: tx };
}

/** After the browser's grant UO lands: flip grantStatus → granted and warm the
 *  AA client with the new key. Idempotent; safe to call after polling.
 *
 * Verification (2026-09-21 fix): this used to persist "granted" purely on
 * the browser's word that it submitted handleOps, with no check the tx
 * actually succeeded. A reverted/never-mined grant left entity 1 without
 * `execute` authorized, but the UI hid the retry button because the
 * registry said "granted" anyway (found live — traced a production AA23
 * failure on a real trade back to this). An EARLIER attempt at this fix
 * dry-ran a trivial call via `client.estimateUserOperationGas()` expecting
 * it to fail the same way `sendUserOperation()` does for an ungranted
 * entity — it didn't: the two AA-SDK actions don't validate equivalently
 * (found live testing this very fix — `estimateUserOperationGas` returned
 * success against a wallet that `sendUserOperation` reliably rejected with
 * `ValidationFunctionMissing`). Don't reintroduce an SDK-action-based dry
 * run as a proxy for "did the grant land" — check the ACTUAL grant tx's
 * receipt instead; that's unambiguous ground truth. */
export async function confirmGrant(userId, chainKey = "ethereum", txHash = null) {
  const rec = getWalletRecord(userId);
  if (!rec || !isV2Record(rec)) throw new Error("no v2 record");
  if (!rec.sessionKeyEnc) throw new Error("no session key stored — call grantSessionKeyForOwner first");
  const sk = decryptSessionKey(rec.sessionKeyEnc);
  if (!sk) throw new Error("stored session key unreadable (MASTER_KEY?)");

  if (txHash) {
    const dep = getChain(chainKey);
    const pub = createPublicClient({ chain: dep.viemChain, transport: http(dep.httpRpc()) });
    const receipt = await pub.getTransactionReceipt({ hash: txHash }).catch(() => null);
    if (!receipt) {
      // Not mined yet — keep whatever status is already stored; the client
      // polls again shortly. Not a verdict either way.
      return { ok: true, grantStatus: rec.grantStatus, verified: false, pending: true };
    }
    if (receipt.status !== "success") {
      if (rec.grantStatus === "granted") {
        setWalletRecord(userId, {
          scwAddress: rec.scwAddress, ownerEoa: rec.ownerEoa, salt: rec.salt,
          sessionKeyAddress: rec.sessionKeyAddress, sessionKeyEnc: rec.sessionKeyEnc,
          grantStatus: "pending",
        });
      }
      return {
        ok: true, grantStatus: "pending", verified: false,
        error: "grant transaction reverted on-chain — try “Enable automated trading” again",
      };
    }
  }
  invalidateSmartAccountClient(chainKey);
  setWalletRecord(userId, {
    scwAddress: rec.scwAddress,
    ownerEoa: rec.ownerEoa,
    salt: rec.salt,
    sessionKeyAddress: rec.sessionKeyAddress,
    sessionKeyEnc: rec.sessionKeyEnc,
    grantStatus: "granted",
  });
  console.log(`[wallet-session] ${userId.slice(0, 6)}…${userId.slice(-4)}: session key GRANTED as entity-1 operator`);
  return { ok: true, grantStatus: "granted", sessionKeyAddress: rec.sessionKeyAddress };
}

// ── v2 move-out (owner-signed sweep, SCW → browser EOA) ──────────────────────
// 2026-09-20 redesign (fork-verified, scripts/.dryrun-sweep-*.mjs): the owner
// EOA calls `execute` DIRECTLY on the SCW instead of routing through the
// EntryPoint. Consequences the UX cares about:
//   - The SCW pays ZERO gas — it can send 100.0000% of its ETH (SCW left at
//     exactly 0, verified). No prefund, no AA23, no "keep $2.5 behind" clamp.
//   - The browser EOA pays the tx gas from OUTSIDE (it's a plain EOA tx).
//   - Works pre-grant (entity 0 = global owner validates any msg.sender).
//   - Same shape carries ERC-20 calldata (WETH transfer verified live).

/** Build the direct-sweep payload: { to: scwAddress, data: execute(...) } for
 *  the browser to sign as a PLAIN tx (eth_sendTransaction). No UO, no digest.
 *  asset: "eth" | "imd" | "usd" | "erc20" (with tokenAddress + tokenDecimals). */
export async function quoteDirectSweepV2(userId, chainKey = "ethereum", { asset = "eth", amount = 0, browserFrom = null, tokenAddress = null, tokenDecimals = null } = {}) {
  const rec = getWalletRecord(userId);
  if (!rec || !isV2Record(rec)) throw new Error("no v2 record");
  const ownerEoa = getAddress(rec.ownerEoa);
  const scwAddress = getAddress(rec.scwAddress);
  if (browserFrom && getAddress(browserFrom).toLowerCase() !== ownerEoa.toLowerCase()) {
    throw new Error(`sweep must be signed by the wallet owner ${ownerEoa}`);
  }
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error("enter a positive amount");
  const pub = await publicClientFor(chainKey);
  const code = await pub.getCode({ address: scwAddress }).catch(() => "0x");
  if (!code || code === "0x") throw new Error("smart wallet is not deployed yet — activate it first");
  const dep = getChain(chainKey);

  const executeAbi = parseAbi(["function execute(address target, uint256 value, bytes data)"]);
  let data;
  if (asset === "eth") {
    const ethWei = await pub.getBalance({ address: scwAddress }).catch(() => 0n);
    if (ethWei === 0n) throw new Error("smart wallet has no ETH to sweep");
    // Amounts at/above the full balance mean "send 100.0000%" — the direct
    // execute takes no gas from the SCW, so the FULL balance goes out.
    const value = parseUnits(String(amt), 18) >= ethWei ? ethWei : parseUnits(String(amt), 18);
    data = encodeFunctionData({ abi: executeAbi, functionName: "execute", args: [ownerEoa, value, "0x"] });
  } else {
    // Token sweep. "imd"/"usd" map to the chain's configured tokens; "erc20"
    // sweeps ANY token address (the move-out box for tokens bought elsewhere —
    // launchpad/curve buys land in the EOA, app trades in the SCW, and the
    // owner can always recover anything by direct-execute sweep).
    let token, decimals;
    if (asset === "imd") {
      token = dep.imdToken; decimals = dep.imdDecimals ?? 18;
      if (!token) throw new Error("no IMD token configured on " + chainKey);
    } else if (asset === "usd") {
      token = dep.dollar; decimals = dep.dollarDecimals ?? 6;
    } else {
      token = tokenAddress;
      decimals = tokenDecimals != null ? Number(tokenDecimals) : 18;
    }
    if (!token || !/^0x[0-9a-fA-F]{40}$/.test(token)) throw new Error("invalid token address");
    const inner = encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [ownerEoa, parseUnits(String(amt), decimals)] });
    data = encodeFunctionData({ abi: executeAbi, functionName: "execute", args: [getAddress(token), 0n, inner] });
  }
  return {
    ok: true,
    browserSign: true,
    schema: 2,
    directExecute: true,      // UI: plain eth_sendTransaction, NOT handleOps
    to: scwAddress,
    data,
    asset,
    requestedAmount: amt,
    message: "Sign in your browser wallet — the SCW sends everything; your EOA pays the tx gas from outside.",
  };
}

/** Quote a v2 sweep: build the transfer UO and return the digest to sign. */
export async function quoteMoveOutV2(userId, chainKey = "ethereum", { asset = "eth", amount = 0, browserFrom = null } = {}) {
  const rec = getWalletRecord(userId);
  if (!rec || !isV2Record(rec)) throw new Error("no v2 record");
  const ownerEoa = getAddress(rec.ownerEoa);
  const scwAddress = getAddress(rec.scwAddress);
  if (browserFrom && getAddress(browserFrom).toLowerCase() !== ownerEoa.toLowerCase()) {
    throw new Error(`sweep must be signed by the wallet owner ${ownerEoa}`);
  }
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error("enter a positive amount");
  const pub = await publicClientFor(chainKey);
  const code = await pub.getCode({ address: scwAddress }).catch(() => "0x");
  if (!code || code === "0x") throw new Error("smart wallet is not deployed yet — activate it first");
  const dep = getChain(chainKey);

  let innerData = "0x";
  let value = 0n;
  if (asset === "eth") {
    const ethWei = await pub.getBalance({ address: scwAddress }).catch(() => 0n);
    // keep ~gas float in the SCW (AA23 class) — clamp like the v1 max-send
    const estGas = 150_000n * 30n * 10n ** 9n; // ~0.0045 ETH worst case
    const max = ethWei > estGas ? ethWei - estGas : 0n;
    value = parseUnits(String(amt), 18);
    if (value > max) {
      if (max === 0n) throw new Error(`balance (${Number(ethWei) / 1e18} ETH) can't cover gas — nothing sendable`);
      value = max;
    }
  } else if (asset === "imd") {
    if (!dep.imdToken) throw new Error("no IMD token configured on " + chainKey);
    innerData = encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [ownerEoa, parseUnits(String(amt), dep.imdDecimals ?? 18)] });
  } else {
    innerData = encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [ownerEoa, parseUnits(String(amt), dep.dollarDecimals ?? 6)] });
  }

  const callData = encodeFunctionData({
    abi: parseAbi(["function execute(address target, uint256 value, bytes data)"]),
    functionName: "execute",
    args: [asset === "eth" ? ownerEoa : (asset === "imd" ? getAddress(dep.imdToken) : getAddress(dep.dollar)), value, innerData],
  });

  const pubEp = getContract({ address: ENTRY_POINT_V7, abi: parseAbi(["function getNonce(address sender, uint192 key) view returns (uint256)"]), client: pub });
  // Owner entity = global validation (entity 0) → nonce key 1
  const nonce = await pubEp.read.getNonce([scwAddress, 1n]);

  const userOp = {
    sender: scwAddress,
    nonce: "0x" + nonce.toString(16),
    initCode: "0x",
    callData,
    verificationGasLimit: "0x" + (400000).toString(16),
    callGasLimit: "0x" + (400000).toString(16),
    preVerificationGas: "0x" + (120000).toString(16),
    maxFeePerGas: "0x" + (30_000_000_000n).toString(16),
    maxPriorityFeePerGas: "0x" + (1_000_000_000n).toString(16),
    paymasterAndData: "0x",
    signature: "SIGN_IN_BROWSER",
  };
  const digestToSign = userOpDigest(chainKey, userOp);
  return {
    ok: true,
    browserSign: true,
    schema: 2,
    entryPoint: ENTRY_POINT_V7,
    userOp,
    digestToSign,
    asset,
    requestedAmount: amt,
    sendValueEth: asset === "eth" ? Number(value) / 1e18 : 0,
    message: "Sign the sweep in your browser wallet — the smart wallet transfers to your EOA.",
  };
}

/** Submit the browser-signed sweep UO (same verify-then-relay as the grant). */
export async function submitMoveOutV2(userId, chainKey = "ethereum", { asset = "eth", amount = 0, signature = null } = {}) {
  if (!signature || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error("missing or malformed browser signature");
  const rec = getWalletRecord(userId);
  if (!rec || !isV2Record(rec)) throw new Error("no v2 record");
  const ownerEoa = getAddress(rec.ownerEoa);
  const quote = await quoteMoveOutV2(userId, chainKey, { asset, amount });
  const digest = userOpDigest(chainKey, quote.userOp);
  const recovered = await (await import("viem")).verifyMessage({ address: ownerEoa, message: { raw: digest } }, signature);
  if (!recovered) throw new Error("sweep signature does not recover the wallet owner — refusing to relay");
  const userOp = { ...quote.userOp, signature: packUOSignature(signature) };
  return relayUserOp(chainKey, userOp, { label: "sweep" });
}

/**
 * The user's granted session key (decrypted), or null when automation is not
 * granted. v2 registry only — the users-table session_key_enc and the global
 * AA_SESSION_KEY are no longer consulted (v1 removed 2026-09-24).
 * Throws (funds-safety) when a stored key exists but cannot be decrypted.
 */
export async function resolveUserSessionKeyAsync(userId) {
  if (!userId || !/^0x[0-9a-fA-F]{40}$/.test(userId)) return null;
  const rec = getWalletRecord(userId);
  if (!rec || !isV2Record(rec) || !rec.sessionKeyEnc) return null;
  const sk = decryptSessionKey(rec.sessionKeyEnc);
  if (sk) return sk;
  throw new Error(`registry session key for ${userId.slice(0, 6)}…${userId.slice(-4)} is unreadable — fix MASTER_KEY / data/connected-wallets.json (funds-safety guard)`);
}

/** Settings card: the user's v2 SCW address, balances, grant state. */
export async function getUserWalletStatus(userId, chainKey = "ethereum") {
  const { getUser } = await import("./users.mjs");
  const user = getUser(userId);
  if (!user) return { ok: false, error: "unknown user" };
  const rec = getWalletRecord(userId);
  if (!rec || !isV2Record(rec)) return { ok: true, hasKey: false, schema: 2, signerMode: user.signer_mode || "copilot", error: "no smart wallet registered — sign in again" };
  const dep = getChain(chainKey);
  const pub = createPublicClient({ chain: dep.viemChain, transport: http(dep.httpRpc()) });
  const address = getAddress(rec.scwAddress);
  let eth = null, usd = null, deployed = false;
  try {
    eth = Number(await pub.getBalance({ address })) / 1e18;
    usd = await getErc20Balance(dep.dollar, address, chainKey).catch(() => null);
    usd = usd != null ? Number(usd) / 10 ** (dep.dollarDecimals ?? 6) : null;
    deployed = (await pub.getCode({ address }).catch(() => "0x")) !== "0x";
  } catch { /* offline — still show the address */ }
  return {
    ok: true, hasKey: Boolean(rec.sessionKeyEnc), schema: 2,
    grantStatus: rec.grantStatus || "none",
    ownerEoa: getAddress(rec.ownerEoa),
    signerMode: user.signer_mode || "copilot",
    address, eth, usd, deployed,
    dollarToken: dep.dollar,
    dollarDecimals: dep.dollarDecimals ?? 6,
  };
}
