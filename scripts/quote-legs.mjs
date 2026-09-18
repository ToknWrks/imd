import { createPublicClient, http, parseAbi, formatUnits } from 'viem';
const c = createPublicClient({ transport: http('https://rpc.mainnet.chain.robinhood.com') });
const QUOTER_V3 = '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7';
const QUOTER_V4 = '0x8dc178efb8111bb0973dd9d722ebeff267c98f94';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const MU   = '0xff080c8ce2e5feadaca0da81314ae59d232d4afd';
const ATL  = '0x26915c10e8ce9fb86b836fe8b129a1c5c3771e18';
const MOO  = '0xd9db30bb0d2b8d2eae3826a1372117e058791e18';
const HOOK = '0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544';

const V4_QUOTER_ABI = parseAbi(['function quoteExactInputSingle((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint256 exactAmount,bytes hookData) returns (uint256 amountOut, uint256 gasEstimate)']);
const poolKey = { currency0: ATL, currency1: MU, fee: 8388608, tickSpacing: 8, hooks: HOOK };
try {
  const { result } = await c.simulateContract({
    address: QUOTER_V4, abi: V4_QUOTER_ABI, functionName: 'quoteExactInputSingle',
    args: [poolKey, true, 10n**18n, '0x'],
  });
  console.log('V4 ATL->MU: 1 ATL =', formatUnits(result[0], 18), 'MU');
} catch (e) {
  console.log('V4 ATL->MU ERR:', String(e).slice(0, 400).replace(/\n/g, ' | '));
}

const V3_QUOTE_ABI = parseAbi(['function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint256[] amounts)']);
async function q3(from, to, label) {
  for (const fee of [100, 500, 3000, 10000]) {
    const feeHex = fee.toString(16).padStart(6, '0');
    const path = '0x' + from.slice(2).toLowerCase() + feeHex + to.slice(2).toLowerCase();
    try {
      const { result } = await c.simulateContract({ address: QUOTER_V3, abi: V3_QUOTE_ABI, functionName: 'quoteExactInput', args: [path, 10n**18n] });
      console.log(`V3 ${label} fee=${fee}: out=${result[0].toString()}`);
    } catch (e) {
      console.log(`V3 ${label} fee=${fee}: no pool`);
    }
  }
}
await q3(MU, WETH, 'MU->WETH');
await q3(MOO, WETH, 'MOO->WETH');
await q3(USDG, WETH, 'USDG->WETH');
await q3(MOO, USDG, 'MOO->USDG');
console.log('done');
process.exit(0);
