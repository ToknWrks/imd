// Dry-run: LONG venue detection + sell quote for ATLANTIS (no funds move).
import { findLongVenue, longStockToken, quoteLongSell } from '../long-platform.mjs';

const ATL = '0x26915c10e8ce9fb86b836fe8b129a1c5c3771e18';
const venue = await findLongVenue(ATL, 'robinhood');
if (!venue) { console.log('NOT A LONG VENUE'); process.exit(1); }
console.log('poolId:', venue.poolId);
console.log('poolKey:', JSON.stringify(venue.poolKey));
const stock = longStockToken(venue, ATL);
console.log('stockToken:', stock);
for (let i = 0; i < 3; i++) {
  try {
    const q = await quoteLongSell(venue, ATL, 1, 18, 'robinhood');
    console.log('quoteLongSell(1 ATL):', JSON.stringify(q, (k, v) => typeof v === 'bigint' ? v.toString() : v));
    break;
  } catch (e) { console.log('retry', i + 1, String(e).slice(0, 120)); }
}
process.exit(0);
