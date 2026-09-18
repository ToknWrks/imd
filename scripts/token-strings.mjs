import { createPublicClient, http } from 'viem';
const c = createPublicClient({ transport: http('https://rpc.mainnet.chain.robinhood.com') });
const ATL = '0x26915c10e8Ce9fb86B836fE8B129A1c5c3771E18';
const code = await c.getBytecode({ address: ATL });
const hex = code.slice(2);
// extract ascii strings >= 6 chars
const s = hex.match(/.{2}/g).map(h => String.fromCharCode(parseInt(h, 16))).join('');
const strs = s.match(/[\x20-\x7e]{6,}/g) || [];
console.log('code size:', (hex.length / 2).toFixed(0), 'bytes');
console.log('ascii strings:', JSON.stringify(strs.slice(0, 40), null, 1));
process.exit(0);
