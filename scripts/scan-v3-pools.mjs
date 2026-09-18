import { createPublicClient, http } from 'viem';
const c = createPublicClient({ transport: http('https://rpc.mainnet.chain.robinhood.com') });
const FACTORY = '0x1f7d7550b1b028f7571e69a784071f0205fd2efa';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const MU   = '0xff080c8ce2e5feadaca0da81314ae59d232d4afd';
const MOO  = '0xd9db30bb0d2b8d2eae3826a1372117e058791e18';
const FACTORY_ABI = [{ name: 'getPool', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }], outputs: [{ type: 'address' }] }];
const POOL_ABI = [
  { name: 'slot0', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint160' }, { type: 'int24' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'uint8' }, { type: 'bool' }, { type: 'bool' }] },
  { name: 'liquidity', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint128' }] },
];
const pairs = [
  ['MU/WETH', MU, WETH], ['MU/USDG', MU, USDG], ['MOO/USDG', MOO, USDG], ['MOO/WETH', MOO, WETH],
];
const FEES = [3000, 10000, 500, 100];
const jobs = [];
for (const [label, a, b] of pairs) {
  for (const fee of FEES) {
    jobs.push((async () => {
      try {
        const pool = await c.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: 'getPool', args: [a, b, fee] });
        if (pool === '0x0000000000000000000000000000000000000000') return;
        const [s0, liq] = await Promise.all([
          c.readContract({ address: pool, abi: POOL_ABI, functionName: 'slot0' }),
          c.readContract({ address: pool, abi: POOL_ABI, functionName: 'liquidity' }),
        ]);
        console.log(label + ' fee=' + fee + ' pool=' + pool + ' sqrt=' + s0[0].toString() + ' liq=' + liq.toString());
      } catch {}
    })());
  }
}
await Promise.all(jobs);
console.log('v3 scan done');
process.exit(0);
