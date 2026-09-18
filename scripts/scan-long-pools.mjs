import { createPublicClient, http, keccak256, encodeAbiParameters, parseAbiParameters } from 'viem';
const c = createPublicClient({ transport: http('https://rpc.mainnet.chain.robinhood.com') });
const SV = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b';
const ZERO = '0x0000000000000000000000000000000000000000';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const MU   = '0xff080c8ce2e5feadaca0da81314ae59d232d4afd';
const MOO  = '0xd9db30bb0d2b8d2eae3826a1372117e058791e18';
const HOOK = '0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544';

function poolIdOf(c0, c1, fee, ts, hooks) {
  const [a, b] = [c0.toLowerCase(), c1.toLowerCase()].sort();
  return keccak256(encodeAbiParameters(parseAbiParameters('address, address, uint24, int24, address'), [a, b, fee, ts, hooks]));
}
const STATE_VIEW_ABI = [
  { name: 'getSlot0', type: 'function', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'uint160' }, { type: 'int24' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'uint8' }, { type: 'bool' }, { type: 'bool' }] },
  { name: 'getLiquidity', type: 'function', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'uint128' }] },
];
// Only the exit-relevant legs: MU back to native ETH / WETH / USDG, MOO back to USDG/ETH
const pairs = [
  ['MU/ETH', MU, ZERO], ['MU/WETH', MU, WETH], ['MU/USDG', MU, USDG],
  ['MOO/USDG', MOO, USDG], ['MOO/ETH', MOO, ZERO], ['MOO/WETH', MOO, WETH],
];
const FEES = [[8388608, 8], [3000, 60], [10000, 200], [500, 10], [100, 1]];
const jobs = [];
for (const [label, a, b] of pairs) {
  for (const [fee, ts] of FEES) {
    for (const hooks of [HOOK, ZERO]) {
      const [c0, c1] = [a.toLowerCase(), b.toLowerCase()].sort();
      const pid = poolIdOf(c0, c1, fee, ts, hooks);
      jobs.push((async () => {
        try {
          const s0 = await c.readContract({ address: SV, abi: STATE_VIEW_ABI, functionName: 'getSlot0', args: [pid] });
          if (s0[0] === 0n) return;
          const liq = await c.readContract({ address: SV, abi: STATE_VIEW_ABI, functionName: 'getLiquidity', args: [pid] });
          console.log(label + ' fee=' + fee + ' ts=' + ts + ' hooks=' + (hooks === HOOK ? 'LONG' : 'zero') + ' liq=' + liq.toString() + ' pid=' + pid);
        } catch {}
      })());
    }
  }
}
await Promise.all(jobs);
console.log('scan done');
process.exit(0);
