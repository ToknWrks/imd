# Wallet Connect & Auth — as-built reference (2026-09-19, unified login)

How login, logout, and wallet switching actually work in the hosted app —
including the failure modes we hit and the rules that came out of them.
Read this before touching `auth.mjs`, `wallet-connect.js`, `wallet-appkit.js`,
or `wallet-slideout.js`.

**This file was rewritten 2026-09-19** to reflect the unification of login
and wallet-connect into one action. Previously there were TWO separate
flows — a full-page login gate (`auth-appkit.js`) and a header "Connect
wallet" button (`wallet-connect.js`) that only recorded an address after you
were already logged in. That split caused two real bugs (see the Hard-Won
Lessons entries in CLAUDE.md dated 2026-09-19): a global `CONNECTED_WALLET`
value shared across every user, and a login flow that hung with no
signature prompt on a fresh connect. Both are fixed by collapsing to one
flow. `auth-appkit.js` is deleted; there is no login page anymore.

## The components

| File | Role |
|---|---|
| `auth.mjs` | Auth gate: nonce → verify → HMAC session cookie (`imd_session`, 12h). Unauthenticated API = 401 JSON; unauthenticated page = the normal shell with a "connect your wallet" placeholder body (`CONNECT_PROMPT_BODY`) — never a different document. On successful verify, also calls `ensureWalletSession()` — logging in IS connecting now. |
| `wallet-connect.js` | Header "Connect wallet" button = **the entire sign-in flow**: connect (AppKit or raw `window.ethereum`) → `/api/auth/nonce` → `personal_sign` → `/api/auth/verify` → cookie → `location.reload()`. Disconnect = full logout. |
| `wallet-appkit.js` | `APPKIT_SCRIPT()` — initializes the Reown AppKit modal, exposes `window.appKitConnect()` (used by `wallet-connect.js`) and `window.appKitModal`. Embedded in every page via `shell()`. |
| `smart-wallet-registry.mjs` | Per-wallet SCW registry (`data/connected-wallets.json`) — the key material. |
| `smart-wallet-api.mjs` | `resolveUserReadWallet()` (balances) + `ensureWalletSession()` (SCW minting) + slideout status — all keyed off the SIGNED-IN session address, never a client-submitted or global value. |
| `signer.mjs` | `resolveSignerUser(userId)` — who SIGNS trades (co-pilot/autonomy). |

## The login flow (also the ONLY connect flow)

1. Any page request without a valid session renders the normal app shell —
   same header/nav as everyone else — with a "connect your wallet" prompt in
   the content area instead of real data. There is no separate login
   document, and the placeholder never renders another user's data (several
   page-render functions treat `userId=null` as an all-users legacy view, so
   this is a safety boundary, not just UX).
2. User clicks **Connect wallet** in the header.
3. `window.appKitConnect()` opens the Reown AppKit modal (falls back to raw
   `window.ethereum.request({method:'eth_requestAccounts'})` if AppKit isn't
   configured); user picks a wallet/account and approves the connection.
4. `wallet-connect.js` fetches `/api/auth/nonce` (single-use, 5-min TTL).
5. `personal_sign` of the nonce message via the wallet's EIP-1193 provider.
6. `POST /api/auth/verify` → server recovers the signer (viem
   `verifyMessage`), checks registration (`REGISTRATION` open/closed,
   `ALLOWED_WALLET` pin), creates/loads the user row (first user = admin),
   and calls `ensureWalletSession(address)` — generating this wallet's
   per-user session key + SCW if it doesn't already have one.
7. `imd_session` HMAC cookie set → `location.reload()` → dashboard, now with
   real per-user data.

**The signed address IS the identity.** The session is keyed off the address
that signed the nonce — never off AppKit's internal connection state. This is
the property that makes wallet switching safe (see below).

## Rules learned the hard way (do not regress)

### 1. Never pre-disconnect before opening the connect modal

An earlier attempt called `modal.disconnect()` + wiped AppKit/wagmi
localStorage keys before `modal.open()`. Result: AppKit's internal
connectors were half-torn-down, the modal could never complete a reconnect —
the user got an infinite connect loop and never a signature prompt. Reverted
in `ec7bdc7` (back when this lived in the now-deleted `auth-appkit.js`); the
same rule applies to `wallet-connect.js`'s `wcToggleConnect()` today.

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
spin"). `wallet-connect.js` races the request against a 45s timer and shows
"signature request stalled — click Connect wallet again" instead of hanging.
Keep this guard when editing the flow.

### 4. `AppKit.subscribeState()` never carries an address — use `subscribeAccount()`

(2026-09-19, the second of the two bugs that motivated this rewrite.)
`subscribeState`'s callback type is `PublicStateControllerState`
(`loading`/`open`/`selectedNetworkId`/`activeChain`/`initialized`/
`connectingWallet` — confirmed against the SDK's own `.d.ts`). It **never**
has `.address`. `wallet-appkit.js`'s `appKitConnect()` used to wait on it
when no address was immediately available (`modal.getAddress()` returning
falsy) — that branch was dead code that could never resolve. A fresh
connect would hang until the 120s timeout with no signature prompt; a page
refresh would let the *next* click's immediate `getAddress()` check succeed
instead, because AppKit had already completed the connection in its own
cache by then. Fixed: use `modal.subscribeAccount(cb)`, whose callback
(`UseAppKitAccountReturn`) does carry `{ address, isConnected, ... }`.

### 5. There is no separate login-page file anymore

Historically there were TWO: `auth-page.js` (dead, imported by nothing,
deleted in `bd9bde9`) and then `auth-appkit.js` (the live one, also now
deleted — 2026-09-19). Both are gone. Login is entirely inside
`wallet-connect.js` + `auth.mjs`. Before assuming any login-related file is
"the one that's served," check `grep -rn "filename" *.mjs *.js` — this
exact mistake (editing a dead file, shipping nothing) happened once already.

### 6. Logout = wallet disconnect = full session teardown

`wcDisconnect()` (the same header button doubles as disconnect when signed
in):
1. `POST /auth/logout` → server clears the `imd_session` cookie
2. AppKit `disconnect()` + localStorage cache keys removed
3. `location.href = '/'` → the placeholder (now unauthenticated) shell

Previously it only cleared the address record and left the session cookie
alive — "logged in with nothing connected." With the auth gate, logout must
end the session, full stop.

### 7. Read wallet vs sign wallet

- `resolveUserReadWallet(userId)` — balances everywhere (watcher, sniper,
  wallet-sync, overview, slideout): registry SCW → users-table key → the
  user's own login address (`userId` itself — identity = wallet address,
  so no lookup needed) → global signer (last resort, local dev only).
  **Until 2026-09-19 step 3 read a single GLOBAL `.env` `CONNECTED_WALLET`
  value** shared by every user on the box — every co-pilot-mode user (the
  default) saw whichever address anyone last connected with, anywhere. Fixed
  by deleting that store; identity now flows from the session on every call.
- `resolveSignerUser(userId)` — trade signing: co-pilot → browser approval;
  autonomy → the user's session key. Never call the global `resolveSigner()`
  for user-facing reads on hosted. The env `AA_SESSION_KEY` has been deleted
  from the VPS; per-user keys in the registry are the only server-side key
  material.

### 8. AppKit quirks (Reown, v1.8.x)

- `subscribeState` reports MODAL UI state (open/loading/network) — never
  account/address state. Use `subscribeAccount` for that (rule 4 above).
- `subscribeAccount`/`getAddress` can report a stale address immediately
  after a disconnect while the provider is momentarily unusable. Checking
  `getAddress()` once at the very start of a connect attempt (before opening
  the modal) is fine — don't poll it as a substitute for the real
  `subscribeAccount` event during an in-flight connect.
- The modal's own reconnect path is fragile after external cache wipes —
  let AppKit own its cache; only clear it as part of a deliberate logout.
- Versions come from `esm.sh` (`APPKIT_VERSION` const, currently `1.8.24`).
  Version drift between what's pinned and what's deployed can change API
  behavior silently — when debugging a connect issue, check the actual
  installed version's type defs before assuming an API shape.

## Session-key / smart wallet model

- Each user in **co-pilot mode** (the DB default, `signer_mode='copilot'`)
  has NO server-side key. The slideout shows an instruction card (generate a
  session key in Settings → Signer) instead of a fundable address. This is
  deliberate — never render a deposit address the user has no key for.
- **Autonomy mode** requires a generated session key → derives the user's
  SCW. Same key = same address, always. Generating a new key = new address
  (blocked while the current one holds funds, unless forced).
- `ensureWalletSession()` now runs INSIDE `/api/auth/verify` on every
  successful login (previously it ran from a separate `/api/wallet-connect`
  POST that fired after a distinct "connect" click). Best-effort: a failure
  here must not block sign-in, since co-pilot users never need a session key.
- The registry is the single source of truth; the users-table
  `session_key_enc` is a legacy fallback kept in sync by dual-writes.
- The old env `AA_SESSION_KEY` is gone from the VPS. Its wallet (`0xF4a6…`)
  is inert; per-user registry keys replaced it.

## Verification protocol (run after touching any of this)

1. Log out → the normal shell renders on every page with a "connect your
   wallet" placeholder body (not a different document); APIs return 401.
2. Click **Connect wallet** → wallet picker → **signature prompt on the
   first click, no refresh needed** → page reloads into the real dashboard.
   Header shows the address you signed with.
3. Log out → sign in with a DIFFERENT account (switch in the extension
   before approving) → session matches the new address (check Settings).
4. Balances: `/tokens`, `/sniper` (P/L card), overview, and the wallet
   slideout's owner card all show the logged-in wallet's data — not another
   user's, not a stuck/shared address, not zeros.
5. Slideout: co-pilot user → instruction card, no fundable address;
   autonomy user → their own SCW.
6. Restart the server → log in again → same SCW as before (phantom-wallet
   canary).
