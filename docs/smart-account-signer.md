# Scope — Alchemy Smart-Account signer mode (server-side session key)

> **Status: IMPLEMENTED & LIVE (as of 2026-09-17).** The interactive signer
> path is Connect wallet → browser-signed funding → MultiOwnerLightAccount
> smart wallet (session-key-signed UserOperations). The build order below is
> historical; the as-built state lives in `CLAUDE.md` § "Wallet-Connect &
> Smart Account (2026-09-17 migration)". Phase 2 (on-chain session-key
> policy) remains future work.
>
> **UPDATE 2026-09-20 — v2 wallets supersede this model for NEW connections.**
> New wallets are SMA v2 accounts OWNED BY THE USER'S EOA (deterministic
> CREATE2 derivation, one browser-signed activation, no gas-key funding).
> The session key becomes an entity-1 operator via `installValidation` only
> when the user enables automation — granted in a browser-signed UO, so the
> server never needs a relayer key. This document describes the LEGACY v1
> path, which existing wallets continue to use. See `CLAUDE.md` § "Signer &
> custody matrix" for the current two-generation matrix.

Decision: for VPS hosting, replace the vault-file model with an ERC-4337
smart account (Alchemy Account Kit, Modular Account v2 — the exact stack
rangedesk runs in `src/lib/wallet/smart-account.ts`). Owner key stays
off-box; the VPS holds only a session key whose spend cap is enforced
on-chain by the account's validation module. A full VPS compromise costs
the session cap until expiry — the property the vault model could not give
(see `docs/vps-deploy.md` §0).

## Constraint discovered: the signer interface is the seam

`signer.mjs` already normalizes every backend to:

    { kind, address, getEthBalanceWei(), callContract({ address, abi, functionName, args, value, maxFeePerGas, maxPriorityFeePerGas }) → txHash }

Consumers (dip-swap, dip-watcher, sniper-routes, sniper-extras, sell-probe,
wallet-position) never learn the backend and all post-check via
`waitForTransactionReceipt(txHash)` / `assertTxSucceeded`. So the whole
feature lives behind `resolveSigner()` — no execution-path rewrite — IF the
AA mode maps onto that interface exactly:

- `callContract(opts)` → `sendUserOperation({ target, data, value })` →
  `waitForUserOperationTransaction(hash)` → **return the inner tx hash**.
  Everything downstream (receipt wait, gas ledger, error rows) then works
  unchanged.
- `getEthBalanceWei()` → public client balance of the smart-account address.
- **`maxFeePerGas` / `maxPriorityFeePerGas` from `wrapSignerGas` must be
  ignored** (UO gas is bundler-estimated). Accept + drop silently, with a
  comment — sniper routes pass them today.
- Multi-tx flows (e.g. `sendV4Buy`'s pre-wrap: WETH.deposit → Permit2
  approves → UR execute) become sequential UOs. Each waits for its UO tx
  before the next — same semantics as today, same revert isolation.

## Files touched

| File | Change |
|---|---|
| `signer.mjs` | New `SMART_ACCOUNT_ACTIVE=true` branch: builds the AA client from a server-side session-key WalletClient (`WalletClientSigner`), returns the standard interface. Memoized per chain like the others. |
| `smart-account.mjs` (new) | **MultiOwnerLightAccount** signer backend: `alchemyTransportFor`, client factory, `gasReserveWei()`, `explainUserOpError()`. No React, no AppKit — server-only. |
| `scripts/deploy-smart-account.mjs` (new) | One-time owner-side helper: derives the counterfactual SCW address for the owner, prints it, optionally deploys (factory tx signed by an owner key entered on the *local* machine, never pasted to the VPS). |
| `scripts/test-aa-execution.mjs` (new) | Dry-run ladder, mirroring `test-v4-execution.mjs`: builds the real UO for a configured buy, `eth_estimateUserOperationGas` via the bundler, sends NOTHING. Must share the same build function the live path uses (the `test-v4-execution` lesson). |
| `dashboard.mjs` (Settings tab) | Smart-account section: show SCW address, session-key address, policy (cap/expiry), deploy + fund status. Read-only at first. |
| `.env.example` | `SMART_ACCOUNT_ACTIVE`, `AA_SESSION_KEY` (as-built: `AA_OWNER_ADDRESS` / `AA_ALCHEMY_GAS_POLICY_ID` were not needed in Phase 1). |
| `package.json` | `@aa-sdk/core`, `@account-kit/infra`, `@account-kit/smart-contracts` `^4.88.5` (pinned to rangedesk's versions — known-good on mainnet + Base). |
| `docs/vps-deploy.md` | §0 rewrite: session-key model replaces the vault model for the VPS path; vault section stays for the local machine. |

## Account type history (2026-09-17, during the funded dry-run)

The plan went through two account types before landing on the final one —
recorded here because each switch reshuffles the counterfactual SCW address:

1. **ModularAccount v2 (original plan)** — during the funded dry-run it failed
   `AA23 reverted / UnrecognizedFunction(0x00000000)` at
   `eth_estimateUserOperationGas` — reproduced with the SDK's OWN client + fresh
   key on both mainnet and sepolia: an Alchemy contract/SDK drift in MA v2's
   plugin init (SDK 4.88.5, latest as of this date), not our config. Its
   factory additionally **silently no-ops when `msg.sender ≠ owner`** — our
   Activate button deployed from the vault while passing the session key as
   owner: two txs "succeeded" (25k gas, zero logs, no code created). Full
   lesson in `CLAUDE.md` § MA v2 factory lesson.
2. **LightAccount v2 (interim)** — same middleware, same interface shim,
   builds cleanly on mainnet and sepolia; abandoned derivation (`0xFB11…b9c5`),
   never funded.
3. **MultiOwnerLightAccount (final, implemented & working)** — the current
   backend in `smart-account.mjs`. Owned by the burner session key
   (`AA_SESSION_KEY`); multi-owner semantics mean a replaced/rotated key keeps
   on-chain authority over its account, so funds are never truly lost — just
   out of the app's view until the old key is re-imported (see the address
   ledger in `CLAUDE.md`; current account `0xF4a6…23Fa`, unfunded-then-live
   via the browser-signed Fund flow). Phase 1 semantics as planned: the
   session key owns the account directly; Phase 2 session-key policies will
   use the LightAccount plugin path — revisit when we get there (or when MA v2
   drift is fixed upstream).

`dip-swap.mjs`, `dip-watcher.mjs`, `sniper-*`, `sell-probe.mjs`,
`wallet-position.mjs`: **no changes** — they consume the interface only.
(The pre-wrap path already approves Permit2 through the signer, which a
smart account can do — approvals are just UOs.)

## Session-key policy (the actual security win)

Phase A ships with the SCW owned by a **dedicated off-box ECDSA owner**
(creates via the deploy script; key lives in your password manager, never on
the VPS) and the VPS signing with a **burner session key that is NOT yet
on-chain-limited** — i.e. Phase 1 = "hot key with a new name", same cap by
funding discipline as today. Say so plainly in the UI.

Phase 2 installs MA v2's session-key validation module
(`@account-kit/smart-contracts` session-key plugin):
- allowed targets: Universal Router, SwapRouter02, PERMIT2, the launchpad
  hook, WETH (deposit), token contracts (approve only)
- spend cap per period in ETH + per-token caps
- expiry ≤ 30 days, rotated by the owner without touching the VPS

Verify the exact plugin API surface during build — the rangedesk codebase
does not use it yet, so treat the API names as unverified until a testnet
pass succeeds.

## Build order (each step gated on the previous one working)

1. **AA dry-run against mainnet bundler** — ✅ DONE 2026-09-17. `buildUserOperation()`
   constructs the full UO through Alchemy's middleware (factory + factoryData +
   callData + fee fields, EntryPoint 0.7 at 0x0000000071727De22E5E9d8BAf0edAc6f37da032).
   `eth_estimateUserOperationGas` reverts with empty revert data — the expected
   unfunded-account state. `scripts/test-aa-execution.mjs` codifies the check:
   rerun after funding; the revert should clear and gas fields print.
2. **Fund the SCW** (the user gate) — plan budget + ~0.001 ETH gas float, via
   the wallet slideout's browser-signed Fund flow (step 2 of the migration, live).
3. **One small live UO** — first buy through `SMART_ACCOUNT_ACTIVE=true`.
   Verify: inner tx hash lands in `dip_trades`, receipt interop with
   `assertTxSucceeded`, gas ledger records the UO's inner tx.
4. Interface shim already built and unit-path tested; `wallet-api.mjs` reads
   now prefer the logged-in session's own address (✅ 2026-09-17, updated
   2026-09-19 when the global `CONNECTED_WALLET` store it originally used
   was removed in favor of per-request session identity).
5. Settings-tab visibility — done (SCW address + session key UI).
6. Only then: Phase 2 session-key policy module on-chain.

## Risks / known unknowns

- **Permit2 from an AA sender**: standard, but the pre-wrap approval chain
  must be re-verified live (gas paid by EntryPoint changes tx `from`).
- **Paymaster**: skip in Phase 1 — SCW holds its own gas float
  (`gasReserveWei` pattern), avoiding gas-manager policy complexity until
  Phase 2.
- **Nonce/mempool**: UOs are bundler-relayed; the wrapSignerGas eviction
  problem (0.001 gwei tip) disappears, but bundler throughput limits apply.
- **wallet-position transfer scans** read by `signer.address` — works
  unchanged since it's just the SCW address, but cost basis history starts
  fresh on the new address (old vault wallet's positions don't migrate).
- VultiSig path stays untouched — local machine keeps using it; this is a
  VPS-deployment signer mode, selected by env, never a forced migration.
