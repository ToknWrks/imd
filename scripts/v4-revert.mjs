import { createPublicClient, http, parseAbi, encodeFunctionData, decodeFunctionResult } from 'viem';
const c = createPublicClient({ transport: http('https://rpc.mainnet.chain.robinhood.com') });
const QUOTER_V4 = '0x8dc178efb8111bb0973dd9d722ebeff267c98f94';
const MU   = '0xff080c8ce2e5feadaca0da81314ae59d232d4afd';
const ATL  = '0x26915c10e8ce9fb86b836fe8b129a1c5c3771e18';
const HOOK = '0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544';

const V4_QUOTER_ABI = parseAbi(['function quoteExactInputSingle((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint256 exactAmount,bytes hookData) returns (uint256 amountOut, uint256 gasEstimate)']);
const poolKey = { currency0: ATL, currency1: MU, fee: 8388608, tickSpacing: 8, hooks: HOOK };
const data = encodeFunctionData({ abi: V4_QUOTER_ABI, functionName: 'quoteExactInputSingle', args: [poolKey, true, 10n**18n, '0x'] });
try {
  const res = await c.call({ to: QUOTER_V4, data });
  console.log('OK:', res.data);
} catch (e) {
  // walk the error chain for the revert data
  let err = e;
  let found = null;
  while (err) {
    if (err.data || (typeof err.details === 'string' && err.details.startsWith('0x'))) { found = err; break; }
    err = err.cause || err.wrapped || null;
  }
  console.log('name:', e.name);
  console.log('message:', String(e.message).slice(0, 500));
  if (e.details) console.log('details:', e.details.slice(0, 500));
  // try raw eth_call to get revert bytes via request
  try {
    const raw = await c.request({ method: 'eth_call', params: [{ to: QUOTER_V4, data }, 'latest'] });
    console.log('raw ok:', raw.slice(0, 200));
  } catch (e2) {
    console.log('raw eth_call error:', JSON.stringify(e2).slice(0, 800));
  }
}
process.exit(0);
