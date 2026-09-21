# Wallet & signer — as-built overview (2026-09-21)

How a user's wallet gets connected, what it owns on-chain, and who actually
signs a trade. This is the overview/index; two sibling docs cover specific
slices in more depth:

- **`docs/wallet-connect.md`** — login/connect flow (`auth.mjs`,
  `wallet-connect.js`, `wallet-appkit.js`), the unified "connecting IS
  logging in" model, and the read-vs-sign-wallet resolvers.
- **`docs/smart-account-signer.md`** — the legacy v1 signer interface
  contract (`{ kind, address, getEthBalanceWei(), callContract(...) }`) and
  the original MultiOwnerLightAccount design. Existing v1 wallets still use
  this path; new connections use v2 (below).

This doc covers what neither of those does yet: **v2 EOA-owned smart
wallets** and the **direct-sign manual-trade** signer (2026-09-21).

## The three ways a trade gets signed

| Mode | Who signs | Key material |
|---|---|---|
| Co-pilot, unattended (dips, autosells, MM) | Approval modal → browser wallet | none on server |
| Co-pilot, manual click (`/tokens` exit, `/sniper` buy/sell) | Direct-sign → browser wallet | none on server |
| Autonomy | Server-side session key | `data/connected-wallets.json` (encrypted, MASTER_KEY) |

Co-pilot NEVER holds key material server-side, in either sub-mode — the
difference between the two is UX (modal + SSE + ledger vs. one-click
built-tx), not custody. See `CLAUDE.md` § Trading modes.

## v2 wallets — EOA-owned SCW, no backup-key problem (2026-09-20)

The smart account is derived DETERMINISTICALLY from the connected EOA
(`predictEoaOwnedScwAddress`, SMA v2 factory CREATE2) — the browser wallet
IS the permanent on-chain owner, so there's no "what if the session key is
lost" scenario the way v1's session-key-owned model had.

- **Activate**: one browser-signed factory tx (`createSemiModularAccount
  (ownerEoa, 0)`, owner pays, ~98k gas).
- **Enable automated trading**: mints a session key only when requested,
  granted via `installValidation` (SingleSignerValidationModule, entity 1,
  non-global, selectors `execute`+`executeBatch`) in a browser-signed
  `handleOps` UO. The user's EOA pays the relay gas — the server holds NO
  relayer liability, ever.
- **Driving it server-side**: `getSmartAccountClient(chainKey, { sessionKey,
  scwAddress })` — passing `scwAddress` is MANDATORY; without it the client
  derives a MultiOwnerLightAccount from the session key and UOs go to an
  orphan address (AA13, found live).
- **Registry record**: `{ schema: 2, ownerEoa, salt, grantStatus,
  sessionKeyEnc: null }` — `sessionKeyEnc: null` means co-pilot, NOT a lost
  key. Readers branch on `isV2Record()` before the funds-safety guard.
- **Gas is user-paid everywhere** — activation, grant, and sweep are all
  browser-submitted; trades pay from the SCW's own prefund via the Alchemy
  bundler. Needs a real float (~0.005–0.01 ETH per mainnet UO) — AA23 on an
  activated wallet means underfunded, not broken.
- **Settings must never offer key generation for a v2 record** — the legacy
  Generate/Regenerate buttons re-derive the SCW from a fresh key and ORPHAN
  the activated, funded wallet (live incident 2026-09-20).

Full byte-level grant/nonce/signature-shape details:
`CLAUDE.md` § "v2 as-built reference".

## Direct-sign — the manual-trade signer (2026-09-21)

When a user clicks Buy/Sell themselves (not an unattended engine trade),
co-pilot mode builds the tx server-side and hands it to the browser wallet
directly — no approval modal, no `copilot_requests` row. The server-side
half of this is a **capture-signer**: a fake signer object whose
`callContract` records the call and throws instead of sending it, passed
into the SAME execution functions autonomy mode uses. See `CLAUDE.md` §
"Direct-sign manual trades" for the full mechanics (staged approvals,
`isApproval`, the float-precision rule, the `getEthBalanceWei` requirement,
the Robinhood LONG-platform exception). Relevant files: `direct-sign.mjs`
(browser bridge), `direct-sell.mjs` (capture-signer builders).

This is a THIRD kind of signer object in the codebase, alongside the real
autonomy signer (`signer.mjs`) and the approval-modal co-pilot signer
(`copilot.mjs`'s `buildCoPilotSignerFor`) — all three satisfy the same
`{ address, getEthBalanceWei(), callContract() }` contract, which is what
lets execution functions (`executeSniperSell`, `buyToken`, `sellCurveCoin`,
…) stay signer-agnostic. **Any new fake/mock signer must implement the FULL
contract** — a capture-signer missing `getEthBalanceWei()` killed every
co-pilot buy in production before it was caught (found live 2026-09-21).

## Read vs. sign — two different resolvers, don't cross them

- **`resolveUserReadWallet(userId)`** (`smart-wallet-api.mjs`) — whose
  BALANCES a user sees: registry SCW → users-table key → the user's own
  login address → global signer (last resort). Used everywhere a page shows
  a number (positions, P/L, overview, wallet slideout).
- **`resolveSignerUser(userId, chainKey)`** (`signer.mjs`) — who SIGNS: v2
  session key / v1 session key (autonomy) or the capture-signer / co-pilot
  approval signer (co-pilot).

Never call the global `resolveSigner()` for anything user-facing on
hosted — it resolves a legacy env wallet that belongs to nobody and holds
nothing. Full incident history (the `CONNECTED_WALLET` global-store bug,
the phantom-wallet key-persistence bug) is in `CLAUDE.md` § Hard-Won
Lessons — read it before touching wallet-resolution code.
