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
 *  - Gas reserve: outbound ETH keeps gasReserveWei in the SCW (EntryPoint
 *    prefund is taken from the account itself — the AA23 class of failures
 *    rangedesk documents happens when you send "max" without a reserve).
 *  - The move routes never touch strategy funds implicitly — they are explicit
 *    user actions with an amount typed in the UI.
 */
import { getChain, getEthUsdPriceFor } from "./chains.mjs";
import { getErc20Balance, getImdPerEth } from "./dip-swap.mjs";
import { resolveSigner, invalidateSigner } from "./signer.mjs";
import { getSmartAccountClient, invalidateSmartAccountClient, gasReserveWei, explainUserOpError } from "./smart-account.mjs";
import { createPublicClient, http, getAddress, encodeFunctionData, parseAbi, formatEther, formatUnits, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getWalletRecord, setWalletRecord } from "./smart-wallet-registry.mjs";

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

  // A record exists but WITHOUT a key (key was lost / file truncated): same
  // guard — the SCW address is known and may hold funds, so do not re-derive.
  if (rec && !rec.sessionKeyEnc) {
    console.error(`[wallet-session] ${connectedAddress.slice(0, 6)}…${connectedAddress.slice(-4)}: registry record for SCW ${rec.scwAddress} has NO session key — refusing to generate a new wallet.`);
    throw new Error(`Smart wallet ${rec.scwAddress} is registered but its session key is missing — refusing to mint a new wallet (funds-safety guard).`);
  }

  // New wallet → generate a fresh session key, derive its SCW, record it.
  const { generatePrivateKey } = await import("viem/accounts");
  const sessionKey = generatePrivateKey();
  const sessionKeyAddress = getAddress(privateKeyToAccount(sessionKey).address);
  const prev = process.env.AA_SESSION_KEY;
  process.env.AA_SESSION_KEY = sessionKey;
  invalidateSmartAccountClient(chainKey);
  try {
    const client = await getSmartAccountClient(chainKey);
    const scwAddress = getAddress(client.account.address);
    setWalletRecord(connectedAddress, {
      scwAddress,
      sessionKeyAddress,
      sessionKeyEnc: encryptSessionKey(sessionKey), // encrypted at rest (MASTER_KEY)
    });
    return { ok: true, created: true, scwAddress, sessionKeyAddress };
  } catch (e) {
    // restore the previous key if creation failed
    if (prev) process.env.AA_SESSION_KEY = prev;
    invalidateSmartAccountClient(chainKey);
    throw e;
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
  if (userId && /^0x[0-9a-fA-F]{40}$/.test(userId)) {
    try {
      const rec = getWalletRecord(userId);
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
      if (rec?.sessionKeyEnc) {
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
    imdSymbol: dep.imdSymbol || "IMD",
    hasSessionKey,
    gasReserveEth: reserve,   // kept for compatibility; max-send now computes live
    owner,
    scw,
    dollarSymbol: dollarSymbol(chainKey),
    dollarToken: getChain(chainKey).dollar,
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

/** POST /api/smart-wallet/activate — owner-paid factory deploy (rangedesk pattern). */
export async function activateSmartWallet(chainKey = "ethereum") {
  const dep = getChain(chainKey);
  const pub = await publicClientFor(chainKey);
  const scw = await getSmartAccountClient(chainKey);
  const address = getAddress(scw.account.address);

  const code = await pub.getCode({ address }).catch(() => "0x");
  if (code && code !== "0x") return { ok: true, alreadyDeployed: true, address };

  // Deploy via a direct factory call signed by the OWNER (rangedesk pattern:
  // createSemiModularAccount(owner, salt) — owner pays gas, no paymaster).
  const owner = await resolveOwnerSigner(chainKey);
  const factoryAbi = parseAbi(["function createSemiModularAccount(address owner, uint256 salt) returns (address)"]);
  // The owner of the account is the session key EOA in Phase 1 (see the
  // honesty note in smart-account.mjs) — pass ITS address as owner.
  const sessionKeyAddress = scw.account.owner?.address ?? owner.address;
  const txHash = await owner.callContract({
    address: "0x00000000000017c61b5bEe81050EC8eFc9c6fecd",
    abi: factoryAbi,
    functionName: "createSemiModularAccount",
    args: [sessionKeyAddress, 0n],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error("deploy tx reverted: " + txHash);
  return { ok: true, address, txHash };
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
export async function moveFunds({ direction, asset = "eth", amount, chainKey = "ethereum" }) {
  const dep = getChain(chainKey);
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error("enter a positive amount");

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
