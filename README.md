# IMD Launchpad Terminal (`accumulate-imd`)

Purpose-built local tooling for the [IMD Community Coins launchpad](https://communitycoins.imd.fun)
on Ethereum mainnet — a **full fork of `/accumulate`** with the Alpha tab
rewired to the IMD launchpad (charter: `CLAUDE.md`).

## Start / restart

```bash
cd ~/accumulate-imd
./imd.sh start        # first start (pm2, background, auto-restart on crash)
./imd.sh restart      # restart after code changes
./imd.sh stop
./imd.sh logs         # tail pm2 logs
./imd.sh status
```

npm aliases work too: `npm run start|restart|stop|logs|status`.

**Port**: defaults to 4200. To run alongside `/accumulate` (which owns 4200),
set it once in your shell profile (`~/.zshrc`):

```bash
export IMD_DASHBOARD_PORT=4210
```

and every `./imd.sh start|restart` honors it. (`DASHBOARD_PORT` also works.)

Foreground (no pm2, Ctrl-C to stop): `npm run dashboard`.

## What works today

- **Alpha tab** (`/alpha`) — every IMD launchpad coin from the public
  indexer: price in USD (IMD figure secondary), market cap, sold %, backing,
  24h/1h volume in USD, buys/sells, unique curve buyers, age, GoPlus
  security, score. Filters: on-curve/all, min 24h volume, min score.
  **Search bar** (top right, or press `/`): filters live by symbol, name, or
  contract address; survives the 10s auto-refresh. In-place refresh every 10s.
- **Board header data** (in the Alpha tab intro): coin count, lifetime
  volume, IMD burned, creator fees — from the indexer's `statss`.
- All other tabs (Tokens, Sniper, Zooch, MM, Settings, Statistics) exist from
  the fork but still target the original `/accumulate` world — they need the
  IMD rework per the build order in `CLAUDE.md` before they're useful here.
- **Read-only**: no execution routes are armed; nothing trades.

## Fork status vs `/accumulate`

| Area | Status |
|---|---|
| Alpha engine | ✅ Rebuilt for IMD (indexer + curve math + curveTokenScore) — see `docs/ALPHA.md` |
| Alpha tab UI | ✅ Rewired: USD prices, sold %, backing, buyers, search, on-curve/all filters |
| Board tab | Not yet (data layer already exists in the engine) |
| Tokens/Accumulate | Forked, still mainnet-pool oriented — needs curve targets |
| Sniper | Forked, still PONS-era — needs curve buy + IMD-quoted sell probe |
| MM / Zooch / Settings | Forked, unmodified |

The old Robinhood/PONS alpha engine is preserved at
`scripts/reference-robinhood-alpha-engine.mjs` for reference; the original
IMD standalone prototype's queue cache is `scripts/imd_alpha_cache_backup.json`.
