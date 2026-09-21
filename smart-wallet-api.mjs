/**
 * smart-wallet-api.mjs — /api/smart-wallet endpoints for the wallet slideout.
 *
 * Owner wallet  = the configured main signer (vault / raw key — whatever
 *                 resolveSigner returns when SMART_ACCOUNT_ACTIVE is off).
 * Smart wallet  = the Alchemy Modular Account v2 derived from AA_SESSION_KEY.
 *
 * Endpoints (all POST unless noted):
 *   GET  /api/smart-wallet/status  — { active, ownerAddress, scwAddress, activated, balances }
 *   POST /api/smart-wallet/activate — deploy the SCW (owner pays gas, EOA tx)
 *   POST /api/smart-wallet/move     — { direction: "in"|"out", asset: "eth"|"usd", amount }
 *
 * "in"  = owner EOA signs a plain transfer to the SCW (ETH transfer or ERC-20
 *         transfer — no AA needed, the SCW receives like any address).
 * "out" = the SCW signs a UserOperation (transfer ETH or ERC-20 back to owner).
 *
 * Safety notes:
 *  - v2 sweeps (2026-09-20, fork-verified): the owner EOA calls `execute`
 *    DIRECTLY on the SCW (73,829 gas) — no EntryPoint, no prefund, no gas
 *    reserve. The SCW sends 100.0000% of its ETH and pays zero gas; the
 *    browser EOA pays the tx gas from outside. Works pre-grant (entity 0 =
 *    global owner validates msg.sender) and for ERC-20 calldata too.
 *  - v1 outbound ETH keeps gasReserveWei in the SCW (EntryPoint prefund is
 *    taken from the account itself — the AA23 class of failures rangedesk
 *    documents happens when you send "max" without a reserve).
 *  - The move routes never touch strategy funds implicitly — they are explicit
 *    user actions with an amount typed in the UI.
 */
import { getChain, getEthUsdPriceFor } from "./chains.mjs";
import { getErc20Balance, getImdPerEth } from "./dip-swap.mjs";
import { resolveSigner, invalidateSigner } from "./signer.mjs";
import { getSmartAccountClient, invalidateSmartAccountClient, gasReserveWei, explainUserOpError, predictEoaOwnedScwAddress, ssvModuleAddress, MAV2_FACTORY, userOpDigest, packUOSignature, ENTRY_POINT_V7 } from "./smart-account.mjs";
import { createPublicClient, http, getAddress, encodeFunctionData, encodeAbiParameters, parseAbi, formatEther, formatUnits, parseUnits, concat, padHex, toHex, getContract } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getWalletRecord, setWalletRecord, isV2Record } from "./smart-wallet-registry.mjs";

const ERC20_ABI = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);

/**
 * Per-connected-wallet session keys (Option 1, 2026-09-18): each connected
 * wallet gets its OWN session key + smart account, recorded in
 * smart-wallet-registry.mjs. On connect, ensure one exists; reuse it on every
 * later connect (never regenerate for a known wallet). The active key is also
 * mirrored into AA_SESSION_KEY so all existing signer paths keep working.
 */
export async function ensureWalletSession(connectedAddress, chainKey = "ethereum") {
  if (!connectedAddress || !/^0x[0-9a-fA-F]{40}$/.test(connectedAddress)) {
    throw new Error("invalid connected wallet address");
  }
  const rec = getWalletRecord(connectedAddress);

  // ── v2 record (user-EOA-owned SCW, plan 2026-09-20): reuse the stored address.
  // No session key exists yet (or a granted one does — sessionKeyEnc filled by
  // the grant flow). The SCW is deterministic from the EOA, so there is nothing
  // to re-derive and nothing that can orphan funds here.
  if (rec && isV2Record(rec)) {
    if (rec.sessionKeyEnc) {
      // Post-grant wallet: mirror the v1 path so AA_SESSION_KEY keeps working.
      const sk = decryptSessionKey(rec.sessionKeyEnc);
      if (!sk) {
        console.error(`[wallet-session] ${connectedAddress.slice(0, 6)}…${connectedAddress.slice(-4)}: v2 session key UNREADABLE — refusing to mint (funds-safety guard).`);
        throw new Error("Stored session key unreadable — refusing to mint a new wallet (funds-safety guard). Check MASTER_KEY / data/connected-wallets.json.");
      }
      process.env.AA_SESSION_KEY = sk;
      invalidateSmartAccountClient(chainKey);
      return { ok: true, created: false, scwAddress: getAddress(rec.scwAddress), sessionKeyAddress: rec.sessionKeyAddress, schema: 2 };
    }
    // sessionKeyEnc: null → co-pilot-only v2 wallet: the SCW address is known
    // (user funds it + activates in the browser); no server key to mint.
    return { ok: true, created: false, scwAddress: getAddress(rec.scwAddress), sessionKeyAddress: null, schema: 2, needsActivate: true };
  }

  // Known wallet → reuse its stored key (this is why switching back restores
  // that wallet's smart wallet). Key is encrypted at rest (MASTER_KEY);
  // legacy plaintext rows are transparently upgraded.
  if (rec?.sessionKeyEnc) {
    let sk = decryptSessionKey(rec.sessionKeyEnc);
    if (!sk) {
      // The stored key can't be decrypted (missing MASTER_KEY or corrupted
      // row). NEVER silently mint a new wallet here — that orphans funds and
      // scrambles the address on every restart (2026-09-18 lesson).
      console.error(`[wallet-session] ${connectedAddress.slice(0, 6)}…${connectedAddress.slice(-4)}: stored session key UNREADABLE (MASTER_KEY set? registry corrupted?) — refusing to generate a new wallet. Fix MASTER_KEY or the registry, then retry.`);
      throw new Error("Stored session key unreadable — refusing to mint a new wallet (funds-safety guard). Check MASTER_KEY / data/connected-wallets.json.");
    }
    // Legacy plaintext row (pre-encrypt-at-rest): upgrade it in place now that
    // we've successfully read it.
    if (/^0x[0-9a-fA-F]{64}$/.test(rec.sessionKeyEnc)) {
      setWalletRecord(connectedAddress, {
        scwAddress: rec.scwAddress,
        sessionKeyAddress: rec.sessionKeyAddress,
        sessionKeyEnc: encryptSessionKey(sk),
      });
      console.log(`[wallet-session] ${connectedAddress.slice(0, 6)}…${connectedAddress.slice(-4)}: legacy plaintext session key upgraded to encrypted-at-rest`);
    }
    process.env.AA_SESSION_KEY = sk;
    invalidateSmartAccountClient(chainKey);
    const client = await getSmartAccountClient(chainKey);
    return { ok: true, created: false, scwAddress: getAddress(client.account.address), sessionKeyAddress: rec.sessionKeyAddress };
  }

  // A v1 record exists but WITHOUT a key (key was lost / file truncated): same
  // guard — the SCW address is known and may hold funds, so do not re-derive.
  // (v2 records never reach this line — handled above.)
  if (rec && !rec.sessionKeyEnc) {
    console.error(`[wallet-session] ${connectedAddress.slice(0, 6)}…${connectedAddress.slice(-4)}: registry record for SCW ${rec.scwAddress} has NO session key — refusing to generate a new wallet.`);
    throw new Error(`Smart wallet ${rec.scwAddress} is registered but its session key is missing — refusing to mint a new wallet (funds-safety guard).`);
  }

  // ── NEW WALLET (plan 2026-09-20): derive the SCW from the user's EOA (v2).
  // No session key is generated here — the account will be owned by the EOA,
  // activated with one browser-signed factory tx, and the session key is only
  // minted when the user grants autonomy (grantSessionKeyForOwner). This kills
  // the "backup key" story: the wallet IS the user's EOA.
  {
    const scwAddress = predictEoaOwnedScwAddress(chainKey, connectedAddress);
    setWalletRecord(connectedAddress, {
      scwAddress,
      ownerEoa: connectedAddress,
      salt: 0,
      grantStatus: "none",
    });
    console.log(`[wallet-session] ${connectedAddress.slice(0, 6)}…${connectedAddress.slice(-4)}: v2 SCW derived ${scwAddress} (owner = user EOA; activate in browser)`);
    return { ok: true, created: true, scwAddress, sessionKeyAddress: null, schema: 2, needsActivate: true };
  }
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
 * Resolve the wallet whose BALANCES a given user sees everywhere (tokens
 * watcher position, sniper context/position/P/L, wallet-sync). Priority:
 *   1. The user's per-connected-wallet session-key SCW from the registry
 *      (their trading wallet — 0x566d-style users hold funds in the browser
 *      wallet that owns it, and the SCW is what the slideout shows).
 *   2. The users-table session key (legacy autonomy users).
 *   3. The global env signer (system/legacy).
 * 2026-09-18: the old code called the GLOBAL resolveSigner() here, so every
 * user's token page showed the balance of the legacy env AA key's wallet
 * (0xF4a6… — always 0) instead of their own. Balances are a READ — they
 * belong to the user, not to whatever signer env happens to be active.
 * Trades still sign through resolveSignerUser (co-pilot/autonomy unchanged).
 */
export async function resolveUserReadWallet(userId, chainKey = "ethereum") {
  // 1. Registry SCW for this user (the per-connected-wallet trading wallet).
  //    v2 records (user-EOA-owned) carry the SCW address directly — no key
  //    needed to read it. v1 records decrypt the stored session key first.
  if (userId && /^0x[0-9a-fA-F]{40}$/.test(userId)) {
    try {
      const rec = getWalletRecord(userId);
      if (rec && isV2Record(rec)) return getAddress(rec.scwAddress);
      if (rec?.sessionKeyEnc) {
        const sk = decryptSessionKey(rec.sessionKeyEnc);
        if (sk) {
          const client = await getSmartAccountClient(chainKey, { sessionKey: sk });
          return getAddress(client.account.address);
        }
      }
    } catch { /* fall through */ }
    // 2. Legacy users-table key (autonomy users who generated in Settings).
    try {
      const { getUserSecret } = await import("./users.mjs");
      const sk = getUserSecret(userId, "session");
      if (sk) {
        const client = await getSmartAccountClient(chainKey, { sessionKey: sk });
        return getAddress(client.account.address);
      }
    } catch { /* fall through */ }
  }
  // 3. The user's own login address (co-pilot read-context — identity IS the
  //    wallet address post-auth-gate; tokens bought from the browser wallet
  //    show up here). Previously this read a single GLOBAL .env
  //    CONNECTED_WALLET value shared by every user on the box — whichever
  //    user last clicked "Connect wallet" anywhere clobbered it for everyone
  //    (the 2026-09-19 "every co-pilot user sees the same balances" bug).
  //    userId here already IS that address (see the regex-checked branch
  //    above), so just use it.
  if (userId && /^0x[0-9a-fA-F]{40}$/.test(userId)) return getAddress(userId);
  // 4. Global signer fallback (local dev / legacy).
  const { resolveSigner } = await import("./signer.mjs");
  return (await resolveSigner(chainKey)).address;
}

/**
 * BOTH of the user's read wallets, deduped: registry SCW (app-signed trades)
 * + the login/browser EOA (launchpad & curve buys land here). Callers pass
 * the list to computeWalletPosition({ walletAddresses }) so balances and cost
 * basis reflect the user's TOTAL holdings across custody boundaries.
 */
export async function resolveUserReadWallets(userId, chainKey = "ethereum") {
  const out = [];
  const push = (a) => { if (a && /^0x[0-9a-fA-F]{40}$/.test(a) && !out.some((x) => x.toLowerCase() === a.toLowerCase())) out.push(getAddress(a)); };
  if (userId && /^0x[0-9a-fA-F]{40}$/.test(userId)) {
    try {
      const rec = getWalletRecord(userId);
      if (rec && isV2Record(rec)) {
        // v2: SCW straight from the record (works pre- and post-grant).
        push(rec.scwAddress);
      } else if (rec?.sessionKeyEnc) {
        const sk = decryptSessionKey(rec.sessionKeyEnc);
        if (sk) {
          const client = await getSmartAccountClient(chainKey, { sessionKey: sk });
          push(client.account.address);
        }
      }
    } catch { /* SCW optional — the EOA read still works */ }
    // The login address itself (the browser EOA).
    push(userId);
  }
  if (!out.length) out.push(await resolveUserReadWallet(userId, chainKey));
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

async function pub_getBalance(pub, addr) {
  return pub.getBalance({ address: addr });
}

/**
 * The OWNER wallet — the one shown in the slideout's left card and the one
 * the user thinks of as "my wallet" (VultiSig vault locally, raw key on a VPS,
 * the LOGGED-IN wallet on hosted). Always resolved WITHOUT the AA branch,
 * regardless of the current SMART_ACCOUNT_ACTIVE mode: the two-card view
 * compares the owner wallet against the smart wallet, and when AA is the
 * ACTIVE trading signer the two would otherwise be the same address.
 */
async function resolveOwnerSigner(chainKey) {
  const prev = process.env.SMART_ACCOUNT_ACTIVE;
  process.env.SMART_ACCOUNT_ACTIVE = "false";
  try {
    // Force fresh resolution — the main signer cache may hold an AA signer
    // from an earlier call under the same env snapshot.
    invalidateSigner(chainKey);
    return await resolveSigner(chainKey);
  } finally {
    process.env.SMART_ACCOUNT_ACTIVE = prev;
    invalidateSigner(chainKey);
  }
}

async function ownerBalances(chainKey, sessionOwnerAddress = null) {
  const dep = getChain(chainKey);
  // PREFER the logged-in wallet's own address — that's "the user's wallet"
  // now that login IS the connect step. Passed in directly from the request's
  // session (never from process.env: a previous version stashed the client's
  // submitted address in a process-global for the duration of the request,
  // which is a race under concurrent requests from different users — request
  // B could overwrite the value before request A read it back).
  let address = null;
  let kind = "signer";
  if (sessionOwnerAddress) {
    address = sessionOwnerAddress;
    kind = "session";
  } else {
    const owner = await resolveOwnerSigner(chainKey);
    address = owner.address;
    kind = "signer";
    const [ethWei, dollarRaw] = await Promise.all([
      owner.getEthBalanceWei(),
      getErc20Balance(dep.dollar, owner.address, chainKey).catch(() => null),
    ]);
    return {
      address,
      source: kind,
      eth: Number(ethWei) / 1e18,
      usd: dollarRaw != null ? Number(dollarRaw) / (10 ** dep.dollarDecimals) : null,
      dollarDecimals: dep.dollarDecimals,
    };
  }
  const [ethWei, dollarRaw] = await Promise.all([
    publicClientFor(chainKey).then((p) => p.getBalance({ address })),
    getErc20Balance(dep.dollar, address, chainKey).catch(() => null),
  ]);
  const imdRaw = dep.imdToken ? await getErc20Balance(dep.imdToken, address, chainKey).catch(() => null) : null;
  return {
    address: getAddress(address),
    source: kind,
    eth: Number(ethWei) / 1e18,
    usd: dollarRaw != null ? Number(dollarRaw) / (10 ** dep.dollarDecimals) : null,
    dollarDecimals: dep.dollarDecimals,
    imd: imdRaw != null ? Number(imdRaw) / 1e18 : null,
  };
}

async function scwBalances(chainKey, { sessionKey = null } = {}) {
  const dep = getChain(chainKey);
  // Per-user (2026-09-19): resolve with the SESSION USER's key when given —
  // never the global env AA_SESSION_KEY.
  const scw = await getSmartAccountClient(chainKey, sessionKey ? { sessionKey } : {});
  const address = getAddress(scw.account.address);
  const pub = await publicClientFor(chainKey);
  const [ethWei, code, dollarRaw] = await Promise.all([
    pub.getBalance({ address }),
    pub.getCode({ address }).catch(() => "0x"),
    getErc20Balance(dep.dollar, address, chainKey).catch(() => null),
  ]);
  const imdRaw = dep.imdToken ? await getErc20Balance(dep.imdToken, address, chainKey).catch(() => null) : null;
  return {
    address,
    eth: Number(ethWei) / 1e18,
    ethRaw: ethWei,
    activated: Boolean(code && code !== "0x"),
    usd: dollarRaw != null ? Number(dollarRaw) / (10 ** dep.dollarDecimals) : null,
    dollarDecimals: dep.dollarDecimals,
    imd: imdRaw != null ? Number(imdRaw) / 1e18 : null,
  };
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

  let userSessionKey = null;
  let hasSessionKey = false;
  try {
    if (uid) {
      userSessionKey = await resolveUserSessionKeyAsync(uid);
      hasSessionKey = !!userSessionKey;
    }
  } catch { /* unauthenticated or resolver error — treated as no key */ }
  const [owner, scw, ethUsd] = await Promise.all([
    ownerBalances(chainKey, uid).catch((e) => ({ error: e.message.slice(0, 120) })),
    // ONLY read the SCW for the session user's key. No user key → no SCW
    // card (the UI renders a generate-session-key prompt instead). This also
    // stops the env AA_SESSION_KEY from leaking into the UI for everyone.
    hasSessionKey
      ? scwBalances(chainKey, { sessionKey: userSessionKey }).catch((e) => ({ error: e.message.slice(0, 120) }))
      : Promise.resolve(null),
    getEthUsdPriceFor(chainKey).catch(() => 0),
  ]);
  const reserve = Number(gasReserveWei(chainKey)) / 1e18;
  // IMD spot: ETH/IMD pool rate → IMD per ETH, inverted for the IMD→ETH/USD
  // display hints. Cached 60s in dip-swap; 0 when the pool read fails (UI hides).
  const imdPerEth = await getImdPerEth(chainKey).catch(() => 0);
  const out = {
    ok: true,
    chain: chainKey,
    ethUsd,
    imdPerEth,
    imdSymbol: getChain(chainKey).imdSymbol || "IMD",
    hasSessionKey,
    gasReserveEth: reserve,   // kept for compatibility; max-send now computes live
    owner,
    scw,
    dollarSymbol: dollarSymbol(chainKey),
    dollarToken: getChain(chainKey).dollar,
    imdToken: getChain(chainKey).imdToken || null,
  };
  // Live max-sendable: build the outbound UO (no send) and subtract its exact
  // gas cost from the SCW's balance. Errors are non-fatal — UI falls back to
  // clamping at move time.
  // GUARD (2026-09-18): owner can be an {error} object when the owner-signer
  // fallback fails (no AGENT_PRIVATE_KEY on hosted, AA resolution failure) —
  // owner.address is then undefined and buildUserOperation THREW
  // InvalidAddressError synchronously past this try/catch, killing the whole
  // server on every slideout poll without a browser wallet param.
  const ownerAddr = owner && /^0x[0-9a-fA-F]{40}$/.test(owner.address || "") ? owner.address : null;
  if (ownerAddr && scw && !scw.error && scw.ethRaw > 0n) {
    try {
      // Same per-user key as the balances above (never the env burner).
      const scwClient = await getSmartAccountClient(chainKey, userSessionKey ? { sessionKey: userSessionKey } : {});
      const built = await scwClient.buildUserOperation({ uo: { target: ownerAddr, data: "0x", value: scw.ethRaw } });
      const gasCost = BigInt(built.preVerificationGas) +
        BigInt(built.verificationGasLimit) * BigInt(built.maxFeePerGas) +
        BigInt(built.callGasLimit) * BigInt(built.maxFeePerGas);
      const max = scw.ethRaw > gasCost ? scw.ethRaw - gasCost : 0n;
      out.maxSendableEth = Number(max) / 1e18;
    } catch (e) {
      // Belt-and-braces: ANY failure here must degrade the field, never the
      // process (the previous crash took pm2 down with it).
      console.error("[smart-wallet] maxSendableEth build failed (non-fatal):", String(e.shortMessage || e.message).slice(0, 120));
    }
  }
  return out;
}

/** POST /api/smart-wallet/activate.
 *
 *  v2 wallets (user-EOA-owned, plan 2026-09-20): returns an UNSIGNED factory
 *  payload for the BROWSER to sign (eth_sendTransaction) — the owner IS the
 *  browser EOA, so msg.sender == owner by construction and the deploy is one
 *  owner-paid click (fork-verified 2026-09-20: 97,772 gas, code lands at the
 *  predicted address). No gas-key funding dance.
 *
 *  v1 wallets (legacy): the session key owns the account and the factory
 *  silently no-ops for anyone else (0.0008 ETH lesson), so the deploy is signed
 *  server-side with the user's registry session key — unchanged legacy flow. */
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

  // ── v1 legacy branch (session-key-owned MultiOwnerLightAccount) — unchanged.
  const scw = await getSmartAccountClient(chainKey);
  const address = getAddress(scw.account.address);

  const code = await pub.getCode({ address }).catch(() => "0x");
  if (code && code !== "0x") return { ok: true, alreadyDeployed: true, address };

  // checkOnly: the funding poller re-runs this until the gas key is funded —
  // it must NEVER trigger the actual deploy. (Real flag is in opts, above.)
  const factoryAbi = parseAbi(["function createSemiModularAccount(address owner, uint256 salt) returns (address)"]);
  // The owner is the session-key EOA, derived from the USER'S registry key.
  // The AA SDK does not reliably expose it (scw.account.owner was undefined in
  // production). NEVER fall back to the SCW address — self-owned = bricked.
  const sessionKey = await resolveUserSessionKeyAsync(userId);
  if (!sessionKey) throw new Error("cannot determine the smart wallet's owner — no registry session key for this user (was the wallet generated in-app?)");
  const sessionKeyAddress = getAddress(privateKeyToAccount(sessionKey).address);
  const FACTORY = "0x00000000000017c61b5bEe81050EC8eFc9c6fecd";
  const callData = encodeFunctionData({
    abi: factoryAbi,
    functionName: "createSemiModularAccount",
    args: [sessionKeyAddress, 0n],
  });

  // Gas is paid by the session-key EOA (msg.sender must equal owner). Require
  // it to hold enough before sending — a failed/reverted deploy burns gas for
  // nothing, and the silent no-op variant doesn't even revert.
  const payerBal = await pub.getBalance({ address: sessionKeyAddress }).catch(() => 0n);
  const minGasWei = 500_000n * 20n * 10n ** 9n; // 500k gas × 20 gwei ≈ 0.01 ETH
  if (payerBal < minGasWei) {
    return {
      ok: false,
      needsGas: true,
      gasPayer: sessionKeyAddress,
      gasPayerBalanceEth: Number(payerBal) / 1e18,
      suggestedGasEth: 0.002,
      ...(checkOnly ? {} : { message: `Activation is signed by the wallet's own gas key (the factory ignores anyone else — msg.sender must be the account owner). Fund the gas key ${sessionKeyAddress} with ~0.002 ETH, then click Activate again.` }),
    };
  }
  if (checkOnly) {
    // Funded — tell the poller to proceed; it will call again without checkOnly.
    return { ok: true, checkOnly: true, readyToDeploy: true, gasPayer: sessionKeyAddress };
  }

  // Server signs WITH THE SESSION KEY so msg.sender == owner.
  const { createWalletClient } = await import("viem");
  const account = privateKeyToAccount(sessionKey);
  const walletClient = createWalletClient({ account, chain: dep.viemChain, transport: http(dep.httpRpc()) });
  const txHash = await walletClient.sendTransaction({
    account,
    chain: dep.viemChain,
    to: FACTORY,
    data: callData,
    value: 0n,
  });
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error("deploy tx reverted: " + txHash);
  // Post-deploy verification — catches the silent no-op class even if the
  // factory's guard ever changes.
  const codeAfter = await pub.getCode({ address }).catch(() => "0x");
  if (!codeAfter || codeAfter === "0x") throw new Error("deploy tx mined but no code at " + address + " — factory no-oped (msg.sender ≠ owner?)");
  return { ok: true, address, txHash };
}

/**
 * v2 AUTONOMY GRANT (plan 2026-09-20, refined sequencing): generate the user's
 * session key, store it encrypted, and return the installValidation UO payload
 * for the BROWSER (owner EOA) to sign and submit via the EntryPoint. The grant
 * rides entity 1 (SingleSignerValidationModule) with selectors
 * [execute, executeBatch] — exactly the shape proven on the 2026-09-20 fork
 * dry run (session-key-only UO mined and transferred).
 *
 * The UO signature is NOT the 1271-packed owner format: for a non-global entity
 * the account validates a raw `0xFF 0x00 <ecdsa>` signature over the userOpHash
 * (verified live — packUOSignature shape).
 *
 * The caller (UI) submits handleOps with the browser's signature; then calls
 * confirmGrant() to record grantStatus + AA_SESSION_KEY. Co-pilot users never
 * call this — no key is generated, nothing to back up.
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
  if (!code || code === "0x") throw new Error("smart wallet is not deployed yet — activate it first (the grant UO's sender must exist on-chain)");

  // Reuse an already-generated key (idempotent re-quotes); mint only if absent.
  let sessionKey = rec.sessionKeyEnc ? decryptSessionKey(rec.sessionKeyEnc) : null;
  let generated = false;
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

  // Build the installValidation self-execute calldata (entity 1, selectors
  // execute + executeBatch, signer = session-key EOA). Verified encoding —
  // see scripts/.dryrun-sessionkey.mjs (grant leg, ValidationFunctionMissing fix).
  const ssv = ssvModuleAddress(chainKey);
  const validationConfig = concat([ssv, toHex(1, { size: 4 }), toHex(0x01, { size: 1 })]); // isUserOpValidation only
  const callData = encodeFunctionData({
    abi: parseAbi(["function execute(address target, uint256 value, bytes data)"]),
    functionName: "execute",
    args: [
      scwAddress,
      0n,
      encodeFunctionData({
        abi: parseAbi(["function installValidation(bytes25 validationConfig, bytes4[] selectors, bytes installData, bytes[] hooks)"]),
        functionName: "installValidation",
        args: [
          validationConfig,
          ["0xb61d27f6", "0x34fcd5be"], // execute, executeBatch
          encodeAbiParameters([{ type: "uint32" }, { type: "address" }], [1, sessionKeyAddress]),
          [],
        ],
      }),
    ],
  });

  const EP = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
  const pubEp = getContract({ address: EP, abi: parseAbi(["function getNonce(address sender, uint192 key) view returns (uint256)"]), client: pub });
  // Entity-1, non-global nonce key = (0 << 40) | (1 << 8) | 0 = 256
  const nonce = await pubEp.read.getNonce([scwAddress, 256n]);

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
    // signature: the BROWSER owner signs userOpDigest(userOp) and the UI sends
    // the raw 65-byte personal_sign result; the submit endpoint packs it with
    // packUOSignature → "0xFF00"+sig. No 1271 packing for non-global entities.
    signature: "SIGN_IN_BROWSER",
  };
  const { userOpDigest } = await import("./smart-account.mjs");
  const digestToSign = userOpDigest(chainKey, userOp);

  return {
    ok: true,
    browserSign: true,
    schema: 2,
    entryPoint: EP,
    userOp,
    digestToSign,
    sessionKeyAddress,
    gasEstimateEth: 0.003,
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
 *  AA client with the new key. Idempotent; safe to call after polling. */
export async function confirmGrant(userId, chainKey = "ethereum") {
  const rec = getWalletRecord(userId);
  if (!rec || !isV2Record(rec)) throw new Error("no v2 record");
  if (!rec.sessionKeyEnc) throw new Error("no session key stored — call grantSessionKeyForOwner first");
  const sk = decryptSessionKey(rec.sessionKeyEnc);
  if (!sk) throw new Error("stored session key unreadable (MASTER_KEY?)");
  process.env.AA_SESSION_KEY = sk;
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
 * POST /api/smart-wallet/generate support — creates the burner session key
 * server-side, derives the SCW address, and returns the key ONCE for the user
 * to back up. The key is written to .env by the caller (dashboard route via
 * writeEnvValues) — after this response it is never shown again (masked only).
 *
 * Security framing shown in the UI: the key is born on THIS machine, which is
 * also where it must live to sign. Generating here does not weaken the model
 * versus CLI generation — the key's home is the trading host either way. Back
 * it up immediately (password manager); Phase 2's on-chain plugin is what
 * downgrades a leaked key from "wallet drained" to "cap hit, revoke, rotate".
 */
export async function generateSessionKey(chainKey = "ethereum", { force = false } = {}) {
  const { generatePrivateKey } = await import("viem/accounts");
  const { invalidateSmartAccountClient } = await import("./smart-account.mjs");

  // FUND GUARD: regenerating while the CURRENT smart account holds funds would
  // orphan them (the new key derives a different address). MultiOwner accounts
  // soften this (old key keeps authority), but the app still loses sight of the
  // funded account — so block unless the operator explicitly forces it.
  // Note: with MultiOwner, the BETTER rotation path is addOwner (not regenerate),
  // which the UI will surface once wired; this guard covers the destructive path.
  const prevKey = process.env.AA_SESSION_KEY;
  const haveFunds = { eth: 0n, usd: 0n };
  if (prevKey) {
    try {
      const dep = getChain(chainKey);
      const pub = createPublicClient({ chain: dep.viemChain, transport: http(dep.httpRpc()) });
      // resolve the CURRENT account address with the CURRENT key
      const curClient = await getSmartAccountClient(chainKey);
      const curAddr = getAddress(curClient.account.address);
      haveFunds.eth = await pub_getBalance(pub, curAddr);
      const usdRaw = await getErc20Balance(dep.dollar, curAddr, chainKey).catch(() => null);
      haveFunds.usd = usdRaw != null ? BigInt(usdRaw) : 0n;
    } catch { /* if we can't read, don't block */ }
  }
  const funded = haveFunds.eth > 0n || haveFunds.usd > 0n;
  if (prevKey && funded && !force) {
    return {
      ok: false,
      blocked: "funds-present",
      message: `The current smart account holds funds (eth ≥ 0 or ${dollarSymbol(chainKey)} > 0). Generating a new key would orphan them. Sweep the funds out first (wallet slideout → Move out), or re-run with force.`,
    };
  }

  const sessionKey = generatePrivateKey();
  // Derive the SCW address for the fresh key without persisting anything —
  // getSmartAccountClient accepts a sessionKey override; no env swap needed.
  invalidateSmartAccountClient(chainKey);
  try {
    const client = await getSmartAccountClient(chainKey, { sessionKey });
    const address = getAddress(client.account.address);
    return { ok: true, sessionKey, address, previousAccountHadFunds: funded };
  } finally {
    invalidateSmartAccountClient(chainKey);
  }
}

/**
 * Per-user session-key generation (Phase 2 multi-user). Generates a fresh
 * burner key, derives the user's own SCW address, and stores the key
 * ENCRYPTED in their users row (never in env). The plaintext is shown ONCE
 * by the caller (UI) for backup. Fund guard: blocks when the user's CURRENT
 * session-key account still holds funds (unless forced).
 */
/**
 * ONE key resolver for per-user trading wallets (unification, 2026-09-18):
 * the REGISTRY (per-connected-wallet, Option 1) is the source of truth;
 * the users-table session_key_enc is a legacy fallback for headless users
 * with no registry record. Every consumer — signer resolution, settings
 * display, slideout — must go through this so the two stores can't show
 * (or sign with) different wallets. Settings' generate button dual-writes
 * both stores to keep legacy consumers working.
 */
export function resolveUserSessionKey(userId) {
  if (!userId || !/^0x[0-9a-fA-F]{40}$/.test(userId)) return null;
  const rec = getWalletRecord(userId);
  if (rec?.sessionKeyEnc) {
    const sk = decryptSessionKey(rec.sessionKeyEnc);
    if (sk) return sk;
    // Unreadable registry key must NOT silently fall through to a different
    // (users-table) key — that would sign trades from a wallet the registry
    // doesn't know about. Surface the error instead.
    throw new Error(`registry session key for ${userId.slice(0, 6)}…${userId.slice(-4)} is unreadable — fix MASTER_KEY / data/connected-wallets.json (funds-safety guard)`);
  }
  // Legacy fallback: users-table secret (pre-registry users, headless setups).
  return null; // async import below — see resolveUserSessionKeyAsync
}

export async function resolveUserSessionKeyAsync(userId) {
  if (!userId || !/^0x[0-9a-fA-F]{40}$/.test(userId)) return null;
  const rec = getWalletRecord(userId);
  // v2 pre-grant (co-pilot-only): sessionKeyEnc is null BY DESIGN — return null
  // so callers treat it as "no autonomy yet", never the funds-safety throw.
  if (rec && isV2Record(rec)) {
    if (!rec.sessionKeyEnc) return null;
    const sk = decryptSessionKey(rec.sessionKeyEnc);
    if (sk) return sk;
    throw new Error(`registry session key for ${userId.slice(0, 6)}…${userId.slice(-4)} is unreadable — fix MASTER_KEY / data/connected-wallets.json (funds-safety guard)`);
  }
  if (rec?.sessionKeyEnc) {
    const sk = decryptSessionKey(rec.sessionKeyEnc);
    if (sk) return sk;
    throw new Error(`registry session key for ${userId.slice(0, 6)}…${userId.slice(-4)} is unreadable — fix MASTER_KEY / data/connected-wallets.json (funds-safety guard)`);
  }
  const { getUserSecret } = await import("./users.mjs");
  return getUserSecret(userId, "session");
}

export async function generateUserSessionKey(userId, chainKey = "ethereum", { force = false } = {}) {
  if (!userId) throw new Error("userId required");
  // ── v2 GUARD (2026-09-20 incident): this legacy path RE-DERIVES the SCW
  // from a fresh key, which would orphan an activated, funded user-EOA-owned
  // wallet. v2 users grant automation via the slideout instead.
  const rec2 = getWalletRecord(userId);
  if (rec2 && isV2Record(rec2)) {
    return {
      ok: false,
      blocked: "v2-wallet",
      message: "This wallet is a v2 (user-EOA-owned) smart wallet — its address never changes. To enable automated trading, open the wallet slideout and click \u201cEnable automated trading\u201d. The legacy Generate/Regenerate buttons do not apply.",
    };
  }
  const { getUser, setUserSecret, getUserSecret } = await import("./users.mjs");
  const user = getUser(userId);
  if (!user) throw new Error("unknown user");

  const { generatePrivateKey } = await import("viem/accounts");
  // Unified resolver — the "current" key is whichever the registry (then the
  // users table) actually holds, not just the users-table copy.
  const prevKey = await resolveUserSessionKeyAsync(userId);
  const haveFunds = { eth: 0n, usd: 0n };
  if (prevKey) {
    try {
      const dep = getChain(chainKey);
      const pub = createPublicClient({ chain: dep.viemChain, transport: http(dep.httpRpc()) });
      const curClient = await getSmartAccountClient(chainKey, { sessionKey: prevKey });
      const curAddr = getAddress(curClient.account.address);
      haveFunds.eth = await pub_getBalance(pub, curAddr);
      const usdRaw = await getErc20Balance(dep.dollar, curAddr, chainKey).catch(() => null);
      haveFunds.usd = usdRaw != null ? BigInt(usdRaw) : 0n;
    } catch { /* can't read — don't block */ }
  }
  const funded = haveFunds.eth > 0n || haveFunds.usd > 0n;
  if (prevKey && funded && !force) {
    return {
      ok: false,
      blocked: "funds-present",
      message: `Your current smart account holds funds. Generating a new key derives a NEW address — sweep the funds out first (wallet slideout → Move out), or confirm force.`,
    };
  }

  const sessionKey = generatePrivateKey();
  const client = await getSmartAccountClient(chainKey, { sessionKey });
  const address = getAddress(client.account.address);

  // DUAL-WRITE both stores (2026-09-18 unification): the registry is the
  // source of truth for connected wallets; the users-table copy keeps legacy
  // headless consumers working. They must never hold DIFFERENT keys.
  setUserSecret(userId, "session", sessionKey);
  const rec = getWalletRecord(userId);
  setWalletRecord(userId, {
    scwAddress: address,
    sessionKeyAddress: getAddress(privateKeyToAccount(sessionKey).address),
    ...(rec?.sessionKeyEnc ? {} : {}),
    sessionKeyEnc: encryptSessionKey(sessionKey),
    createdAt: rec?.createdAt,
  });
  console.log(`[users] session key generated for ${userId.slice(0, 6)}…${userId.slice(-4)} — SCW ${address}`);
  return { ok: true, sessionKey, address };
}

/** Derive a user's SCW address + balances without exposing the key. */
export async function getUserWalletStatus(userId, chainKey = "ethereum") {
  const { getUser } = await import("./users.mjs");
  const user = getUser(userId);
  if (!user) return { ok: false, error: "unknown user" };
  // ── v2 records: report the REGISTRY SCW directly. Never derive from a
  // session key here — the v2 SCW address is EOA-owned and independent of
  // any key (the Settings UI must show the SAME wallet as the slideout).
  const rec = getWalletRecord(userId);
  if (rec && isV2Record(rec)) {
    const dep = getChain(chainKey);
    const pub = createPublicClient({ chain: dep.viemChain, transport: http(dep.httpRpc()) });
    const address = getAddress(rec.scwAddress);
    let eth = null, usd = null, deployed = false;
    try {
      eth = Number(await pub.getBalance({ address })) / 1e18;
      deployed = (await pub.getCode({ address }).catch(() => "0x")) !== "0x";
    } catch { /* offline — still show the address */ }
    return {
      ok: true, hasKey: Boolean(rec.sessionKeyEnc), schema: 2,
      grantStatus: rec.grantStatus || "none",
      ownerEoa: getAddress(rec.ownerEoa),
      signerMode: user.signer_mode || "copilot",
      address, eth, usd, deployed,
    };
  }
  // Unified resolver (2026-09-18): registry first, users-table legacy
  // fallback — settings and the slideout now ALWAYS show the same wallet.
  const sessionKey = await resolveUserSessionKeyAsync(userId);
  if (!sessionKey) return { ok: true, hasKey: false, signerMode: user.signer_mode || "copilot" };
  const dep = getChain(chainKey);
  const pub = createPublicClient({ chain: dep.viemChain, transport: http(dep.httpRpc()) });
  const client = await getSmartAccountClient(chainKey, { sessionKey });
  const address = getAddress(client.account.address);
  const ethWei = await pub_getBalance(pub, address);
  const usdRaw = await getErc20Balance(dep.dollar, address, chainKey).catch(() => null);
  return {
    ok: true, hasKey: true, signerMode: user.signer_mode || "copilot",
    address, eth: Number(ethWei) / 1e18,
    usd: usdRaw != null ? Number(usdRaw) / 10 ** (dep.dollarDecimals ?? 6) : null,
    deployed: (await pub.getBytecode({ address })) !== "0x",
  };
}
/**
 * POST /api/smart-wallet/move — { direction: "in"|"out", asset: "eth"|"usd", amount: number, chain }
 * Returns { ok, txHash } — caller (UI) reloads balances after.
 */
export async function moveFunds({ direction, asset = "eth", amount, chainKey = "ethereum", userId = null }) {
  const dep = getChain(chainKey);
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error("enter a positive amount");

  // ── v2 wallets (user-EOA-owned, plan 2026-09-20): the OWNER is the user's
  // browser EOA — the server has no owner signer and (pre-grant) no session
  // key. Move-out for v2 is therefore NOT supported server-side; the slideout
  // routes it through the browser-sign path instead (wallet-slideout.js).
  // Move-in still works server-side when an env signer exists (local dev).
  const rec = userId ? getWalletRecord(userId) : null;
  if (rec && isV2Record(rec)) {
    if (!direction_in(direction)) {
      throw new Error("Move-out for user-EOA-owned wallets is signed in the browser (the owner is your own EOA) — use the browser-sign Move out in the slideout.");
    }
    // Fall through to move-in using whatever owner signer exists (env key on
    // local dev; on hosted there is none and the browser path handles funding).
  }

  const owner = await resolveOwnerSigner(chainKey);
  const scw = await getSmartAccountClient(chainKey);
  const scwAddress = getAddress(scw.account.address);

  if (direction_in(direction)) {
    // OWNER → SCW: plain EOA tx (ETH send or ERC-20 transfer). No AA needed.
    if (asset === "eth") {
      const wei = parseUnits(String(amt), 18);
      const bal = await owner.getEthBalanceWei();
      if (bal <= wei) throw new Error(`owner balance too low (have ${Number(bal) / 1e18} ETH)`);
      // Plain ETH send: the signer interface's callContract is contract-only,
      // so route through the same wallet client the signer wraps — exposed as
      // signer.sendEth? Not in the interface. Use the walletClient directly.
      const { createWalletClient } = await import("viem");
      // Simplest robust path: ERC-20-style is impossible for native; use the
      // raw wallet client via the signer's underlying client (raw-key signer
      // exposes writeContract only). Fall back: callContract on an address
      // with no calldata is invalid — so do a direct viem sendTransaction
      // using the owner account reconstructed here.
      const { privateKeyToAccount } = await import("viem/accounts");
      // If the owner is a vault, ETH sends must go through callContract-like
      // contract path — vault supports contractCall only. For Phase 1 the
      // move-in flow therefore requires a raw-key owner; document it.
      if (owner.kind !== "key") {
        throw new Error("Move-in for ETH requires the raw-key signer (vault path: send ETH from the vault app directly to the SCW address)");
      }
      const pk = process.env.AGENT_PRIVATE_KEY?.trim();
      const account = privateKeyToAccount(pk.startsWith("0x") ? pk : "0x" + pk);
      const walletClient = await import("viem").then(v => v.createWalletClient({
        account,
        chain: dep.viemChain,
        transport: http(dep.httpRpc()),
      }));
      const txHash = await walletClient.sendTransaction({
        account,
        chain: dep.viemChain,
        to: scwAddress,
        value: wei,
      });
      return { ok: true, txHash };
    }
    const token = getAddress(dep.dollar);
    const dec = dep.dollarDecimals;
    const raw = parseUnits(String(amt), dec);
    const txHash = await owner.callContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [scwAddress, raw],
    });
    return { ok: true, txHash };
  }
  if (asset === "imd") {
    // IMD in: same owner-signed ERC-20 transfer shape, IMD token address.
    if (!dep.imdToken) throw new Error("no IMD token configured on " + chainKey);
    const raw = parseUnits(String(amt), dep.imdDecimals ?? 18);
    const txHash = await owner.callContract({
      address: getAddress(dep.imdToken),
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [scwAddress, raw],
    });
    return { ok: true, txHash };
  }

  // SCW → OWNER: a UserOperation signed by the session key.
  const pub = await publicClientFor(chainKey);
  const ethWei = await pub.getBalance({ address: scwAddress });

  let uo;
  if (asset === "eth") {
    // Max-send support: compute the UO's EXACT gas cost (build first, no send),
    // then send balance-minus-that-cost. The only ETH retained is the real cost
    // of this very transaction — no standing reserve. A "100% out" sweep leaves
    // ~0.00002 ETH of dust, which IS the gas the chain consumed.
    let wei = parseUnits(String(amt), 18);
    const built = await scw.buildUserOperation({ uo: { target: owner.address, data: "0x", value: wei } });
    const gasCost = BigInt(built.preVerificationGas) +
      BigInt(built.verificationGasLimit) * BigInt(built.maxFeePerGas) +
      BigInt(built.callGasLimit) * BigInt(built.maxFeePerGas);
    const maxSendable = ethWei > gasCost ? ethWei - gasCost : 0n;
    if (wei > maxSendable) {
      if (maxSendable === 0n) {
        throw new Error(`balance (${Number(formatEther(ethWei)).toFixed(6)} ETH) can't cover this transaction's gas (${Number(formatEther(gasCost)).toFixed(6)} ETH) — nothing is sendable`);
      }
      // Clamp to max and tell the user — 100% requests send everything minus gas.
      console.log(`[smart-wallet] clamping to max sendable: ${Number(formatEther(maxSendable)).toFixed(6)} ETH (gas ${Number(formatEther(gasCost)).toFixed(6)})`);
      wei = maxSendable;
    }
    uo = { target: owner.address, data: "0x", value: wei };
    // Rebuild the UO with the final value so gas estimation matches exactly.
    const rebuilt = await scw.buildUserOperation({ uo });
    const rebuiltCost = BigInt(rebuilt.preVerificationGas) +
      BigInt(rebuilt.verificationGasLimit) * BigInt(rebuilt.maxFeePerGas) +
      BigInt(rebuilt.callGasLimit) * BigInt(rebuilt.maxFeePerGas);
    if (rebuiltCost >= ethWei) {
      throw new Error("gas cost exceeded balance after clamping — try a slightly smaller amount");
    }
  } else if (asset === "imd") {
    if (!dep.imdToken) throw new Error("no IMD token configured on " + chainKey);
    const raw = parseUnits(String(amt), dep.imdDecimals ?? 18);
    uo = {
      target: getAddress(dep.imdToken),
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [owner.address, raw] }),
      value: 0n,
    };
  } else {
    const token = getAddress(dep.dollar);
    const dec = dep.dollarDecimals;
    const raw = parseUnits(String(amt), dec);
    uo = {
      target: token,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [owner.address, raw] }),
      value: 0n,
    };
  }
  const { hash } = await scw.sendUserOperation({ uo });
  const txHash = await scw.waitForUserOperationTransaction({ hash });
  return { ok: true, txHash };
}

// helper — direction normalization (kept tiny, avoids typos across routes)
function direction_in(d) { return d === "in" || d === "IN" || d === "inbound"; }
