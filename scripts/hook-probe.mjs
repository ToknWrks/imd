import { createPublicClient, http, parseAbi } from 'viem';
const c = createPublicClient({ transport: http('https://rpc.mainnet.chain.robinhood.com') });
const PM = '0x8366a39CC670B4001A1121B8F6A443A643e40951';
const HOOK = '0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544';
const MU   = '0xff080c8ce2e5feadaca0da81314ae59d232d4afd';
const ATL  = '0x26915c10e8ce9fb86b836fe8b129a1c5c3771e18';

// Hook introspection: try common view functions
const HOOK_ABI = parseAbi([
  'function poolManager() view returns (address)',
  'function owner() view returns (address)',
  'function beforeSwap() view returns (bytes4)',
  'function AFTER_SWAP_FLAG() view returns (uint256)',
  'function getFee(uint24) view returns (uint24)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
]);
for (const fn of ['poolManager', 'owner', 'beforeSwap', 'name', 'symbol', 'totalSupply']) {
  try {
    const r = await c.readContract({ address: HOOK, abi: HOOK_ABI_NAME_PLACEHOLDER, functionName: fn });
    console.log(fn, '=', String(r).slice(0, 80));
  } catch (e) { console.log(fn, 'not exposed'); }
}

// Also probe the platform executor 0x6aa8: name + any "canSell" style views
const EXEC = '0x6aa80dbbed9ae5ab45fbf61f9644fada3b29326e';
const EXEC_ABI = parseAbi([
  'function owner() view returns (address)',
  'function poolManager() view returns (address)',
  'function name() view returns (string)',
]);
for (const fn of ['owner', 'poolManager', 'name']) {
  try {
    const r = await c.readContract({ address: EXEC, abi: EXEC_ABI, functionName: fn });
    console.log('exec.' + fn, '=', String(r).slice(0, 80));
  } catch (e) { console.log('exec.' + fn, 'not exposed'); }
}
console.log('done');
process.exit(0);
