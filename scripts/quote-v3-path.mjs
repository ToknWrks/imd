import { createPublicClient, http, encodeFunctionData, pad, numberToHex } from 'viem';
const c = createPublicClient({ transport: http('https://rpc.mainnet.chain.robinhood.com') });
const QUOTER = '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const MU   = '0xff080c8ce2e5feadaca0da81314ae59d232d4afd';
const SENTINEL = '0xfffd8963efd1fc6a506488495d951d5263988d25';

// Build V3 path bytes: token(20) + fee(3) + token(20)
const pathMUtoWETH = MU.slice(2).toLowerCase() + '000bb8' + WETH.slice(2).toLowerCase();
const pathMUtoSentinel = MU.slice(2).toLowerCase() + '000bb8' + SENTINEL.slice(2).toLowerCase();

// quoteExactInput(bytes path, uint256 amountIn) selector 0xc6a5026a
function quoteCall(pathHex, amountIn) {
  // abi-encode: selector + offset(0x40) + amountIn + len(path) + path padded
  const data = '0xc6a502' + '00'; // will build manually
  const sel = 'c6a5026a';
  let enc = sel;
  enc += '0000000000000000000000000000000000000000000000000000000000000040';
  enc += amountIn.toString(16).padStart(64, '0');
  const len = pathHexLen(pathHex(pathMUtoWETH));
  return { sel, pathHexLen };
}
function pathHexLen(x){return x.length/2;}
function pathHex(p){return p;}

const amountIn = 10n**18n; // 1 MU
async function quote(pathBytes, label) {
  const sel = '0xc6a5026a';
  let data = sel;
  data += '0000000000000000000000000000000000000000000000000000000000000040';
  data += amountIn.toString(16).padStart(64, '0');
  const pathLen = (pathBytes.length / 2).toString(16).padStart(64, '0');
  data += pathLen;
  const padded = pathBytes + '0'.repeat((64 - (pathBytes.length % 64)) % 64);
  data += padded;
  try {
    const res = await c.call({ to: QUOTER, data: sel + data.slice(10) });
    console.log(label, 'raw:', res.data.slice(0, 80));
    // amountOut is the first word
    const out = BigInt('0x' + res.data.slice(2, 66));
    console.log(label, 'amountOut:', out.toString());
  } catch (e) {
    console.log(label, 'ERR', String(e).slice(0, 200));
  }
}
await quote(pathMUtoWETH, 'MU->WETH f3000');
await quote(pathMUtoSentinel, 'MU->SENTINEL f3000');
process.exit(0);
