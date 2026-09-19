# Wallet Connect & Auth — as-built reference (2026-09-19)

How login, logout, and wallet switching actually work in the hosted app —
including the failure modes we hit and the rules that came out of them.
Read this before touching `auth.mjs`, `auth-appkit.js`, `wallet-connect.js`,
`wallet-appkit.js`, or `wallet-slideout.js`.

## The components

| File | Role |
|---|---|
| `auth.mjs` | Auth gate: nonce → verify → HMAC session cookie (`imd_session`, 12h). Unauthenticated API = 401 JSON; unauthenticated page = login page. Serves `auth-appkit.js`'s page when `WALLET_CONNECT_PROJECT_ID` is set. |
| `auth-appkit.js` | **The login gate (served to users).** Reown AppKit modal → `personal_sign` of a nonce message → `POST /api/auth/verify` → cookie → reload. |
| `auth-page.js` | **DELETED (was dead code).** Existed with the same export name; nothing imported it. A fix once landed here by mistake — see the lesson below. |
| `wallet-connect.js` | Header Connect button: `wcToggleConnect()` connects or **disconnects**; disconnect is now a full logout. |
| `wallet-appkit.js` | AppKit modal for the header Connect (address-only session for funding/co-pilot). |
| `wallet-connect-store.mjs` | `CONNECTED_WALLET` env persistence (single global value — known gap). |
| `smart-wallet-registry.mjs` | Per-connected-wallet SCW registry (`data/connected-wallets.json`) — the key material. |
| `smart-wallet-api.mjs` | `resolveUserReadWallet()` (balances) + `ensureWalletSession()` (SCW minting) + slideout status. |
| `signer.mjs` | `resolveSignerUser(userId)` — who SIGNS trades (co-pilot/autonomy). |

## The login flow

1. Any page request without a valid session → login gate page.
2. User clicks **Connect wallet & sign in** → AppKit modal opens.
3. User picks a wallet/account and approves the connection.
4. Page fetches `/api/auth/nonce` (single-use, 5-min TTL).
5. `personal_sign` of the nonce message via the wallet's EIP-1193 provider.
6. `POST /api/auth/verify` → server recovers the signer (viem
   `verifyMessage`), checks registration (`REGISTRATION` open/closed,
   `ALLOWED_WALLET` pin), creates/loads the user row (first user = admin).
7. `imd_session` HMAC cookie set → `location.reload()` → dashboard.

**The signed address IS the identity.** The session is keyed off the address
that signed the nonce — never off AppKit's internal connection state. This is
the property that makes wallet switching safe (see below).

## Rules learned the hard way (do not regress)

### 1. Never pre-disconnect on the login gate

An earlier attempt called `modal.disconnect()` + wiped AppKit/wagmi
localStorage keys before `modal.open()`. Result: AppKit's internal
connectors were half-torn-down, the modal could never complete a reconnect —
the user got an infinite connect loop and never a signature prompt. Reverted
in `ec7bdc7`.

**Why it's also unnecessary:** the signature itself proves which address is
logging in. The server session is keyed off the *signed address*, not off
AppKit's connection state. "Forcing" a fresh connection buys nothing.

### 2. The signature prompt is the account switcher

To log in as a different wallet/account: switch the active account inside
your wallet extension, then approve the signature. The session follows
whatever address signed. Do not try to make AppKit's modal do the switching
— its connection cache is sticky and fighting it breaks reconnect.

### 3. Guard the signature request against silent hangs

A half-torn-down provider makes `personal_sign` never settle (the "infinite
spin"). The login page races the request against a 45s timer and shows
"signature request stalled — click Sign in again" instead of hanging.
Keep this guard when editing the flow.

### 4. There are/were two login-page files — check which one is served

`auth-page.js` was imported by NOTHING; `auth-appkit.js` is what `auth.mjs`
serves. A fix applied to the dead file shipped nothing and left the live
gate broken. It's deleted now (`bd9bde9`). Before editing any page, confirm
it's reachable: `grep -rn "filename" *.mjs`.

### 5. Logout = wallet disconnect = full session teardown

`wcDisconnect()` (header button doubles as disconnect when connected):
1. `POST /auth/logout` → server clears the `imd_session` cookie
2. AppKit `disconnect()` + localStorage cache keys removed
3. `location.href = '/'` → login gate

Previously it only cleared the address record and left the session cookie
alive — "logged in with nothing connected." With the auth gate, logout must
land the user on the connect gate, full stop.

### 6. Read wallet vs sign wallet

- `resolveUserReadWallet(userId)` — balances everywhere (watcher, sniper,
  wallet-sync, overview, slideout): registry SCW → users-table key →
  connected browser wallet → global signer (last resort).
- `resolveSignerUser(userId)` — trade signing: co-pilot → browser approval;
  autonomy → the user's session key.
- Never call the global `resolveSigner()` for user-facing reads on hosted.
  The env `AA_SESSION_KEY` has been deleted from the VPS; per-user keys in
  the registry are the only server-side key material.

### 7. AppKit quirks (Reown, v1.8.x)

- `subscribeState` fires immediately with the CURRENT state — after a
  disconnect it may fire with a stale address while the provider is unusable.
  Don't trust "immediate" `getAddress()` results for signing decisions
  (checking once at flow start is fine).
- The modal's own reconnect path is fragile after external cache wipes —
  let AppKit own its cache; only clear it as part of a deliberate logout.
- Versions come from `esm.sh` (`APPKIT_VERSION` const). Version drift between
  the login gate and the header connect can change API behavior silently.

## Session-key / smart wallet model

- Each user in **co-pilot mode** has NO server-side key. The slideout shows
  an instruction card (generate a session key in Settings → Signer) instead
  of a fundable address. This is deliberate — never render a deposit address
  the user has no key for.
- **Autonomy mode** requires a generated session key → derives the user's
  SCW. Same key = same address, always. Generating a new key = new address
  (blocked while the current one holds funds, unless forced).
- The registry is the single source of truth; the users-table
  `session_key_enc` is a legacy fallback kept in sync by dual-writes.
- The old env `AA_SESSION_KEY` is gone from the VPS. Its wallet (`0xF4a6…`)
  is inert; per-user registry keys replaced it.

## Verification protocol (run after touching any of this)

1. Log out → login gate renders on every page; APIs return 401.
2. Log in → wallet picker → **auth signature prompt on the first click** →
   dashboard. Header shows the address you signed with.
3. Log out → log in with a DIFFERENT account (switch in the extension before
   approving) → session matches the new address (check Settings).
4. Balances: `/tokens`, `/sniper` (P/L card), and overview all show the
   logged-in wallet's data — not another user's, not zeros.
5. Slideout: co-pilot user → instruction card, no fundable address;
   autonomy user → their own SCW.
6. Restart the server → log in again → same SCW as before (phantom-wallet
   canary).
